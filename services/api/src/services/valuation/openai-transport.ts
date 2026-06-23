import type { ModelMessage } from 'ai';

/**
 * Pure transport-mapping helper for the valuation LLM engine's OpenAI (Responses
 * API) path — the `other` channel (gpt-5.5). It is dependency-free (type-only
 * imports) so it can be unit-tested in isolation.
 *
 * Note: this channel is currently unreachable in production (every generate*
 * call passes a non-empty label, and only an empty label routes to `other`), so
 * the OpenAI path is a dormant fallback. The migration keeps it consistent with
 * the OpenRouter path: it is driven through `generateText` with the JSON schema
 * injected into a system message (prompt-steered JSON), rather than the Responses
 * API's native strict `json_schema`. The existing text parsers then run on the
 * returned text, exactly as the OpenRouter channels do.
 */

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export type OpenAiResponsesCall = {
  model: string;
  messages: ModelMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  reasoningEffort?: OpenAiReasoningEffort;
  store?: boolean;
  hasWebSearch: boolean;
};

export function parseOpenAiResponsesBody(responsesBody: string): OpenAiResponsesCall {
  const parsed = JSON.parse(responsesBody) as {
    model?: unknown;
    instructions?: unknown;
    input?: unknown;
    max_output_tokens?: unknown;
    temperature?: unknown;
    store?: unknown;
    reasoning?: { effort?: unknown };
    text?: { format?: { type?: unknown; schema?: unknown } };
    tools?: Array<{ type?: unknown }>;
  };

  const format = parsed.text?.format;
  const hasJsonSchema = format?.type === 'json_schema';

  const systemParts: string[] = [];
  if (typeof parsed.instructions === 'string' && parsed.instructions.length > 0) {
    systemParts.push(parsed.instructions);
  }
  if (hasJsonSchema) {
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

  const effort = parsed.reasoning?.effort;
  const reasoningEffort = typeof effort === 'string' ? (effort as OpenAiReasoningEffort) : undefined;

  return {
    model: typeof parsed.model === 'string' ? parsed.model : '',
    messages,
    ...(typeof parsed.max_output_tokens === 'number' ? { maxOutputTokens: parsed.max_output_tokens } : {}),
    ...(typeof parsed.temperature === 'number' ? { temperature: parsed.temperature } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(typeof parsed.store === 'boolean' ? { store: parsed.store } : {}),
    hasWebSearch: Array.isArray(parsed.tools) && parsed.tools.some((tool) => tool?.type === 'web_search'),
  };
}
