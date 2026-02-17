#!/usr/bin/env node

/**
 * Prefill AI Recommendations Script
 *
 * Pre-generates AI similar name recommendations for popular ENS names
 * and stores them in the ai_recommendations table. This ensures most
 * requests are served instantly from cache rather than waiting for
 * an inline OpenAI call (~2-3s).
 *
 * Usage:
 *   npx tsx src/scripts/prefill-ai-recommendations.ts
 *   npx tsx src/scripts/prefill-ai-recommendations.ts --limit 100
 *
 * Environment variables required:
 *   DATABASE_URL - PostgreSQL connection string
 *   OPENAI_API_KEY - OpenAI API key
 */

import { getPostgresPool, config } from '../../../shared/src';
import { normalize } from 'viem/ens';

// ─── Configuration ───────────────────────────────────────────────

const OPENAI_API_URL = 'https://api.openai.com/v1/responses';
const OPENAI_MODEL = 'gpt-5.2-2025-12-11';
const CACHE_TTL_DAYS = 60;

/** Minimum delay between OpenAI calls (ms) */
const MIN_DELAY_MS = 200;

/** Default delay when rate limit headers are absent (ms) */
const DEFAULT_DELAY_MS = 500;

/** Max retries per name on 429/5xx errors */
const MAX_RETRIES = 3;

/** Default number of names to prefill */
const DEFAULT_LIMIT = 500;

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

const EXCLUDED_CATEGORIES = [
  'prepunks',
  'prepunk_100',
  'prepunk_10k',
  'prepunk_1k',
  'prepunk_digits',
];

// ─── OpenAI helpers (self-contained, mirrors api/src/services/openai.ts) ─────

function tryNormalizeName(name: string): string | null {
  let cleaned = name.replaceAll(' ', '').replaceAll('_', '').trim().toLowerCase();
  cleaned = cleaned.replaceAll('.', '');
  if (cleaned.length < 3) return null;

  try {
    const normalized = normalize(cleaned);
    if (normalized.length > 0) return normalized;
    return null;
  } catch {
    return null;
  }
}

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

/** Tracks recommended delay based on rate limit headers from last response */
let nextDelayMs = DEFAULT_DELAY_MS;

/**
 * Call OpenAI with retry on 429/5xx and header-aware pacing.
 * Updates nextDelayMs based on x-ratelimit-remaining-requests headers.
 */
async function callOpenAI(apiKey: string, name: string, categories?: string[]): Promise<string[]> {
  const filteredCategories = categories?.filter(
    (cat) => !EXCLUDED_CATEGORIES.includes(cat.toLowerCase())
  );

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
    reasoning: { effort: 'none' },
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

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    // Handle 429 rate limit — wait for the reset time from headers
    if (response.status === 429 && attempt < MAX_RETRIES) {
      const resetMs = parseResetHeader(response.headers.get('x-ratelimit-reset-requests'));
      const backoffMs = resetMs ?? (1000 * Math.pow(2, attempt) + Math.random() * 1000);
      console.warn(`\n  ⏳ Rate limited (429) for "${name}", waiting ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoffMs);
      continue;
    }

    // Handle 5xx server errors with exponential backoff
    if (response.status >= 500 && attempt < MAX_RETRIES) {
      const backoffMs = 1000 * Math.pow(2, attempt) + Math.random() * 1000;
      console.warn(`\n  ⏳ Server error (${response.status}) for "${name}", retrying in ${Math.round(backoffMs)}ms (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(backoffMs);
      continue;
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new Error(`OpenAI HTTP ${response.status}: ${errorText}`);
    }

    // Adapt pacing based on remaining requests header
    const remaining = response.headers.get('x-ratelimit-remaining-requests');
    const resetRequests = parseResetHeader(response.headers.get('x-ratelimit-reset-requests'));
    if (remaining !== null && resetRequests !== null) {
      const remainingCount = parseInt(remaining);
      if (remainingCount <= 2) {
        // Almost out — wait for the full reset
        nextDelayMs = resetRequests;
      } else if (remainingCount <= 10) {
        // Getting low — spread remaining requests over the reset window
        nextDelayMs = Math.max(MIN_DELAY_MS, Math.ceil(resetRequests / remainingCount));
      } else {
        // Plenty of headroom
        nextDelayMs = MIN_DELAY_MS;
      }
    }

    const data = await response.json();

    if (data.status !== 'completed' && data.status !== 'incomplete') {
      throw new Error(`OpenAI response status: ${data.status} — ${JSON.stringify(data.error)}`);
    }

    if (data.status === 'incomplete') {
      console.warn(`\n  ⚠ OpenAI response incomplete for "${name}", attempting to extract partial content`);
    }

    const messageItem = data.output?.find((item: { type: string }) => item.type === 'message');
    if (!messageItem) throw new Error('No message item in OpenAI response');

    const text = messageItem.content?.find((c: { type: string }) => c.type === 'output_text')?.text;
    if (!text) throw new Error('No text in OpenAI response');

    // Parse structured JSON response: { "names": ["adam", "aaron", ...] }
    let rawNames: string[];
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed.names)) {
        console.warn(`  ⚠ Response JSON for "${name}" missing "names" array:`, text.slice(0, 200));
      }
      rawNames = Array.isArray(parsed.names) ? parsed.names : [];
    } catch {
      throw new Error(`Invalid JSON in OpenAI response: ${text.slice(0, 200)}`);
    }

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
      console.warn(`  ⚠ All ${rawNames.length} suggestions for "${name}" failed normalization`);
    }

    return validSuggestions;
  }

  throw new Error('Max retries exceeded');
}

