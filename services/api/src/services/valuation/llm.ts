import { z } from 'zod';
import { generateText, APICallError, type ToolSet } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenRouter, type OpenRouterUsageAccounting } from '@openrouter/ai-sdk-provider';
import { config } from '../../../../shared/src';
import {
  buildOpenRouterRequest,
  normalizeOpenRouterUsage,
  readTokenCount,
  type OpenAIResponseUsage,
  type OpenRouterProviderRouting,
} from './openrouter-transport';
import { parseOpenAiResponsesBody } from './openai-transport';
import type {
  ValuationAppraisalEvidence,
  ValuationEvidence,
  ValuationNameResearchEvidence,
  ValuationRelatedTermsEvidence,
  ValuationResearchSense,
  ValuationSenseTerms,
} from './types';
import {
  compactEnsLabel,
  dedupeNormalizedLabels,
  normalizeValuationLabel,
  renderValuationPrompt,
  valuationLogInfo,
  valuationLogWarn,
} from './support';

/**
 * LLM engine for the valuation pipeline.
 *
 * Ported from the POC. Preserved: per-channel model routing (OpenAI Responses
 * API + OpenRouter chat/completions with provider pinning, json_schema↔json_object
 * downgrades, reasoning control), retries/backoff, and in-memory cost accounting.
 *
 * Changed for backend:
 * - Prompt text is loaded from the DB (renderValuationPrompt); only JSON schemas
 *   stay in code. The repo is open-source, so prompt bodies must not live here.
 * - maxResearchSenses + the per-sense term-count schedule come from DB config
 *   (passed in by the route), not inline constants.
 * - API keys come from shared config.
 * - The local CSV run-logging (test-only) is removed; the in-memory per-run cost
 *   summary is kept.
 * - OpenRouter calls go through the Vercel AI SDK (`generateText` +
 *   `@openrouter/ai-sdk-provider`) instead of raw fetch. The exact OpenRouter
 *   request body (provider pinning, reasoning ladder incl. the disable-on-'none',
 *   the json_schema↔json_object downgrade with the schema injected into a system
 *   message, the web plugin) is reproduced via `extraBody`, so the wire request
 *   and the parse/cost/error-as-evidence behavior are unchanged. The SDK's own
 *   retries are disabled (`maxRetries: 0`); the hand-rolled retry/backoff loop
 *   below still owns all attempts. The OpenAI Responses path remains raw fetch.
 */

export const VALUATION_OPENAI_MODEL = 'gpt-5.5';

const MAX_RETRIES = 3;
// LLM calls sit on the user-facing stream; bound each attempt so a stalled
// upstream can't hold the request open for undici's multi-minute default.
const LLM_REQUEST_TIMEOUT_MS = 120_000;
const TOKENS_PER_MILLION = 1_000_000;
const MAX_OPENAI_COST_SUMMARIES = 100;

type OpenAIModelPricing = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

// Per-call cost (token estimate, or OpenRouter's reported cost when available).
type OpenAICallCost = {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
};

type OpenAICostStep = 'related_terms' | 'number_variants' | 'name_research' | 'appraisal' | 'other';

// Per-run rollup, keyed by logPrefix, consumed once at the end of a run.
export type OpenAIRunCost = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  costUsd: number;
};

const OPENAI_MODEL_PRICING: Record<string, OpenAIModelPricing> = {
  'gpt-5.5': {
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
  },
  'gpt-5.4-mini': {
    inputUsdPerMillion: 0.75,
    cachedInputUsdPerMillion: 0.08,
    outputUsdPerMillion: 4.5,
  },
  'gpt-5.2': {
    inputUsdPerMillion: 1.75,
    cachedInputUsdPerMillion: 0.18,
    outputUsdPerMillion: 14,
  },
  // OpenRouter candidate models under cost evaluation (provider-listed prices).
  'deepseek/deepseek-v4-pro': {
    inputUsdPerMillion: 0.435,
    cachedInputUsdPerMillion: 0.003625,
    outputUsdPerMillion: 0.87,
  },
  'deepseek/deepseek-v4-flash': {
    inputUsdPerMillion: 0.14,
    cachedInputUsdPerMillion: 0.14,
    outputUsdPerMillion: 0.28,
  },
  'x-ai/grok-4.3': {
    inputUsdPerMillion: 1.25,
    cachedInputUsdPerMillion: 1.25,
    outputUsdPerMillion: 2.5,
  },
};

export type ValuationModelProvider = 'openai' | 'openrouter';

export type ValuationReasoningEffort = 'none' | 'low' | 'medium' | 'high';

export type ValuationChannelModel = {
  provider: ValuationModelProvider;
  model: string;
  reasoningEffort: ValuationReasoningEffort;
  reasoningMaxTokens?: number;
  temperature?: number;
};

// Models in production use. The 2026-06 bake-off evaluated several other
// OpenRouter candidates (Qwen, Kimi, Gemini, Grok-build); only these three were
// selected, so the rest were removed. Add a model here + to OPENAI_MODEL_PRICING
// (and OPENROUTER_PROVIDER_ROUTING if it needs provider pinning) to reintroduce one.
const OPENROUTER_MODELS = {
  deepseekV4Pro: 'deepseek/deepseek-v4-pro',
  deepseekV4Flash: 'deepseek/deepseek-v4-flash',
  grokV43: 'x-ai/grok-4.3',
} as const;

