/**
 * Unit tests for isCurrentlyWrapped (no server or subgraph needed).
 *
 * The subgraph keeps wrappedDomain / wrappedOwner after a wrapped name expires and is
 * re-registered unwrapped, so those fields must not decide the wrapped state.
 */

import { describe, it, expect, vi } from 'vitest';

const NAME_WRAPPER = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

// The shared index also loads a stale compiled migrate.js that breaks under vitest, so expose
// the real config and stub the rest of what ens-roles imports.
vi.mock('../../../shared/src', async () => ({
  ...(await import('../../../shared/src/config')),
  getPostgresPool: () => ({ query: vi.fn() }),
  isEnsV2Name: vi.fn(),
  ensV2LabelId: vi.fn(),
  getEnsV2State: vi.fn(),
  getEnsV2Resolver: vi.fn(),
  checkEnsV2Transferable: vi.fn(),
  EnsV2Status: {},
}));

import { isCurrentlyWrapped } from '../services/ens-roles';
const acct = (id: string) => ({ id });

describe('isCurrentlyWrapped', () => {
  it('ignores leftover wrapper data on a re-registered unwrapped 2LD (99club.eth)', () => {
    // Subgraph data for 99club.eth on 2026-10-29: unwrapped and owned by 0x163b…, with the
    // previous owner's lapsed wrap (wrapper expiry 2026-01-21) still attached.
    const domain = {
      owner: acct('0x163bb0e6194793e1064cb69160daaaa65c111e08'),
      registrant: acct('0x163bb0e6194793e1064cb69160daaaa65c111e08'),
      wrappedOwner: acct('0x0677cc37fb6f776b5900e5e0f499b24676d80a1e'),
      wrappedDomain: { owner: acct('0x0677cc37fb6f776b5900e5e0f499b24676d80a1e'), fuses: 196608, expiryDate: '1768973273' },
    };
    expect(isCurrentlyWrapped(domain)).toBe(false);
  });

  it('detects a wrapped 2LD (registrar token held by the NameWrapper)', () => {
    expect(isCurrentlyWrapped({ owner: acct(NAME_WRAPPER), registrant: acct(NAME_WRAPPER) })).toBe(true);
  });

  it('uses registration.registrant when registrant is missing', () => {
    expect(isCurrentlyWrapped({
      owner: acct(NAME_WRAPPER),
      registrant: null,
      registration: { registrant: acct(NAME_WRAPPER), expiryDate: '0' },
    })).toBe(true);
  });

  it('treats a plain unwrapped 2LD as unwrapped', () => {
    const a = acct('0x1111111111111111111111111111111111111111');
    expect(isCurrentlyWrapped({ owner: a, registrant: a })).toBe(false);
  });

  it('detects a wrapped subname by its registry owner', () => {
    expect(isCurrentlyWrapped({ owner: acct(NAME_WRAPPER), registrant: null })).toBe(true);
  });

  it('treats an unwrapped subname with leftover wrapper data as unwrapped', () => {
    expect(isCurrentlyWrapped({ owner: acct('0x2222222222222222222222222222222222222222'), registrant: null })).toBe(false);
  });
});
