import { getPostgresPool, type AddressRecord, type ContenthashRecord } from '../../../shared/src';

/**
 * Metadata structure for ENS names
 * Contains text records, multichain address records, and contenthash
 */
export interface EnsNameMetadata {
  [key: string]: string | AddressRecord[] | ContenthashRecord | undefined;
  /** Array of multichain address records (ENSIP-9/ENSIP-11) */
  chains?: AddressRecord[];
  /** Contenthash record (ENSIP-7) - IPFS, Swarm, Onion, etc. */
  contenthash?: ContenthashRecord;
}

/**
 * Standard search result format
 * Both /listings/search and /names/search return this structure
 */
export interface SearchResult {
  // ENS Name fields
  id: number;  // ens_names.id - essential for creating offers and fulfilling them
  name: string;
  token_id: string;
  owner: string;
  expiry_date: Date | null;
  registration_date: Date | null;
  creation_date: Date | null;
  last_sale_date: Date | null;
  metadata: EnsNameMetadata | null;
  metadata_updated_at: Date | null;  // When metadata was last fetched from The Graph
  clubs: string[] | null;
  club_ranks: Array<{ club: string; rank: number }> | null;
  has_numbers: boolean;
  has_emoji: boolean;

  // Sale fields
  last_sale_price: string | null;
  last_sale_currency: string | null;
  last_sale_price_usd: number | null;

  // Listing fields (if exists)
  listings: Listing[];

  // Vote fields
  upvotes: number;
  downvotes: number;
  net_score: number;
  user_vote?: number | null;  // Only present if userId provided

  // Watchlist fields
  watchers_count: number;
  is_user_watching: boolean;
  watchlist_record_id: number | null;  // Only present if user is watching

  // Highest offer fields
  highest_offer_wei: string | null;
  highest_offer_currency: string | null;
  highest_offer_id: number | null;

  // View count field
  view_count: number;
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
  broker_address: string | null;
  broker_fee_bps: number | null;
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
      en.id,
      en.name,
      en.token_id,
      en.owner_address,
      en.expiry_date,
      en.registration_date,
      en.creation_date,
      en.last_sale_date,
      en.metadata,
      en.metadata_updated_at,
      en.clubs,
      (SELECT json_agg(json_build_object('club', cm.club_name, 'rank', cm.rank))
       FROM club_memberships cm
       WHERE cm.ens_name = en.name AND cm.rank IS NOT NULL
      ) as club_ranks,
      en.has_numbers,
      en.has_emoji,

      -- Sale fields
      en.last_sale_price,
      en.last_sale_currency,
      en.last_sale_price_usd,

      -- Highest offer fields
      en.highest_offer_wei,
      en.highest_offer_currency,
      en.highest_offer_id,

      -- View count
      COALESCE(en.view_count, 0) as view_count,

      -- Vote fields
      COALESCE(en.upvotes, 0) as upvotes,
      COALESCE(en.downvotes, 0) as downvotes,
      COALESCE(en.net_score, 0) as net_score,
      ${userId ? `(SELECT vote FROM name_votes WHERE ens_name_id = en.id AND user_id = $${ensNames.length + 1}) as user_vote,` : ''}

      -- Watchlist fields
      (SELECT COUNT(*) FROM watchlist WHERE ens_name_id = en.id) as watchers_count,
      ${userId
        ? `(SELECT EXISTS(SELECT 1 FROM watchlist WHERE ens_name_id = en.id AND user_id = $${ensNames.length + 1})) as is_user_watching,`
        : 'false as is_user_watching,'}
      ${userId
        ? `(SELECT id FROM watchlist WHERE ens_name_id = en.id AND user_id = $${ensNames.length + 1}) as watchlist_record_id,`
        : 'NULL as watchlist_record_id,'}

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
            'source', l.source,
            'broker_address', l.broker_address,
            'broker_fee_bps', l.broker_fee_bps
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
      id: row.id,
      name: row.name,
      token_id: row.token_id,
      owner: row.owner_address,
      expiry_date: row.expiry_date,
      registration_date: row.registration_date,
      creation_date: row.creation_date,
      last_sale_date: row.last_sale_date,
      last_sale_price: row.last_sale_price,
      last_sale_currency: row.last_sale_currency,
      last_sale_price_usd: row.last_sale_price_usd ? parseFloat(row.last_sale_price_usd) : null,
      metadata: row.metadata,
      metadata_updated_at: row.metadata_updated_at,
      clubs: row.clubs,
      club_ranks: row.club_ranks || null,
      has_numbers: row.has_numbers,
      has_emoji: row.has_emoji,
      listings: row.listings || [],
      upvotes: row.upvotes,
      downvotes: row.downvotes,
      net_score: row.net_score,
      watchers_count: parseInt(row.watchers_count) || 0,
      is_user_watching: row.is_user_watching || false,
      watchlist_record_id: row.watchlist_record_id || null,
      highest_offer_wei: row.highest_offer_wei,
      highest_offer_currency: row.highest_offer_currency,
      highest_offer_id: row.highest_offer_id,
      view_count: parseInt(row.view_count) || 0,
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
