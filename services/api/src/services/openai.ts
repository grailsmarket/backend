import { config } from '../../../shared/src';
import { normalize } from 'viem/ens';

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = 'gpt-5.2-2025-12-11';

const SYSTEM_PROMPT = `given an input string, return exactly 10 results that are related and likely to be similarly or more common/well-known than the input.
Rules (strict!):
3–16 chars per result
No spaces in any result
If input is single word → results = single words only
Digits-only input → all results digits, same length, similar pattern
PG-13 only! no bad words!
results must not contain "."
Emojis-only input → output emojis-only; if input repeats, results repeat too
If input implies a category/theme → stay on-theme
order the results by highest recognition first.
Return no other data.`;

const SEARCH_EXPANSION_PROMPT = `Given a search query, return exactly 30 single words that are semantically associated with it.
Rules (strict!):
- Each result must be a single word (no spaces, no hyphens, no special characters)
- Include synonyms, related concepts, subtopics, and thematically connected words
- Cast a wide net: include words from adjacent domains, not just direct synonyms
- 3-20 characters per word
- No duplicates
- PG-13 only! No offensive words!
- Digits-only input → all results digits, same length, similar pattern
- Emojis-only input → output emojis only
- Order by semantic relevance (most related first)
- Return no other data.`;

/** Categories to exclude from the AI prompt (not useful for suggestions) */
const EXCLUDED_CATEGORIES = [
  'prepunks',
  'prepunk_100',
  'prepunk_10k',
  'prepunk_1k',
  'prepunk_digits',
  // Social-handle club labels are noisy for ENS-like recommendation intent.
  'social_handles',
];

/**
 * Attempts to normalize and validate a name for ENS validity.
 * Returns the normalized name if valid, or null if it can't be healed.
 *
 * Ported from frontend route.ts tryNormalizeName().
 */
function tryNormalizeName(name: string): string | null {
  // Step 1: Basic cleanup - remove spaces, underscores, dots; trim, lowercase
  let cleaned = name.replaceAll(' ', '').replaceAll('_', '').trim().toLowerCase();
  cleaned = cleaned.replaceAll('.', '');

  // Step 3: Skip empty or too short/long
  if (cleaned.length < 3) {
    return null;
  }

  // Step 4: Try to normalize with ENS library (viem wraps @adraffy/ens-normalize)
  try {
    const normalized = normalize(cleaned);
    if (normalized.length > 0) {
      return normalized;
    }
    return null;
  } catch {
    return null;
  }
}

/** Max retries for rate limit (429) errors */
const MAX_RETRIES = 3;

/**
 * Parse the rate limit reset header (e.g. "1s", "6m0s", "200ms") into milliseconds.
 */
function parseResetHeader(value: string | null): number | null {
  if (!value) return null;
  let ms = 0;
  const minutes = value.match(/(\d+)m(?!s)/);
  const seconds = value.match(/(\d+)s/);
  const millis = value.match(/(\d+)ms/);
  if (minutes) ms += parseInt(minutes[1]) * 60_000;
  if (seconds) ms += parseInt(seconds[1]) * 1_000;
  if (millis) ms += parseInt(millis[1]);
  return ms > 0 ? ms : null;
}

/**
 * Low-level OpenAI Responses API caller with retry/backoff logic.
 *
 * Retries up to MAX_RETRIES times on 429 (rate limit) and 5xx (server) errors
 * with exponential backoff. Respects x-ratelimit-reset-requests header when available.
 *
 * @param apiKey - OpenAI API key
 * @param body - Stringified JSON request body for the Responses API
 * @param label - Human-readable label for log messages (e.g. the query/name)
 * @returns Parsed JSON response from OpenAI
 * @throws On non-retryable HTTP errors or after exhausting retries
 */
