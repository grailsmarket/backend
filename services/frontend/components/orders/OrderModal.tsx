'use client';

import { useState, useEffect } from 'react';
import { Listing } from '@/types';
import { SeaportOrderBuilder } from '@/services/seaport/orderBuilder';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import {
  SEAPORT_ADDRESS,
  USDC_ADDRESS,
  MARKETPLACE_CONDUIT_ADDRESS,
  MARKETPLACE_CONDUIT_KEY,
  OPENSEA_CONDUIT_ADDRESS,
  OPENSEA_CONDUIT_KEY,
  ZERO_ADDRESS
} from '@/lib/constants';
import { SEAPORT_ABI } from '@/services/seaport/abi';
import { formatCurrencyAmount } from '@/lib/currency';

interface OrderModalProps {
  listing: Listing;
  isOpen: boolean;
  onClose: () => void;
}

type TransactionStep = 'review' | 'approving' | 'confirming' | 'processing' | 'success' | 'error';

// ERC20 ABI for approve and allowance functions
const ERC20_ABI = [
  {
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    name: 'approve',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function'
  },
  {
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    name: 'allowance',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function'
  }
] as const;

/**
 * Determine the correct approval target based on the order's conduitKey
 */
function getApprovalTarget(conduitKey: string | undefined): string {
  if (!conduitKey || conduitKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    // No conduit key or zero hash means approve Seaport directly
    return SEAPORT_ADDRESS;
  }

  // Match against known conduit keys
  if (conduitKey.toLowerCase() === OPENSEA_CONDUIT_KEY.toLowerCase()) {
    return OPENSEA_CONDUIT_ADDRESS;
  }

  if (conduitKey.toLowerCase() === MARKETPLACE_CONDUIT_KEY.toLowerCase()) {
    return MARKETPLACE_CONDUIT_ADDRESS;
  }

  // Default to Seaport if unknown conduit key
  console.warn('Unknown conduit key:', conduitKey, '- defaulting to Seaport');
  return SEAPORT_ADDRESS;
}

