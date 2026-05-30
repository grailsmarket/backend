/**
 * ENS names hidden from public-facing registration listings
 * (the `GET /api/v1/analytics/registrations` results list).
 *
 * Add the FULL ENS name including the `.eth` suffix, lowercased.
 * Example: 'somename.eth'
 * Matching is case-insensitive.
 */
export const REGISTRATION_NAME_BLOCKLIST: string[] = [
  'nigger.eth'
];
