/**
 * Unit tests for Seaport order verification (no DB or network: the viem public client is
 * stubbed). Signatures come from viem's signTypedData, so the digest and bulk-proof code is
 * checked against an independent EIP-712 implementation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  ContractFunctionRevertedError,
  concat,
  keccak256,
  labelhash,
  namehash,
  numberToHex,
  serializeCompactSignature,
  parseSignature,
  signatureToCompactSignature,
  hashStruct,
  type Hex,
} from 'viem';

const chain = vi.hoisted(() => ({ simulateContract: vi.fn(), readContract: vi.fn() }));
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return { ...actual, createPublicClient: () => chain };
});
// The shared index also loads a stale compiled migrate.js that breaks under vitest, so expose
// the real modules order-verification uses and stub the DB.
vi.mock('../../../shared/src', async () => ({
  ...(await import('../../../shared/src/config')),
  ...(await import('../../../shared/src/types')),
  ...(await import('../../../shared/src/services/fees')),
  ...(await import('../../../shared/src/utils/ensv2-orders')),
  getPostgresPool: () => ({ query: vi.fn() }),
}));

import { config } from '../../../shared/src/config';
import {
  parseSeaportOrder,
  recoverOrderSigner,
  seaportOrderHash,
  verifyListingOrder,
  verifyOfferOrder,
  type NameRef,
} from '../services/order-verification';

const seller = privateKeyToAccount('0x1111111111111111111111111111111111111111111111111111111111111111');
const stranger = privateKeyToAccount('0x2222222222222222222222222222222222222222222222222222222222222222');
const SELLER = seller.address.toLowerCase();
const STRANGER = stranger.address.toLowerCase();

const REGISTRAR = config.blockchain.ensRegistrarAddress;
const WRAPPER = config.blockchain.ensNameWrapperAddress;
const ZERO = '0x0000000000000000000000000000000000000000';
const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ZERO32 = `0x${'0'.repeat(64)}` as Hex;
const GRAILS_CONDUIT_KEY = '0xc9c3a4337a1bba75d0860a1a81f7b990dc607334000000000000000000000000';

const ITEM = [
  { name: 'itemType', type: 'uint8' },
  { name: 'token', type: 'address' },
  { name: 'identifierOrCriteria', type: 'uint256' },
  { name: 'startAmount', type: 'uint256' },
  { name: 'endAmount', type: 'uint256' },
];
const TYPES = {
  OrderComponents: [
    { name: 'offerer', type: 'address' },
    { name: 'zone', type: 'address' },
    { name: 'offer', type: 'OfferItem[]' },
    { name: 'consideration', type: 'ConsiderationItem[]' },
    { name: 'orderType', type: 'uint8' },
    { name: 'startTime', type: 'uint256' },
    { name: 'endTime', type: 'uint256' },
    { name: 'zoneHash', type: 'bytes32' },
    { name: 'salt', type: 'uint256' },
    { name: 'conduitKey', type: 'bytes32' },
    { name: 'counter', type: 'uint256' },
  ],
  OfferItem: ITEM,
  ConsiderationItem: [...ITEM, { name: 'recipient', type: 'address' }],
};
const DOMAIN = {
  name: 'Seaport',
  version: '1.6',
  chainId: config.blockchain.chainId,
  verifyingContract: config.blockchain.seaportAddress as Hex,
};

const alice: NameRef = { id: 1, name: 'alice.eth', token_id: BigInt(labelhash('alice')).toString(), owner_address: SELLER, ens_version: 1 };
const junk: NameRef = { id: 2, name: 'junk.eth', token_id: BigInt(labelhash('junk')).toString(), owner_address: SELLER, ens_version: 1 };
const wrapped: NameRef = { id: 3, name: 'wrapped.eth', token_id: BigInt(namehash('wrapped.eth')).toString(), owner_address: SELLER, ens_version: 1 };

let salt = 1;

/** Order components as the app stores them (decimal strings) */
function components(offerer: string, offer: any[], consideration: any[]) {
  return {
    offerer,
    zone: ZERO,
    offer,
    consideration,
    orderType: 0,
    startTime: '1700000000',
    endTime: '1900000000',
    zoneHash: ZERO32,
    salt: String(salt++),
    conduitKey: GRAILS_CONDUIT_KEY,
    counter: '0',
  };
}

function nft(token: string, id: string | bigint, itemType = 2) {
  return { itemType, token, identifierOrCriteria: String(id), startAmount: '1', endAmount: '1' };
}

function pay(amount: string, recipient: string, token = ZERO, itemType = token === ZERO ? 0 : 1) {
  return { itemType, token, identifierOrCriteria: '0', startAmount: amount, endAmount: amount, recipient };
}

