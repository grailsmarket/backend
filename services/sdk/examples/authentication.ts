/**
 * Authentication Example
 *
 * This example shows how to authenticate with the Grails API using
 * Sign-In With Ethereum (SIWE).
 */

import { createWalletClient, custom } from 'viem';
import { mainnet } from 'viem/chains';
import { GrailsClient, createViemSigner } from '@grails/sdk';

async function main() {
  // Create Grails client
  const grails = new GrailsClient();

  // Create a viem wallet client (assumes window.ethereum is available)
  // In Node.js, you would use a different transport
  const walletClient = createWalletClient({
    chain: mainnet,
    transport: custom((window as any).ethereum),
  });

  // Get the connected address
  const [address] = await walletClient.getAddresses();
  console.log(`Connected address: ${address}`);

  // Create a signer from the wallet client
  const signer = createViemSigner(walletClient);

  // Sign in
  console.log('Signing in...');

  try {
    const { user, token } = await grails.auth.signIn(address, signer);

    console.log('Successfully signed in!');
    console.log(`User ID: ${user.id}`);
    console.log(`Address: ${user.address}`);
    console.log(`Token: ${token.substring(0, 20)}...`);

    // Check authentication status
    console.log(`\nAuthenticated: ${grails.isAuthenticated}`);
    console.log(`User address: ${grails.userAddress}`);

    // Get current user info
    const me = await grails.auth.me();
    console.log(`\nUser email: ${me.email || 'Not set'}`);
    console.log(`Last sign in: ${me.lastSignIn}`);

    // Logout
    console.log('\nLogging out...');
    await grails.logout();
    console.log(`Authenticated after logout: ${grails.isAuthenticated}`);
  } catch (error: any) {
    console.error('Authentication failed:', error.message);
  }
}

main().catch(console.error);
