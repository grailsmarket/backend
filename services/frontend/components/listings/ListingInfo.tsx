'use client';

import { formatCurrencyAmount } from '@/lib/currency';

interface Listing {
  id: number;
  price_wei: string;
  currency_address: string;
  status: string;
  source: 'grails' | 'opensea';
  expires_at: string | null;
  seller_address: string;
  created_at: string;
}

interface ListingInfoProps {
  listing: Listing;
  ensName: string;
  onBuyClick?: () => void;
}

export function ListingInfo({ listing, ensName, onBuyClick }: ListingInfoProps) {
  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const getExpirationText = (expiresAt: string | null) => {
    if (!expiresAt) return null;

    const now = new Date();
    const expiry = new Date(expiresAt);
    const diffMs = expiry.getTime() - now.getTime();
    const diffDays = Math.floor(diffMs / 86400000);
    const diffHours = Math.floor(diffMs / 3600000);

    if (diffMs < 0) return 'Expired';
    if (diffDays > 0) return `Expires in ${diffDays}d`;
    if (diffHours > 0) return `Expires in ${diffHours}h`;
    return 'Expires soon';
  };

  const platformBadgeColor = listing.source === 'grails' ? 'bg-purple-600' : 'bg-blue-600';
  const expirationText = getExpirationText(listing.expires_at);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-3 mb-2">
            <h3 className="text-sm font-medium text-gray-400">Listed For Sale</h3>
            <span className={`text-xs px-2 py-1 rounded ${platformBadgeColor} text-white capitalize`}>
              {listing.source}
            </span>
          </div>

          <div className="mb-3">
            <div className="text-3xl font-bold text-white">
              {formatCurrencyAmount(listing.price_wei, listing.currency_address)}
            </div>
          </div>

          <div className="space-y-1 text-sm text-gray-400">
            <div className="flex items-center gap-2">
              <span>Seller:</span>
              <span className="text-gray-300 font-mono">{formatAddress(listing.seller_address)}</span>
            </div>
            {expirationText && (
              <div className="flex items-center gap-2">
                <span>{expirationText}</span>
              </div>
            )}
          </div>
        </div>

        <div>
          <button
            onClick={onBuyClick}
            className="bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-lg font-semibold transition"
          >
            Buy Now
          </button>
        </div>
      </div>
    </div>
  );
}
