import {
  BaseError,
  ContractFunctionRevertedError,
  ExecutionRevertedError,
  bytesToHex,
  compactSignatureToSignature,
  concat,
  createPublicClient,
  encodeAbiParameters,
  hashStruct,
  hexToBytes,
  http,
  isAddress,
  isHex,
  keccak256,
  labelhash,
  namehash,
  parseAbi,
  parseCompactSignature,
  recoverAddress,
  stringToBytes,
  type Address,
  type Hex,
} from 'viem';
import {
  config,
  viemChain,
  getPostgresPool,
  getFeeConfig,
  ItemType,
} from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * Server-side checks for every Seaport order a user submits as a listing or an offer.
 *
 * A stored order must be a Seaport 1.6 order, signed by the authenticated wallet, that trades
 * this name's token; listings must come from the name's owner; and the stored price, currency
 * and order hash are taken from the order, not the request.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
// From address for the Seaport.validate eth_call: Seaport skips the signature check when
// msg.sender is the offerer, so it must never be an address that could be one.
const VALIDATE_CALLER = '0x000000000000000000000000000000000000dEaD';

const ITEM_FIELDS = [
  { name: 'itemType', type: 'uint8' },
  { name: 'token', type: 'address' },
  { name: 'identifierOrCriteria', type: 'uint256' },
  { name: 'startAmount', type: 'uint256' },
  { name: 'endAmount', type: 'uint256' },
] as const;

const SEAPORT_TYPES = {
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
  OfferItem: ITEM_FIELDS,
  ConsiderationItem: [...ITEM_FIELDS, { name: 'recipient', type: 'address' }],
} as const;

const ORDER_TYPE_STRINGS =
  'ConsiderationItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount,address recipient)' +
  'OfferItem(uint8 itemType,address token,uint256 identifierOrCriteria,uint256 startAmount,uint256 endAmount)' +
  'OrderComponents(address offerer,address zone,OfferItem[] offer,ConsiderationItem[] consideration,uint8 orderType,uint256 startTime,uint256 endTime,bytes32 zoneHash,uint256 salt,bytes32 conduitKey,uint256 counter)';

const ABI_ITEM_FIELDS = [
  { name: 'itemType', type: 'uint8' },
  { name: 'token', type: 'address' },
  { name: 'identifierOrCriteria', type: 'uint256' },
  { name: 'startAmount', type: 'uint256' },
  { name: 'endAmount', type: 'uint256' },
] as const;

const SEAPORT_VALIDATE_ABI = [{
  type: 'function',
  name: 'validate',
  stateMutability: 'nonpayable',
  inputs: [{
    name: 'orders',
    type: 'tuple[]',
    components: [
      {
        name: 'parameters',
        type: 'tuple',
        components: [
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          { name: 'offer', type: 'tuple[]', components: ABI_ITEM_FIELDS },
          { name: 'consideration', type: 'tuple[]', components: [...ABI_ITEM_FIELDS, { name: 'recipient', type: 'address' }] },
          { name: 'orderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'conduitKey', type: 'bytes32' },
          { name: 'totalOriginalConsiderationItems', type: 'uint256' },
        ],
      },
      { name: 'signature', type: 'bytes' },
    ],
  }],
  outputs: [{ name: 'validated', type: 'bool' }],
}] as const;

const OWNER_OF_ABI = parseAbi(['function ownerOf(uint256 id) view returns (address)']);
const GET_COUNTER_ABI = parseAbi(['function getCounter(address offerer) view returns (uint256 counter)']);

export interface SeaportItem {
  itemType: number;
  token: Address;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
}

export interface SeaportConsiderationItem extends SeaportItem {
  recipient: Address;
}

export interface SeaportOrderComponents {
  offerer: Address;
  zone: Address;
  offer: SeaportItem[];
  consideration: SeaportConsiderationItem[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: Hex;
  salt: bigint;
  conduitKey: Hex;
  /** null when the stored order leaves it out; see resolveCounter */
  counter: bigint | null;
}

export interface ParsedSeaportOrder {
  components: SeaportOrderComponents;
  signature: Hex;
}

export type OrderCheckFailure = { ok: false; status: number; code: string; message: string };

function fail(status: number, code: string, message: string): OrderCheckFailure {
  return { ok: false, status, code, message };
}

class OrderParseError extends Error {}

function toUint(value: unknown, field: string, max: bigint = (1n << 256n) - 1n): bigint {
  let result: bigint;
  try {
    if (typeof value === 'bigint') result = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) result = BigInt(value);
    else if (typeof value === 'string' && /^(0x[0-9a-fA-F]+|[0-9]+)$/.test(value.trim())) result = BigInt(value.trim());
    else throw new Error();
  } catch {
    throw new OrderParseError(`${field} is not an unsigned integer`);
  }
  if (result < 0n || result > max) throw new OrderParseError(`${field} is out of range`);
  return result;
}

function toAddress(value: unknown, field: string): Address {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) {
    throw new OrderParseError(`${field} is not an address`);
  }
  return value.toLowerCase() as Address;
}

