import { concat, encodeAbiParameters, isAddress, keccak256, type Hex } from 'viem';

/**
 * Grails anniversary NFT claim allowlist.
 *
 * Every eligible address gets exactly one token with an id fixed in advance: "special" (power
 * users) get ids 1..counts.special, "generic" the rest up to counts.total. Claims are checked
 * onchain against an OpenZeppelin StandardMerkleTree with (address account, uint256 tokenId)
 * leaves. The generator writes proofs.json; scripts/import-anniversary-proofs.ts validates it
 * with validateAnniversaryProofs() and loads it into anniversary_nft_claims.
 *
 * Deliberately depends on nothing but viem, so the import script's --dry-run never loads the
 * database layer.
 */

export type AnniversaryNftType = 'special' | 'generic';

export interface AnniversaryCounts {
  special: number;
  generic: number;
  total: number;
}

export interface AnniversaryClaim {
  address: string; // lowercase
  tokenId: number;
  type: AnniversaryNftType;
  proof: string[]; // lowercase bytes32 hex
}

export interface AnniversaryProofs {
  merkleRoot: string; // lowercase bytes32 hex
  counts: AnniversaryCounts;
  claims: AnniversaryClaim[]; // ordered by tokenId
}

export type AnniversaryProofsValidation =
  | { ok: true; proofs: AnniversaryProofs }
  | { ok: false; errors: string[] };

/** GET /api/v1/anniversary/proof/:address payload. `address` is EIP-55 checksummed. */
export type AnniversaryProofResponse =
  | {
      address: string;
      eligible: true;
      tokenId: number;
      type: AnniversaryNftType;
      proof: string[];
      merkleRoot: string;
    }
  | { address: string; eligible: false };

export const ANNIVERSARY_LEAF_ENCODING = ['address', 'uint256'] as const;

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const LOWERCASE_ADDRESS_RE = /^0x[0-9a-f]{40}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** StandardMerkleTree leaf: keccak256(bytes.concat(keccak256(abi.encode(account, tokenId)))). */
export function anniversaryLeafHash(address: string, tokenId: number | bigint): Hex {
  const encoded = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }],
    [address.toLowerCase() as Hex, BigInt(tokenId)]
  );
  return keccak256(keccak256(encoded));
}

/** OpenZeppelin MerkleProof.verify: fold the proof with sorted-pair keccak256. */
export function verifyAnniversaryProof(address: string, tokenId: number | bigint, proof: string[], merkleRoot: string): boolean {
  let node: Hex = anniversaryLeafHash(address, tokenId);
  for (const sibling of proof) {
    const s = sibling.toLowerCase() as Hex;
    node = keccak256(node < s ? concat([node, s]) : concat([s, node]));
  }
  return node === merkleRoot.toLowerCase();
}

/**
 * Validate a parsed proofs.json. Collects every problem rather than stopping at the first, so
 * one run shows everything wrong with a file. With verifyProofs (the default) every proof is
 * also checked against merkleRoot.
 */
