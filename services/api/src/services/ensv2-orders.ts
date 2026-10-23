import {
  getPostgresPool,
  isEthRegistryToken,
  findEnsV2NameByTokenId,
  getOrderNftItem,
  checkEnsV2OrderItem,
  checkEnsV2Transferable,
  getOrderOperator,
  getEnsV2State,
  ensV2LabelId,
  labelhashFromV1TokenId,
  EnsV2Status,
  type EnsV2NameRef,
} from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * Checks for orders on ENSv2 names, run before a listing or offer is stored. A v2 order must
 * trade the name's current ETHRegistry token (ERC1155), and a v2 listing must be fillable:
 * the seller owns the name, can transfer it, nobody else holds a role on it, and the order's
 * operator (Seaport or its conduit) is approved. Non-transferable names can't be listed.
 */

export type OrderSide = 'listing' | 'offer';

export type EnsV2OrderCheck =
  | { ok: true; ensNameId?: number }
  | { ok: false; status: number; code: string; message: string };

const OK: EnsV2OrderCheck = { ok: true };

/** Seaport order parameters from any of the order_data shapes we store */
function orderParameters(orderData: unknown): any {
  const data = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;
  return (data as any)?.protocol_data?.parameters ?? (data as any)?.parameters ?? data ?? {};
}

function fail(status: number, code: string, message: string): EnsV2OrderCheck {
  return { ok: false, status, code, message };
}

/** For POST /listings and POST /offers, which reference the name by ens_names.id */
export async function checkOrderForName(params: {
  ensNameId: number;
  orderData: unknown;
  side: OrderSide;
  seller?: string;
}): Promise<EnsV2OrderCheck> {
  const result = await getPostgresPool().query(
    'SELECT id, name, token_id, ens_version FROM ens_names WHERE id = $1',
    [params.ensNameId]
  );
  const row = result.rows[0];
  if (!row) return OK; // the insert's foreign key reports the missing name

  const orderParams = orderParameters(params.orderData);
  const item = getOrderNftItem(orderParams, params.side);
  if (row.ens_version !== 2) {
    if (item && isEthRegistryToken(item.token)) {
      // The name may have just migrated or been registered on v2, before the indexer caught
      // up: the chain decides whether it's a v2 name now.
      const labelId = ensV2LabelId(row.name);
      if (!labelId) {
        return fail(400, 'INVALID_ORDER_ITEM', `${row.name} is not an ENSv2 name; the order trades an ENSv2 token`);
      }
      let state;
      try {
        state = await getEnsV2State(labelId);
      } catch (error: any) {
        logger.error({ error: error?.message, name: row.name }, 'ENSv2 state lookup failed');
        return fail(503, 'CHAIN_CHECK_FAILED', 'Could not verify the name on-chain, try again');
      }
      if (state.status !== EnsV2Status.REGISTERED) {
        return fail(400, 'INVALID_ORDER_ITEM', `${row.name} is an ENS v1 name; the order trades an ENSv2 token`);
      }
      return checkV2Order({ id: row.id, name: row.name, token_id: state.tokenId }, item, orderParams, params.side, params.seller);
    }
    return OK;
  }
  return checkV2Order(row, item, orderParams, params.side, params.seller);
}

/**
 * For POST /orders and /orders/bulk, which reference the name by token ID. Returns null for
 * a v1 order, which continues down the existing path.
 */