function listingFor(name: NameRef, price = '1000000000000000', offerer = SELLER) {
  const label = name.name.split('.')[0];
  return components(offerer, [nft(REGISTRAR, BigInt(labelhash(label)))], [pay(price, offerer)]);
}

async function sign(parameters: any, account = seller): Promise<Hex> {
  return account.signTypedData({ domain: DOMAIN, types: TYPES, primaryType: 'OrderComponents', message: parameters });
}

/** order_data the way the app stores it */
function stored(parameters: any, signature: Hex) {
  return JSON.stringify({
    parameters,
    signature,
    protocol_data: { parameters, signature },
    orderHash: seaportOrderHash(parseOk(JSON.stringify({ parameters, signature })).components),
    marketplace: 'grails',
    usesConduit: true,
  });
}

function parseOk(orderData: string) {
  const parsed = parseSeaportOrder(orderData);
  if ('error' in parsed) throw new Error(parsed.error);
  return parsed;
}

async function signedListing(name: NameRef, price?: string) {
  const parameters = listingFor(name, price);
  return { parameters, orderData: stored(parameters, await sign(parameters)) };
}

beforeEach(() => {
  chain.simulateContract.mockReset();
  chain.readContract.mockReset();
  chain.simulateContract.mockRejectedValue(new ContractFunctionRevertedError({ abi: [], functionName: 'validate', data: '0x815e1d64' }));
});

describe('signature recovery', () => {
  it('recovers a 65-byte signature', async () => {
    const parameters = listingFor(alice);
    const order = parseOk(stored(parameters, await sign(parameters)));
    expect(await recoverOrderSigner(seaportOrderHash(order.components), order.signature)).toBe(SELLER);
  });

  it('recovers a 64-byte compact (EIP-2098) signature', async () => {
    const parameters = listingFor(alice);
    const compact = serializeCompactSignature(signatureToCompactSignature(parseSignature(await sign(parameters))));
    const order = parseOk(stored(parameters, compact));
    expect(await recoverOrderSigner(seaportOrderHash(order.components), compact)).toBe(SELLER);
  });

  it.each([1, 2, 3])('recovers every leaf of a bulk signature of height %i', async (height) => {
    const leaves = Array.from({ length: 2 ** height }, () => listingFor(alice));
    const hashes = leaves.map((p) => seaportOrderHash(parseOk(JSON.stringify({ parameters: p, signature: '0x' })).components));

    // the tree as nested arrays, signed as BulkOrder(OrderComponents[2]...[2] tree)
    let tree: any[] = leaves;
    for (let i = 0; i < height; i++) tree = Array.from({ length: tree.length / 2 }, (_, j) => [tree[2 * j], tree[2 * j + 1]]);
    const bulkSig = await seller.signTypedData({
      domain: DOMAIN,
      types: { ...TYPES, BulkOrder: [{ name: 'tree', type: `OrderComponents${'[2]'.repeat(height)}` }] },
      primaryType: 'BulkOrder',
      message: { tree: tree[0] },
    });
    const compactSig = serializeCompactSignature(signatureToCompactSignature(parseSignature(bulkSig)));

    // merkle levels over the leaf hashes, as Seaport rebuilds them from the proof
    const levels: Hex[][] = [hashes];
    while (levels[levels.length - 1].length > 1) {
      const prev = levels[levels.length - 1];
      levels.push(Array.from({ length: prev.length / 2 }, (_, j) => keccak256(concat([prev[2 * j], prev[2 * j + 1]]))));
    }
    for (let k = 0; k < leaves.length; k++) {
      const proof = Array.from({ length: height }, (_, i) => levels[i][(k >> i) ^ 1]);
      for (const sig of [bulkSig, compactSig]) {
        const signature = concat([sig, numberToHex(k, { size: 3 }), ...proof]);
        expect(await recoverOrderSigner(hashes[k], signature)).toBe(SELLER);
      }
    }
  });

  it('does not recover the signer for a tampered order', async () => {
    const parameters = listingFor(alice);
    const signature = await sign(parameters);
    const tampered = parseOk(stored({ ...parameters, consideration: [pay('1', SELLER)] }, signature));
    expect(await recoverOrderSigner(seaportOrderHash(tampered.components), signature)).not.toBe(SELLER);
  });
});