export function OrderModal({ listing, isOpen, onClose }: OrderModalProps) {
  if (!isOpen) return null;
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();

  const [step, setStep] = useState<TransactionStep>('review');
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [gasEstimate, setGasEstimate] = useState<bigint | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approveTxHash, setApproveTxHash] = useState<string | null>(null);

  const orderBuilder = new SeaportOrderBuilder();

  useEffect(() => {
    // Estimate gas and check approval when modal opens
    estimateGas();
    checkApproval();
  }, []);

  const estimateGas = async () => {
    try {
      if (!address || !walletClient || !publicClient) return;

      const order = orderBuilder.parseStoredOrder(listing);
      if (!order) {
        setError('Invalid order data');
        return;
      }

      // For now, just set a reasonable estimate
      // In production, we'd simulate the transaction
      setGasEstimate(BigInt(300000)); // 300k gas units
    } catch (err) {
      console.error('Failed to estimate gas:', err);
    }
  };

  const checkApproval = async () => {
    try {
      if (!address || !publicClient) return;

      // Check if this listing uses USDC
      const isUSDC = listing.currency_address?.toLowerCase() === USDC_ADDRESS.toLowerCase();
      if (!isUSDC) {
        setNeedsApproval(false);
        return;
      }

      // Parse the order to get the conduitKey
      const order = orderBuilder.parseStoredOrder(listing);
      if (!order) {
        console.error('Failed to parse order for approval check');
        return;
      }

      // Get the correct approval target based on conduitKey
      const conduitKey = order.parameters?.conduitKey;
      const approvalTarget = getApprovalTarget(conduitKey);

      console.log('Checking approval for:', {
        conduitKey,
        approvalTarget,
        currency: 'USDC'
      });

      // Check current allowance
      const allowance = await publicClient.readContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [address, approvalTarget as `0x${string}`],
      });

      // Check if allowance is sufficient
      const requiredAmount = BigInt(listing.price_wei);
      setNeedsApproval(allowance < requiredAmount);
    } catch (err) {
      console.error('Failed to check approval:', err);
    }
  };

  const handleApprove = async () => {
    try {
      setError(null);
      setStep('approving');

      if (!address || !walletClient || !publicClient) {
        throw new Error('Wallet not connected');
      }

      // Parse the order to get the conduitKey
      const order = orderBuilder.parseStoredOrder(listing);
      if (!order) {
        throw new Error('Invalid order data');
      }

      // Get the correct approval target based on conduitKey
      const conduitKey = order.parameters?.conduitKey;
      const approvalTarget = getApprovalTarget(conduitKey);

      console.log('Approving USDC for:', {
        conduitKey,
        approvalTarget,
        amount: listing.price_wei
      });

      // Approve the conduit (or Seaport) to spend USDC
      const approveTx = await walletClient.writeContract({
        address: USDC_ADDRESS as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [approvalTarget as `0x${string}`, BigInt(listing.price_wei)],
      });

      setApproveTxHash(approveTx);

      // Wait for approval confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: approveTx,
        confirmations: 1,
      });

      if (receipt.status === 'success') {
        setNeedsApproval(false);
        setStep('review');
        // Automatically proceed to purchase
        handlePurchase();
      } else {
        throw new Error('Approval failed');
      }
    } catch (err: any) {
      console.error('Approval failed:', err);
      setError(err.message || 'Approval failed');
      setStep('error');
    }
  };

  const handlePurchase = async () => {
    try {
      setError(null);
      setStep('confirming');

      if (!address || !walletClient || !publicClient) {
        throw new Error('Wallet not connected');
      }

      // Parse the stored order
      const order = orderBuilder.parseStoredOrder(listing);
      if (!order) {
        throw new Error('Invalid order data');
      }

      // Validate the order structure
      const validation = orderBuilder.validateOrder(order);
      if (!validation.valid) {
        throw new Error(validation.errors[0] || 'Invalid order');
      }

      // Build basic order parameters for efficient fulfillment
      const basicOrderParams = orderBuilder.buildBasicOrderParameters(order, address);

      // Calculate total payment
      const totalPayment = orderBuilder.calculateTotalPayment(order);
      const usesETH = orderBuilder.usesNativeToken(order);

      // Debug: Log order payment details
      console.log('Order payment analysis:', {
        listingCurrencyAddress: listing.currency_address,
        considerationItems: order.parameters.consideration.map(c => ({
          itemType: c.itemType,
          token: c.token,
          amount: c.startAmount.toString()
        })),
        totalPayment: totalPayment.toString(),
        usesETH,
        basicOrderType: basicOrderParams.basicOrderType,
        valueToSend: usesETH ? totalPayment.toString() : '0'
      });

      console.log('Full basicOrderParams:', {
        considerationToken: basicOrderParams.considerationToken,
        considerationAmount: basicOrderParams.considerationAmount.toString(),
        offerer: basicOrderParams.offerer,
        offerToken: basicOrderParams.offerToken,
        offerIdentifier: basicOrderParams.offerIdentifier.toString(),
        basicOrderType: basicOrderParams.basicOrderType,
        offererConduitKey: basicOrderParams.offererConduitKey,
        totalOriginalAdditionalRecipients: basicOrderParams.totalOriginalAdditionalRecipients.toString(),
        additionalRecipients: basicOrderParams.additionalRecipients
      });

      // For ERC20 orders, use standard fulfillOrder instead of the efficient basic route
      const isERC20Order = !usesETH;
      const fulfillerConduitKey = isERC20Order ? order.parameters.conduitKey : '0x0000000000000000000000000000000000000000000000000000000000000000';

      let tx: `0x${string}`;

      if (isERC20Order) {
        console.log('Using fulfillAdvancedOrder for ERC20 order with conduit key:', fulfillerConduitKey);

        // Build advanced order
        const advancedOrder = orderBuilder.buildAdvancedOrder(order);

        // Simulate with fulfillAdvancedOrder
        try {
          await publicClient.simulateContract({
            address: SEAPORT_ADDRESS as `0x${string}`,
            abi: SEAPORT_ABI,
            functionName: 'fulfillAdvancedOrder',
            args: [
              advancedOrder,
              [], // criteriaResolvers - empty for basic orders
              fulfillerConduitKey,
              address // recipient
            ],
            account: address,
          });
          console.log('Transaction simulation successful (fulfillAdvancedOrder)');
        } catch (simulateError: any) {
          console.error('Transaction simulation failed:', simulateError);
          throw new Error(`Transaction would fail: ${simulateError.shortMessage || simulateError.message}`);
        }

        setStep('processing');

        // Execute with fulfillAdvancedOrder
        tx = await walletClient.writeContract({
          address: SEAPORT_ADDRESS as `0x${string}`,
          abi: SEAPORT_ABI,
          functionName: 'fulfillAdvancedOrder',
          args: [
            advancedOrder,
            [], // criteriaResolvers
            fulfillerConduitKey,
            address // recipient
          ],
          value: BigInt(0),
        });

        setTxHash(tx);
      } else {
        // ETH orders use the efficient basic route
        console.log('Using fulfillBasicOrder_efficient_6GL6yc for ETH order');

        try {
          await publicClient.simulateContract({
            address: SEAPORT_ADDRESS as `0x${string}`,
            abi: SEAPORT_ABI,
            functionName: 'fulfillBasicOrder_efficient_6GL6yc',
            args: [basicOrderParams],
            value: totalPayment,
            account: address,
          });
          console.log('Transaction simulation successful (basic)');
        } catch (simulateError: any) {
          console.error('Transaction simulation failed:', simulateError);
          throw new Error(`Transaction would fail: ${simulateError.shortMessage || simulateError.message}`);
        }

        setStep('processing');

        tx = await walletClient.writeContract({
          address: SEAPORT_ADDRESS as `0x${string}`,
          abi: SEAPORT_ABI,
          functionName: 'fulfillBasicOrder_efficient_6GL6yc',
          args: [basicOrderParams],
          value: totalPayment,
        });

        setTxHash(tx);
      }

      // Wait for confirmation
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: tx,
        confirmations: 1,
      });

      if (receipt.status === 'success') {
        setStep('success');
      } else {
        throw new Error('Transaction failed');
      }
    } catch (err: any) {
      console.error('Purchase failed:', err);
      setError(err.message || 'Transaction failed');
      setStep('error');
    }
  };

  const getModalContent = () => {
    switch (step) {
      case 'review':
        return (
          <>
            <h2 className="text-2xl font-bold text-white mb-6">Complete Purchase</h2>

            <div className="space-y-4 mb-6">
              <div className="bg-gray-900 rounded-lg p-4">
                <p className="text-gray-400 text-sm mb-1">You are buying</p>
                <p className="text-xl font-bold text-white">
                  {listing.ens_name || `Token #${listing.token_id}`}
                </p>
              </div>

              <div className="bg-gray-900 rounded-lg p-4">
                <p className="text-gray-400 text-sm mb-1">Total Price</p>
                <p className="text-2xl font-bold text-purple-400">
                  {formatCurrencyAmount(listing.price_wei, listing.currency_address)}
                </p>
              </div>

              {gasEstimate && (
                <div className="bg-gray-900 rounded-lg p-4">
                  <p className="text-gray-400 text-sm mb-1">Estimated Gas</p>
                  <p className="text-white">~{gasEstimate.toString()} units</p>
                </div>
              )}
            </div>

            {needsApproval && (
              <div className="bg-blue-900/20 border border-blue-500/20 rounded-lg p-4 mb-4">
                <p className="text-blue-400 text-sm">
                  You need to approve USDC spending before purchasing. This is a one-time approval.
                </p>
              </div>
            )}

            <div className="flex gap-4">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition"
              >
                Cancel
              </button>
              <button
                onClick={needsApproval ? handleApprove : handlePurchase}
                className="flex-1 px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition"
              >
                {needsApproval ? 'Approve USDC' : 'Confirm Purchase'}
              </button>
            </div>
          </>
        );

      case 'approving':
        return (
          <>
            <h2 className="text-2xl font-bold text-white mb-6">Approve USDC</h2>
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
              <p className="text-gray-400 mt-4">Approving USDC for Seaport</p>
              {approveTxHash && (
                <p className="text-xs text-gray-500 mt-2 font-mono break-all">
                  {approveTxHash}
                </p>
              )}
            </div>
          </>
        );

      case 'confirming':
        return (
          <>
            <h2 className="text-2xl font-bold text-white mb-6">Confirm in Wallet</h2>
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
              <p className="text-gray-400 mt-4">Please confirm the transaction in your wallet</p>
            </div>
          </>
        );

      case 'processing':
        return (
          <>
            <h2 className="text-2xl font-bold text-white mb-6">Processing Transaction</h2>
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
              <p className="text-gray-400 mt-4">Transaction submitted</p>
              {txHash && (
                <p className="text-xs text-gray-500 mt-2 font-mono break-all">
                  {txHash}
                </p>
              )}
            </div>
          </>
        );

      case 'success':
        return (
          <>
            <h2 className="text-2xl font-bold text-green-400 mb-6">Purchase Successful!</h2>
            <div className="text-center py-8">
              <div className="text-6xl mb-4">🎉</div>
              <p className="text-white mb-2">
                You now own <strong>{listing.ens_name}</strong>
              </p>
              {txHash && (
                <a
                  href={`https://etherscan.io/tx/${txHash}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-purple-400 hover:text-purple-300 text-sm"
                >
                  View on Etherscan →
                </a>
              )}
            </div>
            <button
              onClick={onClose}
              className="w-full px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition"
            >
              Close
            </button>
          </>
        );

      case 'error':
        return (
          <>
            <h2 className="text-2xl font-bold text-red-400 mb-6">Transaction Failed</h2>
            <div className="bg-red-900/20 border border-red-500/20 rounded-lg p-4 mb-6">
              <p className="text-red-400">{error || 'An unknown error occurred'}</p>
            </div>
            <div className="flex gap-4">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-3 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition"
              >
                Close
              </button>
              <button
                onClick={() => setStep('review')}
                className="flex-1 px-4 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition"
              >
                Try Again
              </button>
            </div>
          </>
        );
    }
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-gray-800 rounded-2xl max-w-md w-full p-6 relative">
        {step === 'review' && (
          <button
            onClick={onClose}
            className="absolute top-4 right-4 text-gray-400 hover:text-white"
          >
            ✕
          </button>
        )}
        {getModalContent()}
      </div>
    </div>
  );
}