function toBytes32(value: unknown, field: string): Hex {
  if (typeof value !== 'string' || !isHex(value) || value.length !== 66) {
    throw new OrderParseError(`${field} is not a bytes32 value`);
  }
  return value.toLowerCase() as Hex;
}

function toItem(value: any, field: string): SeaportItem {
  if (!value || typeof value !== 'object') throw new OrderParseError(`${field} is missing`);
  return {
    itemType: Number(toUint(value.itemType, `${field}.itemType`, 5n)),
    token: toAddress(value.token, `${field}.token`),
    identifierOrCriteria: toUint(value.identifierOrCriteria, `${field}.identifierOrCriteria`),
    startAmount: toUint(value.startAmount, `${field}.startAmount`),
    endAmount: toUint(value.endAmount, `${field}.endAmount`),
  };
}

function toComponents(p: any): SeaportOrderComponents {
  if (!p || typeof p !== 'object') throw new OrderParseError('order parameters are missing');
  if (!Array.isArray(p.offer) || !Array.isArray(p.consideration)) {
    throw new OrderParseError('order offer/consideration are missing');
  }
  return {
    offerer: toAddress(p.offerer, 'offerer'),
    zone: toAddress(p.zone, 'zone'),
    offer: p.offer.map((item: any, i: number) => toItem(item, `offer[${i}]`)),
    consideration: p.consideration.map((item: any, i: number) => ({
      ...toItem(item, `consideration[${i}]`),
      recipient: toAddress(item?.recipient, `consideration[${i}].recipient`),
    })),
    orderType: Number(toUint(p.orderType, 'orderType', 4n)),
    startTime: toUint(p.startTime, 'startTime'),
    endTime: toUint(p.endTime, 'endTime'),
    zoneHash: toBytes32(p.zoneHash, 'zoneHash'),
    salt: toUint(p.salt, 'salt'),
    conduitKey: toBytes32(p.conduitKey, 'conduitKey'),
    counter: p.counter === undefined || p.counter === null ? null : toUint(p.counter, 'counter'),
  };
}

/**
 * The Seaport order in stored order_data. Same precedence as the frontend's parseStoredOrder
 * (protocol_data first, then top-level parameters/signature), since that's what a fill uses.
 */
export function parseSeaportOrder(orderData: unknown): ParsedSeaportOrder | { error: string } {
  try {
    const data: any = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;
    if (!data || typeof data !== 'object') return { error: 'order data is not an object' };

    const order = data.protocol_data?.parameters ? data.protocol_data : data.parameters ? data : null;
    if (!order) return { error: 'order data has no Seaport order parameters' };
    if (typeof order.signature !== 'string' || !isHex(order.signature)) {
      return { error: 'order signature is missing' };
    }
    return { components: toComponents(order.parameters), signature: order.signature.toLowerCase() as Hex };
  } catch (error: any) {
    if (error instanceof OrderParseError || error instanceof SyntaxError) {
      return { error: error.message };
    }
    throw error;
  }
}

/** Seaport's order hash: the EIP-712 struct hash of OrderComponents (what getOrderHash returns). */
export function seaportOrderHash(components: SeaportOrderComponents): Hex {
  if (components.counter === null) throw new Error('order counter is not resolved');
  return hashStruct({ data: components as any, primaryType: 'OrderComponents', types: SEAPORT_TYPES as any });
}

function domainSeparator(): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        keccak256(stringToBytes('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(stringToBytes('Seaport')),
        keccak256(stringToBytes('1.6')),
        BigInt(config.blockchain.chainId),
        config.blockchain.seaportAddress as Address,
      ]
    )
  );
}

function eip712Digest(structHash: Hex): Hex {
  return keccak256(concat(['0x1901', domainSeparator(), structHash]));
}

