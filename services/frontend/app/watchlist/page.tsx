'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import { SearchPanel, SearchFilters } from '@/components/search/SearchPanel';
import { WatchlistTable } from '@/components/watchlist/WatchlistTable';
import { useWatchlistSearch } from '@/hooks/useWatchlistSearch';

export default function WatchlistPage() {
  const { isAuthenticated, isHydrated } = useAuth();
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({});
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(true);

  // Redirect if not authenticated (only after hydration completes)
  useEffect(() => {
    if (isHydrated && !isAuthenticated) {
      router.push('/');
    }
  }, [isHydrated, isAuthenticated, router]);

  // Convert SearchFilters to API-compatible format
  const apiFilters = {
    minPrice: searchFilters.minPrice,
    maxPrice: searchFilters.maxPrice,
    minLength: searchFilters.minLength,
    maxLength: searchFilters.maxLength,
    hasEmoji: searchFilters.hasEmoji,
    hasNumbers: searchFilters.hasNumbers,
    clubs: searchFilters.clubs,
    isExpired: searchFilters.isExpired,
    isGracePeriod: searchFilters.isGracePeriod,
    isPremiumPeriod: searchFilters.isPremiumPeriod,
    expiringWithinDays: searchFilters.expiringWithinDays,
    hasSales: searchFilters.hasSales,
    minDaysSinceLastSale: searchFilters.minDaysSinceLastSale,
    maxDaysSinceLastSale: searchFilters.maxDaysSinceLastSale,
  };

  const { data, isLoading, error } = useWatchlistSearch(
    {
      q: searchFilters.query || '*',
      page,
      limit: 20,
      filters: apiFilters,
    },
    isHydrated && isAuthenticated // Only enable after hydration
  );

  const handleSearch = (filters: SearchFilters) => {
    setSearchFilters(filters);
    setPage(1); // Reset to first page on new search
  };

  const handleClearFilters = () => {
    setSearchFilters({});
    setPage(1);
  };

  const isSearchActive = !!(
    searchFilters.query ||
    searchFilters.minPrice ||
    searchFilters.maxPrice ||
    searchFilters.minLength ||
    searchFilters.maxLength ||
    searchFilters.hasEmoji !== undefined ||
    searchFilters.hasNumbers !== undefined ||
    (searchFilters.clubs && searchFilters.clubs.length > 0) ||
    searchFilters.isExpired !== undefined ||
    searchFilters.isGracePeriod !== undefined ||
    searchFilters.isPremiumPeriod !== undefined ||
    searchFilters.expiringWithinDays ||
    searchFilters.hasSales !== undefined ||
    searchFilters.minDaysSinceLastSale ||
    searchFilters.maxDaysSinceLastSale
  );

  // Show loading state while hydrating
  if (!isHydrated) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="flex items-center justify-center py-12">
          <div className="flex items-center gap-3 text-gray-400">
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
            <span>Loading...</span>
          </div>
        </div>
      </div>
    );
  }

  // Hide page if not authenticated (redirect will happen via useEffect)
  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">My Watchlist</h1>
        <p className="text-gray-400">
          Track your favorite ENS names and get notified of important events
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Search Panel - Sidebar on desktop, collapsible on mobile */}
        <div className="lg:col-span-1">
          <button
            onClick={() => setIsSearchPanelOpen(!isSearchPanelOpen)}
            className="lg:hidden w-full mb-4 px-4 py-2 bg-gray-800 rounded-lg text-white font-medium flex items-center justify-between"
          >
            <span>Filters {isSearchActive && '(Active)'}</span>
            <svg
              className={`w-5 h-5 transition-transform ${isSearchPanelOpen ? 'rotate-180' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          <div className={`${isSearchPanelOpen ? 'block' : 'hidden lg:block'}`}>
            <SearchPanel
              onSearch={handleSearch}
              isOpen={isSearchPanelOpen}
              onClose={() => setIsSearchPanelOpen(false)}
            />
          </div>
        </div>

        {/* Results */}
        <div className="lg:col-span-3 space-y-6">
          {/* Active Filters Display */}
          {isSearchActive && (
            <div className="bg-gray-800 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-white">Active Filters</h3>
                <button
                  onClick={handleClearFilters}
                  className="text-xs text-red-400 hover:text-red-300 transition"
                >
                  Clear All
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {searchFilters.query && (
                  <span className="px-3 py-1 bg-purple-500/20 text-purple-400 text-sm rounded-full">
                    Query: {searchFilters.query}
                  </span>
                )}
                {searchFilters.minPrice && (
                  <span className="px-3 py-1 bg-blue-500/20 text-blue-400 text-sm rounded-full">
                    Min: {(parseFloat(searchFilters.minPrice) / 1e18).toFixed(2)} ETH
                  </span>
                )}
                {searchFilters.maxPrice && (
                  <span className="px-3 py-1 bg-blue-500/20 text-blue-400 text-sm rounded-full">
                    Max: {(parseFloat(searchFilters.maxPrice) / 1e18).toFixed(2)} ETH
                  </span>
                )}
                {searchFilters.minLength && (
                  <span className="px-3 py-1 bg-green-500/20 text-green-400 text-sm rounded-full">
                    Min Length: {searchFilters.minLength}
                  </span>
                )}
                {searchFilters.maxLength && (
                  <span className="px-3 py-1 bg-green-500/20 text-green-400 text-sm rounded-full">
                    Max Length: {searchFilters.maxLength}
                  </span>
                )}
                {searchFilters.hasNumbers !== undefined && (
                  <span className="px-3 py-1 bg-yellow-500/20 text-yellow-400 text-sm rounded-full">
                    {searchFilters.hasNumbers ? 'Has' : 'No'} Numbers
                  </span>
                )}
                {searchFilters.hasEmoji !== undefined && (
                  <span className="px-3 py-1 bg-yellow-500/20 text-yellow-400 text-sm rounded-full">
                    {searchFilters.hasEmoji ? 'Has' : 'No'} Emoji
                  </span>
                )}
                {searchFilters.clubs && searchFilters.clubs.length > 0 && (
                  <span className="px-3 py-1 bg-indigo-500/20 text-indigo-400 text-sm rounded-full">
                    Clubs: {searchFilters.clubs.join(', ')}
                  </span>
                )}
                {searchFilters.hasSales !== undefined && (
                  <span className="px-3 py-1 bg-orange-500/20 text-orange-400 text-sm rounded-full">
                    {searchFilters.hasSales ? 'Has' : 'No'} Sales
                  </span>
                )}
              </div>
            </div>
          )}

          {/* Results Count */}
          {data && (
            <div className="text-gray-400 text-sm">
              Found {data.data.pagination.total} result{data.data.pagination.total !== 1 ? 's' : ''}
            </div>
          )}

          {/* Table */}
          {error ? (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-6">
              <p className="text-red-400">Failed to load watchlist</p>
            </div>
          ) : (
            <WatchlistTable
              items={data?.data.results || []}
              isLoading={isLoading}
            />
          )}

          {/* Pagination */}
          {data && data.data.pagination.totalPages > 1 && (
            <div className="flex items-center justify-center gap-4">
              <button
                onClick={() => setPage(page - 1)}
                disabled={!data.data.pagination.hasPrev}
                className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition"
              >
                Previous
              </button>
              <span className="text-gray-400">
                Page {data.data.pagination.page} of {data.data.pagination.totalPages}
              </span>
              <button
                onClick={() => setPage(page + 1)}
                disabled={!data.data.pagination.hasNext}
                className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition"
              >
                Next
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