async function callOpenAIRaw(apiKey: string, body: string, label: string): Promise<any> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const t0 = performance.now();
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    const t1 = performance.now();

    // Handle rate limit (429) with backoff
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const resetMs = parseResetHeader(response.headers.get('x-ratelimit-reset-requests'));
      const backoffMs = resetMs ?? (1000 * Math.pow(2, attempt) + Math.random() * 1000);
      console.warn(`[openai] Rate limited (429) for "${label}", retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }

    // Handle other HTTP errors
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      lastError = new Error(`OpenAI HTTP ${response.status}: ${errorText}`);
      if (response.status >= 500 && attempt < MAX_RETRIES) {
        const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
        console.warn(`[openai] Server error (${response.status}) for "${label}", retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
        continue;
      }
      throw lastError;
    }

    const data: any = await response.json();
    const t2 = performance.now();
    console.log(
      `[openai] callOpenAIRaw("${label}") fetch: ${(t1 - t0).toFixed(0)}ms | parse: ${(t2 - t1).toFixed(0)}ms | reasoning_tokens: ${data.usage?.output_tokens_details?.reasoning_tokens ?? '?'} | output_tokens: ${data.usage?.output_tokens ?? '?'}`
    );

    // Check if response is completed (allow incomplete if we have output)
    if (data.status !== 'completed' && data.status !== 'incomplete') {
      console.error('[openai] Response failed:', data.status, data.error);
      throw new Error(`OpenAI response status: ${data.status}`);
    }

    if (data.status === 'incomplete') {
      console.warn('[openai] Response incomplete, attempting to extract partial content:', data.incomplete_details);
    }

    // Find the message item in output (may have reasoning item before it)
    const messageItem = data.output?.find((item: { type: string }) => item.type === 'message');
    if (!messageItem) {
      console.error('[openai] No message item in response:', data);
      throw new Error('No message item in OpenAI response');
    }

    // Extract text from the message content
    const text = messageItem.content?.find((c: { type: string }) => c.type === 'output_text')?.text;
    if (!text) {
      console.error('[openai] No text in response message:', messageItem);
      throw new Error('No text in OpenAI response');
    }

    return { text, data };
  }

  throw lastError ?? new Error('Max retries exceeded');
}

/**
 * Call the OpenAI Responses API to generate similar ENS name suggestions.
 *
 * Uses json_schema structured output for reliable parsing.
 *
 * @param apiKey - OpenAI API key
 * @param name - ENS label (no .eth suffix), e.g. "vitalik"
 * @param categories - Optional category/club names for prompt context, e.g. ["999", "10k"]
 * @returns Array of normalized, deduplicated name suggestions (up to 10)
 * @throws On non-retryable HTTP errors or after exhausting retries
 */
async function callOpenAI(apiKey: string, name: string, categories?: string[]): Promise<string[]> {
  // Filter out excluded categories
  const filteredCategories = categories?.filter(
    (cat) => !EXCLUDED_CATEGORIES.includes(cat.toLowerCase())
  );

  // Build input with optional categories context
  let input = `name: ${name}`;
  if (filteredCategories && filteredCategories.length > 0) {
    input += `\ncategories: ${filteredCategories.join(', ')}`;
  }

  const body = JSON.stringify({
    model: OPENAI_MODEL,
    instructions: SYSTEM_PROMPT,
    input,
    max_output_tokens: 1000,
    store: true,
    reasoning: {
      effort: 'none',
    },
    text: {
      format: {
        type: 'json_schema',
        name: 'similar_names',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['names'],
          additionalProperties: false,
        },
      },
    },
  });

  const { text } = await callOpenAIRaw(apiKey, body, name);

  // Parse structured JSON response: { "names": ["adam", "aaron", ...] }
  let rawNames: string[];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.names)) {
      console.warn('[openai] Response JSON missing "names" array:', text.slice(0, 500));
    }
    rawNames = Array.isArray(parsed.names) ? parsed.names : [];
  } catch {
    console.error('[openai] Failed to parse JSON response:', text.slice(0, 500));
    throw new Error('Invalid JSON in OpenAI response');
  }

  // Normalize and validate each suggestion
  const validSuggestions: string[] = [];
  for (const raw of rawNames) {
    if (typeof raw !== 'string') continue;
    const normalized = tryNormalizeName(raw);
    if (normalized && normalized !== name && !validSuggestions.includes(normalized)) {
      validSuggestions.push(normalized);
      if (validSuggestions.length >= 10) break;
    }
  }

  if (rawNames.length > 0 && validSuggestions.length === 0) {
    console.warn(`[openai] All ${rawNames.length} suggestions for "${name}" failed normalization`);
  }

  return validSuggestions;
}

