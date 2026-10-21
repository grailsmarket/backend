/**
 * Expiry phases of a .eth name: registered -> grace -> premium -> available.
 *
 * The grace period depends on where the name is registered:
 *   - ENSv1, and v1 names not yet migrated (ens_version 1): 90 days. An unmigrated name's v2
 *     reservation expires 62 days after its v1 expiry and adds a 28-day v2 grace period, so
 *     it becomes available exactly 90 days after the v1 expiry stored in ens_names.
 *   - ENSv2 names, registered or migrated (ens_version 2): 28 days.
 * Both are followed by a 21-day premium period.
 * See docs.ens.domains/ensv2/migration ("Expiry handling") and /ensv2/eth-registrar.
 *
 * Phase boundaries are exact times (grace ends at expiry + grace period), matching the
 * contracts. Every SQL, Elasticsearch and JS check of these phases should go through here.
 */

export const GRACE_PERIOD_DAYS_V1 = 90;
export const GRACE_PERIOD_DAYS_V2 = 28;
export const PREMIUM_PERIOD_DAYS = 21;

const DAY_MS = 24 * 60 * 60 * 1000;

export type ExpiryPhase = 'registered' | 'grace' | 'premium' | 'available';

export function gracePeriodDays(ensVersion: number | null | undefined): number {
  return Number(ensVersion) === 2 ? GRACE_PERIOD_DAYS_V2 : GRACE_PERIOD_DAYS_V1;
}

/** Phase of a name at `now`. Null when the name has no expiry (e.g. subnames). */
export function getExpiryPhase(
  expiryDate: Date | string | null | undefined,
  ensVersion: number | null | undefined,
  now: number = Date.now()
): ExpiryPhase | null {
  if (!expiryDate) return null;
  const expiry = new Date(expiryDate).getTime();
  if (Number.isNaN(expiry)) return null;
  const graceEnd = expiry + gracePeriodDays(ensVersion) * DAY_MS;
  if (now < expiry) return 'registered';
  if (now < graceEnd) return 'grace';
  if (now < graceEnd + PREMIUM_PERIOD_DAYS * DAY_MS) return 'premium';
  return 'available';
}

/** When the grace period ends (the name can no longer be renewed by its owner). */
export function getGracePeriodEnd(
  expiryDate: Date | string,
  ensVersion: number | null | undefined
): Date {
  return new Date(new Date(expiryDate).getTime() + gracePeriodDays(ensVersion) * DAY_MS);
}

export interface ExpirationState {
  isExpired: boolean;
  isGracePeriod: boolean;
  isPremiumPeriod: boolean;
  daysUntilExpiry: number;
  premiumAmountEth: number | null;
}

/**
 * Expiration fields stored on Elasticsearch documents. The phase flags come from
 * getExpiryPhase, so they match the search filters at every boundary.
 */
export function getExpirationState(
  expiryDate: Date | string | null | undefined,
  ensVersion: number | null | undefined,
  now: number = Date.now()
): ExpirationState {
  const phase = getExpiryPhase(expiryDate, ensVersion, now);
  if (!phase) {
    return {
      isExpired: false,
      isGracePeriod: false,
      isPremiumPeriod: false,
      daysUntilExpiry: 999999,
      premiumAmountEth: null,
    };
  }

  const expiry = new Date(expiryDate as Date | string).getTime();
  const daysUntilExpiry = -Math.floor((now - expiry) / DAY_MS);

  let premiumAmountEth: number | null = null;
  if (phase === 'premium') {
    // Rough estimate: $100M at ~$2000/ETH, decaying to 1/10000th over the premium period.
    const daysIntoPremium = (now - getGracePeriodEnd(expiryDate as Date | string, ensVersion).getTime()) / DAY_MS;
    const initialPremiumEth = 100_000_000 / 2000;
    const k = Math.log(10000) / PREMIUM_PERIOD_DAYS;
    premiumAmountEth = initialPremiumEth * Math.exp(-k * daysIntoPremium);
  }

  return {
    isExpired: phase !== 'registered',
    isGracePeriod: phase === 'grace',
    isPremiumPeriod: phase === 'premium',
    daysUntilExpiry,
    premiumAmountEth,
  };
}

// ---------------------------------------------------------------------------------------
// SQL.`alias` is the ens_names table alias ('' for none). Conditions on NULL expiry_date
// are false, so callers keep their own handling of names without an expiry.
//
// Each condition starts with a plain expiry_date range covering both versions so Postgres
// can still use the expiry_date index, then narrows by ens_version.
// ---------------------------------------------------------------------------------------

