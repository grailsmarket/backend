'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useWatchlist } from '@/hooks/useWatchlist';
import { SignInModal } from '@/components/auth/SignInModal';

interface AddToWatchlistProps {
  ensName: string;
}

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
}

export function AddToWatchlist({ ensName }: AddToWatchlistProps) {
  const { isAuthenticated } = useAuth();
  const { checkIsInWatchlist, addToWatchlist, removeFromWatchlist } = useWatchlist({ autoFetch: false });
  const [showSignInModal, setShowSignInModal] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isChecking, setIsChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [inWatchlist, setInWatchlist] = useState(false);
  const [watchlistItem, setWatchlistItem] = useState<WatchlistItem | null>(null);

  // Check watchlist status on mount and when auth changes
  useEffect(() => {
    const checkStatus = async () => {
      setIsChecking(true);
      try {
        const result = await checkIsInWatchlist(ensName);
        setInWatchlist(result.isWatching);
        setWatchlistItem(result.watchlistEntry);
      } catch (err) {
        console.error('Failed to check watchlist status:', err);
      } finally {
        setIsChecking(false);
      }
    };

    if (isAuthenticated) {
      checkStatus();
    } else {
      setInWatchlist(false);
      setWatchlistItem(null);
      setIsChecking(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ensName, isAuthenticated]);

  const handleToggleWatchlist = async () => {
    if (!isAuthenticated) {
      setShowSignInModal(true);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      if (inWatchlist && watchlistItem) {
        await removeFromWatchlist(watchlistItem.id);
        setInWatchlist(false);
        setWatchlistItem(null);
      } else {
        await addToWatchlist(ensName);
        // Re-check status to get the watchlist item ID
        const result = await checkIsInWatchlist(ensName);
        setInWatchlist(result.isWatching);
        setWatchlistItem(result.watchlistEntry);
      }
    } catch (err: any) {
      console.error('Watchlist toggle error:', err);
      setError(err?.message || 'Failed to update watchlist');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <button
        onClick={handleToggleWatchlist}
        disabled={isLoading || isChecking}
        className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
          inWatchlist
            ? 'bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 border border-yellow-500/30'
            : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {isLoading || isChecking ? (
          <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
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
        ) : (
          <svg
            className="w-5 h-5"
            fill={inWatchlist ? 'currentColor' : 'none'}
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
        )}
        <span className="text-sm">
          {inWatchlist ? 'Watching' : 'Add to Watchlist'}
        </span>
      </button>

      {error && (
        <div className="mt-2">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      <SignInModal
        isOpen={showSignInModal}
        onClose={() => setShowSignInModal(false)}
      />
    </>
  );
}
