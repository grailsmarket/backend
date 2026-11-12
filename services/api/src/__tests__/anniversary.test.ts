/**
 * Anniversary NFT: proofs.json validation (pure) and GET /api/v1/anniversary/proof/:address.
 * The database and the Redis response cache are mocked; no API server, database or network needed.
 *
 * FIXTURE was generated with @openzeppelin/merkle-tree 1.0.8 StandardMerkleTree.of(values,
 * ['address', 'uint256']) — 2 special + 3 generic — so the proof checks are tested against the
 * reference implementation, not just against themselves.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { queryMock, cacheOptions } = vi.hoisted(() => ({ queryMock: vi.fn(), cacheOptions: [] as any[] }));

// The shared index also loads a stale compiled migrate.js that breaks under vitest; the route only
// needs the pool.
vi.mock('../../../shared/src', () => ({ getPostgresPool: () => ({ query: queryMock }) }));
vi.mock('../middleware/cache', () => ({
  createCacheHandler: (options: any) => {
    cacheOptions.push(options);
    return async () => {};
  },
}));

import {
  anniversaryLeafHash,
  replaceAnniversaryClaims,
  validateAnniversaryProofs,
  verifyAnniversaryProof,
} from '../services/anniversary-nft';
import { anniversaryRoutes, anniversaryProofCacheKey } from '../routes/anniversary';

const FIXTURE = {
  merkleRoot: '0xa04157cb360ac4705fe2066ddbd611101d5ead91e0581fa94a09ce4584d1ee73',
  leafEncoding: ['address', 'uint256'],
  counts: { special: 2, generic: 3, total: 5 },
  claims: {
    '0xeca9aa4343c1d81f32f2f10a9e0e40c1a89b9c24': {
      address: '0xeca9aa4343c1D81F32f2F10a9E0E40c1A89b9C24',
      tokenId: 1,
      type: 'special',
      proof: [
        '0xdfebc4e4a6efb800236341033b64c2629b13d18cb10860de880c0d231426e74c',
        '0x1db20961ed4d8c602da7d3961349c7e34109f5b9adba7185e14ed4fd2941cefa',
      ],
    },
    '0x0aa899d93956365648639e943eac976e8f594f7f': {
      address: '0x0AA899d93956365648639e943eac976E8f594f7F',
      tokenId: 2,
      type: 'special',
      proof: [
        '0xd2cd7031e4993542b0d3920180578572e1f87678dec889a3f3731edba09eda39',
        '0x1db20961ed4d8c602da7d3961349c7e34109f5b9adba7185e14ed4fd2941cefa',
      ],
    },
    '0x4ee353223184c90e908c0865ad42883baf9bfb75': {
      address: '0x4Ee353223184c90E908C0865aD42883Baf9BFb75',
      tokenId: 3,
      type: 'generic',
      proof: [
        '0x0cba9063b6d520e37807efd21e23776aa86894c70143412d88b4a689150def11',
        '0xe0791eab9faa755baa30c8feea3a3b451e60f6909d870306988caaa50ad1d0ed',
        '0x996c8163f99d33d54e7a76d8c6b9353de2c7cde26337efb2d908211041a8fe70',
      ],
    },
    '0x96189b45b9b345702fbbc899e1099ec5cf5c2c78': {
      address: '0x96189B45b9B345702FbbC899e1099ec5cf5c2C78',
      tokenId: 4,
      type: 'generic',
      proof: [
        '0x2e2c407f3ac48885109efd65ac51c3d5d0acaa1e79c208ead5b55f8c78baec1b',
        '0x996c8163f99d33d54e7a76d8c6b9353de2c7cde26337efb2d908211041a8fe70',
      ],
    },
    '0xa8d9fee9cc33c9b8fce5d952b31c7c42fec7f789': {
      address: '0xA8d9FEe9CC33C9B8FCe5D952b31C7c42FEc7F789',
      tokenId: 5,
      type: 'generic',
      proof: [
        '0x8d98787e5f378cd182fcb5a039ddb2f870316373ecbeece935ca74c398e63984',
        '0xe0791eab9faa755baa30c8feea3a3b451e60f6909d870306988caaa50ad1d0ed',
        '0x996c8163f99d33d54e7a76d8c6b9353de2c7cde26337efb2d908211041a8fe70',
      ],
    },
  } as Record<string, any>,
};

const A1 = '0xeca9aa4343c1d81f32f2f10a9e0e40c1a89b9c24'; // token 1, special
const A1_CHECKSUM = '0xeca9aa4343c1D81F32f2F10a9E0E40c1A89b9C24';
const A3 = '0x4ee353223184c90e908c0865ad42883baf9bfb75'; // token 3, generic

const fixture = () => structuredClone(FIXTURE);

/** Run validation and return its errors (empty when valid). */
const errorsOf = (input: unknown, options?: { verifyProofs?: boolean }) => {
  const result = validateAnniversaryProofs(input, options);
  return result.ok ? [] : result.errors;
};

