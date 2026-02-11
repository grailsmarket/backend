/**
 * Make Offer Example
 *
 * This example shows how to make an offer on an ENS name
 * using the Grails SDK with Seaport order building.
 */

import { createWalletClient, custom } from 'viem';
import { mainnet } from 'viem/chains';
import {
  GrailsClient,
  SeaportOrderBuilder,
  createViemSigner,
  WETH_ADDRESS,
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

  // Get the ENS name you want to make an offer on
  const ensName = 'vitalik.eth';
  const nameDetails = await grails.names.get(ensName);

  console.log(`\nMaking offer on ${ensName}`);
  console.log(`Token ID: ${nameDetails.token_id}`);
  console.log(`Current owner: ${nameDetails.owner_address}`);

  // Check existing offers
  const existingOffers = await grails.offers.getByName(ensName);
  if (existingOffers.offers.length > 0) {
    const highestOffer = existingOffers.offers[0];
    const highestOfferEth =
      BigInt(highestOffer.offer_amount_wei) / BigInt(10 ** 18);
    console.log(`Highest current offer: ${highestOfferEth} WETH`);
  }

  // Build the Seaport offer order
  const offerAmountWei = '500000000000000000'; // 0.5 WETH
  const offerAmountEth = BigInt(offerAmountWei) / BigInt(10 ** 18);

  console.log(`\nYour offer: ${offerAmountEth} WETH`);

  const order = orderBuilder.buildOfferOrder({
    tokenId: nameDetails.token_id,
    offerAmountWei,
    offerer: address,
    durationDays: 7,
    // Optional: Add platform fee
    // platformFeeRecipient: '0x...',
    // platformFeeBps: 250,
  });

  console.log('\nBuilt Seaport offer order');
  console.log(`Start time: ${new Date(order.startTime * 1000).toISOString()}`);
  console.log(`End time: ${new Date(order.endTime * 1000).toISOString()}`);

  // Validate the order
  const validation = orderBuilder.validate(order);
  if (!validation.valid) {
    console.error('Order validation failed:', validation.errors);
    return;
  }

  console.log('\nOrder ready to sign');

  // IMPORTANT: Before making an offer:
  // 1. Ensure you have enough WETH
  // 2. Approve WETH spending to Seaport contract

  console.log(`\nBefore submitting, ensure you have:`);
  console.log(`  - At least ${offerAmountEth} WETH in your wallet`);
  console.log(`  - Approved Seaport to spend your WETH`);
  console.log(`  - WETH address: ${WETH_ADDRESS}`);

  // After signing with Seaport SDK, save the offer to Grails
  // const signature = await signOrder(order); // Using Seaport SDK

  // const result = await grails.offers.create({
  //   ensNameId: nameDetails.id,
  //   buyerAddress: address,
  //   offerAmountWei,
  //   currencyAddress: WETH_ADDRESS,
  //   orderData: { parameters: order, signature },
  //   expiresAt: new Date(order.endTime * 1000).toISOString(),
  // });

  // console.log('Offer created:', result.id);
}

main().catch(console.error);