/** Seaport's _isValidBulkOrderSize: (64 + x) + 3 + 32y bytes, 0 <= x <= 1, 1 <= y <= 24 */
function isBulkSignatureLength(length: number): boolean {
  return length >= 99 && length - 99 < 738 && ((length + 29) & 31) < 2;
}

/**
 * The digest an order's signature signs, and the bare ECDSA signature. A bulk signature
 * (seaport-js createBulkOrders, which is how the app lists several names at once) appends a
 * 3-byte leaf index and a merkle proof; the signed digest is over the tree root. Mirrors
 * Seaport's _computeBulkOrderProof.
 */
export function signedDigest(orderHash: Hex, signature: Hex): { digest: Hex; signature: Hex } {
  const bytes = hexToBytes(signature);
  if (!isBulkSignatureLength(bytes.length)) {
    return { digest: eip712Digest(orderHash), signature };
  }

  const sigLength = bytes.length % 2 === 0 ? 65 : 64;
  const key = (bytes[sigLength] << 16) | (bytes[sigLength + 1] << 8) | bytes[sigLength + 2];
  const height = Math.floor((bytes.length - sigLength) / 32);

  let root: Hex = orderHash;
  for (let i = 0; i < height; i++) {
    const start = sigLength + 3 + i * 32;
    const element = bytesToHex(bytes.slice(start, start + 32));
    root = (key >> i) % 2 === 0 ? keccak256(concat([root, element])) : keccak256(concat([element, root]));
  }

  const bulkTypehash = keccak256(stringToBytes(`BulkOrder(OrderComponents${'[2]'.repeat(height)} tree)${ORDER_TYPE_STRINGS}`));
  return {
    digest: eip712Digest(keccak256(concat([bulkTypehash, root]))),
    signature: bytesToHex(bytes.slice(0, sigLength)),
  };
}

/** ecrecover the way Seaport does it for an EOA offerer; null when it can't recover. */
export async function recoverOrderSigner(orderHash: Hex, signature: Hex): Promise<Address | null> {
  try {
    const { digest, signature: ecdsa } = signedDigest(orderHash, signature);
    const length = hexToBytes(ecdsa).length;
    if (length === 64) {
      const sig = compactSignatureToSignature(parseCompactSignature(ecdsa));
      return (await recoverAddress({ hash: digest, signature: sig })).toLowerCase() as Address;
    }
    if (length === 65) {
      const v = hexToBytes(ecdsa)[64];
      if (v !== 27 && v !== 28) return null; // Seaport reverts with BadSignatureV for an EOA
      return (await recoverAddress({ hash: digest, signature: ecdsa })).toLowerCase() as Address;
    }
    return null;
  } catch {
    return null;
  }
}

function chainClient() {
  return createPublicClient({ chain: viemChain, transport: http(config.blockchain.rpcUrl) });
}

function isRevert(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    !!error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ExecutionRevertedError)
  );
}

/**
 * Seaport.validate([order]) as an eth_call: true when Seaport accepts the signature (EIP-1271
 * contract wallets, pre-validated orders, anything the offline check doesn't cover), false on
 * a revert. Throws when the chain can't be reached.
 */
async function validateOnChain(order: ParsedSeaportOrder): Promise<boolean> {
  const { counter: _counter, ...parameters } = order.components;
  try {
    await chainClient().simulateContract({
      address: config.blockchain.seaportAddress as Address,
      abi: SEAPORT_VALIDATE_ABI,
      functionName: 'validate',
      // abitype can't infer tuple[] nested this deep (it types offer/consideration as never[])
      args: [[{
        parameters: { ...parameters, totalOriginalConsiderationItems: BigInt(parameters.consideration.length) },
        signature: order.signature,
      }]] as any,
      account: VALIDATE_CALLER,
    });
    return true;
  } catch (error) {
    if (isRevert(error)) return false;
    throw error;
  }
}

/** The offerer signed this order: offline for EOAs (incl. bulk signatures), else Seaport decides. */
async function checkSignature(order: ParsedSeaportOrder, orderHash: Hex): Promise<OrderCheckFailure | null> {
  const signer = await recoverOrderSigner(orderHash, order.signature);
  if (signer === order.components.offerer) return null;

  try {
    if (await validateOnChain(order)) return null;
  } catch (error: any) {
    logger.error({ error: error?.message, orderHash }, 'Seaport signature check failed');
    return fail(503, 'CHAIN_CHECK_FAILED', 'Could not verify the order signature on-chain, try again');
  }
  return fail(400, 'INVALID_SIGNATURE', 'The order is not validly signed by its offerer');
}

