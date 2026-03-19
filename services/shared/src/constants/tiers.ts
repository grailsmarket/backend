/**
 * Maps on-chain uint256 tier IDs to backend tier names.
 * Source of truth: GrailsSubscription.sol tier IDs.
 *
 * When new tiers are added to the contract, update this file.
 */

export const TIER_MAP: Record<number, string> = {
  0: 'free',
  1: 'pro',
};

export const TIER_ID_MAP: Record<string, number> = Object.fromEntries(
  Object.entries(TIER_MAP).map(([id, name]) => [name, Number(id)])
);

/**
 * Tier hierarchy for comparison. Higher number = higher tier.
 * Used by requireMinTier() for "at least this tier" checks.
 */
export const TIER_RANK: Record<string, number> = {
  free: 0,
  pro: 1,
};

/** Convert a contract tier_id (uint256) to a tier name string */
export function tierIdToName(tierId: number): string {
  return TIER_MAP[tierId] ?? 'free';
}

/** Convert a tier name to a contract tier_id */
export function tierNameToId(name: string): number {
  return TIER_ID_MAP[name] ?? 0;
}
