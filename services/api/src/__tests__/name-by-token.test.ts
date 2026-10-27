/**
 * Unit tests for finding a name by (contract, token id). The database, the ENS worker and the
 * NameWrapper call are mocked; no API server, database or network needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { labelhash, namehash, toHex } from 'viem';
import { packetToBytes } from 'viem/ens';

const { queryMock, readContractMock } = vi.hoisted(() => ({ queryMock: vi.fn(), readContractMock: vi.fn() }));

vi.mock('../../../shared/src/db/client', () => ({ getPostgresPool: () => ({ query: queryMock }) }));
vi.mock('viem', async (importOriginal) => ({
  ...(await importOriginal<typeof import('viem')>()),
  createPublicClient: () => ({ readContract: readContractMock }),
}));

import { config } from '../../../shared/src/config';
import {
  parseTokenIdParam,
  tokenContractKind,
  dnsDecodeName,
  currentTokenOf,
  findNameByToken,
} from '../../../shared/src/utils/name-by-token';

const REGISTRY = '0xd4ebcbbdf463c9c45784603db0ddd499bc44a8b4';
const REGISTRAR = config.blockchain.ensRegistrarAddress.toLowerCase();
const WRAPPER = config.blockchain.ensNameWrapperAddress.toLowerCase();

const lh = (label: string) => BigInt(labelhash(label));
const nh = (name: string) => BigInt(namehash(name));
const v2Id = (label: string, version = 0) => (lh(label) & ~0xffffffffn) | BigInt(version);
const hex = (id: bigint) => `0x${id.toString(16).padStart(64, '0')}`;

interface Row {
  id: number;
  name: string;
  token_id: string;
  ens_version: number;
  labelhash?: string;
  token_contract?: string;
}

// unwrapped v1, wrapped v1 (namehash token), migrated to v2 (regenerated once: version 1)
const ROWS: Row[] = [
  { id: 1, name: 'alice.eth', token_id: lh('alice').toString(), ens_version: 1 },
  { id: 2, name: 'bob.eth', token_id: nh('bob.eth').toString(), ens_version: 1 },
  { id: 3, name: 'carol.eth', token_id: v2Id('carol', 1).toString(), ens_version: 2, labelhash: hex(lh('carol')), token_contract: REGISTRY },
  { id: 4, name: 'dave.eth', token_id: lh('dave').toString(), ens_version: 1 },
];
const HISTORY = [{ token_contract: REGISTRY, token_id: v2Id('carol').toString(), ens_name_id: 3 }];

// Answers the queries findNameByToken makes, from ROWS and HISTORY
function fakeQuery(sql: string, params: unknown[]) {
  const rows = (list: Row[]) => ({ rows: list.slice(0, 1).map(({ id, name, token_id }) => ({ id, name, token_id })) });
  if (sql.includes('ens_token_ids')) {
    const current = ROWS.filter((r) => r.ens_version === 2 && r.token_id === params[0]);
    const old = HISTORY.filter((h) => h.token_contract === params[1] && h.token_id === params[0]).map(
      (h) => ROWS.find((r) => r.id === h.ens_name_id)!
    );
    return rows([...current, ...old]);
  }
  if (sql.includes('ens_version = 1')) return rows(ROWS.filter((r) => r.ens_version === 1 && r.token_id === params[0]));
  if (sql.includes('labelhash = $1')) return rows(ROWS.filter((r) => r.labelhash === params[0]));
  if (sql.includes('name = $1')) return rows(ROWS.filter((r) => r.name === params[0]));
  throw new Error(`unexpected query: ${sql}`);
}

describe('token id parsing and contracts', () => {
  it('accepts decimal and hex uint256 ids', () => {
    expect(parseTokenIdParam('42')).toBe(42n);
    expect(parseTokenIdParam('0x2a')).toBe(42n);
    expect(parseTokenIdParam((2n ** 256n - 1n).toString())).toBe(2n ** 256n - 1n);
    for (const bad of ['', '-1', '1.5', 'abc', '0x', (2n ** 256n).toString(), `0x${'f'.repeat(65)}`]) {
      expect(parseTokenIdParam(bad), bad).toBeNull();
    }
  });

  it('knows the three ENS NFT contracts, in any case', () => {
    const saved = config.blockchain.ensv2;
    config.blockchain.ensv2 = { ...(saved ?? ({} as any)), ethRegistryAddress: REGISTRY };
    try {
      expect(tokenContractKind(REGISTRAR.toUpperCase().replace('0X', '0x'))).toBe('v1-registrar');
      expect(tokenContractKind(WRAPPER)).toBe('v1-wrapper');
      expect(tokenContractKind(REGISTRY)).toBe('v2-registry');
      expect(tokenContractKind('0x0000000000000000000000000000000000000001')).toBeNull();
      expect(tokenContractKind('nope')).toBeNull();
    } finally {
      config.blockchain.ensv2 = saved;
    }
  });

  it('decodes DNS wire-format names', () => {
    expect(dnsDecodeName(toHex(packetToBytes('sub.bob.eth')))).toBe('sub.bob.eth');
    // NameWrapper.names() on mainnet, for a name wrapped recently
    expect(dnsDecodeName('0x07666c65786176670365746800')).toBe('flexavg.eth');
    expect(dnsDecodeName('0x')).toBeNull();
    expect(dnsDecodeName('0x00')).toBeNull();
    expect(dnsDecodeName('0x05616263')).toBeNull(); // length runs past the end
  });

  it('works out the current token contract of a v1 name from its token id', () => {
    expect(currentTokenOf({ ...ROWS[0], token_contract: null })).toEqual({ contract: REGISTRAR, token_id: ROWS[0].token_id });
    expect(currentTokenOf({ ...ROWS[1], token_contract: null })).toEqual({ contract: WRAPPER, token_id: ROWS[1].token_id });
    expect(currentTokenOf({ ...ROWS[2], token_contract: REGISTRY })).toEqual({ contract: REGISTRY, token_id: ROWS[2].token_id });
  });
});

describe('findNameByToken', () => {
  const saved = { ensv2: config.blockchain.ensv2, worker: config.ensWorker.url };
  let fetchMock: ReturnType<typeof vi.fn>;
  const workerReturns = (status: number, body: unknown = {}) =>
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    );

  beforeEach(() => {
    config.blockchain.ensv2 = { ...(saved.ensv2 ?? ({} as any)), ethRegistryAddress: REGISTRY };
    config.ensWorker.url = 'http://worker.test';
    queryMock.mockReset().mockImplementation(async (sql: string, params: unknown[]) => fakeQuery(sql, params));
    readContractMock.mockReset();
    fetchMock = vi.fn();
    workerReturns(404, { status: 404, error: 'Not Found' });
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    config.blockchain.ensv2 = saved.ensv2;
    config.ensWorker.url = saved.worker;
    vi.unstubAllGlobals();
  });

  it('v1 BaseRegistrar: labelhash of an unwrapped name', async () => {
    expect(await findNameByToken(REGISTRAR, lh('alice'))).toMatchObject({ id: 1, name: 'alice.eth' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v1 BaseRegistrar: labelhash of a migrated name', async () => {
    expect(await findNameByToken(REGISTRAR, lh('carol'))).toMatchObject({ id: 3, name: 'carol.eth' });
  });

  it('v1 BaseRegistrar: labelhash of a wrapped name, through the worker, matched in full', async () => {
    workerReturns(200, { name: 'bob.eth', labelhash: hex(lh('bob')), status: 'reserved', current: false });
    expect(await findNameByToken(REGISTRAR, lh('bob'))).toMatchObject({ id: 2, name: 'bob.eth' });
    expect(fetchMock.mock.calls[0][0]).toBe(`http://worker.test/v2/token/${REGISTRY}/${lh('bob')}`);
    // same high bits, different low bits: not bob's labelhash
    expect(await findNameByToken(REGISTRAR, lh('bob') ^ 1n)).toBeNull();
  });

  it('v1 NameWrapper: namehash of a wrapped name, else NameWrapper.names() on chain', async () => {
    expect(await findNameByToken(WRAPPER, nh('bob.eth'))).toMatchObject({ id: 2, name: 'bob.eth' });
    expect(readContractMock).not.toHaveBeenCalled();
    readContractMock.mockResolvedValue(toHex(packetToBytes('dave.eth')));
    expect(await findNameByToken(WRAPPER, nh('dave.eth'))).toMatchObject({ id: 4, name: 'dave.eth' });
    expect(readContractMock.mock.calls[0][0]).toMatchObject({ functionName: 'names', args: [hex(nh('dave.eth'))] });
    readContractMock.mockResolvedValue('0x');
    expect(await findNameByToken(WRAPPER, nh('never-wrapped.eth'))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('v2 ETHRegistry: current id, an older id, and a reserved label through the worker', async () => {
    expect(await findNameByToken(REGISTRY, v2Id('carol', 1))).toMatchObject({ id: 3 });
    expect(await findNameByToken(REGISTRY, v2Id('carol'))).toMatchObject({ id: 3 });
    expect(fetchMock).not.toHaveBeenCalled();
    workerReturns(200, { name: 'alice.eth', labelhash: hex(lh('alice')), status: 'reserved', current: true });
    expect(await findNameByToken(REGISTRY, v2Id('alice'))).toMatchObject({ id: 1, name: 'alice.eth' });
  });

  it('not found, unknown contracts and worker errors', async () => {
    expect(await findNameByToken(REGISTRY, v2Id('nobody'))).toBeNull();
    expect(await findNameByToken('0x0000000000000000000000000000000000000001', 1n)).toBeNull();
    // worker knows the label but Grails doesn't have the name
    workerReturns(200, { name: 'stranger.eth', labelhash: hex(lh('stranger')), status: 'registered', current: true });
    expect(await findNameByToken(REGISTRY, v2Id('stranger'))).toBeNull();
    workerReturns(500, { status: 500, error: 'boom' });
    await expect(findNameByToken(REGISTRY, v2Id('nobody'))).rejects.toThrow(/500/);
  });

  it('without ENSv2 configured, the ETHRegistry is not a supported contract', async () => {
    config.blockchain.ensv2 = null as any;
    expect(await findNameByToken(REGISTRY, v2Id('carol', 1))).toBeNull();
    // and BaseRegistrar lookups skip the worker
    expect(await findNameByToken(REGISTRAR, lh('bob'))).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
