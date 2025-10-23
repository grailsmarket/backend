'use client';

import { useState } from 'react';
import Link from 'next/link';
import { formatEther } from 'viem';
import { useWatchlist } from '@/hooks/useWatchlist';

interface WatchlistItem {
  name: string;
  tokenId?: string;
  price?: string;
  expiryDate?: string;
  ownerAddress?: string;
  watchlist?: {
    watchlistId: number;
    notifyOnSale: boolean;
    notifyOnOffer: boolean;
    notifyOnListing: boolean;
    notifyOnPriceChange: boolean;
    addedAt: string;
  };
  listing?: {
    id: number;
    priceWei: string;
    currencyAddress: string;
    status: string;
  };
}

interface WatchlistTableProps {
  items: WatchlistItem[];
  isLoading?: boolean;
}

export function WatchlistTable({ items, isLoading }: WatchlistTableProps) {
  const { removeFromWatchlist, updateWatchlistItem } = useWatchlist();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editPreferences, setEditPreferences] = useState({
    notifyOnSale: true,
    notifyOnOffer: true,
    notifyOnListing: true,
    notifyOnPriceChange: false,
  });

  const handleEditClick = (item: WatchlistItem) => {
    if (!item.watchlist) return;

    setEditingId(item.watchlist.watchlistId);
    setEditPreferences({
      notifyOnSale: item.watchlist.notifyOnSale,
      notifyOnOffer: item.watchlist.notifyOnOffer,
      notifyOnListing: item.watchlist.notifyOnListing,
      notifyOnPriceChange: item.watchlist.notifyOnPriceChange,
    });
  };

  const handleSavePreferences = async (watchlistId: number) => {
    try {
      await updateWatchlistItem(watchlistId, editPreferences);
      setEditingId(null);
    } catch (err: any) {
      console.error('Update preferences error:', err);
    }
  };

  const handleRemove = async (watchlistId: number, ensName: string) => {
    if (confirm(`Remove ${ensName} from your watchlist?`)) {
      try {
        await removeFromWatchlist(watchlistId);
      } catch (err: any) {
        console.error('Remove from watchlist error:', err);
      }
    }
  };

  const formatExpiryDate = (date: string | undefined) => {
    if (!date) return '-';
    const expiryDate = new Date(date);
    const now = new Date();
    const daysUntil = Math.floor((expiryDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (daysUntil < 0) {
      return <span className="text-red-400">Expired</span>;
    } else if (daysUntil < 30) {
      return <span className="text-yellow-400">{daysUntil}d</span>;
    } else {
      return <span className="text-gray-400">{expiryDate.toLocaleDateString()}</span>;
    }
  };

  if (isLoading) {
    return (
      <div className="bg-gray-800 rounded-lg p-8">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-16 bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-12 text-center">
        <p className="text-gray-400">No results found</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead className="bg-gray-900 border-b border-gray-700">
            <tr>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                ENS Name
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Active Notifications
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Price
              </th>
              <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Expiry
              </th>
              <th className="px-6 py-4 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-700">
            {items.map((item) => {
              const isEditing = editingId === item.watchlist?.watchlistId;

              return (
                <tr key={item.name} className="hover:bg-gray-750 transition">
                  <td className="px-6 py-4">
                    <Link
                      href={`/names/${item.name}`}
                      className="text-white font-semibold hover:text-purple-400 transition"
                    >
                      {item.name}
                    </Link>
                  </td>
                  <td className="px-6 py-4">
                    {isEditing && item.watchlist ? (
                      <div className="space-y-2">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={editPreferences.notifyOnSale}
                            onChange={(e) =>
                              setEditPreferences({
                                ...editPreferences,
                                notifyOnSale: e.target.checked,
                              })
                            }
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-600"
                          />
                          <span className="text-gray-300">Sales</span>
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={editPreferences.notifyOnOffer}
                            onChange={(e) =>
                              setEditPreferences({
                                ...editPreferences,
                                notifyOnOffer: e.target.checked,
                              })
                            }
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-600"
                          />
                          <span className="text-gray-300">Offers</span>
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={editPreferences.notifyOnListing}
                            onChange={(e) =>
                              setEditPreferences({
                                ...editPreferences,
                                notifyOnListing: e.target.checked,
                              })
                            }
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-600"
                          />
                          <span className="text-gray-300">Listings</span>
                        </label>
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={editPreferences.notifyOnPriceChange}
                            onChange={(e) =>
                              setEditPreferences({
                                ...editPreferences,
                                notifyOnPriceChange: e.target.checked,
                              })
                            }
                            className="w-4 h-4 rounded border-gray-600 bg-gray-700 text-blue-600"
                          />
                          <span className="text-gray-300">Price Changes</span>
                        </label>
                        <div className="flex gap-2 pt-2">
                          <button
                            onClick={() => handleSavePreferences(item.watchlist!.watchlistId)}
                            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded transition"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-3 py-1 bg-gray-700 hover:bg-gray-600 text-white text-xs rounded transition"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex flex-wrap gap-2">
                        {item.watchlist?.notifyOnSale && (
                          <span className="px-2 py-1 bg-blue-500/20 text-blue-400 text-xs rounded">
                            Sales
                          </span>
                        )}
                        {item.watchlist?.notifyOnOffer && (
                          <span className="px-2 py-1 bg-green-500/20 text-green-400 text-xs rounded">
                            Offers
                          </span>
                        )}
                        {item.watchlist?.notifyOnListing && (
                          <span className="px-2 py-1 bg-purple-500/20 text-purple-400 text-xs rounded">
                            Listings
                          </span>
                        )}
                        {item.watchlist?.notifyOnPriceChange && (
                          <span className="px-2 py-1 bg-yellow-500/20 text-yellow-400 text-xs rounded">
                            Price
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {item.listing && item.listing.priceWei ? (
                      <span className="text-white font-medium">
                        {formatEther(BigInt(item.listing.priceWei))} ETH
                      </span>
                    ) : (
                      <span className="text-gray-500">-</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {formatExpiryDate(item.expiryDate)}
                  </td>
                  <td className="px-6 py-4">
                    {!isEditing && item.watchlist && (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleEditClick(item)}
                          className="p-2 text-gray-400 hover:text-white transition"
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
                          onClick={() => handleRemove(item.watchlist!.watchlistId, item.name)}
                          className="p-2 text-gray-400 hover:text-red-500 transition"
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
                    )}
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
