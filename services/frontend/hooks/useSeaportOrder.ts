import { useState } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { SeaportOrderBuilder } from '@/services/seaport/orderBuilder';
import { SEAPORT_ADDRESS } from '@/lib/constants';
import { SEAPORT_ABI } from '@/services/seaport/abi';
import { Listing } from '@/types';

export function useSeaportOrder() {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fulfillOrder = async (listing: Listing) => {
    setIsLoading(true);
    setError(null);

    try {
      if (!address || !walletClient || !publicClient) {
        throw new Error('Wallet not connected');
      }

      const orderBuilder = new SeaportOrderBuilder();

      // Parse the stored order
      const order = orderBuilder.parseStoredOrder(listing);
      if (!order) {
        throw new Error('Invalid order data');
      }

      // Validate the order
      const validation = orderBuilder.validateOrder(order);
      if (!validation.valid) {
        throw new Error(validation.errors[0] || 'Invalid order');
      }

      // Build basic order parameters for efficient fulfillment
      const basicOrderParams = orderBuilder.buildBasicOrderParameters(order, address);

      // Calculate total payment
      const totalPayment = orderBuilder.calculateTotalPayment(order);
      const usesETH = orderBuilder.usesNativeToken(order);

      // Execute the transaction using the efficient function
      const tx = await walletClient.writeContract({
        address: SEAPORT_ADDRESS as `0x${string}`,
        abi: SEAPORT_ABI,
        functionName: 'fulfillBasicOrder_efficient_6GL6yc',
        args: [basicOrderParams],
        value: usesETH ? totalPayment : 0n,
      });

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx,
        confirmations: 1,
      });

      if (receipt.status !== 'success') {
        throw new Error('Transaction failed');
      }

      return { hash: tx, receipt };
    } catch (err: any) {
      const errorMessage = err.message || 'Transaction failed';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const estimateGas = async (listing: Listing) => {
    try {
      if (!address || !publicClient) {
        throw new Error('Wallet not connected');
      }

      const orderBuilder = new SeaportOrderBuilder();
      const order = orderBuilder.parseStoredOrder(listing);

      if (!order) {
        throw new Error('Invalid order data');
      }

      // Build basic order parameters for efficient fulfillment
      const basicOrderParams = orderBuilder.buildBasicOrderParameters(order, address);

      const totalPayment = orderBuilder.calculateTotalPayment(order);
      const usesETH = orderBuilder.usesNativeToken(order);

      // Simulate the transaction to estimate gas
      const gasEstimate = await publicClient.estimateContractGas({
        address: SEAPORT_ADDRESS as `0x${string}`,
        abi: SEAPORT_ABI,
        functionName: 'fulfillBasicOrder_efficient_6GL6yc',
        args: [basicOrderParams],
        value: usesETH ? totalPayment : 0n,
        account: address,
      });

      return gasEstimate;
    } catch (err: any) {
      console.error('Gas estimation failed:', err);
      return null;
    }
  };

  return {
    fulfillOrder,
    estimateGas,
    isLoading,
    error,
  };
}