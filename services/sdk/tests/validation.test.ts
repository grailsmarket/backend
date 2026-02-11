import { describe, it, expect } from 'vitest';
import {
  isValidAddress,
  normalizeAddress,
  isValidENSName,
  normalizeENSName,
  isValidWeiAmount,
  isValidOrderHash,
  isValidTokenId,
} from '../src/utils/validation.js';

describe('Validation utilities', () => {
  describe('isValidAddress', () => {
    it('should return true for valid addresses', () => {
      expect(isValidAddress('0x1234567890123456789012345678901234567890')).toBe(true);
      expect(isValidAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')).toBe(true);
    });

    it('should return false for invalid addresses', () => {
      expect(isValidAddress('0x123')).toBe(false);
      expect(isValidAddress('1234567890123456789012345678901234567890')).toBe(false);
      expect(isValidAddress('0xGGGG567890123456789012345678901234567890')).toBe(false);
      expect(isValidAddress('')).toBe(false);
    });
  });

  describe('normalizeAddress', () => {
    it('should lowercase valid addresses', () => {
      expect(normalizeAddress('0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'))
        .toBe('0xd8da6bf26964af9d7eed9e03e53415d37aa96045');
    });

    it('should throw for invalid addresses', () => {
      expect(() => normalizeAddress('0x123')).toThrow('Invalid Ethereum address');
    });
  });

  describe('isValidENSName', () => {
    it('should return true for valid ENS names', () => {
      expect(isValidENSName('vitalik.eth')).toBe(true);
      expect(isValidENSName('hello-world.eth')).toBe(true);
      expect(isValidENSName('123.eth')).toBe(true);
    });

    it('should return false for invalid ENS names', () => {
      expect(isValidENSName('')).toBe(false);
      expect(isValidENSName('.eth')).toBe(false);
    });
  });

  describe('normalizeENSName', () => {
    it('should lowercase names', () => {
      expect(normalizeENSName('VITALIK.eth')).toBe('vitalik.eth');
    });

    it('should add .eth suffix if missing', () => {
      expect(normalizeENSName('vitalik')).toBe('vitalik.eth');
    });

    it('should not add double .eth suffix', () => {
      expect(normalizeENSName('vitalik.eth')).toBe('vitalik.eth');
    });
  });

  describe('isValidWeiAmount', () => {
    it('should return true for valid wei amounts', () => {
      expect(isValidWeiAmount('0')).toBe(true);
      expect(isValidWeiAmount('1000000000000000000')).toBe(true);
      expect(isValidWeiAmount('123456789012345678901234567890')).toBe(true);
    });

    it('should return false for invalid wei amounts', () => {
      expect(isValidWeiAmount('-1')).toBe(false);
      expect(isValidWeiAmount('1.5')).toBe(false);
      expect(isValidWeiAmount('abc')).toBe(false);
      expect(isValidWeiAmount('')).toBe(false);
    });
  });

  describe('isValidOrderHash', () => {
    it('should return true for valid order hashes', () => {
      expect(isValidOrderHash('0x' + '1'.repeat(64))).toBe(true);
      expect(isValidOrderHash('0x' + 'a'.repeat(64))).toBe(true);
    });

    it('should return false for invalid order hashes', () => {
      expect(isValidOrderHash('0x123')).toBe(false);
      expect(isValidOrderHash('1'.repeat(64))).toBe(false);
    });
  });

  describe('isValidTokenId', () => {
    it('should return true for valid token IDs', () => {
      expect(isValidTokenId('1')).toBe(true);
      expect(isValidTokenId('12345678901234567890')).toBe(true);
    });

    it('should return false for invalid token IDs', () => {
      expect(isValidTokenId('0')).toBe(false);
      expect(isValidTokenId('-1')).toBe(false);
      expect(isValidTokenId('abc')).toBe(false);
    });
  });
});