/**
 * An order saved without `counter` (the SDK's order builders leave it out) is signed for the
 * offerer's current Seaport counter, which is also the one a fill uses, so read it from Seaport.
 */
async function resolveCounter(order: ParsedSeaportOrder): Promise<OrderCheckFailure | null> {
  if (order.components.counter !== null) return null;
  try {
    order.components.counter = await chainClient().readContract({
      address: config.blockchain.seaportAddress as Address,
      abi: GET_COUNTER_ABI,
      functionName: 'getCounter',
      args: [order.components.offerer],
    });
    return null;
  } catch (error: any) {
    logger.error({ error: error?.message, offerer: order.components.offerer }, 'Seaport counter lookup failed');
    return fail(503, 'CHAIN_CHECK_FAILED', 'Could not read the offerer\'s Seaport counter, try again');
  }
}

function registrar(): Address {
  return config.blockchain.ensRegistrarAddress.toLowerCase() as Address;
}

function nameWrapper(): Address {
  return config.blockchain.ensNameWrapperAddress.toLowerCase() as Address;
}

function isNftItem(item: SeaportItem): boolean {
  return item.itemType === ItemType.ERC721 || item.itemType === ItemType.ERC1155;
}

/** The v1 token an item must be for this name: the registrar's labelhash token or the NameWrapper's namehash token */
function matchesV1Name(item: SeaportItem, name: string): boolean {
  if (item.token === registrar()) {
    const labels = name.split('.');
    return (
      item.itemType === ItemType.ERC721 &&
      labels.length === 2 && labels[1] === 'eth' && !!labels[0] &&
      item.identifierOrCriteria === BigInt(labelhash(labels[0]))
    );
  }
  if (item.token === nameWrapper()) {
    return item.itemType === ItemType.ERC1155 && item.identifierOrCriteria === BigInt(namehash(name));
  }
  return false;
}

/** For a token with no ens_names row yet: the item is that token on the registrar or the NameWrapper */
function matchesV1Token(item: SeaportItem, tokenId: string): boolean {
  let id: bigint;
  try {
    id = BigInt(tokenId);
  } catch {
    return false;
  }
  return (
    item.identifierOrCriteria === id &&
    ((item.token === registrar() && item.itemType === ItemType.ERC721) ||
      (item.token === nameWrapper() && item.itemType === ItemType.ERC1155))
  );
}

/**
 * A row the order routes created for a token whose name they couldn't look up. Its name isn't
 * the real ENS name and its owner came from the request, so it's checked like a missing row.
 */
function isPlaceholderName(name: NameRef): boolean {
  return name.name === `token-${name.token_id}.eth`;
}

/** Current holder of a v1 token; null when the registrar reverts (expired or never registered). */
async function v1TokenOwner(item: SeaportItem): Promise<string | null> {
  try {
    const owner = await chainClient().readContract({
      address: item.token,
      abi: OWNER_OF_ABI,
      functionName: 'ownerOf',
      args: [item.identifierOrCriteria],
    });
    return owner.toLowerCase();
  } catch (error) {
    if (isRevert(error)) return null;
    throw error;
  }
}

function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

function parseFailure(error: string): OrderCheckFailure {
  return fail(400, 'INVALID_ORDER', `Invalid Seaport order: ${error}`);
}

export interface NameRef {
  id: number;
  name: string;
  token_id: string;
  owner_address: string | null;
  ens_version: number | null;
}

const NAME_REF_COLUMNS = 'id, name, token_id, owner_address, ens_version';