// ─── Main ────────────────────────────────────────────────────────

interface PopularName {
  name: string;
  label: string;
  popularity_score: number;
  clubs: string[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log('Starting AI recommendations prefill...\n');

  // Parse --limit flag
  const limitArg = process.argv.find((arg) => arg.startsWith('--limit'));
  const limit = limitArg
    ? parseInt(limitArg.includes('=') ? limitArg.split('=')[1] : process.argv[process.argv.indexOf(limitArg) + 1])
    : DEFAULT_LIMIT;

  if (isNaN(limit) || limit < 1) {
    console.error('Invalid --limit value. Must be a positive integer.');
    process.exit(1);
  }

  console.log(`Limit: ${limit} names\n`);

  // Validate API key
  const apiKey = config.openai.apiKey;
  if (!apiKey) {
    console.error('✗ Missing OPENAI_API_KEY environment variable');
    process.exit(1);
  }
  console.log('✓ OpenAI API key configured\n');

  const pool = getPostgresPool();

  try {
    // Fetch names with at least 5 views that don't already have fresh recommendations
    console.log('Fetching viewed names without fresh recommendations...');
    const result = await pool.query<PopularName>(`
      WITH popular_names AS (
        SELECT
          en.name,
          REPLACE(en.name, '.eth', '') AS label,
          COALESCE(en.view_count, 0) AS popularity_score,
          COALESCE(en.clubs, ARRAY[]::text[]) AS clubs
        FROM ens_names en
        WHERE en.name LIKE '%.eth'
          AND en.name NOT LIKE '%.%.eth'
          AND LENGTH(REPLACE(en.name, '.eth', '')) >= 3
          AND COALESCE(en.view_count, 0) >= 5
        ORDER BY en.view_count DESC
        LIMIT $1 * 2
      )
      SELECT pn.*
      FROM popular_names pn
      LEFT JOIN ai_recommendations ar
        ON ar.name = pn.label
        AND ar.expires_at > NOW()
      WHERE ar.id IS NULL
      ORDER BY pn.popularity_score DESC
      LIMIT $1
    `, [limit]);

    const names = result.rows;
    console.log(`✓ Found ${names.length} names needing recommendations\n`);

    if (names.length === 0) {
      console.log('All popular names already have fresh recommendations. Exiting.');
      return;
    }

    // Generate recommendations for each name
    console.log('Generating recommendations...');
    let generated = 0;
    let skipped = 0;
    let failed = 0;

    for (const nameRow of names) {
      try {
        const categories = nameRow.clubs.filter(
          (c) => !EXCLUDED_CATEGORIES.includes(c.toLowerCase())
        );

        const suggestions = await callOpenAI(apiKey, nameRow.label, categories);

        if (suggestions.length === 0) {
          skipped++;
          process.stdout.write(`\r  Progress: ${generated + skipped + failed}/${names.length} (${generated} generated, ${skipped} empty, ${failed} failed)`);
          await sleep(nextDelayMs);
          continue;
        }

        // UPSERT to database (compute expiry per-row to avoid thundering herd)
        const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
        await pool.query(
          `INSERT INTO ai_recommendations (name, recommendations, model, expires_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (name)
           DO UPDATE SET
             recommendations = EXCLUDED.recommendations,
             model = EXCLUDED.model,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
          [nameRow.label, JSON.stringify(suggestions), OPENAI_MODEL, expiresAt]
        );

        generated++;
        process.stdout.write(`\r  Progress: ${generated + skipped + failed}/${names.length} (${generated} generated, ${skipped} empty, ${failed} failed)`);

        // Adaptive rate limit delay (updated by callOpenAI based on response headers)
        await sleep(nextDelayMs);
      } catch (error) {
        failed++;
        console.error(`\n  ✗ Failed for "${nameRow.label}":`, error instanceof Error ? error.message : error);
      }
    }

    // Summary
    console.log('\n');
    console.log('Prefill Summary:');
    console.log('─────────────────────────────────────');
    console.log(`Names processed:      ${names.length}`);
    console.log(`Recommendations made: ${generated}`);
    console.log(`Empty results:        ${skipped}`);
    console.log(`Failed:               ${failed}`);
    console.log(`Cache TTL:            ${CACHE_TTL_DAYS} days`);
    console.log(`Model:                ${OPENAI_MODEL}`);
    console.log('─────────────────────────────────────\n');

    if (generated > 0) {
      console.log(`Top ${Math.min(10, names.length)} names by popularity:`);
      names.slice(0, 10).forEach((name, index) => {
        console.log(`  ${(index + 1).toString().padStart(2)}. ${name.label.padEnd(20)} (score: ${name.popularity_score})`);
      });
      console.log();
    }

  } catch (error) {
    console.error('\n✗ Prefill failed with error:', error);
    process.exit(1);
  } finally {
    await pool.end();
    console.log('✓ Database connection closed\n');
  }
}

// Run the script
main()
  .then(() => {
    console.log('Prefill script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
