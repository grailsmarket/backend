/**
 * Parity tests for the valuation engine's OpenAI (Responses API) transport after
 * the migration to the Vercel AI SDK (`@ai-sdk/openai`). The `other` channel is
 * dormant in production (only an empty label routes to it), so these lock the
 * pure body-mapping helper offline (no network, DB, or live keys).
 *
 * Like the OpenRouter path, the OpenAI path is driven through `generateText` with
 * the JSON schema injected into a system message; the engine's text parsers then
 * run on the returned text.
 */

import { describe, it, expect } from 'vitest';
import { parseOpenAiResponsesBody } from '../services/valuation/openai-transport';

const SCHEMA = {
  type: 'object',
  properties: { t: { type: 'array', items: { type: 'string' } } },
  required: ['t'],
  additionalProperties: false,
} as const;

const systemOf = (call: ReturnType<typeof parseOpenAiResponsesBody>) => String(call.messages[0]?.content ?? '');

describe('parseOpenAiResponsesBody', () => {
  it('maps the default (other) channel body: instructions + schema-in-system, scalar options', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      instructions: 'SYS',
      input: 'hello',
      max_output_tokens: 8000,
      store: true,
      reasoning: { effort: 'low' },
      text: { format: { type: 'json_schema', name: 'x', strict: true, schema: SCHEMA } },
    });

    const call = parseOpenAiResponsesBody(body);

    expect(call.model).toBe('gpt-5.5');
    expect(call.maxOutputTokens).toBe(8000);
    expect(call.store).toBe(true);
    expect(call.reasoningEffort).toBe('low');
    expect(call.hasWebSearch).toBe(false);
    expect(call.temperature).toBeUndefined();

    expect(call.messages).toHaveLength(2);
    expect(call.messages[0].role).toBe('system');
    expect(systemOf(call)).toContain('SYS');
    expect(systemOf(call)).toContain('Respond with ONLY a single JSON object');
    expect(systemOf(call)).toContain(JSON.stringify(SCHEMA));
    expect(call.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('flags web search and builds a system message from the schema alone when there are no instructions', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      input: 'somelabel',
      max_output_tokens: 16000,
      store: true,
      reasoning: { effort: 'low' },
      tools: [{ type: 'web_search' }],
      text: { format: { type: 'json_schema', name: 'term_research', strict: false, schema: SCHEMA } },
    });

    const call = parseOpenAiResponsesBody(body);

    expect(call.hasWebSearch).toBe(true);
    expect(call.messages).toHaveLength(2);
    expect(call.messages[0].role).toBe('system');
    expect(systemOf(call)).toContain('Respond with ONLY a single JSON object');
    expect(call.messages[1]).toEqual({ role: 'user', content: 'somelabel' });
  });

  it('passes temperature through when present', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      instructions: 'S',
      input: 'i',
      temperature: 0,
      text: { format: { type: 'json_schema', name: 'x', strict: true, schema: SCHEMA } },
    });

    const call = parseOpenAiResponsesBody(body);
    expect(call.temperature).toBe(0);
  });

  it('no JSON schema: no schema injection, system message is just the instructions', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      instructions: 'ONLY_INSTRUCTIONS',
      input: 'i',
      reasoning: { effort: 'low' },
    });

    const call = parseOpenAiResponsesBody(body);
    expect(systemOf(call)).toBe('ONLY_INSTRUCTIONS');
    expect(systemOf(call)).not.toContain('Respond with ONLY a single JSON object');
    expect(call.messages[1]).toEqual({ role: 'user', content: 'i' });
  });

  it('stringifies a non-string input for the user message', () => {
    const body = JSON.stringify({
      model: 'gpt-5.5',
      input: { name: 'x.eth', evidence: {} },
      text: { format: { type: 'json_schema', name: 'x', strict: true, schema: SCHEMA } },
    });

    const call = parseOpenAiResponsesBody(body);
    expect(call.messages[call.messages.length - 1]).toEqual({
      role: 'user',
      content: JSON.stringify({ name: 'x.eth', evidence: {} }),
    });
  });
});