// Pin the upstream OpenRouter provider per model (pricing varies a lot by provider).
const OPENROUTER_PROVIDER_ROUTING: Record<string, OpenRouterProviderRouting> = {
  [OPENROUTER_MODELS.deepseekV4Pro]: { order: ['deepseek'], allowFallbacks: false, structuredOutputs: false },
  [OPENROUTER_MODELS.deepseekV4Flash]: { order: ['deepseek'], allowFallbacks: false, structuredOutputs: false },
  [OPENROUTER_MODELS.grokV43]: { structuredOutputs: false },
};

// Per-channel model selection. name_research keeps OpenAI-style web search via the
// OpenRouter web plugin. Tuned via the 2026-06 bake-off (see PRIVATE scratchpad).
const CHANNEL_MODELS: Record<OpenAICostStep, ValuationChannelModel> = {
  related_terms: {
    provider: 'openrouter',
    model: OPENROUTER_MODELS.deepseekV4Pro,
    reasoningEffort: 'none',
    temperature: 0,
  },
  number_variants: {
    provider: 'openrouter',
    model: OPENROUTER_MODELS.deepseekV4Flash,
    reasoningEffort: 'none',
    temperature: 0,
  },
  name_research: {
    provider: 'openrouter',
    model: OPENROUTER_MODELS.deepseekV4Pro,
    reasoningEffort: 'low',
    temperature: 0,
  },
  appraisal: {
    provider: 'openrouter',
    model: OPENROUTER_MODELS.grokV43,
    reasoningEffort: 'none',
    temperature: 0,
  },
  other: { provider: 'openai', model: VALUATION_OPENAI_MODEL, reasoningEffort: 'low' },
};

function getChannelModel(step: OpenAICostStep): ValuationChannelModel {
  return CHANNEL_MODELS[step];
}

const runCostsByLogPrefix = new Map<string, OpenAIRunCost>();

function scopedTermCountForScore(score: number, byScore: Record<string, number>): number {
  const clamped = Math.max(1, Math.min(5, Math.round(score)));
  const count = byScore[String(clamped)];
  if (typeof count !== 'number') {
    throw new Error(`termCounts.byScore is missing an entry for score ${clamped}`);
  }
  return count;
}

const NUMBER_VARIANTS_SCHEMA = {
  type: 'object',
  properties: {
    t: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['t'],
  additionalProperties: false,
} as const;

const NAME_RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    label: { type: 'string' },
    categories: {
      type: 'array',
      items: { type: 'string' },
    },
    senses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          sense: { type: 'string' },
          demandScore: { type: 'number' },
        },
        required: ['sense', 'demandScore'],
        additionalProperties: false,
      },
    },
  },
  required: ['label', 'categories', 'senses'],
  additionalProperties: false,
} as const;

const SCOPED_TERMS_SCHEMA = {
  type: 'object',
  properties: {
    names: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['names'],
  additionalProperties: false,
} as const;

const APPRAISAL_SCHEMA = {
  type: 'object',
  properties: {
    ethValue: { type: 'string' },
    lowEth: { type: 'string' },
    highEth: { type: 'string' },
    reasoning: { type: 'string' },
    signals: {
      type: 'array',
      items: { type: 'string' },
    },
    cautions: {
      type: 'array',
      items: { type: 'string' },
    },
    compsUsed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          priceEth: { type: 'string' },
          date: { type: 'string' },
        },
        required: ['name', 'priceEth', 'date'],
        additionalProperties: false,
      },
    },
  },
  required: ['ethValue', 'lowEth', 'highEth', 'reasoning', 'signals', 'cautions', 'compsUsed'],
  additionalProperties: false,
} as const;

function parseResetHeader(value: string | null): number | null {
  if (!value) return null;

  let ms = 0;
  const minutes = value.match(/(\d+)m(?!s)/);
  const seconds = value.match(/(\d+)s/);
  const millis = value.match(/(\d+)ms/);

  if (minutes) ms += parseInt(minutes[1], 10) * 60_000;
  if (seconds) ms += parseInt(seconds[1], 10) * 1_000;
  if (millis) ms += parseInt(millis[1], 10);

  return ms > 0 ? ms : null;
}

function formatUsd(value: number) {
  return Number(value.toFixed(8));
}

function getOpenAIPricing(model: string): OpenAIModelPricing | null {
  const normalizedModel = model.toLowerCase();
  const exactPricing = OPENAI_MODEL_PRICING[normalizedModel];
  if (exactPricing) return exactPricing;

  const matchedModel = Object.keys(OPENAI_MODEL_PRICING).find((modelKey) => normalizedModel.startsWith(`${modelKey}-`));
  return matchedModel ? OPENAI_MODEL_PRICING[matchedModel] : null;
}

// Per-call cost. Token counts feed the estimate; the caller may override costUsd
// with a provider-reported figure (e.g. OpenRouter's, which includes plugin fees).
function calculateOpenAICost(model: string, usage: OpenAIResponseUsage | undefined): OpenAICallCost | null {
  const pricing = getOpenAIPricing(model);
  if (!pricing || !usage) return null;

  const inputTokens = readTokenCount(usage.input_tokens);
  const outputTokens = readTokenCount(usage.output_tokens);
  const cachedInputTokens = Math.min(readTokenCount(usage.input_tokens_details?.cached_tokens), inputTokens);
  const uncachedInputTokens = Math.max(inputTokens - cachedInputTokens, 0);
  const reasoningTokens = readTokenCount(usage.output_tokens_details?.reasoning_tokens);
  const costUsd =
    (uncachedInputTokens / TOKENS_PER_MILLION) * pricing.inputUsdPerMillion +
    (cachedInputTokens / TOKENS_PER_MILLION) * pricing.cachedInputUsdPerMillion +
    (outputTokens / TOKENS_PER_MILLION) * pricing.outputUsdPerMillion;

  return { inputTokens, outputTokens, reasoningTokens, costUsd: formatUsd(costUsd) };
}

