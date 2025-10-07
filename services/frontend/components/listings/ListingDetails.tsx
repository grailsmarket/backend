'use client';

import { Listing } from '@/types';
import { formatEther } from 'viem';

interface ListingDetailsProps {
  listing: Listing;
}

export function ListingDetails({ listing }: ListingDetailsProps) {
  const formatPrice = (priceWei: string) => {
    try {
      const eth = formatEther(BigInt(priceWei));
      return `${parseFloat(eth).toFixed(4)} ETH`;
    } catch {
      return '0 ETH';
    }
  };

  const truncateAddress = (address: string) => {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold text-gray-300 mb-2">Details</h3>
        <div className="bg-gray-900 rounded-lg p-4 space-y-3">
          <div className="flex justify-between">
            <span className="text-gray-400">Token ID</span>
            <span className="text-white font-mono text-sm">{listing.token_id}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Contract</span>
            <span className="text-white font-mono text-sm">ENS Registrar</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Current Owner</span>
            <span className="text-white font-mono text-sm">
              {truncateAddress(listing.current_owner || listing.seller_address)}
            </span>
          </div>
          {listing.registration_date && (
            <div className="flex justify-between">
              <span className="text-gray-400">Registered</span>
              <span className="text-white">
                {new Date(listing.registration_date).toLocaleDateString()}
              </span>
            </div>
          )}
          {listing.name_expiry_date && (
            <div className="flex justify-between">
              <span className="text-gray-400">Domain Expires</span>
              <span className="text-white">
                {new Date(listing.name_expiry_date).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      </div>

      <div>
        <h3 className="text-lg font-semibold text-gray-300 mb-2">Listing Information</h3>
        <div className="bg-gray-900 rounded-lg p-4 space-y-3">
          <div className="flex justify-between">
            <span className="text-gray-400">Price</span>
            <span className="text-white font-semibold">
              {formatPrice(listing.price_wei)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Seller</span>
            <span className="text-white font-mono text-sm">
              {truncateAddress(listing.seller_address)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Status</span>
            <span className={`capitalize ${
              listing.status === 'active' ? 'text-green-400' : 'text-gray-400'
            }`}>
              {listing.status}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Listed</span>
            <span className="text-white">
              {new Date(listing.created_at).toLocaleDateString()}
            </span>
          </div>
          {listing.expires_at && (
            <div className="flex justify-between">
              <span className="text-gray-400">Listing Expires</span>
              <span className="text-white">
                {new Date(listing.expires_at).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}