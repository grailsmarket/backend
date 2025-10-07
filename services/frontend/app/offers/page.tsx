'use client';

import { useState, useEffect } from 'react';
import { useAccount } from 'wagmi';
import Link from 'next/link';
import { formatCurrencyAmount } from '@/lib/currency';

interface Offer {
  id: number;
  ens_name: string;
  token_id: string;
  offer_amount_wei: string;
  currency_address: string;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  created_at: string;
  expires_at: string | null;
  order_data: any;
}

export default function OffersPage() {
  const { address, isConnected } = useAccount();
  const [offers, setOffers] = useState<Offer[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'pending' | 'accepted' | 'rejected' | 'expired'>('all');

  useEffect(() => {
    if (!address) {
      setLoading(false);
      return;
    }

    const fetchOffers = async () => {
      try {
        setLoading(true);
        const statusParam = filter !== 'all' ? `?status=${filter}` : '';
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/offers/by-buyer/${address}${statusParam}`);
        const data = await response.json();

        if (data.success) {
          setOffers(data.data.offers);
        }
      } catch (error) {
        console.error('Error fetching offers:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchOffers();
  }, [address, filter]);

  const handleCancelOffer = async (offerId: number) => {
    if (!confirm('Are you sure you want to cancel this offer?')) {
      return;
    }

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/offers/${offerId}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          status: 'rejected',
        }),
      });

      if (response.ok) {
        // Refresh offers
        setOffers(offers.map(offer =>
          offer.id === offerId ? { ...offer, status: 'rejected' } : offer
        ));
      }
    } catch (error) {
      console.error('Error cancelling offer:', error);
      alert('Failed to cancel offer');
    }
  };

  const getStatusBadgeColor = (status: string) => {
    switch (status) {
      case 'pending':
        return 'bg-yellow-900/30 text-yellow-400 border-yellow-700';
      case 'accepted':
        return 'bg-green-900/30 text-green-400 border-green-700';
      case 'rejected':
        return 'bg-red-900/30 text-red-400 border-red-700';
      case 'expired':
        return 'bg-gray-900/30 text-gray-400 border-gray-700';
      default:
        return 'bg-gray-900/30 text-gray-400 border-gray-700';
    }
  };

  if (!isConnected) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-4">My Offers</h1>
          <p className="text-gray-400 mb-8">Please connect your wallet to view your offers.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-4">My Offers</h1>
        <p className="text-gray-400">View and manage your ENS name offers</p>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2 mb-6 flex-wrap">
        {['all', 'pending', 'accepted', 'rejected', 'expired'].map((status) => (
          <button
            key={status}
            onClick={() => setFilter(status as any)}
            className={`px-4 py-2 rounded-lg font-medium transition ${
              filter === status
                ? 'bg-purple-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto"></div>
          <p className="text-gray-400 mt-4">Loading offers...</p>
        </div>
      ) : offers.length === 0 ? (
        <div className="text-center py-12 bg-gray-800 rounded-lg border border-gray-700">
          <p className="text-gray-400 mb-4">
            {filter === 'all'
              ? "You haven't made any offers yet."
              : `You have no ${filter} offers.`
            }
          </p>
          <Link
            href="/"
            className="inline-block bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
          >
            Browse ENS Names
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {offers.map((offer) => (
            <div
              key={offer.id}
              className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-gray-600 transition"
            >
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <Link
                      href={`/names/${offer.ens_name}`}
                      className="text-xl font-bold text-white hover:text-purple-400 transition"
                    >
                      {offer.ens_name}
                    </Link>
                    <span
                      className={`px-3 py-1 rounded-full text-xs font-semibold border ${getStatusBadgeColor(
                        offer.status
                      )}`}
                    >
                      {offer.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                    <div>
                      <span className="text-gray-400">Offer Amount:</span>
                      <span className="text-white font-semibold ml-2">
                        {formatCurrencyAmount(offer.offer_amount_wei, offer.currency_address)}
                      </span>
                    </div>
                    <div>
                      <span className="text-gray-400">Created:</span>
                      <span className="text-white ml-2">
                        {new Date(offer.created_at).toLocaleDateString()}
                      </span>
                    </div>
                    {offer.expires_at && (
                      <div>
                        <span className="text-gray-400">Expires:</span>
                        <span className="text-white ml-2">
                          {new Date(offer.expires_at).toLocaleDateString()}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex gap-2">
                  <Link
                    href={`/names/${offer.ens_name}`}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg font-semibold transition"
                  >
                    View Name
                  </Link>
                  {offer.status === 'pending' && (
                    <button
                      onClick={() => handleCancelOffer(offer.id)}
                      className="px-4 py-2 bg-red-900/30 hover:bg-red-900/50 text-red-400 border border-red-700 rounded-lg font-semibold transition"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
