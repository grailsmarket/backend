import {
  getPostgresPool,
  isEthRegistryToken,
  findEnsV2NameByTokenId,
  getOrderNftItem,
  checkEnsV2OrderItem,
  checkEnsV2Transferable,
  getOrderOperator,
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
      return fail(400, 'INVALID_ORDER_ITEM', `${row.name} is an ENS v1 name; the order trades an ENSv2 token`);
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
    const v2 = await getPostgresPool().query(
      'SELECT 1 FROM ens_names WHERE token_id = $1 AND ens_version = 2',
      [params.tokenId]
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
    return fail(404, 'ENS_NAME_NOT_FOUND', `No ENSv2 name for token ${params.tokenId}`);
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
  const itemError = checkEnsV2OrderItem(item, name.token_id);
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
      transfer = await checkEnsV2Transferable({ tokenId: name.token_id, owner: seller, operator });
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
