/**
 * Auth module exports
 */

export {
  createSiweMessage,
  prepareSiweMessage,
  createSiweMessageString,
  type CreateSiweMessageParams,
} from './siwe.js';

export { SessionManager } from './session.js';

export {
  createViemSigner,
  createWagmiSigner,
  createCustomSigner,
  type MessageSigner,
} from './wallet-adapter.js';
