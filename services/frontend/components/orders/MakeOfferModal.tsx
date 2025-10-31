'use client';

import { useState } from 'react';
import { useSeaportClient } from '@/hooks/useSeaportClient';
import { X, Info } from 'lucide-react';

interface MakeOfferModalProps {
  isOpen: boolean;
  onClose: () => void;
  tokenId: string;
  ensName: string;
  ensNameId?: number;  // Database ID of the ENS name (required for offers)
  currentOwner?: string;
  floorPrice?: string;
  isCollectionOffer?: boolean;
}

export function MakeOfferModal({
  isOpen,
  onClose,
  tokenId,
  ensName,
  ensNameId,
  currentOwner,
  floorPrice,
  isCollectionOffer = false,
}: MakeOfferModalProps) {
  const { createOffer, createCollectionOffer, isLoading, error } = useSeaportClient();
  const [offerPriceInEth, setOfferPriceInEth] = useState('');
  const [durationDays, setDurationDays] = useState('7');
  const [traits, setTraits] = useState<Record<string, any>>({});
  const [success, setSuccess] = useState(false);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSuccess(false);

    try {
      if (isCollectionOffer) {
        await createCollectionOffer({
          offerPriceInEth,
          durationDays: parseInt(durationDays),
          traits: Object.keys(traits).length > 0 ? traits : undefined,
        });
      } else {
        await createOffer({
          tokenId,
          ensNameId,
          offerPriceInEth,
          durationDays: parseInt(durationDays),
          currentOwner,
        });
      }

      setSuccess(true);

      // Close modal after 2 seconds
      setTimeout(() => {
        onClose();
        setSuccess(false);
      }, 2000);
    } catch (err) {
      console.error('Failed to create offer:', err);
    }
  };

  const handleTraitAdd = (key: string, value: string) => {
    setTraits((prev) => ({ ...prev, [key]: value }));
  };

  const handleTraitRemove = (key: string) => {
    setTraits((prev) => {
      const newTraits = { ...prev };
      delete newTraits[key];
      return newTraits;
    });
  };

  return (
    <div className="fixed" style={{ top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 9999, overflowY: 'auto', paddingTop: '50px' }}>
      <div className="bg-background border border-border rounded-lg p-6 max-w-md" style={{ margin: '0 auto', maxWidth: '28rem' }}>
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold">
            {isCollectionOffer ? 'Make Collection Offer' : `Make Offer on ${ensName}`}
          </h2>
          <button
            onClick={onClose}
            className="p-1 hover:bg-gray-800 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {success ? (
          <div className="text-center py-8">
            <div className="text-green-500 text-lg font-semibold mb-2">
              Offer Created Successfully!
            </div>
            <p className="text-muted-foreground">
              Your offer has been submitted and signed.
            </p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            {floorPrice && (
              <div className="bg-gray-900 border border-gray-800 rounded-md p-3">
                <div className="flex items-center text-sm">
                  <Info className="w-4 h-4 mr-2 text-gray-400" />
                  <span className="text-gray-400">
                    Floor price: <span className="text-white font-medium">{floorPrice} ETH</span>
                  </span>
                </div>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium mb-2">
                Offer Price (ETH)
              </label>
              <input
                type="number"
                step="0.001"
                min="0"
                value={offerPriceInEth}
                onChange={(e) => setOfferPriceInEth(e.target.value)}
                className="w-full px-3 py-2 bg-black border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                placeholder={floorPrice || '0.1'}
                required
              />
              {floorPrice && offerPriceInEth && parseFloat(offerPriceInEth) < parseFloat(floorPrice) && (
                <p className="text-yellow-500 text-xs mt-1">
                  Offer is below floor price
                </p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">
                Duration
              </label>
              <select
                value={durationDays}
                onChange={(e) => setDurationDays(e.target.value)}
                className="w-full px-3 py-2 bg-black border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
              >
                <option value="1">1 day</option>
                <option value="3">3 days</option>
                <option value="7">7 days</option>
                <option value="14">14 days</option>
                <option value="30">30 days</option>
              </select>
            </div>

            {isCollectionOffer && (
              <div>
                <label className="block text-sm font-medium mb-2">
                  Trait Filters (Optional)
                </label>
                <div className="space-y-2">
                  {Object.entries(traits).map(([key, value]) => (
                    <div key={key} className="flex items-center justify-between bg-gray-900 rounded px-3 py-2">
                      <span className="text-sm">
                        {key}: {value}
                      </span>
                      <button
                        type="button"
                        onClick={() => handleTraitRemove(key)}
                        className="text-red-500 hover:text-red-400"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      placeholder="Trait"
                      id="trait-key"
                      className="flex-1 px-3 py-2 bg-black border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
                    />
                    <input
                      type="text"
                      placeholder="Value"
                      id="trait-value"
                      className="flex-1 px-3 py-2 bg-black border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500 text-sm"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const keyInput = document.getElementById('trait-key') as HTMLInputElement;
                        const valueInput = document.getElementById('trait-value') as HTMLInputElement;
                        if (keyInput.value && valueInput.value) {
                          handleTraitAdd(keyInput.value, valueInput.value);
                          keyInput.value = '';
                          valueInput.value = '';
                        }
                      }}
                      className="px-3 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors"
                    >
                      Add
                    </button>
                  </div>
                </div>
              </div>
            )}

            {error && (
              <div className="text-red-500 text-sm">{error}</div>
            )}

            <div className="text-xs text-gray-400">
              By making an offer, you&apos;re committing to purchase this NFT if the seller accepts.
              The offer will be signed with your wallet and stored on-chain.
            </div>

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
                disabled={isLoading || !offerPriceInEth}
                className="flex-1 px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Creating...' : 'Make Offer'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}