/**
 * Buy Name Example
 *
 * This example shows how to purchase an ENS name by fulfilling
 * a Seaport listing on-chain.
 */

import { createWalletClient, createPublicClient, custom, http } from 'viem';
import { mainnet } from 'viem/chains';
import { GrailsClient, SeaportOrderFulfiller } from '@grails/sdk';

async function main() {
  // Create clients
  const grails = new GrailsClient();
  const fulfiller = new SeaportOrderFulfiller();

  // Create viem clients
  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(),
  });

  const walletClient = createWalletClient({
    chain: mainnet,
    transport: custom((window as any).ethereum),
  });

  const [buyerAddress] = await walletClient.getAddresses();
  console.log(`Buyer address: ${buyerAddress}`);

  // Find a name to buy
  const ensName = 'example.eth';

  // Get listings for the name
  const listings = await grails.listings.getByName(ensName);

  if (listings.length === 0) {
    console.log('No active listings found for this name');
    return;
  }

  const listing = listings[0];
  const priceEth = BigInt(listing.price_wei) / BigInt(10 ** 18);

  console.log(`\nFound listing:`);
  console.log(`  Name: ${listing.ens_name}`);
  console.log(`  Price: ${priceEth} ETH`);
  console.log(`  Seller: ${listing.seller_address}`);

  // Check if the order is still valid
  if (!fulfiller.isOrderValid(listing.order_data)) {
    console.error('Listing has expired');
    return;
  }

  // Build the fulfillment parameters
  const fulfillParams = fulfiller.buildBasicOrderParameters(listing.order_data);

  console.log('\nFulfillment parameters built');

  // Calculate the value to send
  const value = fulfiller.calculateValue(listing.order_data);
  console.log(`Value to send: ${value} wei`);

  // Simulate the transaction first
  console.log('\nSimulating transaction...');

  try {
    await publicClient.simulateContract({
      account: buyerAddress,
      address: fulfiller.getSeaportAddress(),
      abi: SeaportOrderFulfiller.getFulfillBasicOrderAbi(),
      functionName: 'fulfillBasicOrder_efficient_6GL6yc',
      args: [fulfillParams],
      value,
    });

    console.log('Simulation successful!');
  } catch (error: any) {
    console.error('Simulation failed:', error.message);
    return;
  }

  // Execute the purchase
  console.log('\nExecuting purchase...');

  const hash = await walletClient.writeContract({
    account: buyerAddress,
    address: fulfiller.getSeaportAddress(),
    abi: SeaportOrderFulfiller.getFulfillBasicOrderAbi(),
    functionName: 'fulfillBasicOrder_efficient_6GL6yc',
    args: [fulfillParams],
    value,
  });

  console.log(`Transaction submitted: ${hash}`);

  // Wait for confirmation
  const receipt = await publicClient.waitForTransactionReceipt({ hash });

  if (receipt.status === 'success') {
    console.log('\nPurchase successful!');
    console.log(`Block: ${receipt.blockNumber}`);
    console.log(`Gas used: ${receipt.gasUsed}`);
  } else {
    console.log('\nTransaction reverted');
  }
}

main().catch(console.error);
