/**
 * Unit tests for registrationFields: the registration_status / grace_ends_at /
 * premium_ends_at fields on name and search results. No DB or network needed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { registrationFields } from '../utils/registration-fields';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-10-27T12:00:00Z').getTime();
const daysAgo = (d: number) => new Date(NOW - d * DAY);

describe('registrationFields', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function at(fn: () => void) {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    fn();
  }

  it('v1: 90-day grace, then 21-day premium', () => {
    at(() => {
      expect(registrationFields('a.eth', daysAgo(-1), 1).registration_status).toBe('registered');
      expect(registrationFields('a.eth', daysAgo(89), 1).registration_status).toBe('grace');
      expect(registrationFields('a.eth', daysAgo(91), 1).registration_status).toBe('premium');
      expect(registrationFields('a.eth', daysAgo(112), 1).registration_status).toBe('available');
    });
  });

  it('v2: 28-day grace, then 21-day premium', () => {
    at(() => {
      expect(registrationFields('a.eth', daysAgo(27), 2).registration_status).toBe('grace');
      expect(registrationFields('a.eth', daysAgo(29), 2).registration_status).toBe('premium');
      expect(registrationFields('a.eth', daysAgo(50), 2).registration_status).toBe('available');
    });
  });

  it('phase end dates follow the version', () => {
    const expiry = new Date('2026-01-01T00:00:00Z');
    const v1 = registrationFields('a.eth', expiry, 1);
    expect(v1.grace_ends_at?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(v1.premium_ends_at?.toISOString()).toBe('2026-04-22T00:00:00.000Z');
    const v2 = registrationFields('a.eth', expiry.toISOString(), 2);
    expect(v2.grace_ends_at?.toISOString()).toBe('2026-01-29T00:00:00.000Z');
    expect(v2.premium_ends_at?.toISOString()).toBe('2026-02-19T00:00:00.000Z');
  });

  it('never-registered .eth names are available with no dates', () => {
    expect(registrationFields('a.eth', null, null)).toEqual({
      registration_status: 'available',
      grace_ends_at: null,
      premium_ends_at: null,
    });
  });

  it('subnames have no registration status', () => {
    expect(registrationFields('sub.a.eth', daysAgo(10), 1).registration_status).toBeNull();
    expect(registrationFields('sub.a.eth', null, null).registration_status).toBeNull();
  });
});