describe('merkle proofs', () => {
  it('hashes leaves like StandardMerkleTree', () => {
    expect(anniversaryLeafHash(A1_CHECKSUM, 1)).toBe('0xd2cd7031e4993542b0d3920180578572e1f87678dec889a3f3731edba09eda39');
    expect(anniversaryLeafHash(A1, 1n)).toBe(anniversaryLeafHash(A1_CHECKSUM, 1));
  });

  it('verifies every OpenZeppelin proof, and nothing else', () => {
    for (const [address, claim] of Object.entries(FIXTURE.claims)) {
      expect(verifyAnniversaryProof(address, claim.tokenId, claim.proof, FIXTURE.merkleRoot)).toBe(true);
      expect(verifyAnniversaryProof(address, claim.tokenId + 1, claim.proof, FIXTURE.merkleRoot)).toBe(false);
    }
    // case-insensitive hex
    const c = FIXTURE.claims[A1];
    expect(verifyAnniversaryProof(A1, 1, c.proof.map((p: string) => p.toUpperCase().replace('0X', '0x')), FIXTURE.merkleRoot.toUpperCase().replace('0X', '0x'))).toBe(true);
    expect(verifyAnniversaryProof(A3, 1, c.proof, FIXTURE.merkleRoot)).toBe(false);
  });
});

