'use client';

import { useState, useEffect } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import Link from 'next/link';
import { formatCurrencyAmount } from '@/lib/currency';
import {
  SEAPORT_ADDRESS,
  ENS_REGISTRAR_ADDRESS,
  ENS_NAME_WRAPPER_ADDRESS,
  CONDUIT_CONTROLLER_ADDRESS,
  MARKETPLACE_CONDUIT_ADDRESS,
  MARKETPLACE_CONDUIT_KEY,
  OPENSEA_CONDUIT_ADDRESS,
  OPENSEA_CONDUIT_KEY,
  WETH_ADDRESS,
  GRAILS_FEE_ENABLED
} from '@/lib/constants';
import { parseEther } from 'viem';
import { seaportClient } from '@/services/seaport/seaportClient';
import { CreateListingModal } from '@/components/orders/CreateListingModal';
import { useSeaportClient } from '@/hooks/useSeaportClient';

interface Listing {
  id: number;
  price_wei: string;
  currency_address: string;
  status: string;
  source: 'grails' | 'opensea';
  expires_at: string | null;
  created_at: string;
}

interface ENSName {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
  expiry_date: string | null;
  listings: Listing[];
}

interface Offer {
  id: number;
  ens_name: string;
  token_id: string;
  buyer_address: string;
  offer_amount_wei: string;
  currency_address: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  created_at: string;
  expires_at: string | null;
  order_data?: any; // Seaport order data
}

type Tab = 'names' | 'listings' | 'received';

