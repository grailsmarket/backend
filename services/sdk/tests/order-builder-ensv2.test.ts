import { describe, it, expect } from 'vitest';
import { SeaportOrderBuilder } from '../src/seaport/order-builder.js';
import { SeaportOrderFulfiller } from '../src/seaport/order-fulfiller.js';
import { BasicOrderType, ItemType } from '../src/seaport/types.js';
import { getContracts } from '../src/config.js';

const SEPOLIA = 11155111;
const ETH_REGISTRY = getContracts(SEPOLIA).ethRegistry!;
const SELLER = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const V2_TOKEN_ID = '60649293113658356729898504504477945733117666877424817239311691094084368203776';

describe('ENSv2 orders', () => {
  const builder = new SeaportOrderBuilder(SEPOLIA);
  const fulfiller = new SeaportOrderFulfiller();

  it('builds an ERC1155 listing on the ETHRegistry for a v2 name', () => {
    const order = builder.buildListingOrder({
      tokenId: V2_TOKEN_ID,
      ensVersion: 2,
      priceWei: '1000000000000000000',
      offerer: SELLER,
    });

    expect(order.offer[0].itemType).toBe(ItemType.ERC1155);
    expect(order.offer[0].token).toBe(ETH_REGISTRY);
    expect(order.offer[0].identifierOrCriteria).toBe(V2_TOKEN_ID);
    expect(order.offer[0].startAmount).toBe('1');
  });

  it('builds an offer with the ERC1155 ETHRegistry token as consideration', () => {
    const order = builder.buildOfferOrder({
      tokenId: V2_TOKEN_ID,
      ensVersion: 2,
      offerAmountWei: '500000000000000000',
      offerer: SELLER,
    });

    expect(order.consideration[0].itemType).toBe(ItemType.ERC1155);
    expect(order.consideration[0].token).toBe(ETH_REGISTRY);
    expect(order.consideration[0].identifierOrCriteria).toBe(V2_TOKEN_ID);
  });

  it('keeps v1 names on the ERC721 BaseRegistrar by default', () => {
    const order = builder.buildListingOrder({ tokenId: '123', priceWei: '1', offerer: SELLER });
    expect(order.offer[0].itemType).toBe(ItemType.ERC721);
  });

  it('rejects v2 orders on a chain without ENSv2', () => {
    const mainnet = new SeaportOrderBuilder(1);
    expect(() =>
      mainnet.buildListingOrder({ tokenId: V2_TOKEN_ID, ensVersion: 2, priceWei: '1', offerer: SELLER })
    ).toThrow('ENSv2 is not deployed on this chain');
  });

  it('fulfills v2 listings and offers with the ERC1155 basic order types', () => {
    const listing = builder.buildListingOrder({ tokenId: V2_TOKEN_ID, ensVersion: 2, priceWei: '1000', offerer: SELLER });
    const listingParams = fulfiller.buildBasicOrderParameters({ parameters: listing, signature: '0x' } as any);
    expect(listingParams.basicOrderType).toBe(BasicOrderType.ETH_TO_ERC1155_FULL_OPEN);
    expect(listingParams.basicOrderType).toBe(4); // Seaport ETH_TO_ERC1155_FULL_OPEN
    expect(listingParams.offerToken).toBe(ETH_REGISTRY);

    const offer = builder.buildOfferOrder({ tokenId: V2_TOKEN_ID, ensVersion: 2, offerAmountWei: '1000', offerer: SELLER });
    const offerParams = fulfiller.buildBasicOrderParameters({ parameters: offer, signature: '0x' } as any);
    expect(offerParams.basicOrderType).toBe(BasicOrderType.ERC1155_TO_ERC20_FULL_OPEN);
    expect(offerParams.basicOrderType).toBe(20); // Seaport ERC1155_TO_ERC20_FULL_OPEN
  });
});
