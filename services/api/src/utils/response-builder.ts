import { getPostgresPool } from '../../../shared/src';

/**
 * Standard search result format
 * Both /listings/search and /names/search return this structure
 */
export interface SearchResult {
  // ENS Name fields
  name: string;
  token_id: string;
  owner: string;
  expiry_date: Date | null;
  registration_date: Date | null;
  metadata: any;
  clubs: string[] | null;
  has_numbers: boolean;
  has_emoji: boolean;

  // Listing fields (if exists)
  listings: Listing[];
}

export interface Listing {
  id: number;
  price: string;  // price_wei renamed to price
  currency_address: string;
  status: string;
  seller_address: string;
  order_hash: string;
  order_data: any;
  expires_at: Date | null;
  created_at: Date;
  source: string;
}

/**
 * Builds a consistent search result from ENS names and their listings
 *
 * @param ensNames - Array of ENS name identifiers (either full names or just the name strings)
 */
export async function buildSearchResults(
  ensNames: string[]
): Promise<SearchResult[]> {
  if (ensNames.length === 0) {
    return [];
  }

  const pool = getPostgresPool();

  // Build query to fetch ENS names with their listings
  // Use CASE to preserve order from Elasticsearch
  const placeholders = ensNames.map((_, i) => `$${i + 1}`).join(',');
  const orderCases = ensNames
    .map((name, i) => `WHEN LOWER(en.name) = $${i + 1} THEN ${i}`)
    .join(' ');

  const query = `
    SELECT
      -- ENS name fields
      en.name,
      en.token_id,
      en.owner_address,
      en.expiry_date,
      en.registration_date,
      en.metadata,
      en.clubs,
      en.has_numbers,
      en.has_emoji,

      -- Listing fields (aggregated as JSON array)
      COALESCE(
        json_agg(
          json_build_object(
            'id', l.id,
            'price', l.price_wei,
            'currency_address', l.currency_address,
            'status', l.status,
            'seller_address', l.seller_address,
            'order_hash', l.order_hash,
            'order_data', l.order_data,
            'expires_at', l.expires_at,
            'created_at', l.created_at,
            'source', l.source
          )
          ORDER BY l.created_at DESC
        ) FILTER (WHERE l.id IS NOT NULL),
        '[]'::json
      ) as listings
    FROM ens_names en
    LEFT JOIN listings l ON l.ens_name_id = en.id AND l.status = 'active'
    WHERE LOWER(en.name) IN (${placeholders})
    GROUP BY en.id
    ORDER BY CASE ${orderCases} END
  `;

  const result = await pool.query(
    query,
    ensNames.map(name => name.toLowerCase())
  );

  // Transform database results to SearchResult format
  return result.rows.map((row) => ({
    name: row.name,
    token_id: row.token_id,
    owner: row.owner_address,
    expiry_date: row.expiry_date,
    registration_date: row.registration_date,
    metadata: row.metadata,
    clubs: row.clubs,
    has_numbers: row.has_numbers,
    has_emoji: row.has_emoji,
    listings: row.listings || [],
  }));
}

/**
 * Builds a single ENS name result with all its data
 * Used by GET /names/:name endpoint
 */
export async function buildNameResult(name: string): Promise<SearchResult | null> {
  const results = await buildSearchResults([name]);
  return results.length > 0 ? results[0] : null;
}