// Maps an OpenAI call label to its channel step (used for provider routing).
function getOpenAICostStep(label: string): OpenAICostStep {
  if (label === 'number_variants') return 'number_variants';
  if (label.startsWith('name_research:')) return 'name_research';
  if (label.startsWith('appraisal:')) return 'appraisal';
  if (label) return 'related_terms';
  return 'other';
}

function recordOpenAICost(logPrefix: string, cost: OpenAICallCost | null) {
  if (!cost) return;

  const totals = runCostsByLogPrefix.get(logPrefix) ?? {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
  totals.calls += 1;
  totals.inputTokens += cost.inputTokens;
  totals.outputTokens += cost.outputTokens;
  totals.reasoningTokens += cost.reasoningTokens;
  totals.costUsd = formatUsd(totals.costUsd + cost.costUsd);
  runCostsByLogPrefix.set(logPrefix, totals);

  if (runCostsByLogPrefix.size > MAX_OPENAI_COST_SUMMARIES) {
    const oldestKey = runCostsByLogPrefix.keys().next().value;
    if (oldestKey) runCostsByLogPrefix.delete(oldestKey);
  }
}

export function consumeOpenAICostRunSummary(logPrefix: string): OpenAIRunCost | null {
  const totals = runCostsByLogPrefix.get(logPrefix);
  if (!totals) return null;

  runCostsByLogPrefix.delete(logPrefix);
  return totals;
}

function readRequestedOpenAIModel(body: string) {
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === 'string' ? parsed.model : 'unknown';
  } catch {
    return 'unknown';
  }
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// One OpenRouter provider per API key (the key is effectively constant in prod).
// Attribution headers match the old raw-fetch request.
let openRouterProvider: ReturnType<typeof createOpenRouter> | null = null;
let openRouterProviderKey: string | null = null;

function getOpenRouterProvider(apiKey: string): ReturnType<typeof createOpenRouter> {
  if (openRouterProvider && openRouterProviderKey === apiKey) {
    return openRouterProvider;
  }
  openRouterProvider = createOpenRouter({
    apiKey,
    headers: {
      'HTTP-Referer': 'https://grails.app',
      'X-Title': 'Grails Valuation',
    },
  });
  openRouterProviderKey = apiKey;
  return openRouterProvider;
}

async function callOpenRouterChat(responsesBody: string, label: string, logPrefix: string): Promise<string> {
  const apiKey = config.valuation.openrouterApiKey;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const requestedModel = readRequestedOpenAIModel(responsesBody);
  const request = buildOpenRouterRequest(responsesBody, OPENROUTER_PROVIDER_ROUTING[requestedModel]);
  // Settings (provider routing, reasoning, plugins, response_format, usage) ride
  // on extraBody so the outbound body matches the previous hand-built JSON exactly.
  const model = getOpenRouterProvider(apiKey).chat(request.model, { extraBody: request.extraBody });
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = performance.now();
    valuationLogInfo(logPrefix, 'OpenRouter request start', {
      label,
      model: requestedModel,
      attempt: attempt + 1,
      maxAttempts: MAX_RETRIES + 1,
    });

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      // maxRetries:0 — this loop owns all attempts/backoff, exactly as before.
      result = await generateText({
        model,
        messages: request.messages,
        ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // A thrown call exposes an HTTP status only for an API error; a
      // network/timeout/abort has none. Retry on 429, 5xx, and no-status
      // (network/timeout) — and throw immediately on any other 4xx, mirroring
      // the old `!response.ok` non-429/non-5xx path.
      const status = APICallError.isInstance(error) ? error.statusCode : undefined;

      if (status === 429 && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        valuationLogWarn(logPrefix, 'OpenRouter rate limited, retrying', { label, backoffMs: Math.round(backoffMs) });
        await sleep(backoffMs);
        continue;
      }

      if (status !== undefined && status >= 500 && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        valuationLogWarn(logPrefix, 'OpenRouter server error, retrying', {
          label,
          status,
          backoffMs: Math.round(backoffMs),
        });
        await sleep(backoffMs);
        continue;
      }

      if (status === undefined && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        valuationLogWarn(logPrefix, 'OpenRouter network/timeout error, retrying', {
          label,
          message: lastError.message,
          backoffMs: Math.round(backoffMs),
        });
        await sleep(backoffMs);
        continue;
      }

      throw lastError;
    }

    const totalMs = Math.round(performance.now() - startedAt);
    const actualModel = result.response?.modelId || requestedModel;
    // The token split + reported cost come from OpenRouter's usage object in
    // providerMetadata (the normalized result.usage frequently leaves
    // cached/reasoning tokens undefined); result.usage is only a fallback.
    const openrouterUsage = result.providerMetadata?.openrouter?.usage as OpenRouterUsageAccounting | undefined;
    const { normalized, reportedCostUsd } = normalizeOpenRouterUsage(openrouterUsage, result.usage);
    // Prefer OpenRouter's reported cost (includes web-search/plugin fees + the
    // real provider rate). Record it even when the model is absent from the
    // static pricing table — token counts still come from usage.
    let cost = calculateOpenAICost(actualModel, normalized);
    if (reportedCostUsd != null) {
      cost = {
        inputTokens: normalized.input_tokens ?? 0,
        outputTokens: normalized.output_tokens ?? 0,
        reasoningTokens: normalized.output_tokens_details?.reasoning_tokens ?? 0,
        costUsd: formatUsd(reportedCostUsd),
      };
    }
    recordOpenAICost(logPrefix, cost);
    valuationLogInfo(logPrefix, 'OpenRouter response parsed', {
      label,
      model: actualModel,
      finishReason: result.finishReason,
      inputTokens: normalized.input_tokens,
      outputTokens: normalized.output_tokens,
      reportedCostUsd,
      pricingMatched: Boolean(cost),
      totalMs,
    });

    const text = result.text;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error(
        `No content in OpenRouter response (finish_reason: ${result.finishReason ?? 'unknown'}; likely reasoning consumed the token budget)`
      );
    }
    return text;
  }

  throw lastError ?? new Error('OpenRouter request failed');
}

