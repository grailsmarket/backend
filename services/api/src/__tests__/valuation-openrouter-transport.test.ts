/**
 * Parity tests for the valuation engine's OpenRouter transport after the
 * migration from raw fetch to the Vercel AI SDK (`@openrouter/ai-sdk-provider`).
 *
 * The migration keeps every observable behavior identical and only swaps the
 * transport. The two pieces that carry the byte-sensitive risk are pure and are
 * exercised directly here (no network, no DB, no live API keys):
 *
 *  - `buildOpenRouterRequest`: turns the OpenAI-Responses-style body the engine
 *    builds into the SDK call args + the `extraBody` that the AI SDK forwards
 *    verbatim to OpenRouter. This must reproduce the old hand-built body:
 *    provider pinning, the reasoning ladder (incl. disable-on-'none'), the
 *    json_schema -> json_object downgrade with the schema injected into a system
 *    message, the web plugin, and usage accounting.
 *  - `normalizeOpenRouterUsage`: recovers the token split + reported cost from
 *    OpenRouter's usage object (read from providerMetadata, with the normalized
 *    SDK usage only as a fallback) into the OpenAI-shaped usage the cost helpers
 *    consume — preserving the "reported cost wins" behavior.
 */

import { describe, it, expect } from 'vitest';
import { buildOpenRouterRequest, normalizeOpenRouterUsage } from '../services/valuation/openrouter-transport';

// A stand-in JSON schema; only its identity/serialization matters to the translation.
const SCHEMA = {
  type: 'object',
  properties: { t: { type: 'array', items: { type: 'string' } } },
  required: ['t'],
  additionalProperties: false,
} as const;

// Routing fixtures mirroring OPENROUTER_PROVIDER_ROUTING in llm.ts.
const deepseekRouting = { order: ['deepseek'], allowFallbacks: false, structuredOutputs: false };
const grokRouting = { structuredOutputs: false };

const systemOf = (req: ReturnType<typeof buildOpenRouterRequest>) => String(req.messages[0]?.content ?? '');

