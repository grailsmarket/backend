/**
 * Create Listing Example
 *
 * This example shows how to create a listing for an ENS name
 * using the Grails SDK with Seaport order building.
 */

import { createWalletClient, custom } from 'viem';
import { mainnet } from 'viem/chains';
import {
  GrailsClient,
  SeaportOrderBuilder,
  createViemSigner,
} from '@grails/sdk';

async function main() {
  // Create clients
  const grails = new GrailsClient();
  const orderBuilder = new SeaportOrderBuilder();

  // Create viem wallet client
  const walletClient = createWalletClient({
    chain: mainnet,
    transport: custom((window as any).ethereum),
  });

  const [address] = await walletClient.getAddresses();
  console.log(`Connected address: ${address}`);

  // Authenticate first
  const signer = createViemSigner(walletClient);
  await grails.auth.signIn(address, signer);
  console.log('Authenticated successfully');

  // Get the ENS name you want to list
  const ensName = 'myname.eth';
  const nameDetails = await grails.names.get(ensName);

  console.log(`\nListing ${ensName}`);
  console.log(`Token ID: ${nameDetails.token_id}`);
  console.log(`Owner: ${nameDetails.owner_address}`);

  // Verify you own the name
  if (nameDetails.owner_address?.toLowerCase() !== address.toLowerCase()) {
    console.error('You do not own this name!');
    return;
  }

  // Build the Seaport order
  const priceWei = '1000000000000000000'; // 1 ETH

  const order = orderBuilder.buildListingOrder({
    tokenId: nameDetails.token_id,
    priceWei,
    offerer: address,
    durationDays: 7,
    // Optional: Add platform fee
    // platformFeeRecipient: '0x...',
    // platformFeeBps: 250,
  });

  console.log('\nBuilt Seaport order');
  console.log(`Start time: ${new Date(order.startTime * 1000).toISOString()}`);
  console.log(`End time: ${new Date(order.endTime * 1000).toISOString()}`);

  // Validate the order
  const validation = orderBuilder.validate(order);
  if (!validation.valid) {
    console.error('Order validation failed:', validation.errors);
    return;
  }

  // Sign the order with Seaport
  // Note: This requires the Seaport SDK for actual signing
  // Here we just show the structure

  console.log('\nOrder ready to sign');
  console.log('Use Seaport SDK to sign and submit the order');

  // After signing, save the order to Grails
  // const signature = await signOrder(order); // Using Seaport SDK

  // const result = await grails.orders.save({
  //   type: 'listing',
  //   token_id: nameDetails.token_id,
  //   price_wei: priceWei,
  //   order_data: JSON.stringify({ parameters: order, signature }),
  //   order_hash: orderHash, // Computed from signed order
  //   seller_address: address,
  //   source: 'grails',
  // });

  // console.log('Listing created:', result.id);
}

main().catch(console.error);
