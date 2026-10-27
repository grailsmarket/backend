// Kept out of response-builder so it can be imported without the DB layer (unit tests).
import {
  getExpiryPhase,
  getGracePeriodEnd,
  PREMIUM_PERIOD_DAYS,
  type ExpiryPhase,
} from '../../../shared/src/utils/expiry-phase';

export interface RegistrationFields {
  registration_status: ExpiryPhase | null;
  grace_ends_at: Date | null;
  premium_ends_at: Date | null;
}

/**
 * registration_status, grace_ends_at and premium_ends_at for a name. Second-level .eth
 * names with no expiry were never registered, so they're available (matching the
 * status=available search filter). Subnames have no registration phase.
 */
export function registrationFields(
  name: string,
  expiryDate: Date | string | null | undefined,
  ensVersion: number | null | undefined
): RegistrationFields {
  const isSecondLevelEth = /^[^.]+\.eth$/i.test(name);
  if (!expiryDate) {
    return {
      registration_status: isSecondLevelEth ? 'available' : null,
      grace_ends_at: null,
      premium_ends_at: null,
    };
  }
  const graceEnd = getGracePeriodEnd(expiryDate, ensVersion);
  return {
    registration_status: isSecondLevelEth ? getExpiryPhase(expiryDate, ensVersion) : null,
    grace_ends_at: graceEnd,
    premium_ends_at: new Date(graceEnd.getTime() + PREMIUM_PERIOD_DAYS * 24 * 60 * 60 * 1000),
  };
}
