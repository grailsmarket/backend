import { config } from '../../../../shared/src';
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
 */

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const VALUATION_OPENAI_MODEL = 'gpt-5.5';

const MAX_RETRIES = 3;
const TOKENS_PER_MILLION = 1_000_000;
const MAX_OPENAI_COST_SUMMARIES = 100;

type OpenAIModelPricing = {
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
};

type OpenAIResponseUsage = {
  input_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens?: number;
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  total_tokens?: number;
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

type OpenRouterProviderRouting = {
  order?: string[];
  allowFallbacks?: boolean;
  structuredOutputs?: boolean;
};

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

function readTokenCount(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
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

function extractOutputText(data: any): string {
  const messageItem = data.output?.find((item: { type: string }) => item.type === 'message');
  const text = messageItem?.content?.find((content: { type: string }) => content.type === 'output_text')?.text;

  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('No output text in OpenAI response');
  }

  return text;
}

function buildOpenRouterBody(responsesBody: string, routing?: OpenRouterProviderRouting): string {
  const parsed = JSON.parse(responsesBody) as {
    model?: unknown;
    instructions?: unknown;
    input?: unknown;
    max_output_tokens?: unknown;
    temperature?: unknown;
    reasoning?: { effort?: unknown; max_tokens?: unknown };
    text?: { format?: { type?: unknown; name?: unknown; strict?: unknown; schema?: unknown } };
    tools?: Array<{ type?: unknown }>;
  };

  const format = parsed.text?.format;
  const hasJsonSchema = format?.type === 'json_schema';
  // Downgrade to json_object mode when the pinned provider can't do strict
  // json_schema (e.g. DeepSeek). Inject the schema into the prompt instead.
  const useJsonObjectMode = hasJsonSchema && routing?.structuredOutputs === false;

  const systemParts: string[] = [];
  if (typeof parsed.instructions === 'string' && parsed.instructions.length > 0) {
    systemParts.push(parsed.instructions);
  }
  if (useJsonObjectMode) {
    systemParts.push(
      `Respond with ONLY a single JSON object (no markdown, no prose) that strictly conforms to this JSON schema:\n${JSON.stringify(format?.schema)}`
    );
  }

  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }
  const userContent = typeof parsed.input === 'string' ? parsed.input : JSON.stringify(parsed.input ?? '');
  messages.push({ role: 'user', content: userContent });

  const out: Record<string, unknown> = {
    model: parsed.model,
    messages,
    usage: { include: true },
  };

  if (typeof parsed.max_output_tokens === 'number') {
    out.max_tokens = parsed.max_output_tokens;
  }

  if (typeof parsed.temperature === 'number') {
    out.temperature = parsed.temperature;
  }

  const effort = parsed.reasoning?.effort;
  const reasoningMaxTokens = parsed.reasoning?.max_tokens;
  // A bounded reasoning budget takes precedence; otherwise pass through an
  // explicit effort level, or disable reasoning entirely on effort 'none' (the
  // production models all reason by default and would otherwise burn the token
  // budget). If a model that mandates reasoning is reintroduced, it must omit
  // this disable instead of 400-ing.
  if (typeof reasoningMaxTokens === 'number') {
    out.reasoning = { max_tokens: reasoningMaxTokens };
  } else if (typeof effort === 'string' && effort !== 'none') {
    out.reasoning = { effort };
  } else {
    out.reasoning = { enabled: false };
  }

  const providerOptions: Record<string, unknown> = {};

  if (hasJsonSchema) {
    out.response_format = useJsonObjectMode
      ? { type: 'json_object' }
      : {
          type: 'json_schema',
          json_schema: {
            name: typeof format?.name === 'string' ? format.name : 'structured_output',
            strict: Boolean(format?.strict),
            schema: format?.schema,
          },
        };
    providerOptions.require_parameters = true;
  }

  if (routing?.order && routing.order.length > 0) {
    providerOptions.order = routing.order;
    providerOptions.allow_fallbacks = routing.allowFallbacks ?? false;
  }

  if (Object.keys(providerOptions).length > 0) {
    out.provider = providerOptions;
  }

  const hasWebSearch = Array.isArray(parsed.tools) && parsed.tools.some((tool) => tool?.type === 'web_search');
  if (hasWebSearch) {
    out.plugins = [{ id: 'web', max_results: 5 }];
  }

  return JSON.stringify(out);
}

type OpenRouterUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
  cost?: number;
};

function normalizeOpenRouterUsage(usage: OpenRouterUsage | undefined): {
  normalized: OpenAIResponseUsage;
  reportedCostUsd: number | null;
} {
  const promptTokens = readTokenCount(usage?.prompt_tokens);
  const completionTokens = readTokenCount(usage?.completion_tokens);

  return {
    normalized: {
      input_tokens: promptTokens,
      input_tokens_details: { cached_tokens: readTokenCount(usage?.prompt_tokens_details?.cached_tokens) },
      output_tokens: completionTokens,
      output_tokens_details: { reasoning_tokens: readTokenCount(usage?.completion_tokens_details?.reasoning_tokens) },
      total_tokens: readTokenCount(usage?.total_tokens) || promptTokens + completionTokens,
    },
    reportedCostUsd: typeof usage?.cost === 'number' ? usage.cost : null,
  };
}

function extractOpenRouterText(data: any): string {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content !== 'string' || content.length === 0) {
    const finishReason = choice?.finish_reason ?? 'unknown';
    throw new Error(
      `No content in OpenRouter response (finish_reason: ${finishReason}; likely reasoning consumed the token budget)`
    );
  }

  return content;
}

