import { describe, it, expect } from 'vitest';
import { SeaportOrderBuilder } from '../src/seaport/order-builder.js';
import { OrderType, ItemType } from '../src/seaport/types.js';
import { ENS_REGISTRAR_ADDRESS, ZERO_ADDRESS } from '../src/seaport/constants.js';

describe('SeaportOrderBuilder', () => {
  const builder = new SeaportOrderBuilder();

  describe('buildListingOrder', () => {
    it('should build a basic listing order', () => {
      const order = builder.buildListingOrder({
        tokenId: '12345678901234567890',
        priceWei: '1000000000000000000', // 1 ETH
        offerer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      });

      expect(order.offerer).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
      expect(order.orderType).toBe(OrderType.FULL_OPEN);

      // Check offer (NFT)
      expect(order.offer).toHaveLength(1);
      expect(order.offer[0].itemType).toBe(ItemType.ERC721);
      expect(order.offer[0].token).toBe(ENS_REGISTRAR_ADDRESS);
      expect(order.offer[0].identifierOrCriteria).toBe('12345678901234567890');

      // Check consideration (payment to seller)
      expect(order.consideration).toHaveLength(1);
      expect(order.consideration[0].itemType).toBe(ItemType.NATIVE);
      expect(order.consideration[0].startAmount).toBe('1000000000000000000');
      expect(order.consideration[0].recipient).toBe('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045');
    });

    it('should add platform fee to consideration', () => {
      const order = builder.buildListingOrder({
        tokenId: '12345678901234567890',
        priceWei: '1000000000000000000', // 1 ETH
        offerer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        platformFeeRecipient: '0x1111111111111111111111111111111111111111',
        platformFeeBps: 250, // 2.5%
      });

      expect(order.consideration).toHaveLength(2);

      // Seller gets 97.5%
      const sellerPayment = BigInt(order.consideration[0].startAmount);
      expect(sellerPayment.toString()).toBe('975000000000000000');

      // Platform gets 2.5%
      const platformFee = BigInt(order.consideration[1].startAmount);
      expect(platformFee.toString()).toBe('25000000000000000');
      expect(order.consideration[1].recipient).toBe('0x1111111111111111111111111111111111111111');
    });

    it('should add broker fee to consideration', () => {
      const order = builder.buildListingOrder({
        tokenId: '12345678901234567890',
        priceWei: '1000000000000000000', // 1 ETH
        offerer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        platformFeeRecipient: '0x1111111111111111111111111111111111111111',
        platformFeeBps: 250,
        brokerFeeRecipient: '0x2222222222222222222222222222222222222222',
        brokerFeeBps: 100, // 1%
      });

      expect(order.consideration).toHaveLength(3);

      // Verify total adds up to price
      const total = order.consideration.reduce(
        (sum, item) => sum + BigInt(item.startAmount),
        0n
      );
      expect(total.toString()).toBe('1000000000000000000');
    });

    it('should set correct timing', () => {
      const before = Math.floor(Date.now() / 1000);

      const order = builder.buildListingOrder({
        tokenId: '12345678901234567890',
        priceWei: '1000000000000000000',
        offerer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
        durationDays: 7,
      });

      const after = Math.floor(Date.now() / 1000);

      // Start time should be around now
      expect(order.startTime).toBeGreaterThanOrEqual(before);
      expect(order.startTime).toBeLessThanOrEqual(after);

      // End time should be 7 days later
      const sevenDays = 7 * 24 * 60 * 60;
      expect(order.endTime).toBe(order.startTime + sevenDays);
    });
  });

  describe('validate', () => {
    it('should validate a correct order', () => {
      const order = builder.buildListingOrder({
        tokenId: '12345678901234567890',
        priceWei: '1000000000000000000',
        offerer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      });

      const result = builder.validate(order);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should catch invalid offerer address', () => {
      const order = builder.buildListingOrder({
        tokenId: '12345678901234567890',
        priceWei: '1000000000000000000',
        offerer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      });

      order.offerer = '0x123'; // Invalid

      const result = builder.validate(order);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Invalid offerer address');
    });

    it('should catch invalid timing', () => {
      const order = builder.buildListingOrder({
        tokenId: '12345678901234567890',
        priceWei: '1000000000000000000',
        offerer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      });

      order.endTime = order.startTime - 1; // End before start

      const result = builder.validate(order);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('End time must be after start time');
    });

    it('should catch empty offer', () => {
      const order = builder.buildListingOrder({
        tokenId: '12345678901234567890',
        priceWei: '1000000000000000000',
        offerer: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
      });

      order.offer = [];

      const result = builder.validate(order);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Order must have at least one offer item');
    });
  });
});
