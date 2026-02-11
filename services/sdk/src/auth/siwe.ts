/**
 * SIWE (Sign-In With Ethereum) utilities
 */

import { SiweMessage } from 'siwe';

/**
 * Parameters for creating a SIWE message
 */
export interface CreateSiweMessageParams {
  /** Ethereum address */
  address: string;
  /** Nonce from server */
  nonce: string;
  /** Domain making the request */
  domain?: string;
  /** URI of the dapp */
  uri?: string;
  /** Chain ID (default: 1 for mainnet) */
  chainId?: number;
  /** Statement to display */
  statement?: string;
  /** Message expiration time (ISO string) */
  expirationTime?: string;
  /** Issued at time (ISO string, defaults to now) */
  issuedAt?: string;
}

/**
 * Create a SIWE message for signing
 */
export function createSiweMessage(params: CreateSiweMessageParams): SiweMessage {
  // Default domain/uri for Node.js environments
  const defaultDomain = typeof globalThis !== 'undefined' && 'location' in globalThis
    ? (globalThis as unknown as { location: { host: string } }).location.host
    : 'grails.app';
  const defaultUri = typeof globalThis !== 'undefined' && 'location' in globalThis
    ? (globalThis as unknown as { location: { origin: string } }).location.origin
    : 'https://grails.app';

  const {
    address,
    nonce,
    domain = defaultDomain,
    uri = defaultUri,
    chainId = 1,
    statement = 'Sign in to Grails ENS Marketplace',
    expirationTime,
    issuedAt = new Date().toISOString(),
  } = params;

  const message = new SiweMessage({
    domain,
    address,
    statement,
    uri,
    version: '1',
    chainId,
    nonce,
    issuedAt,
    expirationTime,
  });

  return message;
}

/**
 * Prepare SIWE message for signing (get the string to sign)
 */
export function prepareSiweMessage(message: SiweMessage): string {
  return message.prepareMessage();
}

/**
 * Create and prepare a SIWE message in one step
 */
export function createSiweMessageString(params: CreateSiweMessageParams): string {
  const message = createSiweMessage(params);
  return prepareSiweMessage(message);
}