export async function getNameRefById(id: number): Promise<NameRef | null> {
  const result = await getPostgresPool().query(`SELECT ${NAME_REF_COLUMNS} FROM ens_names WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function getNameRefByTokenId(tokenId: string): Promise<NameRef | null> {
  const result = await getPostgresPool().query(
    `SELECT ${NAME_REF_COLUMNS} FROM ens_names WHERE token_id = $1 LIMIT 1`,
    [tokenId]
  );
  return result.rows[0] ?? null;
}

export interface VerifiedListingOrder {
  ok: true;
  orderHash: Hex;
  priceWei: string;
  currencyAddress: string;
}

/**
 * Verify a listing before it's stored.
 *
 * - `seller`: the authenticated wallet; it must be the order's offerer and own the name.
 * - `name`: the ens_names row the listing will be stored against, or null when there's none
 *   yet for `tokenId` (a name registered moments ago), in which case the order's token must
 *   be `tokenId` and the seller must hold it on-chain. Placeholder rows are checked the same way.
 * - `ensV2Checked`: the ENSv2 checks (ensv2-orders.ts) already matched the order's item to the
 *   name's current ETHRegistry token and checked the seller can transfer it.
 *
 * Returns the order hash, price (sum of the consideration, as the app computes it) and
 * currency to store, in place of whatever the client sent. The consideration must be fixed
 * amounts of ETH or of one ERC20 token, so that price is what a fill pays.
 */
export async function verifyListingOrder(params: {
  orderData: unknown;
  seller: string;
  name: NameRef | null;
  tokenId?: string;
  ensV2Checked: boolean;
}): Promise<VerifiedListingOrder | OrderCheckFailure> {
  const order = parseSeaportOrder(params.orderData);
  if ('error' in order) return parseFailure(order.error);
  const { components } = order;
  const seller = params.seller.toLowerCase();
  const placeholder = !!params.name && isPlaceholderName(params.name);
  const name = placeholder ? null : params.name;
  const tokenId = placeholder ? params.name!.token_id : params.tokenId;

  if (components.offerer !== seller) {
    return fail(403, 'OFFERER_MISMATCH', 'The order must be signed by the seller (offerer is a different address)');
  }

  const item = components.offer.find(isNftItem);
  if (!item) {
    return fail(400, 'INVALID_ORDER_ITEM', 'The order does not offer an ENS name');
  }
  if (!params.ensV2Checked) {
    if (name) {
      if (!matchesV1Name(item, name.name)) {
        return fail(400, 'INVALID_ORDER_ITEM', `The order does not trade ${name.name}`);
      }
    } else if (!tokenId || !matchesV1Token(item, tokenId)) {
      return fail(400, 'INVALID_ORDER_ITEM', 'The order does not trade token_id on the ENS registrar or NameWrapper');
    }
  }

  const consideration = components.consideration;
  const currency = consideration[0]?.token ?? ZERO_ADDRESS;
  const payable = consideration.every((c) =>
    (c.itemType === ItemType.NATIVE || c.itemType === ItemType.ERC20) &&
    c.token === currency &&
    c.startAmount === c.endAmount
  );
  if (!payable) {
    return fail(400, 'INVALID_PRICE', 'The order\'s consideration must be fixed amounts of ETH or of one ERC20 token');
  }

  const counterFailure = await resolveCounter(order);
  if (counterFailure) return counterFailure;
  const orderHash = seaportOrderHash(components);
  const signatureFailure = await checkSignature(order, orderHash);
  if (signatureFailure) return signatureFailure;

  // ENSv2 listings already had ownership and transferability checked on-chain
  if (!params.ensV2Checked && !sameAddress(name?.owner_address, seller)) {
    // Our ownership record can lag (a name bought minutes ago): the chain decides
    let owner: string | null;
    try {
      owner = await v1TokenOwner(item);
    } catch (error: any) {
      logger.error({ error: error?.message, orderHash }, 'ENS ownership check failed');
      return fail(503, 'CHAIN_CHECK_FAILED', 'Could not verify name ownership on-chain, try again');
    }
    if (owner !== seller) {
      const label = name?.name ?? `token ${tokenId}`;
      return fail(403, 'NOT_OWNER', `${label} is not owned by the seller`);
    }
  }

  return {
    ok: true,
    orderHash,
    priceWei: consideration.reduce((sum, c) => sum + c.startAmount, 0n).toString(),
    currencyAddress: currency,
  };
}

export interface VerifiedOfferOrder {
  ok: true;
  orderHash: Hex;
  amountWei: string;
  currencyAddress: string;
}

/**
 * Verify an offer before it's stored: signed by `buyer`, and asking for exactly one NFT, this
 * name. The only other consideration allowed is the Grails fee.
 *
 * Returns the order hash, amount (the offer item, as the app reads it) and currency to store.
 */
export async function verifyOfferOrder(params: {
  orderData: unknown;
  buyer: string;
  name: NameRef;
  ensV2Checked: boolean;
}): Promise<VerifiedOfferOrder | OrderCheckFailure> {
  const order = parseSeaportOrder(params.orderData);
  if ('error' in order) return parseFailure(order.error);
  const { components } = order;
  const buyer = params.buyer.toLowerCase();

  if (components.offerer !== buyer) {
    return fail(403, 'OFFERER_MISMATCH', 'The order must be signed by the buyer (offerer is a different address)');
  }

  const offerItem = components.offer[0];
  if (!offerItem) {
    return fail(400, 'INVALID_ORDER', 'Invalid Seaport order: it offers nothing');
  }

  // Criteria items (any token of a contract) count as NFTs too
  const nftItems = components.consideration.filter((c) => c.itemType >= ItemType.ERC721);
  if (nftItems.length !== 1) {
    return fail(400, 'INVALID_ORDER_ITEM', 'An offer must be for exactly one ENS name');
  }
  const item = nftItems[0];
  const matchesName = isPlaceholderName(params.name)
    ? matchesV1Token(item, params.name.token_id)
    : matchesV1Name(item, params.name.name);
  if (!params.ensV2Checked && !matchesName) {
    return fail(400, 'INVALID_ORDER_ITEM', `The order does not ask for ${params.name.name}`);
  }

  const fee = getFeeConfig();
  const others = components.consideration.filter((c) => c !== item);
  if (!others.every((c) => fee.enabled && sameAddress(c.recipient, fee.receiverAddress))) {
    return fail(400, 'INVALID_ORDER_ITEM', 'An offer may only pay the Grails marketplace fee besides the name');
  }

  const counterFailure = await resolveCounter(order);
  if (counterFailure) return counterFailure;
  const orderHash = seaportOrderHash(components);
  const signatureFailure = await checkSignature(order, orderHash);
  if (signatureFailure) return signatureFailure;

  return {
    ok: true,
    orderHash,
    amountWei: offerItem.startAmount.toString(),
    currencyAddress: offerItem.token,
  };
}

/** A listing in a POST /orders/bulk request, after the route's fee and ENSv2 checks */
export interface BatchListing {
  index: number;
  token_id: string;
  order_data: string;
  order_hash: string;
  price_wei: string;
  currency_address: string;
  /** Set when the ENSv2 checks resolved the name (and verified the order's item against it) */
  ensNameId?: number;
}

export interface BatchListingFailure {
  index: number;
  token_id: string;
  order_hash: string;
  status: 'failed';
  error: { code: string; message: string };
}

/**
 * verifyListingOrder for every listing in a bulk request, all sold by `seller`. Verified
 * listings come back with the price, currency and order hash taken from their orders;
 * `namesByTokenId` holds the ens_names rows found for the v1 listings' token IDs.
 */
export async function verifyListingBatch<T extends BatchListing>(listings: T[], seller: string): Promise<{
  verified: T[];
  failed: BatchListingFailure[];
  namesByTokenId: Map<string, NameRef>;
}> {
  const v2NameIds = listings.filter((l) => l.ensNameId !== undefined).map((l) => l.ensNameId!);
  const tokenIds = listings.filter((l) => l.ensNameId === undefined).map((l) => l.token_id);
  const rows = await getPostgresPool().query<NameRef>(
    `SELECT ${NAME_REF_COLUMNS} FROM ens_names WHERE token_id = ANY($1::text[]) OR id = ANY($2::int[])`,
    [tokenIds, v2NameIds]
  );
  const namesById = new Map(rows.rows.map((row) => [row.id, row]));
  const namesByTokenId = new Map(rows.rows.map((row) => [row.token_id, row]));

  const results = await mapWithConcurrency(listings, 8, (listing) => {
    const isV2 = listing.ensNameId !== undefined;
    return verifyListingOrder({
      orderData: listing.order_data,
      seller,
      name: (isV2 ? namesById.get(listing.ensNameId!) : namesByTokenId.get(listing.token_id)) ?? null,
      tokenId: listing.token_id,
      ensV2Checked: isV2,
    });
  });

  const verified: T[] = [];
  const failed: BatchListingFailure[] = [];
  listings.forEach((listing, i) => {
    const result = results[i];
    if (result.ok) {
      verified.push({
        ...listing,
        price_wei: result.priceWei,
        currency_address: result.currencyAddress,
        order_hash: result.orderHash,
      });
    } else {
      failed.push({
        index: listing.index,
        token_id: listing.token_id,
        order_hash: listing.order_hash,
        status: 'failed',
        error: { code: result.code, message: result.message },
      });
    }
  });
  return { verified, failed, namesByTokenId };
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order */
export async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}
