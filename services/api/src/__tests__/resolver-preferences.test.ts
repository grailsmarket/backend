/**
 * Unit tests for resolver labels / preferred resolver (no DB or network: fetch is stubbed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { config } from '../../../shared/src/config';
import {
  EnsWorkerUnavailableError,
  buildResolverList,
  fetchAccountResolvers,
  fetchResolver,
  fetchResolverRecord,
  labelRecords,
  likeContains,
  type WorkerAccountResolver,
} from '../services/resolver-preferences';

const A = '0x72d374ff9f8600cd386e1fd4c853564836de45b1';
const B = '0x8ff0b7968c04c3fb189b721363754c07be3ebfee';
const C = '0x41edc64aa5405884d9ffe00ce74f0577b09f7f10';
const res = (address: string, manages_records = true): WorkerAccountResolver => ({ address, manages_records, record_count: 3 });

describe('buildResolverList', () => {
  const resolvers = [res(A), res(B), res(C, false)];

  it('puts the preferred resolver first and keeps the worker order otherwise', () => {
    const list = buildResolverList(resolvers, new Map([[B, 'Main']]), B);
    expect(list.resolvers.map((r) => r.address)).toEqual([B, A, C]);
    expect(list.resolvers[0]).toMatchObject({ label: 'Main', isPreferred: true });
    expect(list.resolvers[1]).toMatchObject({ label: null, isPreferred: false });
    expect(list.resolvers[0].resolver).toBe(resolvers[1]);
    expect(list.preferred).toEqual({ address: B, label: 'Main', hasRoles: true });
    expect(list.total).toBe(3);
  });

  it('flags a preferred resolver the user can no longer manage', () => {
    expect(buildResolverList(resolvers, new Map(), C).preferred?.hasRoles).toBe(false);
    const gone = '0x0000000000000000000000000000000000000001';
    const list = buildResolverList(resolvers, new Map(), gone);
    expect(list.preferred).toEqual({ address: gone, label: null, hasRoles: false });
    expect(list.resolvers.some((r) => r.isPreferred)).toBe(false);
  });

  it('filters by label or address, case-insensitively', () => {
    const labels = new Map([[A, 'Personal Names'], [B, 'Work']]);
    expect(buildResolverList(resolvers, labels, null, 'personal').resolvers.map((r) => r.address)).toEqual([A]);
    expect(buildResolverList(resolvers, labels, null, '0x41EDC').resolvers.map((r) => r.address)).toEqual([C]);
    const none = buildResolverList(resolvers, labels, null, 'nothing');
    expect([none.total, none.resolvers]).toEqual([0, []]);
    expect(buildResolverList(resolvers, labels, null, '  ').total).toBe(3);
  });

  it('has no preferred entry when none is set', () => {
    expect(buildResolverList(resolvers, new Map(), null).preferred).toBeNull();
  });
});

describe('labelRecords / likeContains', () => {
  it('pairs records with labels', () => {
    const records = [{ record_id: '1' }, { record_id: '2' }];
    expect(labelRecords(records, new Map([['2', 'Default']]))).toEqual([
      { recordId: '1', label: null, record: records[0] },
      { recordId: '2', label: 'Default', record: records[1] },
    ]);
  });

  it('escapes LIKE wildcards', () => {
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });
});

describe('ENS worker client', () => {
  const original = config.ensWorker.url;
  beforeEach(() => {
    config.ensWorker.url = 'https://worker.test';
  });
  afterEach(() => {
    config.ensWorker.url = original;
    vi.unstubAllGlobals();
  });

  const stubFetch = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('lists an account’s resolvers', async () => {
    const fetchMock = stubFetch(200, { account: A, resolvers: [res(A)] });
    expect(await fetchAccountResolvers('0xabc')).toEqual([res(A)]);
    expect(fetchMock.mock.calls[0][0]).toBe('https://worker.test/v2/resolvers?account=0xabc');
  });

  it('returns null for unknown resolvers', async () => {
    stubFetch(404, { status: 404, error: 'Not Found' });
    expect(await fetchResolver(A)).toBeNull();
  });

  it('reads one record as a page of one', async () => {
    const fetchMock = stubFetch(200, { records: [{ record_id: '3' }] });
    expect(await fetchResolverRecord(A, '3')).toEqual({ record_id: '3' });
    expect(fetchMock.mock.calls[0][0]).toBe(`https://worker.test/v2/resolvers/${A}/records?limit=1&offset=2`);
  });

  it('reports the worker as unavailable on errors, a missing index, or no worker', async () => {
    stubFetch(501, { status: 501, error: 'records index not configured' });
    await expect(fetchAccountResolvers('0xabc')).rejects.toBeInstanceOf(EnsWorkerUnavailableError);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('timeout')));
    await expect(fetchResolver(A)).rejects.toBeInstanceOf(EnsWorkerUnavailableError);
    config.ensWorker.url = null as unknown as string;
    await expect(fetchResolver(A)).rejects.toBeInstanceOf(EnsWorkerUnavailableError);
  });
});
