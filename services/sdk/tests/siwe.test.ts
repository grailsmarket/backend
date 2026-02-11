import { describe, it, expect } from 'vitest';
import { createSiweMessage, prepareSiweMessage, createSiweMessageString } from '../src/auth/siwe.js';

describe('SIWE utilities', () => {
  const testParams = {
    address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    nonce: 'abc123xyz',
    domain: 'grails.app',
    uri: 'https://grails.app',
    chainId: 1,
    statement: 'Sign in to Grails',
    issuedAt: '2024-01-01T00:00:00.000Z',
  };

  describe('createSiweMessage', () => {
    it('should create a SIWE message with all parameters', () => {
      const message = createSiweMessage(testParams);

      expect(message.address).toBe(testParams.address);
      expect(message.nonce).toBe(testParams.nonce);
      expect(message.domain).toBe(testParams.domain);
      expect(message.uri).toBe(testParams.uri);
      expect(message.chainId).toBe(testParams.chainId);
      expect(message.statement).toBe(testParams.statement);
    });

    it('should use defaults for optional parameters', () => {
      const message = createSiweMessage({
        address: testParams.address,
        nonce: testParams.nonce,
      });

      expect(message.address).toBe(testParams.address);
      expect(message.nonce).toBe(testParams.nonce);
      expect(message.chainId).toBe(1);
      expect(message.version).toBe('1');
    });
  });

  describe('prepareSiweMessage', () => {
    it('should prepare message string for signing', () => {
      const message = createSiweMessage(testParams);
      const prepared = prepareSiweMessage(message);

      expect(typeof prepared).toBe('string');
      expect(prepared).toContain(testParams.domain);
      expect(prepared).toContain(testParams.address);
      expect(prepared).toContain(testParams.nonce);
      expect(prepared).toContain('Sign in to Grails');
    });
  });

  describe('createSiweMessageString', () => {
    it('should create and prepare message in one step', () => {
      const messageString = createSiweMessageString(testParams);

      expect(typeof messageString).toBe('string');
      expect(messageString).toContain(testParams.domain);
      expect(messageString).toContain(testParams.address);
      expect(messageString).toContain(testParams.nonce);
    });
  });
});