export async function checkOrderForTokenId(params: {
  tokenId: string;
  orderData: unknown;
  side: OrderSide;
  seller?: string;
}): Promise<EnsV2OrderCheck | null> {
  const orderParams = orderParameters(params.orderData);
  const item = getOrderNftItem(orderParams, params.side);

  if (!item || !isEthRegistryToken(item.token)) {
    // A v1 order on a name that's now on v2: by the v2 token ID, or (after a migration, when
    // the row's token_id moved to the v2 ID) by the labelhash the v1 unwrapped token ID encodes.
    const v2 = await getPostgresPool().query(
      `SELECT 1 FROM ens_names
       WHERE ens_version = 2 AND (token_id = $1 OR labelhash = $2)
       LIMIT 1`,
      [params.tokenId, labelhashFromV1TokenId(params.tokenId)]
    );
    if (v2.rows.length > 0) {
      return fail(400, 'INVALID_ORDER_ITEM', 'This is an ENSv2 name: the order must trade its ETHRegistry ERC1155 token');
    }
    return null;
  }

  if (BigInt(item.identifierOrCriteria).toString() !== BigInt(params.tokenId).toString()) {
    return fail(400, 'INVALID_ORDER_ITEM', 'token_id does not match the order\'s token');
  }
  const name = await findEnsV2NameByTokenId(BigInt(params.tokenId).toString());
  if (!name) {
    // Usually a name registered, migrated or regenerated moments ago that the indexer hasn't
    // reached yet: retryable, unlike a 404.
    return fail(503, 'ENS_NAME_NOT_INDEXED', `No ENSv2 name indexed for token ${params.tokenId} yet, try again shortly`);
  }
  return checkV2Order(name, item, orderParams, params.side, params.seller);
}

async function checkV2Order(
  name: Pick<EnsV2NameRef, 'id' | 'name' | 'token_id'>,
  item: ReturnType<typeof getOrderNftItem>,
  orderParams: any,
  side: OrderSide,
  seller?: string
): Promise<EnsV2OrderCheck> {
  // Compare against the CURRENT token ID on-chain, not the indexed one: after a role change
  // the indexer briefly holds the old ID and would reject a correct order. getState accepts
  // any of the name's token IDs. If the chain can't be reached, offers fall back to the
  // indexed ID; listings fail below on the transfer check anyway.
  let currentTokenId = name.token_id;
  try {
    currentTokenId = (await getEnsV2State(name.token_id)).tokenId;
  } catch (error: any) {
    logger.warn({ error: error?.message, name: name.name }, 'ENSv2 token ID lookup failed, using indexed token ID');
  }
  const itemError = checkEnsV2OrderItem(item, currentTokenId);
  if (itemError) {
    return fail(itemError.code === 'STALE_TOKEN_ID' ? 409 : 400, itemError.code, itemError.message);
  }

  if (side === 'listing') {
    if (!seller) {
      return fail(400, 'VALIDATION_ERROR', 'seller address is required');
    }
    const operator = getOrderOperator(orderParams.conduitKey);
    if (!operator) {
      return fail(400, 'UNKNOWN_CONDUIT', `Unsupported conduit key ${orderParams.conduitKey}`);
    }

    let transfer;
    try {
      transfer = await checkEnsV2Transferable({ tokenId: currentTokenId, owner: seller, operator });
    } catch (error: any) {
      logger.error({ error: error?.message, name: name.name }, 'ENSv2 transfer check failed');
      return fail(503, 'CHAIN_CHECK_FAILED', 'Could not verify the name on-chain, try again');
    }

    if (!transfer.ok) {
      switch (transfer.reason) {
        case 'token_changed':
          return fail(409, 'STALE_TOKEN_ID', `${name.name}: ${transfer.detail}`);
        case 'ownership_lost':
          return fail(403, 'NOT_OWNER', `${name.name} is ${transfer.detail}`);
        case 'expired':
          return fail(400, 'NAME_EXPIRED', `${name.name} is expired`);
        case 'not_transferable':
          return fail(400, 'NAME_NOT_TRANSFERABLE', `${name.name} can't be listed: ${transfer.detail}`);
        case 'registry_locked':
          return fail(400, 'NAME_NOT_TRANSFERABLE', `${name.name} can't be listed: ${transfer.detail}`);
        case 'not_approved':
          return fail(400, 'NOT_APPROVED', `Approve the marketplace first: ${transfer.detail}`);
      }
    }
  }

  return { ok: true, ensNameId: name.id };
}
