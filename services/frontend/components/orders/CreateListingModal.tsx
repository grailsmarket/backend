'use client';

import { useState } from 'react';
import { useSeaportClient } from '@/hooks/useSeaportClient';
import { X } from 'lucide-react';

interface CreateListingModalProps {
  isOpen: boolean;
  onClose: () => void;
  tokenId: string;
  ensName: string;
}

export function CreateListingModal({
  isOpen,
  onClose,
  tokenId,
  ensName,
}: CreateListingModalProps) {
  const { createListing, isLoading, error } = useSeaportClient();
  const [priceInEth, setPriceInEth] = useState('');
  const [durationDays, setDurationDays] = useState('7');
  const [currency, setCurrency] = useState<'ETH' | 'USDC'>('ETH');
  const [includeRoyalty, setIncludeRoyalty] = useState(false);
  const [royaltyBps, setRoyaltyBps] = useState('250'); // 2.5% default
  const [royaltyRecipient, setRoyaltyRecipient] = useState('');
  const [selectedMarketplace, setSelectedMarketplace] = useState<'opensea' | 'grails' | 'both'>('grails');
  const [success, setSuccess] = useState(false);
  const [status, setStatus] = useState<string>('');

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(false);
    setStatus('');

    try {
      const params: any = {
        tokenId,
        priceInEth,
        durationDays: parseInt(durationDays),
        marketplace: selectedMarketplace,
        currency,
      };

      if (includeRoyalty && royaltyRecipient) {
        params.royaltyBps = parseInt(royaltyBps);
        params.royaltyRecipient = royaltyRecipient;
      }

      setStatus(`Creating listing on ${selectedMarketplace === 'both' ? 'both marketplaces' : selectedMarketplace}...`);
      await createListing(params);
      setSuccess(true);
      setStatus('');

      // Close modal after 2 seconds
      setTimeout(() => {
        onClose();
        setSuccess(false);
        setStatus('');
        setSelectedMarketplace('grails');
        setCurrency('ETH');
      }, 2000);
    } catch (err) {
      console.error('Failed to create listing:', err);
      setStatus('');
    }
  };

  // Calculate fees to show user
  const calculateFees = () => {
    if (!priceInEth) return null;

    const price = parseFloat(priceInEth);
    const fees: { label: string; amount: number }[] = [];

    if (selectedMarketplace === 'opensea' || selectedMarketplace === 'both') {
      fees.push({ label: 'OpenSea Fee (1%)', amount: price * 0.01 });
    }

    if (includeRoyalty && royaltyBps) {
      const royaltyPercent = parseInt(royaltyBps) / 100;
      fees.push({ label: `Creator Royalty (${royaltyPercent}%)`, amount: price * (royaltyPercent / 100) });
    }

    const totalFees = fees.reduce((sum, fee) => sum + fee.amount, 0);
    const netProceeds = price - totalFees;

    return { fees, totalFees, netProceeds };
  };

  return (
    <div className="fixed" style={{ top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, overflowY: 'auto', paddingTop: '50px' }}>
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6 max-w-md" style={{ margin: '0 auto', maxWidth: '28rem' }}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-white">List {ensName}</h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-700 rounded transition-colors text-gray-400 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {success ? (
          <div className="text-center py-8">
            <div className="text-green-500 text-lg font-semibold mb-2">
              Listing Created Successfully!
            </div>
            <p className="text-gray-400">
              Your ENS name has been listed on the marketplace.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Price
              </label>
              <div className="relative">
                <input
                  type="number"
                  step="0.001"
                  min="0"
                  value={priceInEth}
                  onChange={(e) => setPriceInEth(e.target.value)}
                  className="w-full px-3 py-2 bg-gray-900 text-white border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                  placeholder="0.1"
                  required
                />
                <span className="absolute right-3 top-2.5 text-gray-400">{currency}</span>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Currency
              </label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as 'ETH' | 'USDC')}
                className="w-full px-3 py-2 bg-gray-900 text-white border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="ETH">ETH (Ethereum)</option>
                <option value="USDC">USDC (USD Coin)</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Duration (days)
              </label>
              <select
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
                className="w-full px-3 py-2 bg-gray-900 text-white border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="1">1 day</option>
                <option value="3">3 days</option>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
                <option value="90">90 days</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                List on Marketplace
              </label>
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => setSelectedMarketplace('grails')}
                  className={`px-3 py-2 border rounded-md transition-colors ${
                    selectedMarketplace === 'grails'
                      ? 'border-purple-500 bg-purple-500/20 text-purple-400'
                      : 'border-gray-700 hover:bg-gray-800'
                  }`}
                >
                  Grails
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMarketplace('opensea')}
                  className={`px-3 py-2 border rounded-md transition-colors ${
                    selectedMarketplace === 'opensea'
                      ? 'border-purple-500 bg-purple-500/20 text-purple-400'
                      : 'border-gray-700 hover:bg-gray-800'
                  }`}
                >
                  OpenSea
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedMarketplace('both')}
                  className={`px-3 py-2 border rounded-md transition-colors ${
                    selectedMarketplace === 'both'
                      ? 'border-purple-500 bg-purple-500/20 text-purple-400'
                      : 'border-gray-700 hover:bg-gray-800'
                  }`}
                >
                  Both
                </button>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="includeRoyalty"
                  checked={includeRoyalty}
                  onChange={(e) => setIncludeRoyalty(e.target.checked)}
                  className="mr-2"
                />
                <label htmlFor="includeRoyalty" className="text-sm text-gray-300">
                  Include royalty fee
                </label>
              </div>

              {includeRoyalty && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Royalty Percentage
                    </label>
                    <div className="flex items-center">
                      <input
                        type="number"
                        step="0.1"
                        min="0"
                        max="100"
                        value={(parseInt(royaltyBps) / 100).toString()}
                        onChange={(e) =>
                          setRoyaltyBps(
                            (parseFloat(e.target.value) * 100).toString()
                          )
                        }
                        className="w-24 px-3 py-2 bg-gray-900 text-white border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                      />
                      <span className="ml-2 text-gray-300">%</span>
                    </div>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-300 mb-2">
                      Royalty Recipient Address
                    </label>
                    <input
                      type="text"
                      value={royaltyRecipient}
                      onChange={(e) => setRoyaltyRecipient(e.target.value)}
                      className="w-full px-3 py-2 bg-gray-900 text-white border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
                      placeholder="0x..."
                      pattern="^0x[a-fA-F0-9]{40}$"
                    />
                  </div>
                </>
              )}
            </div>

            {/* Fee breakdown */}
            {priceInEth && calculateFees() && (
              <div className="bg-gray-900 border border-gray-800 rounded-md p-3 text-sm">
                <div className="space-y-1">
                  <div className="flex justify-between text-gray-400">
                    <span>Listing Price:</span>
                    <span>{priceInEth} {currency}</span>
                  </div>
                  {calculateFees()!.fees.map((fee, idx) => (
                    <div key={idx} className="flex justify-between text-gray-500">
                      <span>- {fee.label}:</span>
                      <span>{fee.amount.toFixed(currency === 'USDC' ? 2 : 4)} {currency}</span>
                    </div>
                  ))}
                  <div className="border-t border-gray-800 pt-1 flex justify-between font-medium">
                    <span>You Receive:</span>
                    <span className="text-green-400">
                      {calculateFees()!.netProceeds.toFixed(currency === 'USDC' ? 2 : 4)} {currency}
                    </span>
                  </div>
                </div>
              </div>
            )}

            {status && (
              <div className="text-blue-500 text-sm">{status}</div>
            )}

            {error && (
              <div className="text-red-500 text-sm">{error}</div>
            )}

            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 px-4 py-2 border border-gray-700 text-gray-300 rounded-md hover:bg-gray-800 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isLoading || !priceInEth}
                className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Creating...' : `List on ${
                  selectedMarketplace === 'both' ? 'Both' :
                  selectedMarketplace === 'opensea' ? 'OpenSea' : 'Grails'
                }`}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}