const V1 = `INTERVAL '${GRACE_PERIOD_DAYS_V1} days'`;
const V2 = `INTERVAL '${GRACE_PERIOD_DAYS_V2} days'`;
const V1_END = `INTERVAL '${GRACE_PERIOD_DAYS_V1 + PREMIUM_PERIOD_DAYS} days'`;
const V2_END = `INTERVAL '${GRACE_PERIOD_DAYS_V2 + PREMIUM_PERIOD_DAYS} days'`;

function cols(alias: string) {
  const p = alias ? `${alias}.` : '';
  return { expiry: `${p}expiry_date`, version: `${p}ens_version` };
}

/** Name is registered or still in its grace period (expiry + grace period is in the future). */
export function sqlWithinGracePeriod(alias = 'en'): string {
  const { expiry, version } = cols(alias);
  return `(${expiry} > NOW() - ${V1} AND (${version} <> 2 OR ${expiry} > NOW() - ${V2}))`;
}

/** Name is past its grace period (premium or available). */
export function sqlPastGracePeriod(alias = 'en'): string {
  const { expiry, version } = cols(alias);
  return `(${expiry} <= NOW() - ${V2} AND (${version} = 2 OR ${expiry} <= NOW() - ${V1}))`;
}

/** SQL condition for one phase. */
export function sqlExpiryPhase(phase: ExpiryPhase, alias = 'en'): string {
  const { expiry, version } = cols(alias);
  switch (phase) {
    case 'registered':
      return `${expiry} > NOW()`;
    case 'grace':
      return `(${expiry} <= NOW() AND ${sqlWithinGracePeriod(alias)})`;
    case 'premium':
      return (
        `(${expiry} <= NOW() - ${V2} AND ${expiry} > NOW() - ${V1_END} AND (` +
        `(${version} = 2 AND ${expiry} > NOW() - ${V2_END}) OR ` +
        `(${version} <> 2 AND ${expiry} <= NOW() - ${V1})))`
      );
    case 'available':
      return `(${expiry} <= NOW() - ${V2_END} AND (${version} = 2 OR ${expiry} <= NOW() - ${V1_END}))`;
  }
}

// ---------------------------------------------------------------------------------------
// Elasticsearch. Documents carry `ens_version`; documents without it are v1.
// ---------------------------------------------------------------------------------------

const ES_V2 = { term: { ens_version: 2 } };
const ES_V1 = { bool: { must_not: [ES_V2] } };

function esRange(gt: string | null, lte: string | null) {
  const range: Record<string, string> = {};
  if (gt) range.gt = gt;
  if (lte) range.lte = lte;
  return { range: { expiry_date: range } };
}

/** Per version: v1 condition OR v2 condition. */
function esByVersion(v1: object, v2: object) {
  return {
    bool: {
      should: [
        { bool: { filter: [ES_V1, v1] } },
        { bool: { filter: [ES_V2, v2] } },
      ],
      minimum_should_match: 1,
    },
  };
}

/** Elasticsearch query for names in the given phase. */
export function esExpiryPhaseQuery(phase: ExpiryPhase): object {
  const v1Grace = `now-${GRACE_PERIOD_DAYS_V1}d`;
  const v2Grace = `now-${GRACE_PERIOD_DAYS_V2}d`;
  const v1End = `now-${GRACE_PERIOD_DAYS_V1 + PREMIUM_PERIOD_DAYS}d`;
  const v2End = `now-${GRACE_PERIOD_DAYS_V2 + PREMIUM_PERIOD_DAYS}d`;
  switch (phase) {
    case 'registered':
      return esRange('now', null);
    case 'grace':
      return esByVersion(esRange(v1Grace, 'now'), esRange(v2Grace, 'now'));
    case 'premium':
      return esByVersion(esRange(v1End, v1Grace), esRange(v2End, v2Grace));
    case 'available':
      return esByVersion(esRange(null, v1End), esRange(null, v2End));
  }
}

/** Elasticsearch query for names registered or in grace (not yet past the grace period). */
export function esWithinGracePeriodQuery(): object {
  return esByVersion(
    esRange(`now-${GRACE_PERIOD_DAYS_V1}d`, null),
    esRange(`now-${GRACE_PERIOD_DAYS_V2}d`, null)
  );
}
