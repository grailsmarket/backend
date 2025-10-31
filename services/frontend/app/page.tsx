'use client';

import { ListingGrid } from '@/components/listings/ListingGrid';
import { ListingTable } from '@/components/listings/ListingTable';
import { ViewToggle } from '@/components/listings/ViewToggle';
import { SearchPanel, SearchFilters } from '@/components/search/SearchPanel';
import { useListings, useSearchListings } from '@/hooks/useListings';
import { useState, useEffect } from 'react';

export default function Home() {
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<'price' | 'created' | 'name' | 'last_sale_price' | 'watchers_count'>('created');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');
  const [searchFilters, setSearchFilters] = useState<SearchFilters>({});
  const [isSearchPanelOpen, setIsSearchPanelOpen] = useState(true);
  const [view, setView] = useState<'grid' | 'table'>('grid');

  // Load view preference from localStorage
  useEffect(() => {
    const savedView = localStorage.getItem('marketplace-view');
    if (savedView === 'table' || savedView === 'grid') {
      setView(savedView);
    }
  }, []);

  // Save view preference to localStorage
  const handleViewChange = (newView: 'grid' | 'table') => {
    setView(newView);
    localStorage.setItem('marketplace-view', newView);
  };

  // Use search endpoint if there's a text query, length filters, character filters, clubs filter, sale filters, owner filter, showAll is enabled, or using new sort options (last_sale_price, watchers_count)
  const useSearchEndpoint = !!(searchFilters.query || searchFilters.minLength || searchFilters.maxLength || searchFilters.hasEmoji !== undefined || searchFilters.hasNumbers !== undefined || searchFilters.showAll || (searchFilters.clubs && searchFilters.clubs.length > 0) || searchFilters.owner || searchFilters.hasSales !== undefined || searchFilters.minDaysSinceLastSale || searchFilters.maxDaysSinceLastSale || sortBy === 'last_sale_price' || sortBy === 'watchers_count');

  // Use search if text/length/character/clubs filters are active, otherwise use regular listings with price filters
  const { data: searchData, isLoading: searchLoading, error: searchError } = useSearchListings(
    searchFilters.query || '',
    {
      page,
      limit: 12,
      sortBy: sortBy === 'created' ? undefined : sortBy,
      sortOrder: order,
      minPrice: searchFilters.minPrice,
      maxPrice: searchFilters.maxPrice,
      minLength: searchFilters.minLength,
      maxLength: searchFilters.maxLength,
      hasEmoji: searchFilters.hasEmoji,
      hasNumbers: searchFilters.hasNumbers,
      showAll: searchFilters.showAll,
      clubs: searchFilters.clubs,
      owner: searchFilters.owner,
      isExpired: searchFilters.isExpired,
      isGracePeriod: searchFilters.isGracePeriod,
      isPremiumPeriod: searchFilters.isPremiumPeriod,
      expiringWithinDays: searchFilters.expiringWithinDays,
      hasSales: searchFilters.hasSales,
      minDaysSinceLastSale: searchFilters.minDaysSinceLastSale,
      maxDaysSinceLastSale: searchFilters.maxDaysSinceLastSale,
    },
    useSearchEndpoint
  );

  const { data: listingsData, isLoading: listingsLoading, error: listingsError } = useListings(
    {
      page,
      limit: 12,
      status: 'active',
      sort: sortBy,
      order,
      minPrice: searchFilters.minPrice,
      maxPrice: searchFilters.maxPrice,
    },
    !useSearchEndpoint
  );

  const data = useSearchEndpoint ? searchData : listingsData;
  const isLoading = useSearchEndpoint ? searchLoading : listingsLoading;
  const error = useSearchEndpoint ? searchError : listingsError;

  const isSearchActive = !!(searchFilters.query || searchFilters.minPrice || searchFilters.maxPrice || searchFilters.minLength || searchFilters.maxLength || searchFilters.hasEmoji !== undefined || searchFilters.hasNumbers !== undefined || searchFilters.showAll || (searchFilters.clubs && searchFilters.clubs.length > 0) || searchFilters.owner || searchFilters.hasSales !== undefined || searchFilters.minDaysSinceLastSale || searchFilters.maxDaysSinceLastSale || sortBy === 'last_sale_price' || sortBy === 'watchers_count');

  const handleSearch = (filters: SearchFilters) => {
    setSearchFilters(filters);
    setPage(1); // Reset to first page on new search
  };

  return (
    <div>
      {/* Hero Section */}


      {/* Main Content with Sidebar */}
      <div className="flex flex-col lg:flex-row gap-8">
        {/* Mobile Search Toggle */}
        <div className="lg:hidden mb-4">
          <button
            onClick={() => setIsSearchPanelOpen(!isSearchPanelOpen)}
            className="bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-700 hover:border-purple-500 transition flex items-center gap-2"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            {isSearchPanelOpen ? 'Hide Filters' : 'Show Filters'}
          </button>
        </div>

        {/* Search Panel - Left Sidebar */}
        <aside className={`${isSearchPanelOpen ? 'block' : 'hidden'} lg:block lg:w-80 flex-shrink-0`}>
          <div className="sticky top-4">
            <SearchPanel
              onSearch={handleSearch}
              isOpen={isSearchPanelOpen}
              onClose={() => setIsSearchPanelOpen(false)}
            />
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0">
          {/* Sort Controls and View Toggle */}
          {!isSearchActive && (
            <section className="mb-8">
              <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
                <div className="flex gap-4">
                  <select
                    value={sortBy}
                    onChange={(e) => setSortBy(e.target.value as any)}
                    className="bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
                  >
                    <option value="created">Recently Listed</option>
                    <option value="price">Price</option>
                    <option value="name">Name</option>
                    <option value="last_sale_price">Last Sale Price</option>
                    <option value="watchers_count">Watchers Count</option>
                  </select>
                  <button
                    onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
                    className="bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-700 hover:border-purple-500 transition"
                  >
                    {order === 'asc' ? '↑' : '↓'}
                  </button>
                </div>
                <div className="flex items-center gap-4">
                  {/* Pagination */}
                  {data?.pagination && data.pagination.totalPages > 1 && (
                    <div className="flex items-center gap-2">
                      <span className="text-gray-400 text-sm">
                        Page {page} of {data.pagination.totalPages}
                      </span>
                      <button
                        onClick={() => setPage(page - 1)}
                        disabled={!data.pagination.hasPrev}
                        className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition border border-gray-700"
                      >
                        ←
                      </button>
                      <button
                        onClick={() => setPage(page + 1)}
                        disabled={!data.pagination.hasNext}
                        className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition border border-gray-700"
                      >
                        →
                      </button>
                    </div>
                  )}
                  <ViewToggle view={view} onViewChange={handleViewChange} />
                </div>
              </div>
            </section>
          )}

          {/* Results Header with View Toggle and Pagination for Search */}
          {isSearchActive && (
            <div className="mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
              <div className="text-gray-400">
                {data?.listings && data.listings.length > 0 ? (
                  <p>Found {data.pagination.total} results</p>
                ) : !isLoading && (
                  <p>No results found</p>
                )}
              </div>
              <div className="flex items-center gap-4">
                {/* Pagination */}
                {data?.pagination && data.pagination.totalPages > 1 && (
                  <div className="flex items-center gap-2">
                    <span className="text-gray-400 text-sm">
                      Page {page} of {data.pagination.totalPages}
                    </span>
                    <button
                      onClick={() => setPage(page - 1)}
                      disabled={!data.pagination.hasPrev}
                      className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition border border-gray-700"
                    >
                      ←
                    </button>
                    <button
                      onClick={() => setPage(page + 1)}
                      disabled={!data.pagination.hasNext}
                      className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition border border-gray-700"
                    >
                      →
                    </button>
                  </div>
                )}
                <ViewToggle view={view} onViewChange={handleViewChange} />
              </div>
            </div>
          )}

          {/* Listings View */}
          {error && (
            <div className="text-center py-12">
              <p className="text-red-400 text-lg">Error loading listings</p>
            </div>
          )}

          {view === 'grid' ? (
            <ListingGrid listings={data?.listings || []} loading={isLoading} />
          ) : (
            <ListingTable listings={data?.listings || []} loading={isLoading} />
          )}
        </main>
      </div>
    </div>
  );
}
