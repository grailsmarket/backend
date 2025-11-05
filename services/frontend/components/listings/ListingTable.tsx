'use client';

import { Listing } from '@/types';
import Link from 'next/link';
import { formatCurrencyAmount } from '@/lib/currency';

interface ListingTableProps {
  listings: Listing[];
  loading?: boolean;
}

export function ListingTable({ listings, loading }: ListingTableProps) {
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

  const formatName = (name: string | null, tokenId: string) => {
    if (!name || name.startsWith('token-')) {
      if (tokenId.length > 20) {
        return `#${tokenId.slice(0, 8)}...${tokenId.slice(-6)}`;
      }
      return `Token #${tokenId}`;
    }
    if (name.length > 32) {
      return `${name.slice(0, 20)}...${name.slice(-9)}`;
    }
    return name;
  };

  const formatDate = (dateString: string | null | undefined) => {
    if (!dateString) return '—';
    const date = new Date(dateString);
    if (isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-lg overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-900 border-b border-gray-700">
            <tr>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Name</th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Price</th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Highest Offer</th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Seller</th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Source</th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Last Sale</th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">Listed</th>
            </tr>
          </thead>
          <tbody>
            {[...Array(8)].map((_, i) => (
              <tr key={i} className="border-b border-gray-700 animate-pulse">
                <td className="px-6 py-4"><div className="h-4 bg-gray-700 rounded w-32"></div></td>
                <td className="px-6 py-4"><div className="h-4 bg-gray-700 rounded w-20"></div></td>
                <td className="px-6 py-4"><div className="h-4 bg-gray-700 rounded w-20"></div></td>
                <td className="px-6 py-4"><div className="h-4 bg-gray-700 rounded w-24"></div></td>
                <td className="px-6 py-4"><div className="h-4 bg-gray-700 rounded w-16"></div></td>
                <td className="px-6 py-4"><div className="h-4 bg-gray-700 rounded w-20"></div></td>
                <td className="px-6 py-4"><div className="h-4 bg-gray-700 rounded w-20"></div></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (listings.length === 0) {
    return (
      <div className="text-center py-12 bg-gray-800 rounded-lg">
        <p className="text-gray-400 text-lg">No listings found</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-900 border-b border-gray-700">
            <tr>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Name
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Price
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Highest Offer
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Seller
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Source
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Last Sale
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Listed
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {listings.map((listing) => {
              const isListed = listing.status === 'active' && listing.price_wei;
              const displayName = listing.name || listing.ens_name;
              const href = `/names/${displayName}`;

              return (
                <tr
                  key={listing.id || displayName || listing.token_id}
                  className="hover:bg-gray-750 transition-colors"
                >
                  <td className="px-6 py-4">
                    <Link href={href} className="flex items-center gap-2 hover:text-purple-400 transition">
                      <span className="font-semibold text-white">
                        {formatName(displayName, listing.token_id)}
                      </span>
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    {isListed ? (
                      <span className="text-purple-400 font-semibold">
                        {formatPrice(listing.price_wei, listing.currency_address)}
                      </span>
                    ) : (
                      <span className="text-gray-500">Not listed</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {listing.highest_offer_wei ? (
                      <span className="text-green-400 font-semibold">
                        {formatPrice(listing.highest_offer_wei, listing.highest_offer_currency || '0x0000000000000000000000000000000000000000')}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {isListed && listing.seller_address ? (
                      <span className="text-gray-300 font-mono text-sm">
                        {truncateAddress(listing.seller_address)}
                      </span>
                    ) : listing.current_owner && listing.current_owner !== '0x0000000000000000000000000000000000000000' ? (
                      <span className="text-gray-500 font-mono text-sm">
                        {truncateAddress(listing.current_owner)}
                      </span>
                    ) : (
                      <span className="text-gray-600">—</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {listing.source && (
                      <span className={`inline-block px-2 py-1 text-xs rounded font-semibold ${
                        listing.source === 'opensea'
                          ? 'bg-blue-500/20 text-blue-400 border border-blue-500/30'
                          : 'bg-purple-500/20 text-purple-400 border border-purple-500/30'
                      }`}>
                        {listing.source === 'opensea' ? 'OpenSea' : 'Grails'}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-gray-400 text-sm">
                      {formatDate(listing.last_sale_date)}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-gray-400 text-sm">
                      {formatDate(listing.created_at)}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
