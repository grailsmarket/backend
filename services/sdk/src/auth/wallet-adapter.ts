/**
 * Wallet adapter for signing messages
 */

import type { WalletClient } from 'viem';

/**
 * Signer interface for signing SIWE messages
 */
export interface MessageSigner {
  signMessage(message: string): Promise<string>;
}

/**
 * Create a signer from a viem WalletClient
 *
 * @example
 * ```ts
 * import { createWalletClient, custom } from 'viem';
 * import { mainnet } from 'viem/chains';
 * import { createViemSigner } from '@grails/sdk';
 *
 * const walletClient = createWalletClient({
 *   chain: mainnet,
 *   transport: custom(window.ethereum),
 * });
 *
 * const signer = createViemSigner(walletClient);
 * ```
 */
export function createViemSigner(walletClient: WalletClient): MessageSigner {
  return {
    async signMessage(message: string): Promise<string> {
      const [account] = await walletClient.getAddresses();
      if (!account) {
        throw new Error('No account found in wallet');
      }

      const signature = await walletClient.signMessage({
        account,
        message,
      });

      return signature;
    },
  };
}

/**
 * Create a signer from wagmi/RainbowKit's signMessageAsync function
 *
 * This is useful when using wagmi hooks where you already have signMessageAsync
 *
 * @example
 * ```ts
 * import { useSignMessage } from 'wagmi';
 * import { createWagmiSigner } from '@grails/sdk';
 *
 * function MyComponent() {
 *   const { signMessageAsync } = useSignMessage();
 *   const signer = createWagmiSigner(signMessageAsync);
 *
 *   // Use signer with grails.auth.signIn(address, signer)
 * }
 * ```
 */
export function createWagmiSigner(
  signMessageAsync: (args: { message: string }) => Promise<`0x${string}`>
): MessageSigner {
  return {
    async signMessage(message: string): Promise<string> {
      return signMessageAsync({ message });
    },
  };
}

/**
 * Create a signer from a raw signing function
 *
 * @example
 * ```ts
 * const signer = createCustomSigner(async (message) => {
 *   // Your custom signing logic
 *   return await myWallet.sign(message);
 * });
 * ```
 */
export function createCustomSigner(
  signFn: (message: string) => Promise<string>
): MessageSigner {
  return {
    signMessage: signFn,
  };
}
