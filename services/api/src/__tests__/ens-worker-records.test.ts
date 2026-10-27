/**
 * Unit tests for reading name records from the ENS worker (ensv2-records).
 * fetch is mocked; no API server or network needed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
// Imported per module: the shared index pulls in the DB layer
import {
  parseWorkerProfile,
  parseWorkerChains,
  fetchNameRecordsFromWorker,
  keepCachedRecordsWithoutResolver,
} from '../../../shared/src/utils/ens-worker';
import { contenthashFromUri } from '../../../shared/src/utils/contenthash-decoder';

const DAY = 24 * 60 * 60 * 1000;

// Shape returned by GET /n/:name (from mainnet-api for nick.eth, trimmed)
const PROFILE = {
  name: 'nick.eth',
  address: '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5',
  avatar: 'https://euc.li/nick.eth',
  display: 'nick.eth',
  records: {
    avatar: 'https://euc.li/nick.eth',
    'com.github': 'arachnid',
    description: 'Lead developer of ENS & Ethereum Foundation alum.',
    empty: '',
  },
  chains: {
    eth: '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5',
    btc: 'bc1qj0y7zgt7z6yquf3wnth3y8xdjzlxcs3x4fncyp',
    base: '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5',
    '2147483658': '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5',
  },
  contenthash: 'ipns://k51qzi5uqu5dgccx524mfjv7znyfsa6g013o6v4yvis9dxnrjbwojc62pt0430',
  fresh: 1792638849729,
  resolver: '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41',
};

describe('parseWorkerProfile', () => {
  it('converts text records, chains and contenthash to the metadata shape', () => {
    const metadata = parseWorkerProfile(PROFILE);

    expect(metadata['com.github']).toBe('arachnid');
    expect(metadata.avatar).toBe('https://euc.li/nick.eth');
    expect(metadata.empty).toBeUndefined();

    expect(metadata.chains).toEqual([
      { coinType: 0, chainName: 'Bitcoin', address: 'bc1qj0y7zgt7z6yquf3wnth3y8xdjzlxcs3x4fncyp' },
      { coinType: 60, chainName: 'Ethereum', address: '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5' },
      { coinType: 2147483658, chainId: 10, chainName: 'Optimism', address: '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5' },
      { coinType: 2147492101, chainId: 8453, chainName: 'Base', address: '0xb8c2C29ee19D8307cb7255e1Cd9CbDE883A267d5' },
    ]);

    expect(metadata.contenthash).toEqual({
      protocol: 'ipns',
      value: 'k51qzi5uqu5dgccx524mfjv7znyfsa6g013o6v4yvis9dxnrjbwojc62pt0430',
    });
  });

  it('omits chains and contenthash when the profile has none', () => {
    const metadata = parseWorkerProfile({ name: 'allada.eth', records: {}, chains: {} });
    expect(metadata).toEqual({});
  });

  it('skips unknown chain keys', () => {
    expect(parseWorkerChains({ notachain: '0x1' })).toEqual([]);
  });
});

describe('contenthashFromUri', () => {
  it.each([
    ['ipfs://bafybeiesmy6rsaglneqxbzkbdj5degzp2izydfadhl2vu3oyrp7k52fypu', 'ipfs'],
    ['bzz://d1de9994b4d039f6548d191eb26786769f580809256b4685ef316805265ea162', 'swarm'],
    ['ar://abc', 'arweave'],
  ])('parses %s', (uri, protocol) => {
    expect(contenthashFromUri(uri)?.protocol).toBe(protocol);
  });

  it('returns null for unknown or empty values', () => {
    expect(contenthashFromUri('https://example.com')).toBeNull();
    expect(contenthashFromUri('ipfs://')).toBeNull();
    expect(contenthashFromUri(undefined)).toBeNull();
  });
});

describe('fetchNameRecordsFromWorker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (status: number, body: unknown) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  it('returns records and the lowercased resolver', async () => {
    const fetchMock = stubFetch(200, PROFILE);
    const result = await fetchNameRecordsFromWorker('nick.eth', { fresh: true });

    expect(fetchMock.mock.calls[0][0]).toMatch(/\/n\/nick\.eth\?fresh=true$/);
    expect(result.found).toBe(true);
    if (result.found) {
      expect(result.resolverAddress).toBe('0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41');
      expect(result.records['com.github']).toBe('arachnid');
    }
  });

  it('treats 404 as no resolver', async () => {
    stubFetch(404, { status: 404, error: 'Not Found' });
    await expect(fetchNameRecordsFromWorker('matan1.eth')).resolves.toEqual({ found: false });
  });

  it('throws on resolver errors so callers can fall back', async () => {
    stubFetch(502, { status: 502, error: 'resolver reverted without data' });
    await expect(fetchNameRecordsFromWorker('cid.eth')).rejects.toThrow(/502/);
  });
});

describe('keepCachedRecordsWithoutResolver', () => {
  const ago = (days: number) => new Date(Date.now() - days * DAY);

  it('keeps cached records during the grace period', () => {
    expect(keepCachedRecordsWithoutResolver(ago(10), 2)).toBe(true);
    expect(keepCachedRecordsWithoutResolver(ago(70), 1)).toBe(true);
  });

  it('drops records for registered names and names past grace', () => {
    expect(keepCachedRecordsWithoutResolver(ago(-30), 2)).toBe(false);
    expect(keepCachedRecordsWithoutResolver(ago(30), 2)).toBe(false);
    expect(keepCachedRecordsWithoutResolver(ago(100), 1)).toBe(false);
    expect(keepCachedRecordsWithoutResolver(null, 1)).toBe(false);
  });
});