export function validateAnniversaryProofs(
  input: unknown,
  options: { verifyProofs?: boolean } = {}
): AnniversaryProofsValidation {
  const { verifyProofs = true } = options;
  const errors: string[] = [];

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['proofs file must be a JSON object'] };
  }

  const { merkleRoot, leafEncoding, counts, claims } = input;

  if (typeof merkleRoot !== 'string' || !BYTES32_RE.test(merkleRoot)) {
    errors.push(`merkleRoot must be 0x + 64 hex chars, got ${JSON.stringify(merkleRoot)}`);
  }

  if (
    !Array.isArray(leafEncoding) ||
    leafEncoding.length !== ANNIVERSARY_LEAF_ENCODING.length ||
    leafEncoding.some((t, i) => t !== ANNIVERSARY_LEAF_ENCODING[i])
  ) {
    errors.push(`leafEncoding must be ${JSON.stringify(ANNIVERSARY_LEAF_ENCODING)}, got ${JSON.stringify(leafEncoding)}`);
  }

  // The per-claim checks below need well-formed counts and claims.
  let malformed = false;
  if (
    !isPlainObject(counts) ||
    !isCount(counts.special) ||
    !isCount(counts.generic) ||
    !isCount(counts.total) ||
    counts.total === 0
  ) {
    errors.push(`counts must be { special, generic, total } non-negative integers with total > 0, got ${JSON.stringify(counts)}`);
    malformed = true;
  } else if (counts.special + counts.generic !== counts.total) {
    errors.push(`counts.special (${counts.special}) + counts.generic (${counts.generic}) != counts.total (${counts.total})`);
    malformed = true;
  }

  if (!isPlainObject(claims)) {
    errors.push('claims must be an object keyed by lowercase address');
    malformed = true;
  }

  if (malformed) return { ok: false, errors };

  const { special, generic, total } = counts as unknown as AnniversaryCounts;
  const entries = Object.entries(claims as Record<string, unknown>);
  if (entries.length !== total) {
    errors.push(`claims has ${entries.length} entries but counts.total is ${total}`);
  }

  const valid: AnniversaryClaim[] = [];
  const addressByTokenId = new Map<number, string>();
  const seen = { special: 0, generic: 0 };

  for (const [key, entry] of entries) {
    const before = errors.length;
    const at = `claims[${key}]`;

    if (!LOWERCASE_ADDRESS_RE.test(key)) {
      errors.push(`${at}: key is not a lowercase 0x address`);
    }
    if (!isPlainObject(entry)) {
      errors.push(`${at}: entry must be an object`);
      continue;
    }

    const { address, tokenId, type, proof } = entry;

    // isAddress is strict: a mixed-case address must carry a valid EIP-55 checksum.
    if (typeof address !== 'string' || !isAddress(address)) {
      errors.push(`${at}: address ${JSON.stringify(address)} is not a valid (checksummed) address`);
    } else if (address.toLowerCase() !== key.toLowerCase()) {
      // (a non-lowercase key is reported above)
      errors.push(`${at}: key does not match address ${address}`);
    }

    if (!Number.isSafeInteger(tokenId) || (tokenId as number) < 1 || (tokenId as number) > total) {
      errors.push(`${at}: tokenId ${JSON.stringify(tokenId)} is not an integer in 1..${total}`);
    } else {
      const other = addressByTokenId.get(tokenId as number);
      if (other !== undefined) {
        errors.push(`${at}: tokenId ${tokenId} is also assigned to ${other}`);
      } else {
        addressByTokenId.set(tokenId as number, key);
      }
    }

    if (type !== 'special' && type !== 'generic') {
      errors.push(`${at}: type ${JSON.stringify(type)} must be "special" or "generic"`);
    } else {
      seen[type]++;
      if (Number.isSafeInteger(tokenId)) {
        const expected: AnniversaryNftType = (tokenId as number) <= special ? 'special' : 'generic';
        if (type !== expected) {
          errors.push(`${at}: tokenId ${tokenId} must be "${expected}" (special ids are 1..${special}), got "${type}"`);
        }
      }
    }

    if (!Array.isArray(proof)) {
      errors.push(`${at}: proof must be an array`);
    } else {
      // Only a one-leaf tree has empty proofs.
      if (proof.length === 0 && total > 1) errors.push(`${at}: proof is empty`);
      proof.forEach((p, i) => {
        if (typeof p !== 'string' || !BYTES32_RE.test(p)) {
          errors.push(`${at}: proof[${i}] ${JSON.stringify(p)} is not 0x + 64 hex chars`);
        }
      });
    }

    if (errors.length === before) {
      valid.push({
        address: key,
        tokenId: tokenId as number,
        type: type as AnniversaryNftType,
        proof: (proof as string[]).map((p) => p.toLowerCase()),
      });
    }
  }

  if (seen.special !== special) {
    errors.push(`found ${seen.special} special claims but counts.special is ${special}`);
  }
  if (seen.generic !== generic) {
    errors.push(`found ${seen.generic} generic claims but counts.generic is ${generic}`);
  }

  if (errors.length > 0) return { ok: false, errors };

  if (verifyProofs) {
    for (const claim of valid) {
      if (!verifyAnniversaryProof(claim.address, claim.tokenId, claim.proof, merkleRoot as string)) {
        errors.push(`claims[${claim.address}]: proof for tokenId ${claim.tokenId} does not verify against merkleRoot`);
      }
    }
    if (errors.length > 0) return { ok: false, errors };
  }

  valid.sort((a, b) => a.tokenId - b.tokenId);
  return {
    ok: true,
    proofs: { merkleRoot: (merkleRoot as string).toLowerCase(), counts: { special, generic, total }, claims: valid },
  };
}

/** The slice of a pg client replaceAnniversaryClaims needs. */
interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: any[] }>;
}

/**
 * Replace the whole of anniversary_nft_claims with validated proofs: DELETE, batched INSERT,
 * then a sanity check that throws on any mismatch. Call it inside a transaction and roll back
 * on error (scripts/import-anniversary-proofs.ts does). DELETE rather than TRUNCATE so readers
 * keep seeing the old list until COMMIT.
 */
export async function replaceAnniversaryClaims(
  client: Queryable,
  proofs: AnniversaryProofs,
  options: { batchSize?: number; onProgress?: (inserted: number) => void } = {}
): Promise<{ deleted: number; inserted: number }> {
  const { batchSize = 500, onProgress } = options;

  const deleted = await client.query('DELETE FROM anniversary_nft_claims');

  let inserted = 0;
  for (let i = 0; i < proofs.claims.length; i += batchSize) {
    const batch = proofs.claims.slice(i, i + batchSize);
    const params: unknown[] = [proofs.merkleRoot];
    const rows = batch.map((claim) => {
      params.push(claim.address, claim.tokenId, claim.type, claim.proof);
      const n = params.length;
      return `($${n - 3}, $${n - 2}, $${n - 1}, $${n}, $1)`;
    });

    await client.query(
      `INSERT INTO anniversary_nft_claims (address, token_id, nft_type, proof, merkle_root)
       VALUES ${rows.join(', ')}`,
      params
    );

    inserted += batch.length;
    onProgress?.(inserted);
  }

  const check = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE nft_type = 'special')::int AS special,
            COUNT(DISTINCT merkle_root)::int AS roots,
            MIN(merkle_root) AS root
       FROM anniversary_nft_claims`
  );
  const row = check.rows[0];
  if (
    row?.total !== proofs.counts.total ||
    row?.special !== proofs.counts.special ||
    row?.roots !== 1 ||
    row?.root !== proofs.merkleRoot
  ) {
    throw new Error(`Post-insert check failed: expected ${JSON.stringify(proofs.counts)}, got ${JSON.stringify(row)}`);
  }

  return { deleted: deleted.rowCount ?? 0, inserted };
}
