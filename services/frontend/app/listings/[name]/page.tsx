'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useListingByName } from '@/hooks/useListings';
import { ListingDetails } from '@/components/listings/ListingDetails';
import { OrderModal } from '@/components/orders/OrderModal';
import { useAccount } from 'wagmi';
import { formatCurrencyAmount } from '@/lib/currency';
import { useQueryClient } from '@tanstack/react-query';

export default function ListingPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();
  const name = params.name as string;
  const { address } = useAccount();
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [selectedListing, setSelectedListing] = useState<any>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  const { data: listings, isLoading, error } = useListingByName(name);

  // Debug logging
  console.log('Listings data:', listings, 'isLoading:', isLoading, 'error:', error);

  const formatPrice = (priceWei: string, currencyAddress: string) => {
    try {
      return formatCurrencyAmount(priceWei, currencyAddress);
    } catch {
      return '0 ETH';
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-gray-800 rounded-lg p-8 animate-pulse">
          <div className="h-8 bg-gray-700 rounded mb-4 w-1/3"></div>
          <div className="h-4 bg-gray-700 rounded mb-2 w-1/2"></div>
          <div className="h-4 bg-gray-700 rounded mb-6 w-2/3"></div>
          <div className="h-12 bg-gray-700 rounded w-32"></div>
        </div>
      </div>
    );
  }

  if (error || !listings || !Array.isArray(listings) || listings.length === 0) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="bg-gray-800 rounded-lg p-8 text-center">
          <h2 className="text-2xl font-bold text-red-400 mb-4">Listing Not Found</h2>
          <p className="text-gray-400">The listing for {name} could not be found.</p>
        </div>
      </div>
    );
  }

  // Get first listing for general info (safe to access after check above)
  const firstListing = listings[0];

  const handleCancelListing = async (listingId: number) => {
    if (!listingId || !address) return;

    // Show confirmation dialog
    if (!window.confirm('Are you sure you want to cancel this listing? This action cannot be undone.')) {
      return;
    }

    setIsCancelling(true);
    setCancelError(null);

    try {
      const response = await fetch('/api/orders/cancel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          listingIds: [listingId],
          canceller: address,
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to cancel listing');
      }

      // Invalidate all listings queries to refresh the cache
      await queryClient.invalidateQueries({ queryKey: ['listings'] });
      await queryClient.invalidateQueries({ queryKey: ['listing'] });

      // Redirect to home
      router.push('/');
    } catch (err: any) {
      console.error('Error cancelling listing:', err);
      setCancelError(err.message || 'Failed to cancel listing');
    } finally {
      setIsCancelling(false);
    }
  };

  return (
    <>
      <div className="max-w-4xl mx-auto">
        <div className="bg-gray-800 rounded-lg p-8">
          {/* ENS Name Header */}
          <div className="mb-8 border-b border-gray-700 pb-6">
            <h1 className="text-4xl font-bold text-white mb-4">
              {firstListing.ens_name || `Token #${firstListing.token_id}`}
            </h1>
            <div className="flex flex-wrap gap-4 text-sm text-gray-400">
              <div>
                Token ID: <span className="text-white font-mono">{firstListing.token_id}</span>
              </div>
              {firstListing.name_expiry_date && (
                <div>
                  Expires: <span className="text-white">{new Date(firstListing.name_expiry_date).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>

          {/* Listings Section */}
          <div className="space-y-6">
            <h2 className="text-2xl font-bold text-white">Active Listings ({listings.length})</h2>

            {listings.map((listing) => {
              const isOwner = address && listing.seller_address.toLowerCase() === address.toLowerCase();

              return (
                <div key={listing.id} className="bg-gray-750 rounded-lg p-6 border border-gray-700">
                  {/* Listing Header with Badge */}
                  <div className="flex items-start justify-between mb-4">
                    <div>
                      <p className="text-gray-400 text-sm mb-1">Price</p>
                      <p className="text-3xl font-bold text-purple-400">
                        {formatPrice(listing.price_wei, listing.currency_address)}
                      </p>
                    </div>
                    {listing.source && (
                      <span className={`inline-block px-3 py-1.5 text-sm rounded-lg font-semibold ${
                        listing.source === 'opensea'
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                          : 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                      }`}>
                        {listing.source === 'opensea' ? 'OpenSea' : 'Grails'}
                      </span>
                    )}
                  </div>

                  {/* Seller Info */}
                  <div className="mb-4">
                    <p className="text-gray-400 text-sm mb-1">Seller</p>
                    <p className="text-white font-mono text-sm">{listing.seller_address}</p>
                  </div>

                  {/* Expiry */}
                  {listing.expires_at && (
                    <div className="mb-4">
                      <p className="text-gray-400 text-sm">
                        Listing expires: {new Date(listing.expires_at).toLocaleDateString()}
                      </p>
                    </div>
                  )}

                  {/* Action Buttons */}
                  <div className="flex gap-4">
                    {!address ? (
                      <p className="text-gray-400 text-sm">Connect your wallet to purchase</p>
                    ) : isOwner ? (
                      <button
                        onClick={() => handleCancelListing(listing.id)}
                        disabled={isCancelling}
                        className="px-6 py-3 bg-red-600 hover:bg-red-700 text-white rounded-lg font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {isCancelling ? 'Cancelling...' : 'Cancel Listing'}
                      </button>
                    ) : (
                      <button
                        onClick={() => {
                          setSelectedListing(listing);
                          setShowOrderModal(true);
                        }}
                        className="px-6 py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold transition"
                      >
                        Buy Now
                      </button>
                    )}
                  </div>

                  {/* Order Data (Debug) */}
                  {process.env.NODE_ENV === 'development' && listing.order_data && (
                    <div className="mt-4 pt-4 border-t border-gray-600">
                      <details>
                        <summary className="text-gray-400 cursor-pointer text-sm">Order Data (Debug)</summary>
                        <pre className="mt-2 p-2 bg-gray-900 rounded text-xs text-gray-400 overflow-auto">
                          {JSON.stringify(listing.order_data, null, 2)}
                        </pre>
                      </details>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Error Display */}
          {cancelError && (
            <div className="mt-4 text-red-400 text-sm">
              {cancelError}
            </div>
          )}
        </div>
      </div>

      {/* Order Modal */}
      {showOrderModal && selectedListing && (
        <OrderModal
          listing={selectedListing}
          onClose={() => {
            setShowOrderModal(false);
            setSelectedListing(null);
          }}
        />
      )}
    </>
  );
}