async function callOpenAIRaw(body: string, label: string, logPrefix = '[valuation/openai]'): Promise<string> {
  if (getChannelModel(getOpenAICostStep(label)).provider === 'openrouter') {
    return callOpenRouterChat(body, label, logPrefix);
  }

  return callOpenAi(body, label, logPrefix);
}

// One OpenAI provider per API key. openai.responses(...) targets the Responses API.
let openAiProvider: ReturnType<typeof createOpenAI> | null = null;
let openAiProviderKey: string | null = null;

function getOpenAiProvider(apiKey: string): ReturnType<typeof createOpenAI> {
  if (openAiProvider && openAiProviderKey === apiKey) {
    return openAiProvider;
  }
  openAiProvider = createOpenAI({ apiKey });
  openAiProviderKey = apiKey;
  return openAiProvider;
}

async function callOpenAi(responsesBody: string, label: string, logPrefix: string): Promise<string> {
  const apiKey = config.openai.apiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const requestedModel = readRequestedOpenAIModel(responsesBody);
  const call = parseOpenAiResponsesBody(responsesBody);
  const provider = getOpenAiProvider(apiKey);
  const model = provider.responses(call.model);
  // Native server-side web search on the Responses API (the 'other' channel only).
  const tools: ToolSet | undefined = call.hasWebSearch ? { web_search: provider.tools.webSearch() } : undefined;
  const providerOptions = {
    openai: {
      ...(call.store !== undefined ? { store: call.store } : {}),
      ...(call.reasoningEffort !== undefined ? { reasoningEffort: call.reasoningEffort } : {}),
    },
  };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = performance.now();
    valuationLogInfo(logPrefix, 'OpenAI request start', {
      label,
      model: requestedModel,
      attempt: attempt + 1,
      maxAttempts: MAX_RETRIES + 1,
    });

    let result: Awaited<ReturnType<typeof generateText>>;
    try {
      // maxRetries:0 — this loop owns all attempts/backoff, exactly as before.
      result = await generateText({
        model,
        messages: call.messages,
        ...(call.maxOutputTokens !== undefined ? { maxOutputTokens: call.maxOutputTokens } : {}),
        ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
        ...(tools ? { tools } : {}),
        providerOptions,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const status = APICallError.isInstance(error) ? error.statusCode : undefined;
      const headers = APICallError.isInstance(error) ? error.responseHeaders : undefined;

      if (status === 429 && attempt < MAX_RETRIES) {
        // Preserve the OpenAI-specific reset-header backoff (and its precedence
        // quirk: resetMs is used raw, without added jitter).
        const resetMs = parseResetHeader(headers?.['x-ratelimit-reset-requests'] ?? null);
        const backoffMs = resetMs ?? 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        valuationLogWarn(logPrefix, 'OpenAI rate limited, retrying', { label, backoffMs: Math.round(backoffMs) });
        await sleep(backoffMs);
        continue;
      }

      if (status !== undefined && status >= 500 && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        valuationLogWarn(logPrefix, 'OpenAI server error, retrying', {
          label,
          status,
          backoffMs: Math.round(backoffMs),
        });
        await sleep(backoffMs);
        continue;
      }

      if (status === undefined && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        valuationLogWarn(logPrefix, 'OpenAI network/timeout error, retrying', {
          label,
          message: lastError.message,
          backoffMs: Math.round(backoffMs),
        });
        await sleep(backoffMs);
        continue;
      }

      throw lastError;
    }

    const totalMs = Math.round(performance.now() - startedAt);
    const actualModel = result.response?.modelId || requestedModel;
    const usage = result.usage;
    const normalized: OpenAIResponseUsage = {
      input_tokens: readTokenCount(usage.inputTokens),
      input_tokens_details: { cached_tokens: readTokenCount(usage.cachedInputTokens) },
      output_tokens: readTokenCount(usage.outputTokens),
      output_tokens_details: { reasoning_tokens: readTokenCount(usage.reasoningTokens) },
      total_tokens:
        readTokenCount(usage.totalTokens) || readTokenCount(usage.inputTokens) + readTokenCount(usage.outputTokens),
    };
    const cost = calculateOpenAICost(actualModel, normalized);
    recordOpenAICost(logPrefix, cost);
    valuationLogInfo(logPrefix, 'OpenAI response parsed', {
      label,
      model: actualModel,
      finishReason: result.finishReason,
      inputTokens: normalized.input_tokens,
      outputTokens: normalized.output_tokens,
      reasoningTokens: normalized.output_tokens_details?.reasoning_tokens,
      pricingMatched: Boolean(cost),
      costUsd: cost?.costUsd,
      totalMs,
    });

    const text = result.text;
    if (typeof text !== 'string' || text.length === 0) {
      throw new Error('No output text in OpenAI response');
    }
    return text;
  }

  throw lastError ?? new Error('OpenAI request failed');
}

function parseNumberVariants(text: string): string[] {
  const parsed = JSON.parse(text) as { t?: unknown };
  if (!Array.isArray(parsed.t)) {
    throw new Error('OpenAI number variant response JSON missing t array');
  }

  return parsed.t.filter((name): name is string => typeof name === 'string');
}

function createNameResearchErrorEvidence(label: string, error: unknown): ValuationNameResearchEvidence {
  return {
    source: 'openai_web_search',
    model: getChannelModel('name_research').model,
    dataStatus: 'error',
    generatedAt: new Date().toISOString(),
    label,
    categories: [],
    senses: [],
    meanings: [],
    error: {
      message: error instanceof Error ? error.message : 'Unknown name research error',
    },
  };
}

function createAppraisalErrorEvidence(error: unknown): ValuationAppraisalEvidence {
  return {
    source: 'openai_full_evidence_appraisal',
    model: getChannelModel('appraisal').model,
    dataStatus: 'error',
    generatedAt: new Date().toISOString(),
    ethValue: '0',
    lowEth: '0',
    highEth: '0',
    reasoning: '',
    signals: [],
    cautions: [],
    compsUsed: [],
    error: {
      message: error instanceof Error ? error.message : 'Unknown appraisal error',
    },
  };
}

function parseNameResearch(
  text: string,
  maxResearchSenses: number
): Pick<ValuationNameResearchEvidence, 'label' | 'categories' | 'senses' | 'meanings'> {
  const parsed = JSON.parse(text) as { label?: unknown; categories?: unknown; senses?: unknown };

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAI name research response JSON must be an object');
  }

  if (typeof parsed.label !== 'string' || !Array.isArray(parsed.categories) || !Array.isArray(parsed.senses)) {
    throw new Error('OpenAI name research response JSON missing required fields');
  }

  const senses = parsed.senses
    .map((entry): ValuationResearchSense | null => {
      const sense = (entry as { sense?: unknown }).sense;
      const score = (entry as { demandScore?: unknown }).demandScore;
      if (typeof sense !== 'string' || !sense.trim()) return null;
      const demandScore = Math.max(
        1,
        Math.min(5, Math.round(typeof score === 'number' && Number.isFinite(score) ? score : 1))
      );
      return { sense: sense.trim(), demandScore };
    })
    .filter((entry): entry is ValuationResearchSense => entry !== null)
    .slice(0, maxResearchSenses);

  return {
    label: parsed.label,
    categories: parsed.categories.filter((category): category is string => typeof category === 'string'),
    senses,
    meanings: senses.map((entry) => entry.sense),
  };
}

