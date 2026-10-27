import { getPostgresPool, config, type AddressRecord, type ContenthashRecord, type ExpiryPhase } from '../../../shared/src';
import { registrationFields } from './registration-fields';

export { registrationFields };
import {
  getCompromisedByEnsNameIds,
  canViewListingOrder,
  type CompromisedInfo,
} from '../services/compromised-names';

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
  // 1 = ENS v1, 2 = ENSv2 (an ERC1155 on token_contract, the ETHRegistry; token_id can change)
  version: number;
  token_contract: string | null;
  owner: string | null;
  expiry_date: Date | null;
  // Registration phase at response time (shared/utils/expiry-phase.ts, the same rule the
  // status filters use). Null for subnames. grace_ends_at / premium_ends_at are null
  // when there's no expiry.
  registration_status: ExpiryPhase | null;
  grace_ends_at: Date | null;
  premium_ends_at: Date | null;
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

  // Stolen-name flag (null unless the name has an active compromised_names row)
  compromised: CompromisedInfo | null;
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
  order_data_redacted?: boolean;
}

/**
 * Builds a consistent search result from ENS names and their listings
 *
 * @param ensNames - Array of ENS name identifiers (either full names or just the name strings)
 * @param userId - Optional user ID to include user's vote in results. Also identifies the viewer's
 *   wallet: on compromised names, listing order_data is only returned to the original owner /
 *   recovery wallets / the seller (redacted otherwise)
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
      en.ens_version,
      en.token_contract,
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
      ${userId ? `(SELECT address FROM users WHERE id = $${ensNames.length + 1}) as viewer_address,` : ''}

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
  const compromisedFlags = await getCompromisedByEnsNameIds(result.rows.map((row) => row.id));

  // Transform database results to SearchResult format
  return result.rows.map((row) => {
    const result: SearchResult = {
      id: row.id,
      name: row.name,
      token_id: row.token_id,
      version: row.ens_version,
      token_contract: row.token_contract,
      owner: row.owner_address,
      expiry_date: row.expiry_date,
      ...registrationFields(row.name, row.expiry_date, row.ens_version),
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
      compromised: compromisedFlags.get(row.id) || null,
    };

    if (result.compromised) {
      const info = result.compromised;
      result.listings = result.listings.map((listing) =>
        canViewListingOrder(info, listing.seller_address, row.viewer_address)
          ? listing
          : { ...listing, order_data: null, order_data_redacted: true }
      );
    }

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

/**
 * Creates a placeholder SearchResult for an unregistered club name.
 * Used when browsing clubs to show names that exist in club_memberships
 * but have never been registered on-chain.
 */
export function createUnregisteredPlaceholder(name: string, clubs: string[]): SearchResult {
  const label = name.replace('.eth', '');
  return {
    id: 0,
    name,
    token_id: '',
    // ENSv2 is live wherever it's configured, so a new registration would be a v2 name
    version: config.blockchain.ensv2 ? 2 : 1,
    token_contract: null,
    owner: null,
    expiry_date: new Date('2020-01-01T00:00:00Z'),
    // Never registered: available, no phase dates (the 2020 expiry above is a sort placeholder)
    ...registrationFields(name, null, null),
    registration_date: null,
    creation_date: null,
    last_sale_date: null,
    metadata: null,
    metadata_updated_at: null,
    clubs,
    club_ranks: null,
    has_numbers: /\d/.test(label),
    has_emoji: /\p{Emoji_Presentation}/u.test(label),
    last_sale_price: null,
    last_sale_currency: null,
    last_sale_price_usd: null,
    listings: [],
    upvotes: 0,
    downvotes: 0,
    net_score: 0,
    watchers_count: 0,
    is_user_watching: false,
    watchlist_record_id: null,
    highest_offer_wei: null,
    highest_offer_currency: null,
    highest_offer_id: null,
    view_count: 0,
    compromised: null,
  };
}
