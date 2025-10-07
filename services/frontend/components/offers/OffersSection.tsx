'use client';

import { useState, useEffect } from 'react';
import { formatCurrencyAmount } from '@/lib/currency';

interface Offer {
  id: number;
  buyer_address: string;
  offer_amount_wei: string;
  currency_address: string;
  status: string;
  source: string;
  expires_at: string | null;
  created_at: string;
}

interface OffersSectionProps {
  ensName: string;
  isOwner?: boolean;
}

export function OffersSection({ ensName, isOwner = false }: OffersSectionProps) {
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchOffers = async () => {
      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002/api/v1';
        const response = await fetch(`${apiUrl}/offers/by-name/${ensName}?status=pending`);
        if (!response.ok) throw new Error('Failed to fetch offers');

        const data = await response.json();
        setOffers(data.data?.offers || []);
      } catch (err) {
        console.error('Error fetching offers:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchOffers();
  }, [ensName]);

  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const getTimeAgo = (timestamp: string) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  if (loading) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
        <div className="animate-pulse space-y-3">
          <div className="h-4 bg-gray-700 rounded w-24"></div>
          <div className="h-12 bg-gray-700 rounded"></div>
        </div>
      </div>
    );
  }

  if (offers.length === 0) {
    return (
      <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
        <h3 className="text-sm font-medium text-gray-400 mb-3">Offers</h3>
        <p className="text-gray-500 text-sm">No active offers</p>
      </div>
    );
  }

  // Sort offers by amount (highest first)
  const sortedOffers = [...offers].sort((a, b) => {
    const amountA = BigInt(a.offer_amount_wei);
    const amountB = BigInt(b.offer_amount_wei);
    if (amountA > amountB) return -1;
    if (amountA < amountB) return 1;
    return 0;
  });

  const highestOffer = sortedOffers[0];
  const otherOffers = sortedOffers.slice(1);

  return (
    <div className="bg-gray-800 border border-gray-700 rounded-lg p-6">
      <div className="mb-4">
        <h3 className="text-sm font-medium text-gray-400 mb-1">
          {isOwner ? 'Offers Received' : 'Highest Offer'}
        </h3>
        <div className="text-2xl font-bold text-white">
          {formatCurrencyAmount(highestOffer.offer_amount_wei, highestOffer.currency_address)}
        </div>
        <p className="text-sm text-gray-400 mt-1">
          from {formatAddress(highestOffer.buyer_address)} • {getTimeAgo(highestOffer.created_at)}
        </p>
      </div>

      {otherOffers.length > 0 && (
        <div className="space-y-2 pt-4 border-t border-gray-700">
          {otherOffers.map((offer) => (
            <div key={offer.id} className="flex items-center justify-between py-1.5">
              <div className="flex items-center gap-2">
                <span className="text-xs font-mono text-gray-500">{formatAddress(offer.buyer_address)}</span>
                <span className="text-xs text-gray-600">•</span>
                <span className="text-xs text-gray-600">{getTimeAgo(offer.created_at)}</span>
              </div>
              <span className="text-sm font-medium text-gray-300">
                {formatCurrencyAmount(offer.offer_amount_wei, offer.currency_address)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