// The appraisal channel runs in json_object mode (the production models don't
// honor strict json_schema), so the schema is only suggested in the prompt.
// Validate + default here: ethValue is required, everything else defaults so a
// response missing cautions/compsUsed/lowEth can't crash result assembly.
const AppraisalResponseSchema = z.object({
  ethValue: z.string(),
  lowEth: z.string().optional().default('0'),
  highEth: z.string().optional().default('0'),
  reasoning: z.string().optional().default(''),
  signals: z.array(z.string()).optional().default([]),
  cautions: z.array(z.string()).optional().default([]),
  compsUsed: z
    .array(z.object({ name: z.string(), priceEth: z.string(), date: z.string() }))
    .optional()
    .default([]),
});

function parseAppraisal(
  text: string
): Omit<ValuationAppraisalEvidence, 'source' | 'model' | 'dataStatus' | 'generatedAt'> {
  const result = AppraisalResponseSchema.safeParse(JSON.parse(text));
  if (!result.success) {
    throw new Error(
      `OpenAI appraisal response failed validation: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`
    );
  }
  return result.data;
}

function weiToEthString(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;

  try {
    const wei = BigInt(String(value));
    const weiPerEth = BigInt(10) ** BigInt(18);
    const roundedMilliEth = (wei * BigInt(1000) + weiPerEth / BigInt(2)) / weiPerEth;
    const whole = roundedMilliEth / BigInt(1000);
    const fractional = roundedMilliEth % BigInt(1000);
    if (fractional === BigInt(0)) return whole.toString();
    return `${whole}.${fractional.toString().padStart(3, '0').replace(/0+$/, '')}`;
  } catch {
    return null;
  }
}

function compactActivityRow(
  activity: {
    name: string;
    price_wei: string | null;
    created_at: string;
    clubs: string[] | null;
    metadata?: Record<string, unknown>;
  },
  termSenses?: Record<string, number[]>
) {
  const senses = termSenses?.[activity.name.replace(/\.eth$/i, '').toLowerCase()];
  return {
    name: activity.name,
    priceEth: weiToEthString((activity.metadata?.total_cost_wei as string | undefined) ?? activity.price_wei),
    premiumEth: weiToEthString(activity.metadata?.premium_wei as string | undefined),
    date: activity.created_at,
    clubs: activity.clubs ?? [],
    ...(senses && senses.length > 0 ? { senses } : {}),
  };
}

