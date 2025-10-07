import {
  createPublicClient,
  createWalletClient,
  http,
  getContract,
  parseUnits,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters
} from 'viem';
import { mainnet } from 'viem/chains';
import { config, SeaportOrder, ItemType, OrderType } from '../../../shared/src';

const publicClient = createPublicClient({
  chain: mainnet,
  transport: http(config.blockchain.rpcUrl),
});

interface CreateOrderParams {
  tokenId: string;
  price: string;
  currency: string;
  duration: number; // days
  offerer: string;
}

export async function createSeaportOrder(params: CreateOrderParams): Promise<SeaportOrder> {
  const { tokenId, price, currency, duration, offerer } = params;

  const startTime = Math.floor(Date.now() / 1000);
  const endTime = startTime + (duration * 24 * 60 * 60);

  const salt = keccak256(encodeAbiParameters(
    parseAbiParameters('uint256, address, uint256'),
    [BigInt(Date.now()), offerer as `0x${string}`, BigInt(tokenId)]
  ));

  const order: SeaportOrder = {
    offerer,
    zone: '0x0000000000000000000000000000000000000000',
    offer: [
      {
        itemType: ItemType.ERC721,
        token: config.blockchain.ensRegistrarAddress,
        identifierOrCriteria: tokenId,
        startAmount: '1',
        endAmount: '1',
      },
    ],
    consideration: [
      {
        itemType: currency === '0x0000000000000000000000000000000000000000'
          ? ItemType.NATIVE
          : ItemType.ERC20,
        token: currency,
        identifierOrCriteria: '0',
        startAmount: price,
        endAmount: price,
        recipient: offerer,
      },
    ],
    orderType: OrderType.FULL_OPEN,
    startTime,
    endTime,
    zoneHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    salt,
    conduitKey: '0x0000000000000000000000000000000000000000000000000000000000000000',
    totalOriginalConsiderationItems: 1,
  };

  return order;
}

export async function validateSeaportOrder(order: SeaportOrder): Promise<{
  valid: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  if (!order.offerer || !order.offerer.match(/^0x[a-fA-F0-9]{40}$/)) {
    errors.push('Invalid offerer address');
  }

  if (!order.offer || order.offer.length === 0) {
    errors.push('Order must have at least one offer item');
  }

  if (!order.consideration || order.consideration.length === 0) {
    errors.push('Order must have at least one consideration item');
  }

  const currentTime = Math.floor(Date.now() / 1000);
  if (order.startTime > currentTime + (365 * 24 * 60 * 60)) {
    errors.push('Start time too far in the future');
  }

  if (order.endTime <= order.startTime) {
    errors.push('End time must be after start time');
  }

  if (order.endTime > currentTime + (365 * 24 * 60 * 60)) {
    errors.push('End time too far in the future');
  }

  order.offer.forEach((item, index) => {
    if (item.itemType === ItemType.ERC721 || item.itemType === ItemType.ERC1155) {
      if (!item.token || !item.token.match(/^0x[a-fA-F0-9]{40}$/)) {
        errors.push(`Invalid token address in offer item ${index}`);
      }
    }

    const startAmount = BigInt(item.startAmount);
    const endAmount = BigInt(item.endAmount);

    if (startAmount < 0n) {
      errors.push(`Invalid start amount in offer item ${index}`);
    }

    if (endAmount < startAmount) {
      errors.push(`End amount must be >= start amount in offer item ${index}`);
    }
  });

  order.consideration.forEach((item, index) => {
    if (!item.recipient || !item.recipient.match(/^0x[a-fA-F0-9]{40}$/)) {
      errors.push(`Invalid recipient address in consideration item ${index}`);
    }

    const startAmount = BigInt(item.startAmount);
    const endAmount = BigInt(item.endAmount);

    if (startAmount <= 0n) {
      errors.push(`Invalid start amount in consideration item ${index}`);
    }

    if (endAmount < startAmount) {
      errors.push(`End amount must be >= start amount in consideration item ${index}`);
    }
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}