describe('validateAnniversaryProofs', () => {
  it('accepts a valid file, normalised and ordered by token id', () => {
    const input = fixture();
    input.merkleRoot = input.merkleRoot.toUpperCase().replace('0X', '0x');
    const result = validateAnniversaryProofs(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proofs.merkleRoot).toBe(FIXTURE.merkleRoot);
    expect(result.proofs.counts).toEqual({ special: 2, generic: 3, total: 5 });
    expect(result.proofs.claims.map((c) => c.tokenId)).toEqual([1, 2, 3, 4, 5]);
    expect(result.proofs.claims[0]).toEqual({ address: A1, tokenId: 1, type: 'special', proof: FIXTURE.claims[A1].proof });
  });

  it('rejects malformed top-level fields', () => {
    expect(errorsOf(null)).toEqual(['proofs file must be a JSON object']);
    expect(errorsOf([])).toEqual(['proofs file must be a JSON object']);

    for (const merkleRoot of ['0x1234', 'a04157cb360ac4705fe2066ddbd611101d5ead91e0581fa94a09ce4584d1ee73', 42, undefined]) {
      expect(errorsOf({ ...fixture(), merkleRoot })[0], String(merkleRoot)).toMatch(/^merkleRoot must be/);
    }
    for (const leafEncoding of [['uint256', 'address'], ['address'], ['address', 'uint256', 'bytes32'], 'address,uint256']) {
      expect(errorsOf({ ...fixture(), leafEncoding })[0], String(leafEncoding)).toMatch(/^leafEncoding must be/);
    }
    for (const counts of [undefined, { special: 2, generic: 3 }, { special: -1, generic: 6, total: 5 }, { special: 2, generic: 3, total: '5' }, { special: 0, generic: 0, total: 0 }]) {
      expect(errorsOf({ ...fixture(), counts }), JSON.stringify(counts)).toEqual([expect.stringMatching(/^counts must be/)]);
    }
    expect(errorsOf({ ...fixture(), counts: { special: 2, generic: 2, total: 5 } })).toEqual([expect.stringContaining('!= counts.total')]);
    expect(errorsOf({ ...fixture(), claims: [] })).toEqual(['claims must be an object keyed by lowercase address']);
  });

  it('keeps checking claims when only the root is bad', () => {
    const input = fixture();
    input.merkleRoot = '0x1234';
    input.claims[A3].tokenId = 99;
    const errors = errorsOf(input);
    expect(errors[0]).toMatch(/^merkleRoot must be/);
    expect(errors).toContainEqual(expect.stringContaining('tokenId 99 is not an integer in 1..5'));
  });

  it('requires lowercase keys that match a valid, checksummed address', () => {
    let input = fixture();
    input.claims[A1_CHECKSUM] = input.claims[A1];
    delete input.claims[A1];
    expect(errorsOf(input)).toEqual([`claims[${A1_CHECKSUM}]: key is not a lowercase 0x address`]);

    input = fixture();
    input.claims[A1].address = '0xEca9aa4343c1D81F32f2F10a9E0E40c1A89b9C24'; // one letter's case flipped
    expect(errorsOf(input)).toEqual([expect.stringContaining('is not a valid (checksummed) address')]);

    input = fixture();
    input.claims[A1].address = A1; // all-lowercase is fine
    expect(errorsOf(input)).toEqual([]);

    input = fixture();
    input.claims[A1].address = FIXTURE.claims[A3].address;
    expect(errorsOf(input)).toEqual([`claims[${A1}]: key does not match address ${FIXTURE.claims[A3].address}`]);

    input = fixture();
    input.claims[A1].address = 'vitalik.eth';
    expect(errorsOf(input)).toEqual([expect.stringContaining('is not a valid (checksummed) address')]);
  });

  it('requires unique token ids in 1..total', () => {
    for (const tokenId of [0, 6, 1.5, '1', null]) {
      const input = fixture();
      input.claims[A1].tokenId = tokenId;
      expect(errorsOf(input), String(tokenId)).toContainEqual(expect.stringContaining('is not an integer in 1..5'));
    }

    const input = fixture();
    input.claims[A3].tokenId = 4; // collides with another generic
    expect(errorsOf(input)).toContainEqual(expect.stringMatching(/tokenId 4 is also assigned to 0x/));
  });

  it('requires special iff tokenId <= counts.special', () => {
    let input = fixture();
    input.claims[A1].type = 'generic';
    expect(errorsOf(input)).toEqual([
      `claims[${A1}]: tokenId 1 must be "special" (special ids are 1..2), got "generic"`,
      'found 1 special claims but counts.special is 2',
      'found 4 generic claims but counts.generic is 3',
    ]);

    input = fixture();
    input.claims[A3].type = 'special';
    expect(errorsOf(input)).toContainEqual(`claims[${A3}]: tokenId 3 must be "generic" (special ids are 1..2), got "special"`);

    input = fixture();
    input.claims[A1].type = 'legendary';
    expect(errorsOf(input)).toContainEqual(expect.stringContaining('must be "special" or "generic"'));
  });

  it('requires counts to match the claims', () => {
    // counts consistent with each other, but the file has 5 claims and the ranges say 3 special
    const input = fixture();
    input.counts = { special: 3, generic: 3, total: 6 };
    const errors = errorsOf(input);
    expect(errors).toContainEqual('claims has 5 entries but counts.total is 6');
    expect(errors).toContainEqual(`claims[${A3}]: tokenId 3 must be "special" (special ids are 1..3), got "generic"`);
  });

  it('requires 0x + 64 hex proof elements', () => {
    for (const bad of ['0x1234', `0x${'g'.repeat(64)}`, `${'a'.repeat(64)}`, 7, null]) {
      const input = fixture();
      input.claims[A1].proof[1] = bad;
      expect(errorsOf(input), String(bad)).toEqual([expect.stringContaining(`claims[${A1}]: proof[1]`)]);
    }

    let input = fixture();
    input.claims[A1].proof = [];
    expect(errorsOf(input)).toEqual([`claims[${A1}]: proof is empty`]);

    input = fixture();
    input.claims[A1].proof = 'nope';
    expect(errorsOf(input)).toEqual([`claims[${A1}]: proof must be an array`]);
  });

  it('rejects proofs that do not verify against the root (unless verifyProofs is off)', () => {
    const input = fixture();
    input.claims[A1].proof[0] = `0x${'ab'.repeat(32)}`;
    expect(errorsOf(input)).toEqual([`claims[${A1}]: proof for tokenId 1 does not verify against merkleRoot`]);
    expect(errorsOf(input, { verifyProofs: false })).toEqual([]);

    // swapping two addresses' token ids keeps every structural rule but breaks both proofs
    const swapped = fixture();
    swapped.claims[A1].tokenId = 2;
    swapped.claims['0x0aa899d93956365648639e943eac976e8f594f7f'].tokenId = 1;
    expect(errorsOf(swapped)).toHaveLength(2);
  });
});