export default function PortfolioPage() {
  const { address, isConnected } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const { cancelOrders } = useSeaportClient();
  const [activeTab, setActiveTab] = useState<Tab>('names');
  const [names, setNames] = useState<ENSName[]>([]);
  const [offersReceived, setOffersReceived] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [acceptingOfferId, setAcceptingOfferId] = useState<number | null>(null);
  const [showListingModal, setShowListingModal] = useState(false);
  const [selectedName, setSelectedName] = useState<ENSName | null>(null);
  const [cancellingListingId, setCancellingListingId] = useState<number | null>(null);

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }

    const fetchData = async () => {
      try {
        setLoading(true);

        // Fetch owned names
        const namesResponse = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/names?owner=${address}&limit=100`
        );
        const namesData = await namesResponse.json();
        if (namesData.success) {
          setNames(namesData.data.names);
        }

        // Fetch offers received
        const offersResponse = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL}/offers/owner/${address}?status=pending`
        );
        const offersData = await offersResponse.json();
        if (offersData.success) {
          setOffersReceived(offersData.data.offers);
        }
      } catch (error) {
        console.error('Error fetching portfolio data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [address]);

  const handleAcceptOffer = async (offerId: number) => {
    if (!walletClient || !publicClient || !address) {
      alert('Please connect your wallet');
      return;
    }

    try {
      setAcceptingOfferId(offerId);

      // Fetch the full offer details with order_data
      const offerResponse = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/offers/${offerId}`);
      const offerData = await offerResponse.json();

      if (!offerData.success || !offerData.data.order_data) {
        throw new Error('Could not fetch offer order data');
      }

      const offer = offerData.data;
      const orderData = offer.order_data;

      console.log('Accepting offer:', offer);
      console.log('Order data:', orderData);

      // Extract parameters and signature from order_data
      // Order data may have structure: { parameters, signature } or { protocol_data: { parameters, signature } }
      let parameters = orderData.parameters;
      let signature = orderData.signature;
      let storedConduitKey = orderData.conduitKey;

      // Check if data is nested in protocol_data
      if (!parameters && orderData.protocol_data) {
        parameters = orderData.protocol_data.parameters;
        signature = orderData.protocol_data.signature;
        storedConduitKey = orderData.protocol_data.conduitKey;
      }

      // CRITICAL: Convert string values back to BigInts
      // When parameters are stored in the database, BigInts are serialized to strings
      // But Seaport expects BigInts for signature validation
      // The signature was created with BigInt values, so we must recreate the exact same structure
      console.log('Before deserialization - parameter types:', {
        startTime: typeof parameters.startTime,
        endTime: typeof parameters.endTime,
        salt: typeof parameters.salt,
        counter: typeof parameters.counter
      });

      parameters = seaportClient.deserializeOrderParameters(parameters);

      console.log('After deserialization - parameter types:', {
        startTime: typeof parameters.startTime,
        endTime: typeof parameters.endTime,
        salt: typeof parameters.salt,
        counter: typeof parameters.counter
      });

      // Fallback to parameters object itself if it's the root
      if (!parameters && orderData.offerer) {
        parameters = orderData;
      }

      if (!parameters) {
        throw new Error('Invalid order data structure - missing parameters');
      }

      // Build the fulfillOrder call to Seaport
      // We need to call fulfillOrder or fulfillAdvancedOrder on the Seaport contract
      const seaportAbi = [
        {
          name: 'fulfillOrder',
          type: 'function',
          stateMutability: 'payable',
          inputs: [
            {
              name: 'order',
              type: 'tuple',
              components: [
                {
                  name: 'parameters',
                  type: 'tuple',
                  components: [
                    { name: 'offerer', type: 'address' },
                    { name: 'zone', type: 'address' },
                    { name: 'offer', type: 'tuple[]', components: [
                      { name: 'itemType', type: 'uint8' },
                      { name: 'token', type: 'address' },
                      { name: 'identifierOrCriteria', type: 'uint256' },
                      { name: 'startAmount', type: 'uint256' },
                      { name: 'endAmount', type: 'uint256' }
                    ]},
                    { name: 'consideration', type: 'tuple[]', components: [
                      { name: 'itemType', type: 'uint8' },
                      { name: 'token', type: 'address' },
                      { name: 'identifierOrCriteria', type: 'uint256' },
                      { name: 'startAmount', type: 'uint256' },
                      { name: 'endAmount', type: 'uint256' },
                      { name: 'recipient', type: 'address' }
                    ]},
                    { name: 'orderType', type: 'uint8' },
                    { name: 'startTime', type: 'uint256' },
                    { name: 'endTime', type: 'uint256' },
                    { name: 'zoneHash', type: 'bytes32' },
                    { name: 'salt', type: 'uint256' },
                    { name: 'conduitKey', type: 'bytes32' },
                    { name: 'totalOriginalConsiderationItems', type: 'uint256' }
                  ]
                },
                { name: 'signature', type: 'bytes' }
              ]
            },
            { name: 'fulfillerConduitKey', type: 'bytes32' }
          ],
          outputs: [{ name: 'fulfilled', type: 'bool' }]
        },
        // Seaport error signatures for better error messages
        { type: 'error', name: 'InvalidSignature', inputs: [] },
        { type: 'error', name: 'BadContractSignature', inputs: [] },
        { type: 'error', name: 'BadSignatureV', inputs: [{ name: 'v', type: 'uint8' }] },
        { type: 'error', name: 'InvalidSigner', inputs: [] },
        { type: 'error', name: 'InvalidTime', inputs: [{ name: 'startTime', type: 'uint256' }, { name: 'endTime', type: 'uint256' }] },
        { type: 'error', name: 'OrderAlreadyFilled', inputs: [{ name: 'orderHash', type: 'bytes32' }] },
        { type: 'error', name: 'OrderIsCancelled', inputs: [{ name: 'orderHash', type: 'bytes32' }] },
        { type: 'error', name: 'OrderPartiallyFilled', inputs: [{ name: 'orderHash', type: 'bytes32' }] },
        { type: 'error', name: 'BadFraction', inputs: [] },
        { type: 'error', name: 'CannotCancelOrder', inputs: [] },
        { type: 'error', name: 'ConsiderationNotMet', inputs: [{ name: 'orderIndex', type: 'uint256' }, { name: 'considerationIndex', type: 'uint256' }, { name: 'shortfallAmount', type: 'uint256' }] }
      ];

      // The seller needs to pay the offer amount (it's a bid, so seller receives ETH and sends NFT)
      // Actually, this is backwards - the BUYER pays ETH and receives NFT
      // In an offer, the buyer has already signed to send ETH, and we (the seller) fulfill by sending the NFT
      // So value should be 0 for the seller

      // Use the conduit key from various possible locations:
      // 1. Stored separately in order_data or protocol_data
      // 2. Within the parameters.conduitKey
      // 3. Default to zero bytes
      const fulfillerConduitKey = storedConduitKey ||
                                   parameters.conduitKey ||
                                   '0x0000000000000000000000000000000000000000000000000000000000000000';

      // Use the signature from the extracted location, not orderData directly
      let orderSignature = signature || orderData.signature;

      if (!orderSignature) {
        throw new Error('Invalid order data structure - missing signature');
      }

      // Ensure signature has 0x prefix
      if (!orderSignature.startsWith('0x')) {
        orderSignature = `0x${orderSignature}`;
      }

      console.log('Signature info:', {
        signature: orderSignature,
        length: orderSignature.length,
        expectedLength: '130 (64 bytes) or 132 (65 bytes with v)'
      });

      // Log the complete order structure for debugging
      console.log('Complete order structure being sent to Seaport:', {
        parameters: {
          offerer: parameters.offerer,
          zone: parameters.zone,
          offerLength: parameters.offer?.length,
          considerationLength: parameters.consideration?.length,
          orderType: parameters.orderType,
          startTime: parameters.startTime?.toString(),
          endTime: parameters.endTime?.toString(),
          zoneHash: parameters.zoneHash,
          salt: parameters.salt?.toString(),
          conduitKey: parameters.conduitKey,
          totalOriginalConsiderationItems: parameters.totalOriginalConsiderationItems?.toString(),
          counter: parameters.counter?.toString()
        },
        signature: orderSignature,
        fulfillerConduitKey
      });

      // Check what counter the offerer currently has on Seaport
      const currentCounter = await publicClient.readContract({
        address: SEAPORT_ADDRESS as `0x${string}`,
        abi: [
          {
            name: 'getCounter',
            type: 'function',
            inputs: [{ name: 'offerer', type: 'address' }],
            outputs: [{ name: 'counter', type: 'uint256' }],
            stateMutability: 'view'
          }
        ],
        functionName: 'getCounter',
        args: [parameters.offerer as `0x${string}`]
      });

      console.log('Counter check:', {
        storedCounter: parameters.counter,
        currentCounter: currentCounter.toString(),
        match: parameters.counter?.toString() === currentCounter.toString()
      });

      // Update counter if it's different
      if (parameters.counter?.toString() !== currentCounter.toString()) {
        console.warn('Counter mismatch! Order was signed with old counter. This order is invalid.');
        throw new Error(`Order counter mismatch. Order counter: ${parameters.counter}, Current counter: ${currentCounter}. The offerer may have cancelled orders or the order is stale.`);
      }

      console.log('Fulfilling order with:', {
        conduitKey: fulfillerConduitKey,
        offerer: parameters.offerer,
        orderType: parameters.orderType,
        hasSignature: !!orderSignature
      });

      // Check if we need to approve the NFT transfer
      // The consideration (what buyer wants) should contain the NFT
      const nftConsideration = parameters.consideration.find((item: any) =>
        item.itemType === 2 || item.itemType === 3 // ERC721 or ERC1155
      );

      if (!nftConsideration) {
        throw new Error('Could not find NFT in offer consideration');
      }

      const nftContract = nftConsideration.token;
      const isWrapped = nftContract.toLowerCase() === ENS_NAME_WRAPPER_ADDRESS.toLowerCase();

      // Determine which address needs approval based on conduit key
      let operatorToApprove: string;

      if (fulfillerConduitKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        // No conduit, use Seaport directly
        operatorToApprove = SEAPORT_ADDRESS;
        console.log('Using Seaport directly (no conduit)');
      } else {
        // Need to resolve conduit key to conduit address
        // Check known conduit keys first
        if (fulfillerConduitKey === MARKETPLACE_CONDUIT_KEY) {
          operatorToApprove = MARKETPLACE_CONDUIT_ADDRESS;
          console.log('Using marketplace conduit');
        } else if (fulfillerConduitKey === OPENSEA_CONDUIT_KEY) {
          operatorToApprove = OPENSEA_CONDUIT_ADDRESS;
          console.log('Using OpenSea conduit');
        } else {
          // Query the Conduit Controller to get the conduit address
          console.log('Querying Conduit Controller for conduit address...');
          try {
            const conduitData = await publicClient.readContract({
              address: CONDUIT_CONTROLLER_ADDRESS as `0x${string}`,
              abi: [
                {
                  name: 'getConduit',
                  type: 'function',
                  inputs: [{ name: 'conduitKey', type: 'bytes32' }],
                  outputs: [
                    { name: 'conduit', type: 'address' },
                    { name: 'exists', type: 'bool' }
                  ],
                  stateMutability: 'view'
                }
              ],
              functionName: 'getConduit',
              args: [fulfillerConduitKey as `0x${string}`]
            }) as [string, boolean];

            const [conduitAddress, exists] = conduitData;

            if (!exists || conduitAddress === '0x0000000000000000000000000000000000000000') {
              throw new Error('Conduit does not exist for this key');
            }

            operatorToApprove = conduitAddress;
            console.log('Resolved conduit address:', conduitAddress);
          } catch (error) {
            console.error('Failed to resolve conduit address:', error);
            throw new Error('Could not resolve conduit address from conduit key');
          }
        }
      }

      console.log('Checking approval for:', {
        nftContract,
        operator: operatorToApprove,
        conduitKey: fulfillerConduitKey,
        isWrapped
      });

      // Check if already approved
      const isApproved = await publicClient.readContract({
        address: nftContract as `0x${string}`,
        abi: [
          {
            name: 'isApprovedForAll',
            type: 'function',
            inputs: [
              { name: 'owner', type: 'address' },
              { name: 'operator', type: 'address' }
            ],
            outputs: [{ name: '', type: 'bool' }],
            stateMutability: 'view'
          }
        ],
        functionName: 'isApprovedForAll',
        args: [address as `0x${string}`, operatorToApprove as `0x${string}`]
      });

      console.log('Approval check result:', {
        isApproved,
        owner: address,
        operator: operatorToApprove,
        nftContract
      });

      // If not approved, request approval
      if (!isApproved) {
        console.log('Requesting NFT approval...');

        const approvalHash = await walletClient.writeContract({
          address: nftContract as `0x${string}`,
          abi: [
            {
              name: 'setApprovalForAll',
              type: 'function',
              inputs: [
                { name: 'operator', type: 'address' },
                { name: 'approved', type: 'bool' }
              ],
              outputs: [],
              stateMutability: 'nonpayable'
            }
          ],
          functionName: 'setApprovalForAll',
          args: [operatorToApprove as `0x${string}`, true],
          account: address
        });

        console.log('NFT approval transaction sent:', approvalHash);

        // Wait for approval to be confirmed
        await publicClient.waitForTransactionReceipt({ hash: approvalHash });
        console.log('NFT approval confirmed');
      }

      // Check if there are any WETH fees that need to be paid by the seller (fulfiller)
      // When accepting an offer with Grails fees enabled, the seller needs to approve
      // the conduit to transfer WETH on their behalf for the fee payment
      if (GRAILS_FEE_ENABLED) {
        const wethConsiderations = parameters.consideration.filter((item: any) =>
          item.itemType === 1 && // ERC20
          item.token?.toLowerCase() === WETH_ADDRESS.toLowerCase() &&
          item.recipient?.toLowerCase() !== parameters.offerer?.toLowerCase() // Not the main payment to buyer
        );

        if (wethConsiderations.length > 0) {
          console.log('Found WETH fee considerations:', wethConsiderations);

          // Calculate total WETH fees the seller needs to pay
          const totalWethFees = wethConsiderations.reduce(
            (sum: bigint, item: any) => sum + BigInt(item.startAmount || 0),
            0n
          );

          console.log('Total WETH fees to approve:', totalWethFees.toString());

          // Check current WETH allowance for the conduit/seaport
          const currentAllowance = await publicClient.readContract({
            address: WETH_ADDRESS as `0x${string}`,
            abi: [
              {
                name: 'allowance',
                type: 'function',
                inputs: [
                  { name: 'owner', type: 'address' },
                  { name: 'spender', type: 'address' }
                ],
                outputs: [{ name: '', type: 'uint256' }],
                stateMutability: 'view'
              }
            ],
            functionName: 'allowance',
            args: [address as `0x${string}`, operatorToApprove as `0x${string}`]
          }) as bigint;

          console.log('Current WETH allowance:', {
            allowance: currentAllowance.toString(),
            required: totalWethFees.toString(),
            sufficient: currentAllowance >= totalWethFees
          });

          // If allowance is insufficient, request approval
          if (currentAllowance < totalWethFees) {
            console.log('WETH allowance insufficient, requesting approval...');

            // Approve a larger amount to cover future fees (approve 10x the current fee)
            const approvalAmount = totalWethFees * 10n;

            const wethApprovalHash = await walletClient.writeContract({
              address: WETH_ADDRESS as `0x${string}`,
              abi: [
                {
                  name: 'approve',
                  type: 'function',
                  inputs: [
                    { name: 'spender', type: 'address' },
                    { name: 'amount', type: 'uint256' }
                  ],
                  outputs: [{ name: '', type: 'bool' }],
                  stateMutability: 'nonpayable'
                }
              ],
              functionName: 'approve',
              args: [operatorToApprove as `0x${string}`, approvalAmount],
              account: address
            });

            console.log('WETH approval transaction sent:', wethApprovalHash);

            // Wait for WETH approval to be confirmed
            await publicClient.waitForTransactionReceipt({ hash: wethApprovalHash });
            console.log('WETH approval confirmed');
          }
        }
      }

      // Now fulfill the order
      console.log('Preparing to fulfill order with:', {
        seaportAddress: SEAPORT_ADDRESS,
        fulfillerConduitKey,
        orderParameters: {
          offerer: parameters.offerer,
          zone: parameters.zone,
          offerCount: parameters.offer?.length,
          considerationCount: parameters.consideration?.length,
          orderType: parameters.orderType,
          startTime: parameters.startTime,
          endTime: parameters.endTime,
          conduitKey: parameters.conduitKey
        },
        hasSignature: !!orderSignature,
        signatureLength: orderSignature?.length
      });

      // Simulate the transaction first to validate it
      console.log('Simulating transaction to validate order...');
      try {
        const simulation = await publicClient.simulateContract({
          address: SEAPORT_ADDRESS as `0x${string}`,
          abi: seaportAbi,
          functionName: 'fulfillOrder',
          args: [
            {
              parameters,
              signature: orderSignature
            },
            fulfillerConduitKey as `0x${string}`
          ],
          account: address,
          value: 0n,
        });
        console.log('Simulation successful! Order is valid:', simulation);
      } catch (simulationError: any) {
        console.error('Simulation failed - order validation error:', {
          message: simulationError.message,
          cause: simulationError.cause,
          shortMessage: simulationError.shortMessage,
          details: simulationError.details,
          metaMessages: simulationError.metaMessages
        });

        // Try to extract useful error info
        const errorMessage = simulationError.shortMessage || simulationError.message || 'Unknown error';
        throw new Error(`Order validation failed: ${errorMessage}`);
      }

      const hash = await walletClient.writeContract({
        address: SEAPORT_ADDRESS as `0x${string}`,
        abi: seaportAbi,
        functionName: 'fulfillOrder',
        args: [
          {
            parameters,
            signature: orderSignature
          },
          fulfillerConduitKey as `0x${string}`
        ],
        account: address,
        value: 0n, // Seller doesn't pay, buyer pays
      });

      console.log('FulfillOrder transaction sent:', hash);

      console.log('Transaction sent:', hash);

      // Wait for transaction confirmation
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      console.log('Transaction confirmed:', receipt);

      // Update offer status in API
      await fetch(`${process.env.NEXT_PUBLIC_API_URL}/offers/${offerId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'accepted',
        }),
      });

      // Remove offer from list
      setOffersReceived(offersReceived.filter(o => o.id !== offerId));

      alert('Offer accepted successfully!');
    } catch (error: any) {
      console.error('Error accepting offer:', error);
      alert(`Failed to accept offer: ${error.message || 'Unknown error'}`);
    } finally {
      setAcceptingOfferId(null);
    }
  };

  const handleRejectOffer = async (offerId: number) => {
    if (!confirm('Are you sure you want to reject this offer?')) {
      return;
    }

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/offers/${offerId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'rejected',
        }),
      });

      if (response.ok) {
        setOffersReceived(offersReceived.filter(offer => offer.id !== offerId));
      }
    } catch (error) {
      console.error('Error rejecting offer:', error);
      alert('Failed to reject offer');
    }
  };

  const handleCancelListing = async (listingId: number, source?: string) => {
    if (!address) {
      alert('Please connect your wallet');
      return;
    }

    const confirmed = confirm(
      `Are you sure you want to cancel this listing?${
        source === 'both'
          ? ' This will cancel on both Grails and OpenSea (requires on-chain transaction).'
          : source === 'opensea'
          ? ' This will cancel on OpenSea (requires on-chain transaction).'
          : ' This will cancel the listing (requires on-chain transaction).'
      }`
    );

    if (!confirmed) return;

    try {
      setCancellingListingId(listingId);

      // Use the Seaport client hook to handle on-chain cancellation
      await cancelOrders([listingId]);

      console.log('Listing cancelled successfully');

      // Refresh the listings
      const namesResponse = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/names?owner=${address}&limit=100`
      );
      const namesData = await namesResponse.json();
      if (namesData.success) {
        setNames(namesData.data.names);
      }

      alert('Listing cancelled successfully!');
    } catch (error: any) {
      console.error('Error cancelling listing:', error);
      alert(`Failed to cancel listing: ${error.message}`);
    } finally {
      setCancellingListingId(null);
    }
  };

  if (!isConnected) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-4">My Portfolio</h1>
          <p className="text-gray-400 mb-8">Please connect your wallet to view your portfolio.</p>
        </div>
      </div>
    );
  }

  const listedNames = names.filter(n => n.listings && n.listings.length > 0);
  const unlistedNames = names.filter(n => !n.listings || n.listings.length === 0);

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-4">My Portfolio</h1>
        <p className="text-gray-400">Manage your ENS names, listings, and offers</p>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-6 border-b border-gray-700">
        <button
          onClick={() => setActiveTab('names')}
          className={`px-6 py-3 font-medium transition border-b-2 ${
            activeTab === 'names'
              ? 'border-purple-500 text-purple-400'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          My Names ({names.length})
        </button>
        <button
          onClick={() => setActiveTab('listings')}
          className={`px-6 py-3 font-medium transition border-b-2 ${
            activeTab === 'listings'
              ? 'border-purple-500 text-purple-400'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Active Listings ({listedNames.length})
        </button>
        <button
          onClick={() => setActiveTab('received')}
          className={`px-6 py-3 font-medium transition border-b-2 relative ${
            activeTab === 'received'
              ? 'border-purple-500 text-purple-400'
              : 'border-transparent text-gray-400 hover:text-white'
          }`}
        >
          Offers Received ({offersReceived.length})
          {offersReceived.length > 0 && (
            <span className="absolute top-2 right-1 w-2 h-2 bg-purple-500 rounded-full"></span>
          )}
        </button>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto"></div>
          <p className="text-gray-400 mt-4">Loading portfolio...</p>
        </div>
      ) : (
        <>
          {/* My Names Tab */}
          {activeTab === 'names' && (
            <div className="space-y-4">
              {names.length === 0 ? (
                <div className="text-center py-12 bg-gray-800 rounded-lg border border-gray-700">
                  <p className="text-gray-400 mb-4">You don't own any ENS names yet.</p>
                  <a
                    href="https://app.ens.domains/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-block bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
                  >
                    Register an ENS Name
                  </a>
                </div>
              ) : (
                names.map((name) => (
                  <div
                    key={name.id}
                    className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-gray-600 transition"
                  >
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <Link
                            href={`/names/${name.name}`}
                            className="text-xl font-bold text-white hover:text-purple-400 transition"
                          >
                            {name.name}
                          </Link>
                          {name.listings && name.listings.length > 0 && (
                            <div className="flex gap-1">
                              {name.listings.map(listing => (
                                <span
                                  key={listing.id}
                                  className={`px-2 py-1 rounded text-xs font-semibold ${
                                    listing.source === 'opensea'
                                      ? 'bg-blue-900/30 text-blue-400 border border-blue-700'
                                      : 'bg-purple-900/30 text-purple-400 border border-purple-700'
                                  }`}
                                >
                                  {listing.source === 'opensea' ? 'OpenSea' : 'Grails'}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                          {name.listings && name.listings.length > 0 && (
                            <div>
                              <span className="text-gray-400">Listed Price:</span>
                              <span className="text-white font-semibold ml-2">
                                {formatCurrencyAmount(name.listings[0].price_wei, name.listings[0].currency_address)}
                              </span>
                            </div>
                          )}
                          {name.expiry_date && (
                            <div>
                              <span className="text-gray-400">Expires:</span>
                              <span className="text-white ml-2">
                                {new Date(name.expiry_date).toLocaleDateString()}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <Link
                          href={`/names/${name.name}`}
                          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
                        >
                          View
                        </Link>
                        {(!name.listings || name.listings.length === 0) && (
                          <button
                            onClick={() => {
                              setSelectedName(name);
                              setShowListingModal(true);
                            }}
                            className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition"
                          >
                            List for Sale
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Active Listings Tab */}
          {activeTab === 'listings' && (
            <div className="space-y-4">
              {listedNames.length === 0 ? (
                <div className="text-center py-12 bg-gray-800 rounded-lg border border-gray-700">
                  <p className="text-gray-400 mb-4">You don't have any active listings.</p>
                  {unlistedNames.length > 0 && (
                    <button
                      onClick={() => setActiveTab('names')}
                      className="inline-block bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
                    >
                      List a Name
                    </button>
                  )}
                </div>
              ) : (
                listedNames.flatMap((name) =>
                  name.listings.map((listing) => (
                    <div
                      key={`${name.id}-${listing.id}`}
                      className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-gray-600 transition"
                    >
                      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                        <div className="flex-1">
                          <div className="flex items-center gap-3 mb-2">
                            <Link
                              href={`/names/${name.name}`}
                              className="text-xl font-bold text-white hover:text-purple-400 transition"
                            >
                              {name.name}
                            </Link>
                            <span
                              className={`px-3 py-1 rounded text-xs font-semibold ${
                                listing.source === 'opensea'
                                  ? 'bg-blue-900/30 text-blue-400 border border-blue-700'
                                  : 'bg-purple-900/30 text-purple-400 border border-purple-700'
                              }`}
                            >
                              {listing.source === 'opensea' ? 'OpenSea' : 'Grails'}
                            </span>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                            <div>
                              <span className="text-gray-400">Price:</span>
                              <span className="text-white font-semibold ml-2">
                                {formatCurrencyAmount(listing.price_wei, listing.currency_address)}
                              </span>
                            </div>
                            {listing.expires_at && (
                              <div>
                                <span className="text-gray-400">Expires:</span>
                                <span className="text-white ml-2">
                                  {new Date(listing.expires_at).toLocaleDateString()}
                                </span>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex gap-2 items-center">
                          <Link
                            href={`/names/${name.name}`}
                            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
                          >
                            View
                          </Link>
                          <button
                            onClick={() => handleCancelListing(listing.id, listing.source)}
                            disabled={cancellingListingId === listing.id}
                            className="px-4 py-2 bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-700 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {cancellingListingId === listing.id ? 'Cancelling...' : 'Cancel'}
                          </button>
                        </div>
                      </div>
                    </div>
                  ))
                )
              )}
            </div>
          )}

          {/* Offers Received Tab */}
          {activeTab === 'received' && (
            <div className="space-y-4">
              {offersReceived.length === 0 ? (
                <div className="text-center py-12 bg-gray-800 rounded-lg border border-gray-700">
                  <p className="text-gray-400">You haven't received any offers yet.</p>
                </div>
              ) : (
                offersReceived.map((offer) => (
                  <div
                    key={offer.id}
                    className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-gray-600 transition"
                  >
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                      <div className="flex-1">
                        <div className="flex items-center gap-3 mb-2">
                          <Link
                            href={`/names/${offer.ens_name}`}
                            className="text-xl font-bold text-white hover:text-purple-400 transition"
                          >
                            {offer.ens_name}
                          </Link>
                          <span className="px-3 py-1 rounded-full text-xs font-semibold bg-yellow-900/30 text-yellow-400 border border-yellow-700">
                            New Offer
                          </span>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                          <div>
                            <span className="text-gray-400">Offer Amount:</span>
                            <span className="text-white font-semibold ml-2">
                              {formatCurrencyAmount(offer.offer_amount_wei, offer.currency_address)}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">From:</span>
                            <span className="text-white ml-2 font-mono text-xs">
                              {offer.buyer_address.slice(0, 6)}...{offer.buyer_address.slice(-4)}
                            </span>
                          </div>
                          <div>
                            <span className="text-gray-400">Received:</span>
                            <span className="text-white ml-2">
                              {new Date(offer.created_at).toLocaleDateString()}
                            </span>
                          </div>
                          {offer.expires_at && (
                            <div>
                              <span className="text-gray-400">Expires:</span>
                              <span className="text-white ml-2">
                                {new Date(offer.expires_at).toLocaleDateString()}
                              </span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          onClick={() => handleAcceptOffer(offer.id)}
                          disabled={acceptingOfferId === offer.id}
                          className="px-4 py-2 bg-green-900/30 hover:bg-green-900/50 text-green-400 border border-green-700 rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {acceptingOfferId === offer.id ? 'Accepting...' : 'Accept'}
                        </button>
                        <button
                          onClick={() => handleRejectOffer(offer.id)}
                          disabled={acceptingOfferId === offer.id}
                          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      {/* Create Listing Modal */}
      {selectedName && (
        <CreateListingModal
          isOpen={showListingModal}
          onClose={() => {
            setShowListingModal(false);
            setSelectedName(null);
          }}
          tokenId={selectedName.token_id}
          ensName={selectedName.name}
          ownerAddress={selectedName.owner_address}
        />
      )}
    </div>
  );
}