function compactMarketActivitySummary(evidence: ValuationEvidence['marketActivity']) {
  const { salesFloorWei, premiumRegistrationFloorWei, ...summary } = evidence.summary;

  return {
    ...summary,
    salesFloorEth: weiToEthString(salesFloorWei),
    premiumRegistrationFloorEth: weiToEthString(premiumRegistrationFloorWei),
  };
}

// Comparable sales can run to the hundreds for liquid related terms (50/term ×
// many terms). The list is sorted by price descending, so cap the appraisal input
// at the top N to bound prompt token cost; report how many were dropped.
const MAX_APPRAISAL_TOP_SALES = 25;

function compactMarketActivity(
  evidence: ValuationEvidence['marketActivity'],
  termSenses?: Record<string, number[]>
) {
  const salesTruncated = Math.max(0, evidence.sales.length - MAX_APPRAISAL_TOP_SALES);
  return {
    summary: { ...compactMarketActivitySummary(evidence), salesTruncated },
    topSales: evidence.sales
      .slice(0, MAX_APPRAISAL_TOP_SALES)
      .map((sale) => compactActivityRow(sale, termSenses)),
    topMintEvents: evidence.mintEvents.slice(0, 10).map((mint) => compactActivityRow(mint, termSenses)),
    topPremiumRegistrations: evidence.premiumRegistrations
      .slice(0, 10)
      .map((registration) => compactActivityRow(registration, termSenses)),
    errorsSummary: {
      count: evidence.errors.length,
      rateLimited: evidence.summary.rateLimited,
      sample: evidence.errors.slice(0, 3).map((error) => ({
        term: error.term,
        status: error.status,
        message: error.message,
      })),
    },
  };
}

function compactWeb2Evidence(evidence: ValuationEvidence['web2']) {
  return {
    summary: evidence.summary,
  };
}

function compactSearchDemand(evidence: ValuationEvidence['searchDemand']) {
  return {
    source: evidence.source,
    keyword: evidence.keyword,
    dataStatus: evidence.dataStatus,
    note: evidence.note,
    summary: evidence.summary,
  };
}

function compactNameResearch(evidence: ValuationEvidence['nameResearch']) {
  return {
    dataStatus: evidence.dataStatus,
    label: evidence.label,
    categories: evidence.categories,
    senses: evidence.senses,
    error: evidence.error,
  };
}

function compactCategoryMarketActivity(evidence: ValuationEvidence['categoryMarketActivity']) {
  return {
    source: evidence.source,
    scope: evidence.scope,
    note: evidence.note,
    summary: evidence.summary,
    skippedCategories: evidence.skippedCategories,
    categories: evidence.categories.map((category) => ({
      slug: category.slug,
      eventsFound: category.eventsFound,
      salesFound: category.salesFound,
      mintEventsFound: category.mintEventsFound,
      targetNameEventsExcluded: category.targetNameEventsExcluded,
      sales: category.sales.slice(0, 20).map((sale) => compactActivityRow(sale)),
      mintEvents: category.mintEvents.slice(0, 5).map((mint) => compactActivityRow(mint)),
      errorsSummary: {
        count: category.errors.length,
        sample: category.errors.slice(0, 2).map((error) => ({
          status: error.status,
          message: error.message,
        })),
      },
    })),
  };
}

function buildAppraisalEvidenceInput(evidence: Omit<ValuationEvidence, 'appraisal'>) {
  return {
    marketActivity: compactMarketActivity(evidence.marketActivity, evidence.relatedTerms.termSenses),
    web2: compactWeb2Evidence(evidence.web2),
    searchDemand: compactSearchDemand(evidence.searchDemand),
    nameResearch: compactNameResearch(evidence.nameResearch),
    categoryContext: evidence.categoryContext,
    categoryMarketActivity: compactCategoryMarketActivity(evidence.categoryMarketActivity),
    calibrationContext: evidence.calibrationContext,
  };
}

async function generateNumberVariants(terms: string[], options: { logPrefix?: string }): Promise<string[]> {
  const logPrefix = options.logPrefix || '[valuation]';
  const channel = getChannelModel('number_variants');
  const channelModel = channel.model;
  const instructions = await renderValuationPrompt('number_variants');
  valuationLogInfo(logPrefix, 'OpenAI number variants request prepared', {
    model: channelModel,
    reasoningEffort: channel.reasoningEffort,
    inputTerms: terms.length,
    usesJsonSchema: true,
  });

  const body = JSON.stringify({
    model: channelModel,
    instructions,
    input: JSON.stringify(terms),
    max_output_tokens: Math.max(8000, Math.min(16000, terms.length * 60)),
    store: true,
    ...(channel.temperature !== undefined ? { temperature: channel.temperature } : {}),
    reasoning: {
      effort: channel.reasoningEffort,
    },
    text: {
      format: {
        type: 'json_schema',
        name: 'number_variants',
        strict: true,
        schema: NUMBER_VARIANTS_SCHEMA,
      },
    },
  });

  const text = await callOpenAIRaw(body, 'number_variants', logPrefix);
  valuationLogInfo(logPrefix, 'OpenAI number variant output text received', { textLength: text.length });
  const generated = parseNumberVariants(text);
  valuationLogInfo(logPrefix, 'OpenAI number variants parsed', {
    rawCount: generated.length,
    sample: generated.slice(0, 10),
  });

  const originalTerms = new Set(terms);
  const variants = dedupeNormalizedLabels(generated).filter((term) => !originalTerms.has(term));
  valuationLogInfo(logPrefix, 'OpenAI number variants normalized', {
    normalizedCount: variants.length,
    removedCount: Math.max(generated.length - variants.length, 0),
    sample: variants.slice(0, 10),
  });

  return variants;
}

