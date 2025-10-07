'use client';

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import { CreateListingModal } from '@/components/orders/CreateListingModal';
import { MakeOfferModal } from '@/components/orders/MakeOfferModal';
import { fetchENSTokenId, isValidENSName } from '@/lib/ensUtils';

export default function TestOrdersPage() {
  const { address, isConnected } = useAccount();
  const [showListingModal, setShowListingModal] = useState(false);
  const [showOfferModal, setShowOfferModal] = useState(false);
  const [showCollectionOfferModal, setShowCollectionOfferModal] = useState(false);
  const [customTokenId, setCustomTokenId] = useState('');
  const [customENSName, setCustomENSName] = useState('');
  const [isLoadingTokenId, setIsLoadingTokenId] = useState(false);
  const [tokenIdError, setTokenIdError] = useState('');

  // Fetch token ID from ENS subgraph when ENS name changes
  useEffect(() => {
    const fetchTokenId = async () => {
      if (customENSName) {
        setIsLoadingTokenId(true);
        setTokenIdError('');

        const nameToCheck = customENSName.endsWith('.eth') ? customENSName : `${customENSName}.eth`;

        try {
          const tokenId = await fetchENSTokenId(nameToCheck);
          if (tokenId) {
            setCustomTokenId(tokenId);
          } else {
            setTokenIdError(`Could not find token ID for ${nameToCheck}`);
          }
        } catch (error) {
          setTokenIdError('Error looking up ENS name');
        } finally {
          setIsLoadingTokenId(false);
        }
      } else {
        setCustomTokenId('');
        setTokenIdError('');
      }
    };

    // Debounce the lookup
    const timeoutId = setTimeout(fetchTokenId, 500);
    return () => clearTimeout(timeoutId);
  }, [customENSName]);

  // Test ENS name data - using placeholder values
  const testENS = {
    tokenId: customTokenId || '1234567890123456789012345678901234567890', // Placeholder token ID
    name: customENSName || 'example.eth',
    owner: address || '0x0000000000000000000000000000000000000000',
  };

  if (!isConnected) {
    return (
      <div className="container mx-auto px-4 py-8">
        <h1 className="text-3xl font-bold mb-6">Test Order Creation</h1>
        <div className="bg-yellow-900/20 border border-yellow-600 rounded-lg p-4">
          <p className="text-yellow-400">
            Please connect your wallet to test order creation.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-3xl font-bold mb-6">Test Order Creation</h1>

      <div className="mb-6 space-y-4">
        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-2">Connected Wallet</h2>
          <p className="text-sm text-gray-400 font-mono">{address}</p>
        </div>

        <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
          <h2 className="text-lg font-semibold mb-3">Test Configuration (Optional)</h2>
          <p className="text-sm text-gray-400 mb-4">
            Enter your own ENS token ID and name for testing, or leave empty to use placeholder values.
          </p>
          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium mb-1">ENS Name</label>
              <input
                type="text"
                value={customENSName}
                onChange={(e) => setCustomENSName(e.target.value)}
                placeholder="vitalik.eth or just vitalik"
                className="w-full px-3 py-2 bg-black border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
              {isLoadingTokenId && (
                <p className="text-xs text-yellow-400 mt-1">
                  Looking up token ID...
                </p>
              )}
              {!isLoadingTokenId && customTokenId && !tokenIdError && (
                <p className="text-xs text-green-400 mt-1">
                  ✓ Token ID found: {customTokenId}
                </p>
              )}
              {tokenIdError && (
                <p className="text-xs text-red-400 mt-1">
                  {tokenIdError}
                </p>
              )}
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">
                Token ID {customTokenId && !tokenIdError && '(Auto-filled from ENS subgraph)'}
              </label>
              <input
                type="text"
                value={customTokenId}
                onChange={(e) => setCustomTokenId(e.target.value)}
                placeholder={isLoadingTokenId ? "Looking up..." : "Will be fetched from ENS name"}
                className="w-full px-3 py-2 bg-black border border-gray-700 rounded-md focus:outline-none focus:ring-2 focus:ring-purple-500"
                disabled={isLoadingTokenId}
              />
              <p className="text-xs text-gray-500 mt-1">
                Automatically fetched from the ENS subgraph, or enter manually if you know it.
              </p>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {/* Create Listing Card */}
        <div className="bg-background border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-3">Create Listing</h2>
          <p className="text-muted-foreground mb-4">
            List an ENS name for sale on the marketplace
          </p>
          <button
            onClick={() => setShowListingModal(true)}
            className="w-full px-4 py-2 bg-purple-600 text-white rounded-md hover:bg-purple-700 transition-colors"
          >
            Create Test Listing
          </button>
        </div>

        {/* Make Offer Card */}
        <div className="bg-background border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-3">Make Offer</h2>
          <p className="text-muted-foreground mb-4">
            Make an offer on a specific ENS name
          </p>
          <button
            onClick={() => setShowOfferModal(true)}
            className="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
          >
            Make Test Offer
          </button>
        </div>

        {/* Collection Offer Card */}
        <div className="bg-background border border-border rounded-lg p-6">
          <h2 className="text-xl font-semibold mb-3">Collection Offer</h2>
          <p className="text-muted-foreground mb-4">
            Make an offer on any ENS name in the collection
          </p>
          <button
            onClick={() => setShowCollectionOfferModal(true)}
            className="w-full px-4 py-2 bg-green-600 text-white rounded-md hover:bg-green-700 transition-colors"
          >
            Make Collection Offer
          </button>
        </div>
      </div>

      {/* Info Section */}
      <div className="mt-8 bg-blue-900/20 border border-blue-600 rounded-lg p-6">
        <h3 className="text-lg font-semibold mb-3 text-blue-400">How it works:</h3>
        <ul className="space-y-2 text-sm">
          <li className="flex items-start">
            <span className="text-blue-400 mr-2">1.</span>
            <span>Click one of the buttons above to open the order creation modal</span>
          </li>
          <li className="flex items-start">
            <span className="text-blue-400 mr-2">2.</span>
            <span>Fill in the order details (price, duration, etc.)</span>
          </li>
          <li className="flex items-start">
            <span className="text-blue-400 mr-2">3.</span>
            <span>The Seaport.js library will create and structure the order</span>
          </li>
          <li className="flex items-start">
            <span className="text-blue-400 mr-2">4.</span>
            <span>Sign the order with your wallet (EIP-712 signature)</span>
          </li>
          <li className="flex items-start">
            <span className="text-blue-400 mr-2">5.</span>
            <span>The signed order is stored in our database</span>
          </li>
          <li className="flex items-start">
            <span className="text-blue-400 mr-2">6.</span>
            <span>Orders can be fulfilled using the Seaport contract</span>
          </li>
        </ul>
      </div>

      {/* Modals */}
      <CreateListingModal
        isOpen={showListingModal}
        onClose={() => setShowListingModal(false)}
        tokenId={testENS.tokenId}
        ensName={testENS.name}
      />

      <MakeOfferModal
        isOpen={showOfferModal}
        onClose={() => setShowOfferModal(false)}
        tokenId={testENS.tokenId}
        ensName={testENS.name}
        currentOwner={testENS.owner}
        floorPrice="0.05"
      />

      <MakeOfferModal
        isOpen={showCollectionOfferModal}
        onClose={() => setShowCollectionOfferModal(false)}
        tokenId=""
        ensName="Any ENS"
        isCollectionOffer={true}
        floorPrice="0.05"
      />
    </div>
  );
}