/**
 * Call the OpenAI Responses API to generate semantic search expansions.
 *
 * Returns ~100 semantically associated words for a search query.
 * No ENS normalization — these are search expansion terms, not ENS labels.
 *
 * @param apiKey - OpenAI API key
 * @param query - Search query string
 * @returns Array of sanitized, deduplicated expansion words (up to 100)
 * @throws On non-retryable HTTP errors or after exhausting retries
 */
async function callOpenAIExpansions(apiKey: string, query: string): Promise<string[]> {
  const body = JSON.stringify({
    model: OPENAI_MODEL,
    instructions: SEARCH_EXPANSION_PROMPT,
    input: `query: ${query}`,
    max_output_tokens: 1500,
    store: true,
    reasoning: {
      effort: 'none',
    },
    text: {
      format: {
        type: 'json_schema',
        name: 'search_expansions',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            words: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['words'],
          additionalProperties: false,
        },
      },
    },
  });

  const { text } = await callOpenAIRaw(apiKey, body, `expansion:${query}`);

  // Parse structured JSON response: { "words": ["dog", "kitten", ...] }
  let rawWords: string[];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed.words)) {
      console.warn('[openai] Response JSON missing "words" array:', text.slice(0, 500));
    }
    rawWords = Array.isArray(parsed.words) ? parsed.words : [];
  } catch {
    console.error('[openai] Failed to parse JSON response:', text.slice(0, 500));
    throw new Error('Invalid JSON in OpenAI response');
  }

  // Basic sanitization: lowercase, strip non-alphanumeric, deduplicate, cap at 100
  const seen = new Set<string>();
  const validWords: string[] = [];
  for (const raw of rawWords) {
    if (typeof raw !== 'string') continue;
    const cleaned = raw.toLowerCase().replace(/[^a-z0-9\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '');
    if (cleaned.length < 1 || cleaned.length > 20) continue;
    if (seen.has(cleaned)) continue;
    seen.add(cleaned);
    validWords.push(cleaned);
    if (validWords.length >= 30) break;
  }

  return validWords;
}

/**
 * Generate similar name suggestions for an ENS label.
 *
 * Returns null on any error (API key missing, OpenAI failure, etc.)
 * following the same error pattern as opensea.ts.
 *
 * @param name - ENS label (no .eth suffix), e.g. "vitalik"
 * @param categories - Optional club/category names for context, e.g. ["999", "10k"]
 * @returns Array of suggested name labels, or null on failure
 */
export async function generateSimilarNames(
  name: string,
  categories?: string[]
): Promise<string[] | null> {
  const apiKey = config.openai.apiKey;
  if (!apiKey) {
    console.error('[openai] Missing OPENAI_API_KEY — cannot generate similar names');
    return null;
  }

  try {
    return await callOpenAI(apiKey, name, categories);
  } catch (error) {
    console.error('[openai] Error generating similar names:', error);
    return null;
  }
}

/**
 * Generate semantic search expansions for a query.
 *
 * Returns ~100 semantically associated words, or null on any error.
 *
 * @param query - Search query string
 * @returns Array of expansion words, or null on failure
 */
export async function generateSemanticExpansions(
  query: string
): Promise<string[] | null> {
  const apiKey = config.openai.apiKey;
  if (!apiKey) {
    console.error('[openai] Missing OPENAI_API_KEY — cannot generate semantic expansions');
    return null;
  }

  try {
    return await callOpenAIExpansions(apiKey, query);
  } catch (error) {
    console.error('[openai] Error generating semantic expansions:', error);
    return null;
  }
}

/** The OpenAI model name used for generation (exposed for DB storage) */
export const OPENAI_MODEL_NAME = OPENAI_MODEL;
