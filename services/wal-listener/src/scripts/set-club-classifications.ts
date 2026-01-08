#!/usr/bin/env node

/**
 * Set Club Classifications Script
 *
 * Maps existing clubs to their classification categories.
 * Clubs can have multiple classifications (stored as TEXT[] array).
 *
 * Classifications:
 * - ethmojis: Emoji-based clubs
 * - digits: Numeric clubs (pure digits and ethmoji digits)
 * - palindromes: Palindrome clubs (both digit and letter)
 * - prepunk: Pre-Cryptopunk registration clubs
 * - geo: Geographic clubs (countries, cities, states)
 * - letters: Letter-based clubs (no digits or emojis)
 *
 * Usage:
 *   npx tsx src/scripts/set-club-classifications.ts
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();

// Classification mappings - clubs can have multiple classifications
const CLASSIFICATION_MAPPINGS: Record<string, string[]> = {
  // Ethmojis classification
  base_single_ethmoji: ['ethmojis'],
  single_ethmoji: ['ethmojis'],
  double_ethmoji: ['ethmojis'],
  triple_ethmoji: ['ethmojis'],
  quad_ethmoji: ['ethmojis'],
  quint_ethmoji: ['ethmojis'],
  ethmoji_999: ['ethmojis', 'digits'], // Ethmoji digits
  ethmoji_99: ['ethmojis', 'digits'], // Ethmoji digits
  ethmoji_10k: ['ethmojis', 'digits'], // Ethmoji digits

  // Pure digits classification
  '999': ['digits'],
  '10k': ['digits'],
  '100k_club': ['digits'],
  double_triple_digits: ['digits'],

  // Digit palindromes (both digits and palindromes)
  '3_digit_palindromes': ['digits', 'palindromes'],
  '4_digit_palindromes': ['digits', 'palindromes'],
  '5_digit_palindromes': ['digits', 'palindromes'],
  '6_digit_palindromes': ['digits', 'palindromes'],

  // Letter palindromes (both letters and palindromes)
  '3_letter_palindromes': ['palindromes', 'letters'],

  // Prepunk classification
  prepunks: ['prepunk'],
  prepunk_100: ['prepunk'],
  prepunk_1k: ['prepunk'],
  prepunk_10k: ['prepunk'],
  prepunk_digits: ['prepunk', 'digits'],

  // Geo classification
  un_countries: ['geo'],
  un_capital_cities: ['geo'],
  top_cities_global: ['geo'],
  top_cities_usa: ['geo'],
  us_states: ['geo'],

  // Letters classification (word-based clubs)
  '1kforenames': ['letters'],
  '1ksurnames': ['letters'],
  bip_39: ['letters'],
  pokemon: ['letters'],
  english_adjectives: ['letters'],
  top_crypto_names: ['letters'],
  top_crypto_tickers: ['letters'],
  wikidata_top_fantasy_char: ['letters'],
  periodic_table: ['letters'],
};

async function main() {
  console.log('Setting club classifications...\n');

  try {
    // Get all clubs
    const result = await pool.query('SELECT name FROM clubs ORDER BY name');
    const clubs = result.rows;

    console.log(`Found ${clubs.length} clubs\n`);

    let updated = 0;
    let uncategorized = 0;

    for (const club of clubs) {
      const classifications = CLASSIFICATION_MAPPINGS[club.name];

      if (classifications && classifications.length > 0) {
        await pool.query(
          'UPDATE clubs SET classifications = $1 WHERE name = $2',
          [classifications, club.name]
        );
        console.log(`  [SET] ${club.name} -> [${classifications.join(', ')}]`);
        updated++;
      } else {
        // Set to NULL for uncategorized clubs
        await pool.query(
          'UPDATE clubs SET classifications = NULL WHERE name = $1',
          [club.name]
        );
        console.log(`  [NULL] ${club.name} (uncategorized)`);
        uncategorized++;
      }
    }

    console.log(`\n${'─'.repeat(50)}`);
    console.log('Summary:');
    console.log(`  Categorized:   ${updated}`);
    console.log(`  Uncategorized: ${uncategorized}`);
    console.log(`  Total:         ${clubs.length}`);
    console.log(`${'─'.repeat(50)}\n`);

    // Show classification distribution
    console.log('Classification Distribution:');
    const distResult = await pool.query(`
      SELECT
        unnest(classifications) as classification,
        COUNT(*) as count
      FROM clubs
      WHERE classifications IS NOT NULL
      GROUP BY classification
      ORDER BY count DESC
    `);

    for (const row of distResult.rows) {
      console.log(`  ${row.classification}: ${row.count} clubs`);
    }

    console.log();
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await closeAllConnections();
  }
}

// Run the script
main()
  .then(() => {
    console.log('Classification script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
