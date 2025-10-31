import { useEffect, useState, useCallback } from 'react';
import { useAccount, useWalletClient, usePublicClient } from 'wagmi';
import { seaportClient } from '@/services/seaport/seaportClient';
import { OrderWithCounter } from '@opensea/seaport-js/lib/types';

export function useSeaportClient() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize Seaport client when wallet connects
  useEffect(() => {
    const initializeSeaport = async () => {
      if (!publicClient) return;

      try {
        // Pass viem clients directly
        await seaportClient.initialize(publicClient, walletClient || undefined);
        setIsInitialized(true);
      } catch (err) {
        console.error('Failed to initialize Seaport:', err);
        setError('Failed to initialize Seaport client');
      }
    };

    initializeSeaport();
  }, [publicClient, walletClient, isConnected]);

  // Create a listing
  const createListing = useCallback(
    async (params: {
      tokenId: string;
      priceInEth: string;
      durationDays: number;
      royaltyBps?: number;
      royaltyRecipient?: string;
      marketplace: 'opensea' | 'grails' | 'both';
      currency?: 'ETH' | 'USDC';
    }) => {
      if (!isInitialized || !address) {
        throw new Error('Wallet not connected or Seaport not initialized');
      }

      setIsLoading(true);
      setError(null);

      try {
        const order = await seaportClient.createListingOrder({
          ...params,
          offererAddress: address,
          marketplace: params.marketplace,
          currency: params.currency,
        });

        // Handle "both" marketplace case
        if (params.marketplace === 'both' && 'opensea' in order && 'grails' in order) {
          // Create two separate listings - one for each platform
          const openSeaOrder = seaportClient.formatOrderForStorage(order.opensea);
          openSeaOrder.marketplace = 'opensea';

          const grailsOrder = seaportClient.formatOrderForStorage(order.grails);
          grailsOrder.marketplace = 'grails';

          // Submit both orders
          const [openSeaResponse, grailsResponse] = await Promise.all([
            fetch('/api/orders/create', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'listing',
                tokenId: params.tokenId,
                price: params.priceInEth,
                currency: params.currency,
                order_data: openSeaOrder,
                seller_address: address,
              }),
            }),
            fetch('/api/orders/create', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                type: 'listing',
                tokenId: params.tokenId,
                price: params.priceInEth,
                currency: params.currency,
                order_data: grailsOrder,
                seller_address: address,
              }),
            }),
          ]);

          if (!openSeaResponse.ok || !grailsResponse.ok) {
            const errors = [];
            if (!openSeaResponse.ok) {
              const osError = await openSeaResponse.json();
              errors.push('OpenSea: ' + (osError.error || 'Unknown error'));
            }
            if (!grailsResponse.ok) {
              const grailsError = await grailsResponse.json();
              errors.push('Grails: ' + (grailsError.error || 'Unknown error'));
            }
            throw new Error('Failed to save orders: ' + errors.join(', '));
          }

          const [openSeaResult, grailsResult] = await Promise.all([
            openSeaResponse.json(),
            grailsResponse.json()
          ]);

          // Check for warnings in either result
          const warnings = [];
          if (openSeaResult.warning) warnings.push(openSeaResult.warning);
          if (grailsResult.warning) warnings.push(grailsResult.warning);
          if (warnings.length > 0) {
            console.warn('Listing warnings:', warnings);
            setError(warnings.join(' | '));
          }

          return { opensea: openSeaResult, grails: grailsResult };
        }

        // Single marketplace case
        const formattedOrder = seaportClient.formatOrderForStorage(order as any);
        formattedOrder.marketplace = params.marketplace;

        // Send to API
        const response = await fetch('/api/orders/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'listing',
            tokenId: params.tokenId,
            price: params.priceInEth,
            currency: params.currency,
            order_data: formattedOrder,
            seller_address: address,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.error || 'Failed to save order to database');
        }

        const result = await response.json();

        // Check for OpenSea submission warnings
        if (result.warning) {
          console.warn('OpenSea submission warning:', result.warning);
          // Set error to show warning to user
          setError(result.warning);
        }

        return result;
      } catch (err: any) {
        setError(err.message || 'Failed to create listing');
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [isInitialized, address]
  );

  // Create an offer
  const createOffer = useCallback(
    async (params: {
      tokenId: string;
      ensNameId?: number;  // Database ID of the ENS name (required by backend)
      offerPriceInEth: string;
      durationDays: number;
      currentOwner?: string;
      marketplace?: 'opensea' | 'grails' | 'both';
    }) => {
      if (!isInitialized || !address) {
        throw new Error('Wallet not connected or Seaport not initialized');
      }

      setIsLoading(true);
      setError(null);

      try {
        // Use createOffer which handles marketplace selection properly
        const order = await seaportClient.createOffer({
          tokenId: params.tokenId,
          priceInEth: params.offerPriceInEth,
          durationDays: params.durationDays,
          offererAddress: address,
          marketplace: params.marketplace || 'grails', // Default to grails
        });

        // Format order for API storage
        const formattedOrder = seaportClient.formatOrderForStorage(order as any);

        // Send to API
        const response = await fetch('/api/orders/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'offer',
            tokenId: params.tokenId,
            ensNameId: params.ensNameId,
            price: params.offerPriceInEth,
            order_data: formattedOrder,
            buyer_address: address,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to save offer to database');
        }

        const result = await response.json();
        return result;
      } catch (err: any) {
        setError(err.message || 'Failed to create offer');
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [isInitialized, address]
  );

  // Create a collection offer
  const createCollectionOffer = useCallback(
    async (params: {
      offerPriceInEth: string;
      durationDays: number;
      traits?: Record<string, any>;
    }) => {
      if (!isInitialized || !address) {
        throw new Error('Wallet not connected or Seaport not initialized');
      }

      setIsLoading(true);
      setError(null);

      try {
        const order = await seaportClient.createCollectionOffer({
          ...params,
          offererAddress: address,
        });

        // Format order for API storage
        const formattedOrder = seaportClient.formatOrderForStorage(order);

        // Send to API
        const response = await fetch('/api/orders/create', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            type: 'collection_offer',
            price: params.offerPriceInEth,
            order_data: formattedOrder,
            buyer_address: address,
            traits: params.traits,
          }),
        });

        if (!response.ok) {
          throw new Error('Failed to save collection offer to database');
        }

        const result = await response.json();
        return result;
      } catch (err: any) {
        setError(err.message || 'Failed to create collection offer');
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [isInitialized, address]
  );

  // Fulfill an order
  const fulfillOrder = useCallback(
    async (order: OrderWithCounter) => {
      if (!isInitialized || !address) {
        throw new Error('Wallet not connected or Seaport not initialized');
      }

      setIsLoading(true);
      setError(null);

      try {
        const transaction = await seaportClient.fulfillOrder(order, address);
        return transaction;
      } catch (err: any) {
        setError(err.message || 'Failed to fulfill order');
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [isInitialized, address]
  );

  // Cancel orders
  const cancelOrders = useCallback(
    async (listingIds: number[]) => {
      if (!address) {
        throw new Error('Wallet not connected');
      }

      // Ensure Seaport is initialized with wallet client for signing
      if (!walletClient || !publicClient) {
        throw new Error('Wallet client not available');
      }

      setIsLoading(true);
      setError(null);

      try {
        // Re-initialize to ensure we have the wallet client
        await seaportClient.initialize(publicClient, walletClient);
        console.log('Seaport re-initialized with wallet client for cancellation');
        // Step 1: Fetch order components from API
        const fetchResponse = await fetch('/api/orders/cancel', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listingIds,
            canceller: address,
          }),
        });

        if (!fetchResponse.ok) {
          const errorData = await fetchResponse.json();
          throw new Error(errorData.error || 'Failed to fetch order data');
        }

        const { requiresOnChainCancellation, orders, message } = await fetchResponse.json();

        // If no on-chain cancellation is required, Grails listings were already cancelled in the database
        if (!requiresOnChainCancellation) {
          console.log('Grails listings cancelled successfully:', message);
          return { success: true, message };
        }

        // For OpenSea listings, proceed with on-chain cancellation
        if (!orders || orders.length === 0) {
          throw new Error('No orders to cancel on-chain');
        }

        // Step 2: Cancel on-chain using Seaport contract
        const orderComponents = orders.map((o: any) => o.orderComponents);
        const transaction = await seaportClient.cancelOrders(orderComponents, address);

        console.log('Cancellation transaction:', transaction);

        // Step 3: Update database after successful on-chain cancellation
        const updateResponse = await fetch('/api/orders/cancel', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            listingIds: orders.map((o: any) => o.listingId),
            canceller: address,
            onChainCancellation: true,
          }),
        });

        if (!updateResponse.ok) {
          console.warn('Failed to update database after cancellation, but on-chain cancel succeeded');
        }

        return transaction;
      } catch (err: any) {
        setError(err.message || 'Failed to cancel orders');
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [address, walletClient, publicClient]
  );

  // Validate order
  const validateOrder = useCallback(
    async (order: OrderWithCounter) => {
      if (!isInitialized) {
        throw new Error('Seaport not initialized');
      }

      try {
        const isValid = await seaportClient.validateOrder(order);
        return isValid;
      } catch (err: any) {
        console.error('Order validation error:', err);
        return false;
      }
    },
    [isInitialized]
  );

  // Get order status
  const getOrderStatus = useCallback(
    async (orderHash: string) => {
      if (!isInitialized) {
        throw new Error('Seaport not initialized');
      }

      try {
        const status = await seaportClient.getOrderStatus(orderHash);
        return status;
      } catch (err: any) {
        console.error('Failed to get order status:', err);
        return null;
      }
    },
    [isInitialized]
  );

  // Get conduit configuration
  const conduitConfig = seaportClient.getConduitConfig();

  return {
    isInitialized,
    isLoading,
    error,
    createListing,
    createOffer,
    createCollectionOffer,
    fulfillOrder,
    cancelOrders,
    validateOrder,
    getOrderStatus,
    conduitConfig,
  };
}