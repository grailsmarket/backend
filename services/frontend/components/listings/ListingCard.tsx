'use client';

import { Listing } from '@/types';
import Link from 'next/link';
import { formatCurrencyAmount } from '@/lib/currency';

interface ListingCardProps {
  listing: Listing;
}

export function ListingCard({ listing }: ListingCardProps) {
  const formatPrice = (priceWei: string, currencyAddress: string) => {
    try {
      return formatCurrencyAmount(priceWei, currencyAddress);
    } catch {
      return '0 ETH';
    }
  };

  const truncateAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  const formatRelativeTime = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
    if (diffDays < 365) return `${Math.floor(diffDays / 30)} months ago`;
    return `${Math.floor(diffDays / 365)} years ago`;
  };

  const formatName = (name: string | null, tokenId: string) => {
    // If no name or it's a placeholder token-XXX, show formatted token ID
    if (!name || name.startsWith('token-')) {
      // Truncate long token IDs
      if (tokenId.length > 20) {
        return `#${tokenId.slice(0, 8)}...${tokenId.slice(-6)}`;
      }
      return `Token #${tokenId}`;
    }
    return name;
  };

  const isListed = listing.status === 'active' && listing.price_wei;
  const hasOwner = listing.current_owner && listing.current_owner !== '0x0000000000000000000000000000000000000000';

  // Use 'name' from search API or 'ens_name' from listings API
  const displayName = listing.name || listing.ens_name;

  // Route to listing page if listed, profile page if not
  const href = `/names/${displayName}`;

  return (
    <Link href={href}>
      <div className="bg-gray-800 rounded-lg p-6 hover:bg-gray-750 transition-all hover:shadow-xl cursor-pointer border border-gray-700">
        <div className="mb-4">
          <div className="flex items-start justify-between mb-2">
            <h3 className="text-xl font-bold text-white">
              {formatName(displayName, listing.token_id)}
            </h3>
            {listing.source && (
              <span className={`inline-block px-2 py-1 text-xs rounded font-semibold ${
                listing.source === 'opensea'
                  ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                  : 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
              }`}>
                {listing.source === 'opensea' ? 'OpenSea' : 'Grails'}
              </span>
            )}
          </div>
          {isListed && listing.seller_address && (
            <p className="text-sm text-gray-400">
              Seller: {truncateAddress(listing.seller_address)}
            </p>
          )}
          {!isListed && hasOwner && (
            <p className="text-sm text-gray-400">
              Owner: {truncateAddress(listing.current_owner!)}
            </p>
          )}
          {listing.last_sale_date && (
            <p className="text-xs text-gray-500 mt-1">
              Last sold: {formatRelativeTime(listing.last_sale_date)}
            </p>
          )}
        </div>

        <div className="space-y-3">
          <div className="flex justify-between items-end">
            <div>
              {isListed ? (
                <>
                  <p className="text-sm text-gray-400 mb-1">Price</p>
                  <p className="text-2xl font-bold text-purple-400">
                    {formatPrice(listing.price_wei, listing.currency_address)}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-sm text-gray-400 mb-1">Not Listed</p>
                  <p className="text-lg font-semibold text-gray-300">
                    Make an Offer
                  </p>
                </>
              )}
            </div>

            {isListed && listing.expires_at && (
              <div className="text-right">
                <p className="text-xs text-gray-500">
                  Expires: {new Date(listing.expires_at).toLocaleDateString()}
                </p>
              </div>
            )}
          </div>

          {listing.highest_offer_wei && (
            <div className="pt-3 border-t border-gray-700">
              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-400">Highest Offer</span>
                <span className="text-lg font-semibold text-green-400">
                  {formatPrice(listing.highest_offer_wei, listing.highest_offer_currency || '0x0000000000000000000000000000000000000000')}
                </span>
              </div>
            </div>
          )}
        </div>

        {listing.status && listing.status !== 'active' && (
          <div className="mt-4">
            <span className="inline-block px-2 py-1 text-xs rounded bg-gray-700 text-gray-400">
              {listing.status}
            </span>
          </div>
        )}
      </div>
    </Link>
  );
}