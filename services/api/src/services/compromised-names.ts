import { getPostgresPool } from '../../../shared/src';

/**
 * Compromised (stolen) names — see migration 0895_create_compromised_names.sql.
 *
 * Grails orders are zone-less FULL_OPEN Seaport orders, so nothing on-chain stops a fill. What the
 * API controls is visibility: for a name with an active compromised flag we
 *   - attach a `compromised` object to every name / listing / offer payload so the app can warn
 *     and grey out actions,
 *   - withhold signed `order_data` unless the caller is allowed to use it:
 *       listings → only an allowed counterparty (original owner / recovery wallet) or the seller,
 *       offers   → visible when the BUYER is allowed (so the current holder can accept it),
 *                  otherwise only to the buyer themselves,
 *   - reject new Grails offers from anyone who isn't allowed (assertOfferAllowed).
 */

export interface CompromiseIncident {
  slug: string;
  title: string;
  description: string | null;
  info_url: string | null;
  malicious_operators: string[];
}

export interface CompromisedInfo {
  incident: CompromiseIncident;
  original_owner: string;
  allowed_addresses: string[];
  taken_at: Date | null;
}

const pool = getPostgresPool();

/**
 * Load active compromised flags for a set of ens_names ids.
 */
export async function getCompromisedByEnsNameIds(
  ensNameIds: Array<number | null | undefined>
): Promise<Map<number, CompromisedInfo>> {
  const ids = [...new Set(ensNameIds.filter((id): id is number => typeof id === 'number' && id > 0))];
  const map = new Map<number, CompromisedInfo>();
  if (ids.length === 0) return map;

  const result = await pool.query(
    `SELECT cn.ens_name_id, cn.original_owner, cn.allowed_addresses, cn.taken_at,
            ci.slug, ci.title, ci.description, ci.info_url, ci.malicious_operators
       FROM compromised_names cn
       JOIN compromise_incidents ci ON ci.id = cn.incident_id
      WHERE cn.ens_name_id = ANY($1::int[])
        AND cn.status = 'active'`,
    [ids]
  );

  for (const row of result.rows) {
    map.set(row.ens_name_id, {
      incident: {
        slug: row.slug,
        title: row.title,
        description: row.description,
        info_url: row.info_url,
        malicious_operators: row.malicious_operators || [],
      },
      original_owner: row.original_owner,
      allowed_addresses: row.allowed_addresses || [],
      taken_at: row.taken_at,
    });
  }

  return map;
}

/**
 * True when `address` may trade with a compromised name: the original owner or a recovery wallet.
 */
export function isAllowedCounterparty(info: CompromisedInfo, address?: string | null): boolean {
  if (!address) return false;
  const addr = address.toLowerCase();
  return info.original_owner === addr || info.allowed_addresses.includes(addr);
}

function sameAddress(a?: string | null, b?: string | null): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether a listing's signed order may be returned to `viewer`.
 */
export function canViewListingOrder(
  info: CompromisedInfo,
  sellerAddress: string | null | undefined,
  viewer?: string | null
): boolean {
  return isAllowedCounterparty(info, viewer) || sameAddress(sellerAddress, viewer);
}

/**
 * Whether an offer's signed order may be returned to `viewer`.
 */
export function canViewOfferOrder(
  info: CompromisedInfo,
  buyerAddress: string | null | undefined,
  viewer?: string | null
): boolean {
  return isAllowedCounterparty(info, buyerAddress) || sameAddress(buyerAddress, viewer);
}

type ListingRow = { ens_name_id?: number; seller_address?: string; order_data?: any; [key: string]: any };
type OfferRow = { ens_name_id?: number; buyer_address?: string; order_data?: any; [key: string]: any };

/**
 * Annotate listing rows (any query returning listings.*) with `compromised` and redact
 * `order_data` the viewer isn't allowed to see. Mutates and returns the rows.
 */
export async function applyCompromisedToListingRows<T extends ListingRow>(
  rows: T[],
  viewer?: string | null
): Promise<T[]> {
  const flags = await getCompromisedByEnsNameIds(rows.map((r) => r.ens_name_id));
  for (const row of rows) {
    const info = row.ens_name_id ? flags.get(row.ens_name_id) : undefined;
    (row as any).compromised = info || null;
    if (info && !canViewListingOrder(info, row.seller_address, viewer)) {
      row.order_data = null;
      (row as any).order_data_redacted = true;
    }
  }
  return rows;
}

/**
 * Annotate offer rows (any query returning offers.*) with `compromised` and redact
 * `order_data` the viewer isn't allowed to see. Mutates and returns the rows.
 */
export async function applyCompromisedToOfferRows<T extends OfferRow>(
  rows: T[],
  viewer?: string | null
): Promise<T[]> {
  const flags = await getCompromisedByEnsNameIds(rows.map((r) => r.ens_name_id));
  for (const row of rows) {
    const info = row.ens_name_id ? flags.get(row.ens_name_id) : undefined;
    (row as any).compromised = info || null;
    if (info && !canViewOfferOrder(info, row.buyer_address, viewer)) {
      row.order_data = null;
      (row as any).order_data_redacted = true;
    }
  }
  return rows;
}

/**
 * Returns an error message when `buyerAddress` may not place an offer on `ensNameId`, else null.
 */
export async function getOfferBlockReason(
  ensNameId: number,
  buyerAddress: string
): Promise<string | null> {
  const info = (await getCompromisedByEnsNameIds([ensNameId])).get(ensNameId);
  if (!info || isAllowedCounterparty(info, buyerAddress)) return null;
  return 'This name was reported stolen; only the original owner can place offers on it';
}

/**
 * Active incidents (for the app's malicious-approval check).
 */
export async function getIncidents(): Promise<CompromiseIncident[]> {
  const result = await pool.query(
    `SELECT slug, title, description, info_url, malicious_operators
       FROM compromise_incidents
      ORDER BY occurred_at DESC NULLS LAST, id DESC`
  );
  return result.rows.map((row) => ({ ...row, malicious_operators: row.malicious_operators || [] }));
}
