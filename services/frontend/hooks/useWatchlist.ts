'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './useAuth';

interface WatchlistItem {
  id: number;
  userId: number;
  ensNameId: number;
  ensName: string;
  notifyOnSale: boolean;
  notifyOnOffer: boolean;
  notifyOnListing: boolean;
  notifyOnPriceChange: boolean;
  addedAt: string;
  nameData: {
    name: string;
    tokenId: string;
    ownerAddress: string;
    expiryDate: string;
    hasActiveListing: boolean;
    activeListing?: {
      id: number;
      price_wei: string;
      currency_address: string;
      source: string;
      created_at: string;
    };
  };
}

interface WatchlistResponse {
  watchlist: WatchlistItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

interface UseWatchlistOptions {
  autoFetch?: boolean; // Whether to automatically fetch watchlist on mount
}

export function useWatchlist(options: UseWatchlistOptions = {}) {
  const { autoFetch = true } = options;
  const { token, isAuthenticated } = useAuth();
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchWatchlist = async () => {
    if (!token || !isAuthenticated) {
      setWatchlist([]);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/watchlist`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error('Failed to fetch watchlist');
      }

      const { data } = await response.json();
      setWatchlist(data.watchlist);
    } catch (err: any) {
      console.error('Fetch watchlist error:', err);
      setError(err?.message || 'Failed to load watchlist');
    } finally {
      setIsLoading(false);
    }
  };

  const addToWatchlist = async (
    ensName: string,
    preferences: {
      notifyOnSale?: boolean;
      notifyOnOffer?: boolean;
      notifyOnListing?: boolean;
      notifyOnPriceChange?: boolean;
    } = {}
  ) => {
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/watchlist`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        ensName,
        notifyOnSale: preferences.notifyOnSale ?? true,
        notifyOnOffer: preferences.notifyOnOffer ?? true,
        notifyOnListing: preferences.notifyOnListing ?? true,
        notifyOnPriceChange: preferences.notifyOnPriceChange ?? false,
      }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to add to watchlist');
    }

    // Refresh watchlist
    await fetchWatchlist();
  };

  const removeFromWatchlist = async (id: number) => {
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/watchlist/${id}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to remove from watchlist');
    }

    // Refresh watchlist
    await fetchWatchlist();
  };

  const updateWatchlistItem = async (
    id: number,
    preferences: {
      notifyOnSale?: boolean;
      notifyOnOffer?: boolean;
      notifyOnListing?: boolean;
      notifyOnPriceChange?: boolean;
    }
  ) => {
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(
      `${process.env.NEXT_PUBLIC_API_URL}/watchlist/${id}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(preferences),
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to update preferences');
    }

    // Refresh watchlist
    await fetchWatchlist();
  };

  const isInWatchlist = (ensName: string): boolean => {
    return watchlist.some(
      (item) => item.ensName.toLowerCase() === ensName.toLowerCase()
    );
  };

  const getWatchlistItem = (ensName: string): WatchlistItem | undefined => {
    return watchlist.find(
      (item) => item.ensName.toLowerCase() === ensName.toLowerCase()
    );
  };

  const checkIsInWatchlist = useCallback(async (
    ensName: string
  ): Promise<{ isWatching: boolean; watchlistEntry: WatchlistItem | null }> => {
    if (!token || !isAuthenticated) {
      return { isWatching: false, watchlistEntry: null };
    }

    try {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/watchlist/check/${encodeURIComponent(ensName)}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        // If name not found, treat as not watched
        if (response.status === 404) {
          return { isWatching: false, watchlistEntry: null };
        }
        throw new Error('Failed to check watchlist status');
      }

      const { data } = await response.json();
      return {
        isWatching: data.isWatching,
        watchlistEntry: data.watchlistEntry,
      };
    } catch (err: any) {
      console.error('Check watchlist error:', err);
      // On error, fall back to local check
      const item = watchlist.find(
        (w) => w.ensName.toLowerCase() === ensName.toLowerCase()
      );
      return {
        isWatching: !!item,
        watchlistEntry: item || null,
      };
    }
  }, [token, isAuthenticated, watchlist]);

  // Fetch watchlist when authenticated (only if autoFetch is enabled)
  useEffect(() => {
    if (autoFetch) {
      if (isAuthenticated) {
        fetchWatchlist();
      } else {
        setWatchlist([]);
      }
    }
  }, [isAuthenticated, token, autoFetch]);

  return {
    watchlist,
    isLoading,
    error,
    fetchWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    updateWatchlistItem,
    isInWatchlist,
    getWatchlistItem,
    checkIsInWatchlist,
  };
}
