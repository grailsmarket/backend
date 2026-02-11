/**
 * SDK Configuration
 */

export interface TokenStorage {
  getToken(): string | null;
  setToken(token: string): void;
  clearToken(): void;
  getAddress(): string | null;
  setAddress(address: string): void;
  clearAddress(): void;
}

/**
 * In-memory token storage (default)
 */
export class MemoryTokenStorage implements TokenStorage {
  private token: string | null = null;
  private address: string | null = null;

  getToken(): string | null {
    return this.token;
  }

  setToken(token: string): void {
    this.token = token;
  }

  clearToken(): void {
    this.token = null;
  }

  getAddress(): string | null {
    return this.address;
  }

  setAddress(address: string): void {
    this.address = address;
  }

  clearAddress(): void {
    this.address = null;
  }
}

/**
 * Contract addresses for mainnet
 */
export const CONTRACTS = {
  /** ENS Base Registrar */
  ensRegistrar: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
  /** ENS Registry */
  ensRegistry: '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e',
  /** ENS Name Wrapper */
  nameWrapper: '0xD4416b13d2b3a9AbAe7AcD5D6C2BbDBE25686401',
  /** Seaport 1.6 */
  seaport: '0x0000000000000068F116a894984e2DB1123eB395',
  /** WETH */
  weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
} as const;

/**
 * Default API configuration
 */
export const DEFAULT_CONFIG = {
  baseUrl: 'https://api.grails.app',
  apiVersion: 'v1',
  timeout: 30000,
  retries: 3,
  retryDelay: 1000,
} as const;

/**
 * SDK client options
 */
export interface GrailsClientOptions {
  /** Base URL for the Grails API */
  baseUrl?: string;
  /** API version (default: 'v1') */
  apiVersion?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** Number of retries for failed requests (default: 3) */
  retries?: number;
  /** Delay between retries in milliseconds (default: 1000) */
  retryDelay?: number;
  /** Custom token storage implementation */
  tokenStorage?: TokenStorage;
  /** Custom fetch implementation (for testing or SSR) */
  fetch?: typeof fetch;
}

/**
 * Resolved configuration with all defaults applied
 */
export interface ResolvedConfig {
  baseUrl: string;
  apiVersion: string;
  timeout: number;
  retries: number;
  retryDelay: number;
  tokenStorage: TokenStorage;
  fetch: typeof fetch;
}

/**
 * Resolve configuration with defaults
 */
export function resolveConfig(options?: GrailsClientOptions): ResolvedConfig {
  return {
    baseUrl: options?.baseUrl ?? DEFAULT_CONFIG.baseUrl,
    apiVersion: options?.apiVersion ?? DEFAULT_CONFIG.apiVersion,
    timeout: options?.timeout ?? DEFAULT_CONFIG.timeout,
    retries: options?.retries ?? DEFAULT_CONFIG.retries,
    retryDelay: options?.retryDelay ?? DEFAULT_CONFIG.retryDelay,
    tokenStorage: options?.tokenStorage ?? new MemoryTokenStorage(),
    fetch: options?.fetch ?? globalThis.fetch.bind(globalThis),
  };
}
