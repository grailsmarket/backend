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
  last_sale_date: Date | null;
  metadata: any;
  clubs: string[] | null;
  has_numbers: boolean;
  has_emoji: boolean;

  // Listing fields (if exists)
  listings: Listing[];

  // Vote fields
  upvotes: number;
  downvotes: number;
  net_score: number;
  user_vote?: number | null;  // Only present if userId provided

  // Watchlist fields
  watchers_count: number;
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
 * @param userId - Optional user ID to include user's vote in results
 */
export async function buildSearchResults(
  ensNames: string[],
  userId?: number
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
      en.last_sale_date,
      en.metadata,
      en.clubs,
      en.has_numbers,
      en.has_emoji,

      -- Vote fields
      COALESCE(en.upvotes, 0) as upvotes,
      COALESCE(en.downvotes, 0) as downvotes,
      COALESCE(en.net_score, 0) as net_score,
      ${userId ? `(SELECT vote FROM name_votes WHERE ens_name_id = en.id AND user_id = $${ensNames.length + 1}) as user_vote,` : ''}

      -- Watchlist fields
      (SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) as watchers_count,

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

  const queryParams: (string | number)[] = ensNames.map(name => name.toLowerCase());
  if (userId !== undefined) {
    queryParams.push(userId);
  }

  const result = await pool.query(query, queryParams);

  // Transform database results to SearchResult format
  return result.rows.map((row) => {
    const result: SearchResult = {
      name: row.name,
      token_id: row.token_id,
      owner: row.owner_address,
      expiry_date: row.expiry_date,
      registration_date: row.registration_date,
      last_sale_date: row.last_sale_date,
      metadata: row.metadata,
      clubs: row.clubs,
      has_numbers: row.has_numbers,
      has_emoji: row.has_emoji,
      listings: row.listings || [],
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      net_score: row.net_score,
      watchers_count: parseInt(row.watchers_count) || 0,
    };

    // Only include user_vote if userId was provided
    if (userId !== undefined) {
      result.user_vote = row.user_vote;
    }

    return result;
  });
}

/**
 * Builds a single ENS name result with all its data
 * Used by GET /names/:name endpoint
 *
 * @param name - ENS name to fetch
 * @param userId - Optional user ID to include user's vote
 */
export async function buildNameResult(name: string, userId?: number): Promise<SearchResult | null> {
  const results = await buildSearchResults([name], userId);
  return results.length > 0 ? results[0] : null;
}