describe('parseSeaportOrder', () => {
  it('rejects empty order data', () => {
    expect(parseSeaportOrder({})).toEqual({ error: expect.stringContaining('no Seaport order') });
    expect(parseSeaportOrder('{}')).toEqual({ error: expect.stringContaining('no Seaport order') });
  });

  it('reads protocol_data first, like the frontend does when it fills the order', async () => {
    const real = listingFor(alice);
    const signature = await sign(real);
    const decoy = { ...real, consideration: [pay('1', SELLER)] };
    const data = JSON.stringify({ parameters: decoy, signature: '0x', protocol_data: { parameters: real, signature } });
    const parsed = parseOk(data);
    expect(parsed.signature).toBe(signature);
    expect(parsed.components.consideration[0].startAmount).toBe(1000000000000000n);
  });
});

describe('verifyListingOrder', () => {
  const listing = (orderData: string, name: NameRef | null, extra: Partial<Parameters<typeof verifyListingOrder>[0]> = {}) =>
    verifyListingOrder({ orderData, seller: SELLER, name, ensV2Checked: false, ...extra });

  it('accepts a signed order for the seller\'s own name and takes price, currency and hash from it', async () => {
    const { orderData } = await signedListing(alice, '5000000000000000');
    const result = await listing(orderData, alice);
    expect(result).toMatchObject({ ok: true, priceWei: '5000000000000000', currencyAddress: ZERO, orderHash: JSON.parse(orderData).orderHash });
    expect(chain.simulateContract).not.toHaveBeenCalled();
    expect(chain.readContract).not.toHaveBeenCalled();
  });

  it('sums the consideration for the price, as the app does', async () => {
    const parameters = components(SELLER, [nft(REGISTRAR, BigInt(labelhash('alice')))], [pay('900', SELLER, USDC), pay('100', STRANGER, USDC)]);
    expect(await listing(stored(parameters, await sign(parameters)), alice)).toMatchObject({ ok: true, priceWei: '1000', currencyAddress: USDC });
  });

  it('rejects empty order data', async () => {
    expect(await listing('{}', alice)).toMatchObject({ ok: false, status: 400, code: 'INVALID_ORDER' });
  });

  it('rejects an order for a different name', async () => {
    const { orderData } = await signedListing(junk);
    expect(await listing(orderData, alice)).toMatchObject({ ok: false, code: 'INVALID_ORDER_ITEM' });
  });

  it('rejects an order signed by someone other than the seller', async () => {
    const parameters = listingFor(alice, undefined, STRANGER);
    const orderData = stored(parameters, await sign(parameters, stranger));
    expect(await listing(orderData, alice)).toMatchObject({ ok: false, status: 403, code: 'OFFERER_MISMATCH' });
  });

  it('accepts a wrapped name traded as its NameWrapper namehash token, not as a labelhash', async () => {
    const good = components(SELLER, [nft(WRAPPER, BigInt(namehash('wrapped.eth')), 3)], [pay('1000', SELLER)]);
    expect(await listing(stored(good, await sign(good)), wrapped)).toMatchObject({ ok: true });
    const bad = components(SELLER, [nft(WRAPPER, BigInt(labelhash('wrapped')), 3)], [pay('1000', SELLER)]);
    expect(await listing(stored(bad, await sign(bad)), wrapped)).toMatchObject({ code: 'INVALID_ORDER_ITEM' });
  });

  it('asks Seaport when the signature does not recover, and rejects on a revert', async () => {
    const parameters = listingFor(alice);
    const signature = await sign(parameters);
    const tampered = stored({ ...parameters, consideration: [pay('1', SELLER)] }, signature);
    expect(await listing(tampered, alice)).toMatchObject({ ok: false, status: 400, code: 'INVALID_SIGNATURE' });
    expect(chain.simulateContract).toHaveBeenCalledTimes(1);
    const call = chain.simulateContract.mock.calls[0][0];
    expect(call.functionName).toBe('validate');
    expect(call.account.toLowerCase()).not.toBe(SELLER);
  });

  it('accepts a signature only Seaport can verify (e.g. an EIP-1271 wallet)', async () => {
    chain.simulateContract.mockResolvedValue({ result: true });
    const parameters = listingFor(alice);
    const orderData = stored(parameters, `0x${'ab'.repeat(112)}`);
    expect(await listing(orderData, alice)).toMatchObject({ ok: true });
  });

  it('returns 503 when Seaport cannot be reached', async () => {
    chain.simulateContract.mockRejectedValue(new Error('fetch failed'));
    const parameters = listingFor(alice);
    expect(await listing(stored(parameters, '0x'), alice)).toMatchObject({ ok: false, status: 503, code: 'CHAIN_CHECK_FAILED' });
  });

  it('checks ownership on-chain when our record says someone else owns the name', async () => {
    const { orderData } = await signedListing(alice);
    const ownedByOther = { ...alice, owner_address: STRANGER };

    chain.readContract.mockResolvedValue(stranger.address);
    expect(await listing(orderData, ownedByOther)).toMatchObject({ ok: false, status: 403, code: 'NOT_OWNER' });

    // the indexer lags a fresh purchase: the chain says the seller owns it
    chain.readContract.mockResolvedValue(seller.address);
    expect(await listing(orderData, ownedByOther)).toMatchObject({ ok: true });
    expect(chain.readContract.mock.calls[0][0]).toMatchObject({ functionName: 'ownerOf', args: [BigInt(labelhash('alice'))] });
  });

  it('for a token with no name row, requires the order to trade that token and the seller to hold it', async () => {
    const { orderData } = await signedListing(alice);
    chain.readContract.mockResolvedValue(seller.address);
    expect(await listing(orderData, null, { tokenId: alice.token_id })).toMatchObject({ ok: true });
    expect(await listing(orderData, null, { tokenId: junk.token_id })).toMatchObject({ code: 'INVALID_ORDER_ITEM' });
    chain.readContract.mockResolvedValue(stranger.address);
    expect(await listing(orderData, null, { tokenId: alice.token_id })).toMatchObject({ code: 'NOT_OWNER' });
  });
});