describe('replaceAnniversaryClaims', () => {
  const proofs = () => {
    const result = validateAnniversaryProofs(fixture());
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return result.proofs;
  };
  const fakeClient = (check: Record<string, unknown>) => {
    const calls: { sql: string; params?: unknown[] }[] = [];
    return {
      calls,
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.startsWith('DELETE')) return { rowCount: 7, rows: [] };
        if (sql.includes('COUNT(*)')) return { rowCount: 1, rows: [check] };
        return { rowCount: params ? (params.length - 1) / 4 : 0, rows: [] };
      },
    };
  };
  const goodCheck = { total: 5, special: 2, roots: 1, root: FIXTURE.merkleRoot };

  it('deletes everything, then inserts in batches sharing the root parameter', async () => {
    const client = fakeClient(goodCheck);
    const progress: number[] = [];
    expect(await replaceAnniversaryClaims(client, proofs(), { batchSize: 2, onProgress: (n) => progress.push(n) })).toEqual({ deleted: 7, inserted: 5 });

    expect(client.calls[0].sql).toBe('DELETE FROM anniversary_nft_claims');
    const inserts = client.calls.filter((c) => c.sql.includes('INSERT'));
    expect(inserts).toHaveLength(3);
    expect(inserts[0].sql).toContain('VALUES ($2, $3, $4, $5, $1), ($6, $7, $8, $9, $1)');
    expect(inserts[0].params).toEqual([FIXTURE.merkleRoot, A1, 1, 'special', FIXTURE.claims[A1].proof, '0x0aa899d93956365648639e943eac976e8f594f7f', 2, 'special', expect.any(Array)]);
    expect(inserts[2].params).toHaveLength(5); // last batch: root + one row
    expect(progress).toEqual([2, 4, 5]);
  });

  it('throws when the table does not match afterwards, so the caller rolls back', async () => {
    for (const check of [{ ...goodCheck, total: 4 }, { ...goodCheck, special: 3 }, { ...goodCheck, roots: 2 }, { ...goodCheck, root: '0xother' }]) {
      await expect(replaceAnniversaryClaims(fakeClient(check), proofs()), JSON.stringify(check)).rejects.toThrow(/Post-insert check failed/);
    }
  });
});

describe('GET /api/v1/anniversary/proof/:address', () => {
  let app: FastifyInstance;
  const get = (address: string) => app.inject({ method: 'GET', url: `/api/v1/anniversary/proof/${address}` });

  beforeAll(async () => {
    app = Fastify();
    await app.register(anniversaryRoutes, { prefix: '/api/v1/anniversary' });
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    queryMock.mockReset().mockImplementation(async (_sql: string, params: unknown[]) => {
      const claim = FIXTURE.claims[params[0] as string];
      return {
        rows: claim
          ? [{ token_id: claim.tokenId, nft_type: claim.type, proof: claim.proof, merkle_root: FIXTURE.merkleRoot }]
          : [],
      };
    });
  });

  it('rejects an invalid address with 400', async () => {
    for (const bad of ['not-an-address', '0x1234', `0x${'a'.repeat(41)}`, `0x${'g'.repeat(40)}`, 'vitalik.eth']) {
      const res = await get(bad);
      expect(res.statusCode, bad).toBe(400);
      expect(res.json()).toMatchObject({ success: false, error: { code: 'INVALID_ADDRESS' }, meta: { timestamp: expect.any(String) } });
    }
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns eligible: false (200) for an address not on the list', async () => {
    const res = await get('0x000000000000000000000000000000000000dead');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      data: { address: '0x000000000000000000000000000000000000dEaD', eligible: false },
      meta: { timestamp: expect.any(String) },
    });
    expect(Object.keys(res.json().data)).toEqual(['address', 'eligible']);
  });

  it('looks up a mixed-case address in lowercase and returns the claim', async () => {
    for (const input of [A1.toUpperCase().replace('0X', '0x'), A1_CHECKSUM, A1]) {
      queryMock.mockClear();
      const res = await get(input);
      expect(res.statusCode, input).toBe(200);
      expect(res.json().data).toEqual({
        address: A1_CHECKSUM,
        eligible: true,
        tokenId: 1,
        type: 'special',
        proof: FIXTURE.claims[A1].proof,
        merkleRoot: FIXTURE.merkleRoot,
      });
      expect(queryMock).toHaveBeenCalledTimes(1);
      expect(queryMock.mock.calls[0][1]).toEqual([A1]);
    }

    const generic = (await get(A3)).json().data;
    expect(generic).toMatchObject({ address: FIXTURE.claims[A3].address, eligible: true, tokenId: 3, type: 'generic' });
  });

  it('returns 500 in the error envelope when the database fails', async () => {
    queryMock.mockRejectedValueOnce(new Error('connection refused'));
    const res = await get(A1);
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  it('caches per lowercase address', () => {
    expect(cacheOptions).toHaveLength(1);
    expect(cacheOptions[0].ttl).toBe(60);
    const key = anniversaryProofCacheKey(A1);
    expect(key).toBe(`cache:/api/v1/anniversary/proof/${A1}`);
    expect(cacheOptions[0].keyGenerator({ params: { address: A1_CHECKSUM } })).toBe(key);
  });
});
