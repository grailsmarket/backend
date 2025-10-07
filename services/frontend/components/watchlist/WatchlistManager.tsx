'use client';

import { useState } from 'react';
import { useWatchlist } from '@/hooks/useWatchlist';
import { formatEther } from 'viem';
import Link from 'next/link';

export function WatchlistManager() {
  const {
    watchlist,
    isLoading,
    error,
    removeFromWatchlist,
    updateWatchlistItem,
  } = useWatchlist();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPreferences, setEditPreferences] = useState({
    notifyOnSale: true,
    notifyOnOffer: true,
    notifyOnListing: true,
    notifyOnPriceChange: false,
  });

  const handleEditClick = (item: any) => {
    setEditingId(item.id);
    setEditPreferences({
      notifyOnSale: item.notifyOnSale,
      notifyOnOffer: item.notifyOnOffer,
      notifyOnListing: item.notifyOnListing,
      notifyOnPriceChange: item.notifyOnPriceChange,
    });
  };

  const handleSavePreferences = async (id: number) => {
    try {
      await updateWatchlistItem(id, editPreferences);
      setEditingId(null);
    } catch (err: any) {
      console.error('Update preferences error:', err);
    }
  };

  const handleRemove = async (id: number) => {
    if (confirm('Are you sure you want to remove this name from your watchlist?')) {
      try {
        await removeFromWatchlist(id);
      } catch (err: any) {
        console.error('Remove from watchlist error:', err);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-3 text-zinc-400">
          <svg className="w-6 h-6 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>Loading watchlist...</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-6">
        <p className="text-red-400">{error}</p>
      </div>
    );
  }

  if (watchlist.length === 0) {
    return (
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-12 text-center">
        <div className="max-w-md mx-auto">
          <svg
            className="w-16 h-16 mx-auto mb-4 text-zinc-600"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z"
            />
          </svg>
          <h3 className="text-xl font-semibold text-white mb-2">
            Your watchlist is empty
          </h3>
          <p className="text-zinc-400 mb-6">
            Start tracking ENS names by adding them to your watchlist from the
            marketplace.
          </p>
          <Link
            href="/"
            className="inline-block px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            Browse Marketplace
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {watchlist.map((item) => (
        <div
          key={item.id}
          className="bg-zinc-900 border border-zinc-800 rounded-lg p-6"
        >
          <div className="flex items-start justify-between mb-4">
            <div className="flex-1">
              <Link
                href={`/names/${item.ensName}`}
                className="text-xl font-bold text-white hover:text-purple-400 transition-colors"
              >
                {item.ensName}
              </Link>
              <div className="flex items-center gap-4 mt-2 text-sm text-zinc-400">
                <span>Added {new Date(item.addedAt).toLocaleDateString()}</span>
                {item.nameData.hasActiveListing && item.nameData.activeListing && (
                  <span className="flex items-center gap-1 text-green-500">
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
                        clipRule="evenodd"
                      />
                    </svg>
                    Listed for {formatEther(BigInt(item.nameData.activeListing.price_wei))} ETH
                  </span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() =>
                  editingId === item.id
                    ? setEditingId(null)
                    : handleEditClick(item)
                }
                className="p-2 text-zinc-400 hover:text-white transition-colors"
                title="Edit preferences"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </button>
              <button
                onClick={() => handleRemove(item.id)}
                className="p-2 text-zinc-400 hover:text-red-500 transition-colors"
                title="Remove from watchlist"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"
                  />
                </svg>
              </button>
            </div>
          </div>

          {editingId === item.id ? (
            <div className="bg-zinc-800 rounded-lg p-4 space-y-3">
              <h4 className="text-sm font-semibold text-white mb-2">
                Notification Preferences
              </h4>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={editPreferences.notifyOnSale}
                  onChange={(e) =>
                    setEditPreferences({
                      ...editPreferences,
                      notifyOnSale: e.target.checked,
                    })
                  }
                  className="w-4 h-4 rounded border-zinc-600 bg-zinc-700 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-zinc-300">Notify on sale</span>
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={editPreferences.notifyOnOffer}
                  onChange={(e) =>
                    setEditPreferences({
                      ...editPreferences,
                      notifyOnOffer: e.target.checked,
                    })
                  }
                  className="w-4 h-4 rounded border-zinc-600 bg-zinc-700 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-zinc-300">Notify on offer</span>
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={editPreferences.notifyOnListing}
                  onChange={(e) =>
                    setEditPreferences({
                      ...editPreferences,
                      notifyOnListing: e.target.checked,
                    })
                  }
                  className="w-4 h-4 rounded border-zinc-600 bg-zinc-700 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-zinc-300">Notify on listing</span>
              </label>
              <label className="flex items-center gap-3">
                <input
                  type="checkbox"
                  checked={editPreferences.notifyOnPriceChange}
                  onChange={(e) =>
                    setEditPreferences({
                      ...editPreferences,
                      notifyOnPriceChange: e.target.checked,
                    })
                  }
                  className="w-4 h-4 rounded border-zinc-600 bg-zinc-700 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-sm text-zinc-300">Notify on price change</span>
              </label>
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => handleSavePreferences(item.id)}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={() => setEditingId(null)}
                  className="px-4 py-2 bg-zinc-700 hover:bg-zinc-600 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {item.notifyOnSale && (
                <span className="px-2 py-1 bg-blue-500/20 text-blue-400 text-xs rounded-md">
                  Sales
                </span>
              )}
              {item.notifyOnOffer && (
                <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded-md">
                  Offers
                </span>
              )}
              {item.notifyOnListing && (
                <span className="px-2 py-1 bg-purple-500/20 text-purple-400 text-xs rounded-md">
                  Listings
                </span>
              )}
              {item.notifyOnPriceChange && (
                <span className="px-2 py-1 bg-yellow-500/20 text-yellow-400 text-xs rounded-md">
                  Price Changes
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