describe('verifyOfferOrder', () => {
  const buyer = seller;
  const BUYER = SELLER;
  const FEE_RECEIVER = '0x00000000000000000000000000000000000fee00';
  const nameItem = (name = 'alice') => ({ ...nft(REGISTRAR, BigInt(labelhash(name))), recipient: BUYER });

  function offerFor(name: NameRef, consideration?: any[]) {
    const label = name.name.split('.')[0];
    return components(BUYER, [{ itemType: 1, token: WETH, identifierOrCriteria: '0', startAmount: '1000', endAmount: '1000' }],
      consideration ?? [nameItem(label)]);
  }
  const offer = async (parameters: any, name = alice) =>
    verifyOfferOrder({ orderData: JSON.parse(stored(parameters, await sign(parameters, buyer))), buyer: BUYER, name, ensV2Checked: false });

  const env = { FEE_ENABLED: process.env.FEE_ENABLED, FEE_RECEIVER_ADDRESS: process.env.FEE_RECEIVER_ADDRESS };
  afterEach(() => {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('accepts a signed WETH offer for the name and takes amount and currency from it', async () => {
    expect(await offer(offerFor(alice))).toMatchObject({ ok: true, amountWei: '1000', currencyAddress: WETH });
  });

  it('rejects empty order data', async () => {
    expect(await verifyOfferOrder({ orderData: {}, buyer: BUYER, name: alice, ensV2Checked: false })).toMatchObject({ code: 'INVALID_ORDER' });
  });

  it('rejects an offer for a different name', async () => {
    expect(await offer(offerFor(junk))).toMatchObject({ code: 'INVALID_ORDER_ITEM' });
  });

  it('rejects an offer for more than one NFT, criteria items included', async () => {
    expect(await offer(offerFor(alice, [nameItem('alice'), nameItem('junk')]))).toMatchObject({ code: 'INVALID_ORDER_ITEM' });
    const anyName = { itemType: 4, token: REGISTRAR, identifierOrCriteria: '0', startAmount: '1', endAmount: '1', recipient: BUYER };
    expect(await offer(offerFor(alice, [nameItem('alice'), anyName]))).toMatchObject({ code: 'INVALID_ORDER_ITEM' });
  });

  it('only allows the Grails fee as other consideration', async () => {
    process.env.FEE_ENABLED = 'true';
    process.env.FEE_RECEIVER_ADDRESS = FEE_RECEIVER;
    const withFee = (recipient: string) => offerFor(alice, [nameItem('alice'), pay('10', recipient, WETH)]);
    expect(await offer(withFee(FEE_RECEIVER))).toMatchObject({ ok: true });
    expect(await offer(withFee(BUYER))).toMatchObject({ code: 'INVALID_ORDER_ITEM' });
    process.env.FEE_ENABLED = 'false';
    expect(await offer(withFee(FEE_RECEIVER))).toMatchObject({ code: 'INVALID_ORDER_ITEM' });
  });
});

describe('seaportOrderHash', () => {
  it('is the EIP-712 struct hash of OrderComponents', async () => {
    const parameters = listingFor(alice);
    const order = parseOk(JSON.stringify({ parameters, signature: '0x' }));
    expect(seaportOrderHash(order.components)).toBe(
      hashStruct({ data: parameters as any, primaryType: 'OrderComponents', types: TYPES as any })
    );
  });
});
