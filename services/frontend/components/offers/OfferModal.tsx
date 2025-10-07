'use client';

import { useState } from 'react';
import { useAccount, usePublicClient, useWalletClient } from 'wagmi';
import { seaportClient } from '@/services/seaport/seaportClient';

interface OfferModalProps {
  isOpen: boolean;
  onClose: () => void;
  ensName: string;
  tokenId: string;
  currentOwner: string;
}

type OfferStep = 'input' | 'platform' | 'signing' | 'processing' | 'success' | 'error';
type Platform = 'grails' | 'opensea' | 'both';

export function OfferModal({ isOpen, onClose, ensName, tokenId, currentOwner }: OfferModalProps) {
  const { address } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [step, setStep] = useState<OfferStep>('input');
  const [price, setPrice] = useState('');
  const [expirationDays, setExpirationDays] = useState('7');
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>('grails');
  const [currency, setCurrency] = useState<'WETH' | 'USDC'>('WETH');
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState<string>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!price || parseFloat(price) <= 0) {
      setError('Please enter a valid price');
      return;
    }

    if (!expirationDays || parseInt(expirationDays) <= 0) {
      setError('Please enter a valid expiration time');
      return;
    }

    setError('');
    setStep('platform');
  };

  const handleCreateOffer = async () => {
    if (!address) {
      setError('Please connect your wallet');
      return;
    }

    if (!publicClient || !walletClient) {
      setError('Wallet not connected properly');
      return;
    }

    setStep('signing');

    try {
      // Initialize Seaport client
      await seaportClient.initialize(publicClient, walletClient);

      // Create the offer
      const order = await seaportClient.createOffer({
        tokenId,
        priceInEth: price,
        durationDays: parseInt(expirationDays),
        offererAddress: address,
        marketplace: selectedPlatform,
        currency,
      });

      console.log('Order created by seaport-js:', {
        hasParameters: !!order.parameters,
        hasSignature: !!order.signature,
        signatureLength: order.signature?.length,
        parameters: order.parameters,
        signature: order.signature
      });

      setStep('processing');

      // Format order for storage (handles BigInt serialization)
      const formattedOrder = seaportClient.formatOrderForStorage(order);

      console.log('Formatted order for storage:', {
        hasParameters: !!formattedOrder.parameters,
        hasSignature: !!formattedOrder.signature,
        hasProtocolData: !!formattedOrder.protocol_data
      });

      // Calculate price with correct decimals based on currency
      const decimals = currency === 'USDC' ? 6 : 18;
      const priceInSmallestUnit = (parseFloat(price) * Math.pow(10, decimals)).toString();

      // Submit to API
      const response = await fetch('/api/offers/create', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          token_id: tokenId,
          ens_name: ensName,
          buyer_address: address,
          price_wei: priceInSmallestUnit,
          currency: currency, // Send the selected currency (WETH or USDC)
          order_data: formattedOrder,
          platform: selectedPlatform,
        }),
      });

      if (!response.ok) {
        throw new Error('Failed to save offer to API');
      }

      setStep('success');
    } catch (err: any) {
      console.error('Error creating offer:', err);
      setError(err.message || 'Failed to create offer');
      setStep('error');
    }
  };

  const handleClose = () => {
    setStep('input');
    setPrice('');
    setExpirationDays('7');
    setSelectedPlatform('grails');
    setError('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed" style={{ top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, overflowY: 'auto', paddingTop: '50px' }}>
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-md" style={{ margin: '0 auto', maxWidth: '28rem' }}>
        {/* Header */}
        <div className="p-6 border-b border-gray-700">
          <div className="flex justify-between items-center">
            <h2 className="text-2xl font-bold text-white">Make an Offer</h2>
            <button
              onClick={handleClose}
              className="text-gray-400 hover:text-white transition"
            >
              <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
          <p className="text-gray-400 mt-2">{ensName}</p>
        </div>

        {/* Content */}
        <div className="p-6">
          {step === 'input' && (
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* Price Input */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Offer Price *
                </label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.001"
                    min="0"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder="0.0"
                    className="w-full bg-gray-800 text-white px-4 py-3 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
                  />
                  <span className="absolute right-4 top-3 text-gray-400">{currency}</span>
                </div>
              </div>

              {/* Currency */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Currency
                </label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as 'WETH' | 'USDC')}
                  className="w-full bg-gray-800 text-white px-4 py-3 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
                >
                  <option value="WETH">WETH (Wrapped Ether)</option>
                  <option value="USDC">USDC (USD Coin)</option>
                </select>
                <p className="text-xs text-gray-500 mt-1">Offers require ERC20 tokens, not native ETH</p>
              </div>

              {/* Expiration */}
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2">
                  Offer Expiration *
                </label>
                <select
                  value={expirationDays}
                  onChange={(e) => setExpirationDays(e.target.value)}
                  className="w-full bg-gray-800 text-white px-4 py-3 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
                >
                  <option value="1">1 Day</option>
                  <option value="3">3 Days</option>
                  <option value="7">7 Days</option>
                  <option value="14">14 Days</option>
                  <option value="30">30 Days</option>
                  <option value="60">60 Days</option>
                  <option value="90">90 Days</option>
                </select>
              </div>

              {error && (
                <div className="bg-red-900/20 border border-red-500 text-red-400 px-4 py-3 rounded-lg">
                  {error}
                </div>
              )}

              <button
                type="submit"
                className="w-full bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
              >
                Continue
              </button>
            </form>
          )}

          {step === 'platform' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-lg font-semibold text-white mb-4">Choose Where to Post</h3>
                <p className="text-gray-400 text-sm mb-6">
                  Select where you'd like to post your offer
                </p>

                <div className="space-y-3">
                  {/* Grails */}
                  <button
                    onClick={() => setSelectedPlatform('grails')}
                    className={`w-full p-4 rounded-lg border-2 transition text-left ${
                      selectedPlatform === 'grails'
                        ? 'border-purple-500 bg-purple-900/20'
                        : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-white">Grails Only</p>
                      <p className="text-sm text-gray-400">No marketplace fees</p>
                    </div>
                  </button>

                  {/* OpenSea */}
                  <button
                    onClick={() => setSelectedPlatform('opensea')}
                    className={`w-full p-4 rounded-lg border-2 transition text-left ${
                      selectedPlatform === 'opensea'
                        ? 'border-purple-500 bg-purple-900/20'
                        : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-white">OpenSea Only</p>
                      <p className="text-sm text-gray-400">Maximum visibility</p>
                    </div>
                  </button>

                  {/* Both */}
                  <button
                    onClick={() => setSelectedPlatform('both')}
                    className={`w-full p-4 rounded-lg border-2 transition text-left ${
                      selectedPlatform === 'both'
                        ? 'border-purple-500 bg-purple-900/20'
                        : 'border-gray-700 bg-gray-800 hover:border-gray-600'
                    }`}
                  >
                    <div>
                      <p className="font-semibold text-white">Both Platforms</p>
                      <p className="text-sm text-gray-400">Recommended for best results</p>
                    </div>
                  </button>
                </div>
              </div>

              {/* Offer Summary */}
              <div className="bg-gray-800 rounded-lg p-4 border border-gray-700">
                <h4 className="text-sm font-semibold text-gray-300 mb-3">Offer Summary</h4>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-400">Offer Price:</span>
                    <span className="text-white font-semibold">{price} {currency}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Expires In:</span>
                    <span className="text-white">{expirationDays} Days</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-400">Platform:</span>
                    <span className="text-white capitalize">{selectedPlatform}</span>
                  </div>
                </div>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => setStep('input')}
                  className="flex-1 bg-gray-700 hover:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold transition"
                >
                  Back
                </button>
                <button
                  onClick={handleCreateOffer}
                  className="flex-1 bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
                >
                  Create Offer
                </button>
              </div>
            </div>
          )}

          {step === 'signing' && (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-purple-500 mx-auto mb-4"></div>
              <h3 className="text-xl font-semibold text-white mb-2">Sign Offer</h3>
              <p className="text-gray-400">Please sign the offer in your wallet...</p>
            </div>
          )}

          {step === 'processing' && (
            <div className="text-center py-8">
              <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-purple-500 mx-auto mb-4"></div>
              <h3 className="text-xl font-semibold text-white mb-2">Creating Offer</h3>
              <p className="text-gray-400">Your offer is being created...</p>
            </div>
          )}

          {step === 'success' && (
            <div className="text-center py-8">
              <div className="w-16 h-16 bg-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-white mb-2">Offer Created!</h3>
              <p className="text-gray-400 mb-6">Your offer has been successfully created</p>
              <button
                onClick={handleClose}
                className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
              >
                Done
              </button>
            </div>
          )}

          {step === 'error' && (
            <div className="text-center py-8">
              <div className="w-16 h-16 bg-red-500 rounded-full flex items-center justify-center mx-auto mb-4">
                <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </div>
              <h3 className="text-xl font-semibold text-white mb-2">Error</h3>
              <p className="text-red-400 mb-6">{error}</p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => setStep('input')}
                  className="bg-gray-700 hover:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold transition"
                >
                  Try Again
                </button>
                <button
                  onClick={handleClose}
                  className="bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
                >
                  Close
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
