import type { ModelMessage } from 'ai';
import type { OpenRouterUsageAccounting } from '@openrouter/ai-sdk-provider';

/**
 * Pure transport-mapping helpers for the valuation LLM engine's OpenRouter path.
 *
 * These translate between the OpenAI-Responses-style request body the engine
 * builds and the Vercel AI SDK call surface, and map OpenRouter's usage object
 * back into the OpenAI-shaped usage the cost helpers consume. They are kept in a
 * dedicated, dependency-free module (type-only imports) so the byte-sensitive
 * behavior can be unit-tested in isolation, without pulling in the engine's DB /
 * config / network dependencies.
 */

// OpenAI Responses API usage shape — also the normalized target the OpenRouter
// usage object is mapped into, so the same cost code can consume both providers.
export type OpenAIResponseUsage = {
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

export type OpenRouterProviderRouting = {
  order?: string[];
  allowFallbacks?: boolean;
  structuredOutputs?: boolean;
};

// Message + SDK call args + the raw OpenRouter body extras that ride on extraBody.
// The AI SDK serializes `{ model, messages, max_tokens, temperature, ...extraBody }`,
// so packing usage/reasoning/response_format/provider/plugins into extraBody makes
// the outbound body field-for-field equivalent to the old hand-built JSON body.
export type OpenRouterRequest = {
  model: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  extraBody: Record<string, unknown>;
};

// Structural view of the AI SDK's normalized usage (used only as a fallback).
export type SdkUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cachedInputTokens?: number;
};

export function readTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildOpenRouterRequest(responsesBody: string, routing?: OpenRouterProviderRouting): OpenRouterRequest {
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

  const messages: ModelMessage[] = [];
  if (systemParts.length > 0) {
    messages.push({ role: 'system', content: systemParts.join('\n\n') });
  }
  const userContent = typeof parsed.input === 'string' ? parsed.input : JSON.stringify(parsed.input ?? '');
  messages.push({ role: 'user', content: userContent });

  // Everything the AI SDK doesn't model as a first-class call option is forwarded
  // verbatim through extraBody (snake_case, exactly as OpenRouter's API expects).
  const extraBody: Record<string, unknown> = {
    usage: { include: true },
  };

  const effort = parsed.reasoning?.effort;
  const reasoningMaxTokens = parsed.reasoning?.max_tokens;
  // A bounded reasoning budget takes precedence; otherwise pass through an
  // explicit effort level, or disable reasoning entirely on effort 'none' (the
  // production models all reason by default and would otherwise burn the token
  // budget). If a model that mandates reasoning is reintroduced, it must omit
  // this disable instead of 400-ing.
  if (typeof reasoningMaxTokens === 'number') {
    extraBody.reasoning = { max_tokens: reasoningMaxTokens };
  } else if (typeof effort === 'string' && effort !== 'none') {
    extraBody.reasoning = { effort };
  } else {
    extraBody.reasoning = { enabled: false };
  }

  const providerOptions: Record<string, unknown> = {};

  if (hasJsonSchema) {
    extraBody.response_format = useJsonObjectMode
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
    extraBody.provider = providerOptions;
  }

  const hasWebSearch = Array.isArray(parsed.tools) && parsed.tools.some((tool) => tool?.type === 'web_search');
  if (hasWebSearch) {
    extraBody.plugins = [{ id: 'web', max_results: 5 }];
  }

  return {
    model: typeof parsed.model === 'string' ? parsed.model : '',
    messages,
    ...(typeof parsed.max_output_tokens === 'number' ? { maxOutputTokens: parsed.max_output_tokens } : {}),
    ...(typeof parsed.temperature === 'number' ? { temperature: parsed.temperature } : {}),
    extraBody,
  };
}

// Maps the OpenRouter usage object (read from providerMetadata.openrouter.usage,
// with the AI SDK's normalized usage as a fallback) into the OpenAI-shaped usage
// the cost helpers consume. The token split + reported cost live in
// providerMetadata — the normalized result.usage often leaves cached/reasoning
// tokens undefined — so this mirrors the old normalizeOpenRouterUsage exactly.
export function normalizeOpenRouterUsage(
  usage: OpenRouterUsageAccounting | undefined,
  sdkUsage: SdkUsage
): { normalized: OpenAIResponseUsage; reportedCostUsd: number | null } {
  const promptTokens = readTokenCount(usage?.promptTokens ?? sdkUsage.inputTokens);
  const completionTokens = readTokenCount(usage?.completionTokens ?? sdkUsage.outputTokens);

  return {
    normalized: {
      input_tokens: promptTokens,
      input_tokens_details: {
        cached_tokens: readTokenCount(usage?.promptTokensDetails?.cachedTokens ?? sdkUsage.cachedInputTokens),
      },
      output_tokens: completionTokens,
      output_tokens_details: {
        reasoning_tokens: readTokenCount(usage?.completionTokensDetails?.reasoningTokens ?? sdkUsage.reasoningTokens),
      },
      total_tokens: readTokenCount(usage?.totalTokens ?? sdkUsage.totalTokens) || promptTokens + completionTokens,
    },
    reportedCostUsd: typeof usage?.cost === 'number' ? usage.cost : null,
  };
}