async function callOpenRouterChat(responsesBody: string, label: string, logPrefix: string): Promise<string> {
  const apiKey = config.valuation.openrouterApiKey;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }

  const requestedModel = readRequestedOpenAIModel(responsesBody);
  const body = buildOpenRouterBody(responsesBody, OPENROUTER_PROVIDER_ROUTING[requestedModel]);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = performance.now();
    valuationLogInfo(logPrefix, 'OpenRouter request start', {
      label,
      model: requestedModel,
      attempt: attempt + 1,
      maxAttempts: MAX_RETRIES + 1,
    });
    const response = await fetch(OPENROUTER_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://grails.app',
        'X-Title': 'Grails Valuation',
      },
      body,
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    valuationLogInfo(logPrefix, 'OpenRouter response received', {
      label,
      attempt: attempt + 1,
      status: response.status,
      elapsedMs,
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      valuationLogWarn(logPrefix, 'OpenRouter rate limited, retrying', { label, backoffMs: Math.round(backoffMs) });
      await sleep(backoffMs);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      lastError = new Error(`OpenRouter HTTP ${response.status}: ${errorText}`);

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        valuationLogWarn(logPrefix, 'OpenRouter server error, retrying', {
          label,
          status: response.status,
          backoffMs: Math.round(backoffMs),
        });
        await sleep(backoffMs);
        continue;
      }

      throw lastError;
    }

    const data: any = await response.json();
    const totalMs = Math.round(performance.now() - startedAt);
    const model = typeof data.model === 'string' ? data.model : requestedModel;
    const { normalized, reportedCostUsd } = normalizeOpenRouterUsage(data.usage as OpenRouterUsage | undefined);
    const cost = calculateOpenAICost(model, normalized);
    // Prefer OpenRouter's reported cost (includes web-search/plugin fees and the
    // real provider rate) over our static token estimate.
    if (cost && reportedCostUsd != null) {
      cost.costUsd = formatUsd(reportedCostUsd);
    }
    recordOpenAICost(logPrefix, cost);
    valuationLogInfo(logPrefix, 'OpenRouter response parsed', {
      label,
      model,
      finishReason: data.choices?.[0]?.finish_reason,
      inputTokens: normalized.input_tokens,
      outputTokens: normalized.output_tokens,
      reportedCostUsd,
      pricingMatched: Boolean(cost),
      ttfbMs: elapsedMs,
      totalMs,
    });

    return extractOpenRouterText(data);
  }

  throw lastError ?? new Error('OpenRouter request failed');
}

async function callOpenAIRaw(body: string, label: string, logPrefix = '[valuation/openai]'): Promise<string> {
  if (getChannelModel(getOpenAICostStep(label)).provider === 'openrouter') {
    return callOpenRouterChat(body, label, logPrefix);
  }

  const apiKey = config.openai.apiKey;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  let lastError: Error | null = null;
  const requestedModel = readRequestedOpenAIModel(body);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const startedAt = performance.now();
    valuationLogInfo(logPrefix, 'OpenAI request start', {
      label,
      model: requestedModel,
      attempt: attempt + 1,
      maxAttempts: MAX_RETRIES + 1,
    });
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    const elapsedMs = Math.round(performance.now() - startedAt);
    valuationLogInfo(logPrefix, 'OpenAI response received', {
      label,
      attempt: attempt + 1,
      status: response.status,
      elapsedMs,
    });

    if (response.status === 429 && attempt < MAX_RETRIES) {
      const resetMs = parseResetHeader(response.headers.get('x-ratelimit-reset-requests'));
      const backoffMs = resetMs ?? 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      valuationLogWarn(logPrefix, 'OpenAI rate limited, retrying', { label, backoffMs: Math.round(backoffMs) });
      await sleep(backoffMs);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      lastError = new Error(`OpenAI HTTP ${response.status}: ${errorText}`);

      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        valuationLogWarn(logPrefix, 'OpenAI server error, retrying', {
          label,
          status: response.status,
          backoffMs: Math.round(backoffMs),
        });
        await sleep(backoffMs);
        continue;
      }

      throw lastError;
    }

    const data: any = await response.json();
    const totalMs = Math.round(performance.now() - startedAt);
    const model = typeof data.model === 'string' ? data.model : requestedModel;
    const usage = data.usage as OpenAIResponseUsage | undefined;
    const cost = calculateOpenAICost(model, usage);
    recordOpenAICost(logPrefix, cost);
    valuationLogInfo(logPrefix, 'OpenAI response parsed', {
      label,
      model,
      status: data.status,
      inputTokens: usage?.input_tokens,
      outputTokens: usage?.output_tokens,
      reasoningTokens: usage?.output_tokens_details?.reasoning_tokens,
      pricingMatched: Boolean(cost),
      costUsd: cost?.costUsd,
      ttfbMs: elapsedMs,
      totalMs,
    });
    if (data.status !== 'completed' && data.status !== 'incomplete') {
      throw new Error(`OpenAI response status: ${data.status}`);
    }

    return extractOutputText(data);
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

function parseAppraisal(
  text: string
): Omit<ValuationAppraisalEvidence, 'source' | 'model' | 'dataStatus' | 'generatedAt'> {
  const parsed = JSON.parse(text) as Omit<ValuationAppraisalEvidence, 'source' | 'model' | 'dataStatus' | 'generatedAt'>;

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('OpenAI appraisal response JSON must be an object');
  }

  if (typeof parsed.ethValue !== 'string' || !Array.isArray(parsed.signals)) {
    throw new Error('OpenAI appraisal response JSON missing required fields');
  }

  return parsed;
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

function compactMarketActivity(
  evidence: ValuationEvidence['marketActivity'],
  termSenses?: Record<string, number[]>
) {
  return {
    summary: compactMarketActivitySummary(evidence),
    topSales: evidence.sales.map((sale) => compactActivityRow(sale, termSenses)),
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