export async function generateNameResearch(
  label: string,
  options: { logPrefix?: string; maxResearchSenses: number }
): Promise<ValuationNameResearchEvidence> {
  const logPrefix = options.logPrefix || '[valuation]';
  const startedAt = performance.now();
  const channel = getChannelModel('name_research');
  const channelModel = channel.model;
  valuationLogInfo(logPrefix, 'OpenAI name research request prepared', {
    label,
    model: channelModel,
    reasoningEffort: channel.reasoningEffort,
    usesWebSearch: true,
  });

  try {
    const input = await renderValuationPrompt('name_research', { label: JSON.stringify(label) });
    const body = JSON.stringify({
      model: channelModel,
      input,
      max_output_tokens: 16000,
      store: true,
      ...(channel.temperature !== undefined ? { temperature: channel.temperature } : {}),
      reasoning: {
        effort: channel.reasoningEffort,
      },
      tools: [{ type: 'web_search' }],
      text: {
        format: {
          type: 'json_schema',
          name: 'term_research',
          strict: false,
          schema: NAME_RESEARCH_SCHEMA,
        },
      },
    });

    const text = await callOpenAIRaw(body, `name_research:${label}`, logPrefix);
    valuationLogInfo(logPrefix, 'OpenAI name research output text received', {
      label,
      textLength: text.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    const parsed = parseNameResearch(text, options.maxResearchSenses);
    const evidence: ValuationNameResearchEvidence = {
      source: 'openai_web_search',
      model: channelModel,
      dataStatus: 'available',
      generatedAt: new Date().toISOString(),
      ...parsed,
    };
    valuationLogInfo(logPrefix, 'OpenAI name research parsed', {
      label,
      categories: evidence.categories,
      meaningsCount: evidence.meanings.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return evidence;
  } catch (error) {
    valuationLogWarn(logPrefix, 'OpenAI name research failed, returning error evidence', {
      label,
      error: error instanceof Error ? error.message : error,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return createNameResearchErrorEvidence(label, error);
  }
}

export async function generateAppraisal(
  name: string,
  evidence: Omit<ValuationEvidence, 'appraisal'>,
  options: { logPrefix?: string } = {}
): Promise<ValuationAppraisalEvidence> {
  const logPrefix = options.logPrefix || '[valuation]';
  const startedAt = performance.now();
  const channel = getChannelModel('appraisal');
  const channelModel = channel.model;
  const appraisalEvidence = buildAppraisalEvidenceInput(evidence);
  valuationLogInfo(logPrefix, 'OpenAI appraisal request prepared', {
    name,
    model: channelModel,
    reasoningEffort: channel.reasoningEffort,
    usesJsonSchema: true,
    evidenceBytes: JSON.stringify(appraisalEvidence).length,
    relatedTermsOmitted: true,
    compactEvidence: true,
  });

  try {
    const instructions = await renderValuationPrompt('appraisal', { name: JSON.stringify(`${name}.eth`) });
    const body = JSON.stringify({
      model: channelModel,
      instructions,
      input: JSON.stringify({ name: `${name}.eth`, evidence: appraisalEvidence }),
      max_output_tokens: 8000,
      store: true,
      ...(channel.temperature !== undefined ? { temperature: channel.temperature } : {}),
      reasoning: {
        effort: channel.reasoningEffort,
      },
      text: {
        format: {
          type: 'json_schema',
          name: 'ens_valuation_appraisal',
          strict: true,
          schema: APPRAISAL_SCHEMA,
        },
      },
    });

    const text = await callOpenAIRaw(body, `appraisal:${name}`, logPrefix);
    valuationLogInfo(logPrefix, 'OpenAI appraisal output text received', {
      name,
      textLength: text.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    const parsed = parseAppraisal(text);
    const appraisal: ValuationAppraisalEvidence = {
      source: 'openai_full_evidence_appraisal',
      model: channelModel,
      dataStatus: 'available',
      generatedAt: new Date().toISOString(),
      ...parsed,
    };
    valuationLogInfo(logPrefix, 'OpenAI appraisal parsed', {
      name,
      ethValue: appraisal.ethValue,
      lowEth: appraisal.lowEth,
      highEth: appraisal.highEth,
      signalsCount: appraisal.signals.length,
      cautionsCount: appraisal.cautions.length,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return appraisal;
  } catch (error) {
    valuationLogWarn(logPrefix, 'OpenAI appraisal failed, returning error evidence', {
      name,
      error: error instanceof Error ? error.message : error,
      elapsedMs: Math.round(performance.now() - startedAt),
    });
    return createAppraisalErrorEvidence(error);
  }
}

// Generates the per-sense scoped terms for one research sense. Returns compacted
// ENS labels (deduped within the sense); errors are captured, not thrown.
async function generateScopedSenseTerms(
  name: string,
  sense: ValuationResearchSense,
  senseIdx: number,
  options: { logPrefix: string; termCountsByScore: Record<string, number> }
): Promise<ValuationSenseTerms> {
  const channel = getChannelModel('related_terms');
  const requested = scopedTermCountForScore(sense.demandScore, options.termCountsByScore);

  try {
    const instructions = await renderValuationPrompt('scoped_terms', { count: String(requested) });
    const body = JSON.stringify({
      model: channel.model,
      instructions,
      input: `${name}\n\nSense: ${sense.sense}`,
      max_output_tokens: 8000,
      store: true,
      ...(channel.temperature !== undefined ? { temperature: channel.temperature } : {}),
      reasoning: {
        effort: channel.reasoningEffort,
      },
      text: {
        format: {
          type: 'json_schema',
          name: 'similar_names',
          strict: true,
          schema: SCOPED_TERMS_SCHEMA,
        },
      },
    });

    const text = await callOpenAIRaw(body, `related_terms:${name}:s${senseIdx}`, options.logPrefix);
    const parsed = JSON.parse(text) as { names?: unknown };
    if (!Array.isArray(parsed.names)) {
      throw new Error('scoped related-terms response JSON missing names array');
    }
    const raw = parsed.names.filter((value): value is string => typeof value === 'string');
    const seen = new Set<string>();
    const terms: string[] = [];
    for (const value of raw) {
      const compacted = compactEnsLabel(value);
      if (!compacted || seen.has(compacted)) continue;
      seen.add(compacted);
      terms.push(compacted);
    }
    return {
      senseIdx,
      sense: sense.sense,
      demandScore: sense.demandScore,
      requested,
      returned: raw.length,
      terms,
    };
  } catch (error) {
    valuationLogWarn(options.logPrefix, 'scoped sense terms generation failed; sense contributes no terms', {
      name,
      senseIdx,
      sense: sense.sense,
      error: error instanceof Error ? error.message : error,
    });
    return {
      senseIdx,
      sense: sense.sense,
      demandScore: sense.demandScore,
      requested,
      returned: 0,
      terms: [],
      error: error instanceof Error ? error.message : 'Unknown scoped terms error',
    };
  }
}

export async function generateRelatedTerms(
  rawName: string,
  senses: ValuationResearchSense[],
  options: {
    logPrefix?: string;
    termCountsByScore: Record<string, number>;
    maxResearchSenses: number;
  }
): Promise<ValuationRelatedTermsEvidence> {
  const name = normalizeValuationLabel(rawName);
  if (!name) {
    throw new Error('Invalid valuation name');
  }

  const logPrefix = options.logPrefix || '[valuation]';
  const channel = getChannelModel('related_terms');
  const cappedSenses = senses.slice(0, options.maxResearchSenses);

  if (cappedSenses.length === 0) {
    valuationLogWarn(logPrefix, 'no research senses available; related terms limited to the name itself', { name });
  }

  valuationLogInfo(logPrefix, 'scoped related-terms generation prepared', {
    name,
    model: channel.model,
    senseCount: cappedSenses.length,
    requestedPerSense: cappedSenses.map((sense) => scopedTermCountForScore(sense.demandScore, options.termCountsByScore)),
  });

  // One scoped generation per sense, in parallel. A failed sense must not fail
  // the valuation — it just contributes no terms (recorded in perSense.error).
  const perSense: ValuationSenseTerms[] = await Promise.all(
    cappedSenses.map((sense, senseIdx) =>
      generateScopedSenseTerms(name, sense, senseIdx, {
        logPrefix,
        termCountsByScore: options.termCountsByScore,
      })
    )
  );

  // Sense-tagged union: preserve sense order (highest demand first), compact each
  // raw term into an ENS label, track which senses produced each term.
  const senseIdxsByTerm = new Map<string, Set<number>>();
  for (const senseResult of perSense) {
    for (const compacted of senseResult.terms) {
      if (compacted === name) continue;
      const indices = senseIdxsByTerm.get(compacted) ?? new Set<number>();
      indices.add(senseResult.senseIdx);
      senseIdxsByTerm.set(compacted, indices);
    }
  }
  const termSenses: Record<string, number[]> = {};
  for (const [term, indices] of senseIdxsByTerm) {
    termSenses[term] = [...indices].sort((a, b) => a - b);
  }

  const baseTerms = dedupeNormalizedLabels([name, ...senseIdxsByTerm.keys()]);
  valuationLogInfo(logPrefix, 'scoped related terms normalized', {
    name,
    senseCount: cappedSenses.length,
    sensesWithErrors: perSense.filter((senseResult) => senseResult.error).length,
    baseTermCount: baseTerms.length,
    multiSenseTerms: Object.values(termSenses).filter((indices) => indices.length > 1).length,
    sample: baseTerms.slice(0, 10),
  });

  // Number-variant expansion is supplementary; a failure must not fail the run.
  let numberVariants: string[] = [];
  try {
    numberVariants = await generateNumberVariants(baseTerms, { logPrefix });
  } catch (error) {
    valuationLogWarn(logPrefix, 'number variants generation failed; continuing with base terms only', {
      error: error instanceof Error ? error.message : error,
    });
  }
  const terms = dedupeNormalizedLabels([...baseTerms, ...numberVariants]);
  valuationLogInfo(logPrefix, 'related terms expanded with number variants', {
    baseTermCount: baseTerms.length,
    numberVariantCount: numberVariants.length,
    validCount: terms.length,
    sample: terms.slice(0, 10),
  });

  return {
    source: 'ai_scoped_senses',
    model: channel.model,
    senseCount: cappedSenses.length,
    perSense,
    termSenses,
    baseTermCount: baseTerms.length,
    numberVariantCount: numberVariants.length,
    validCount: terms.length,
    baseTerms,
    numberVariants,
    terms,
  };
}