describe('buildOpenRouterRequest', () => {
  it('number_variants channel: deepseek pinning, reasoning disabled, json_object downgrade with schema in system message', () => {
    const body = JSON.stringify({
      model: 'deepseek/deepseek-v4-flash',
      instructions: 'SYS_INSTRUCTIONS',
      input: '["alpha","beta"]',
      max_output_tokens: 8000,
      store: true,
      temperature: 0,
      reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: 'number_variants', strict: true, schema: SCHEMA } },
    });

    const req = buildOpenRouterRequest(body, deepseekRouting);

    expect(req.model).toBe('deepseek/deepseek-v4-flash');
    expect(req.maxOutputTokens).toBe(8000);
    expect(req.temperature).toBe(0);

    expect(req.messages).toHaveLength(2);
    expect(req.messages[0].role).toBe('system');
    expect(systemOf(req)).toContain('SYS_INSTRUCTIONS');
    expect(systemOf(req)).toContain('Respond with ONLY a single JSON object');
    expect(systemOf(req)).toContain(JSON.stringify(SCHEMA));
    expect(req.messages[1]).toEqual({ role: 'user', content: '["alpha","beta"]' });

    expect(req.extraBody.usage).toEqual({ include: true });
    expect(req.extraBody.reasoning).toEqual({ enabled: false });
    expect(req.extraBody.response_format).toEqual({ type: 'json_object' });
    expect(req.extraBody.provider).toEqual({ require_parameters: true, order: ['deepseek'], allow_fallbacks: false });
    expect(req.extraBody.plugins).toBeUndefined();
  });

  it('name_research channel: passes reasoning effort through, enables the web plugin, no instructions', () => {
    const body = JSON.stringify({
      model: 'deepseek/deepseek-v4-pro',
      input: 'somename',
      max_output_tokens: 16000,
      store: true,
      temperature: 0,
      reasoning: { effort: 'low' },
      tools: [{ type: 'web_search' }],
      text: { format: { type: 'json_schema', name: 'term_research', strict: false, schema: SCHEMA } },
    });

    const req = buildOpenRouterRequest(body, deepseekRouting);

    expect(req.extraBody.reasoning).toEqual({ effort: 'low' });
    expect(req.extraBody.response_format).toEqual({ type: 'json_object' });
    expect(req.extraBody.plugins).toEqual([{ id: 'web', max_results: 5 }]);
    expect(req.extraBody.provider).toEqual({ require_parameters: true, order: ['deepseek'], allow_fallbacks: false });

    // No instructions on the Responses body -> the system message is only the
    // schema-injection line (the downgrade still fires for deepseek).
    expect(req.messages).toHaveLength(2);
    expect(req.messages[0].role).toBe('system');
    expect(systemOf(req)).toContain('Respond with ONLY a single JSON object');
    expect(req.messages[1]).toEqual({ role: 'user', content: 'somename' });
  });

  it('appraisal channel: grok has no order pinning, reasoning disabled, json_object downgrade', () => {
    const body = JSON.stringify({
      model: 'x-ai/grok-4.3',
      instructions: 'APPRAISE',
      input: JSON.stringify({ name: 'x.eth', evidence: {} }),
      max_output_tokens: 8000,
      store: true,
      temperature: 0,
      reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: 'ens_valuation_appraisal', strict: true, schema: SCHEMA } },
    });

    const req = buildOpenRouterRequest(body, grokRouting);

    expect(req.extraBody.reasoning).toEqual({ enabled: false });
    expect(req.extraBody.response_format).toEqual({ type: 'json_object' });
    // grok routing carries no order -> provider only sets require_parameters.
    expect(req.extraBody.provider).toEqual({ require_parameters: true });
    expect(req.extraBody.plugins).toBeUndefined();
  });

  it('no downgrade when the provider supports strict schema: emits json_schema strict, no schema in prompt', () => {
    const body = JSON.stringify({
      model: 'some/model',
      instructions: 'X',
      input: 'y',
      reasoning: { effort: 'medium' },
      text: { format: { type: 'json_schema', name: 'foo', strict: true, schema: SCHEMA } },
    });

    // No routing => structuredOutputs is not false => no json_object downgrade.
    const req = buildOpenRouterRequest(body, undefined);

    expect(req.extraBody.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'foo', strict: true, schema: SCHEMA },
    });
    expect(req.extraBody.reasoning).toEqual({ effort: 'medium' });
    // require_parameters is set whenever there is a json schema, even with no order.
    expect(req.extraBody.provider).toEqual({ require_parameters: true });
    expect(systemOf(req)).toBe('X');
    expect(systemOf(req)).not.toContain('Respond with ONLY a single JSON object');
  });

  it('reasoning max_tokens takes precedence over effort', () => {
    const body = JSON.stringify({
      model: 'm',
      input: 'i',
      reasoning: { max_tokens: 1234, effort: 'high' },
      text: { format: { type: 'json_schema', name: 'n', strict: true, schema: SCHEMA } },
    });

    const req = buildOpenRouterRequest(body, deepseekRouting);
    expect(req.extraBody.reasoning).toEqual({ max_tokens: 1234 });
  });

  it('omits maxOutputTokens / temperature when absent on the Responses body', () => {
    const body = JSON.stringify({
      model: 'm',
      input: 'i',
      reasoning: { effort: 'none' },
      text: { format: { type: 'json_schema', name: 'n', strict: true, schema: SCHEMA } },
    });

    const req = buildOpenRouterRequest(body, deepseekRouting);
    expect(req.maxOutputTokens).toBeUndefined();
    expect(req.temperature).toBeUndefined();
  });
});

describe('normalizeOpenRouterUsage', () => {
  it('prefers the OpenRouter usage object (providerMetadata) for the token split and cost', () => {
    const { normalized, reportedCostUsd } = normalizeOpenRouterUsage(
      {
        promptTokens: 100,
        completionTokens: 40,
        promptTokensDetails: { cachedTokens: 30 },
        completionTokensDetails: { reasoningTokens: 5 },
        totalTokens: 140,
        cost: 0.0012,
      },
      // SDK normalized usage is intentionally empty — must not be relied upon.
      { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined, reasoningTokens: undefined, cachedInputTokens: undefined }
    );

    expect(normalized).toEqual({
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 30 },
      output_tokens: 40,
      output_tokens_details: { reasoning_tokens: 5 },
      total_tokens: 140,
    });
    expect(reportedCostUsd).toBe(0.0012);
  });

  it('falls back to the SDK normalized usage when providerMetadata usage is absent; cost is null', () => {
    const { normalized, reportedCostUsd } = normalizeOpenRouterUsage(undefined, {
      inputTokens: 50,
      outputTokens: 20,
      totalTokens: 70,
      reasoningTokens: 2,
      cachedInputTokens: 10,
    });

    expect(normalized).toEqual({
      input_tokens: 50,
      input_tokens_details: { cached_tokens: 10 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 2 },
      total_tokens: 70,
    });
    expect(reportedCostUsd).toBeNull();
  });

  it('returns null cost when cost is missing, and derives total from prompt+completion when total is 0/absent', () => {
    const { normalized, reportedCostUsd } = normalizeOpenRouterUsage(
      { promptTokens: 10, completionTokens: 5, totalTokens: 0 },
      {}
    );
    expect(reportedCostUsd).toBeNull();
    expect(normalized.total_tokens).toBe(15);
    expect(normalized.input_tokens_details).toEqual({ cached_tokens: 0 });
    expect(normalized.output_tokens_details).toEqual({ reasoning_tokens: 0 });
  });
});
