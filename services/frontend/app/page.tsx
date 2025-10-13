'use client';

import { ListingGrid } from '@/components/listings/ListingGrid';
import { ListingTable } from '@/components/listings/ListingTable';
import { ViewToggle } from '@/components/listings/ViewToggle';
import { SearchPanel, SearchFilters } from '@/components/search/SearchPanel';
import { useListings, useSearchListings } from '@/hooks/useListings';
import { useState, useEffect } from 'react';

export default function Home() {
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<'price' | 'created' | 'name'>('created');
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

  // Only use search endpoint if there's a text query, length filters, character filters, or showAll is enabled
  const useSearchEndpoint = !!(searchFilters.query || searchFilters.minLength || searchFilters.maxLength || searchFilters.hasEmoji !== undefined || searchFilters.hasNumbers !== undefined || searchFilters.showAll);

  // Use search if text/length/character filters are active, otherwise use regular listings with price filters
  const { data: searchData, isLoading: searchLoading, error: searchError } = useSearchListings(
    searchFilters.query || '',
    {
      page,
      limit: 12,
      minPrice: searchFilters.minPrice,
      maxPrice: searchFilters.maxPrice,
      minLength: searchFilters.minLength,
      maxLength: searchFilters.maxLength,
      hasEmoji: searchFilters.hasEmoji,
      hasNumbers: searchFilters.hasNumbers,
      showAll: searchFilters.showAll,
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

  const isSearchActive = !!(searchFilters.query || searchFilters.minPrice || searchFilters.maxPrice || searchFilters.minLength || searchFilters.maxLength || searchFilters.hasEmoji !== undefined || searchFilters.hasNumbers !== undefined || searchFilters.showAll);

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
                  </select>
                  <button
                    onClick={() => setOrder(order === 'asc' ? 'desc' : 'asc')}
                    className="bg-gray-800 text-white px-4 py-2 rounded-lg border border-gray-700 hover:border-purple-500 transition"
                  >
                    {order === 'asc' ? '↑' : '↓'}
                  </button>
                </div>
                <ViewToggle view={view} onViewChange={handleViewChange} />
              </div>
            </section>
          )}

          {/* Results Header with View Toggle for Search */}
          {isSearchActive && (
            <div className="mb-6 flex justify-between items-center">
              <div className="text-gray-400">
                {data?.listings && data.listings.length > 0 ? (
                  <p>Found {data.pagination.total} results</p>
                ) : !isLoading && (
                  <p>No results found</p>
                )}
              </div>
              <ViewToggle view={view} onViewChange={handleViewChange} />
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

          {/* Pagination */}
          {data?.pagination && data.pagination.totalPages > 1 && (
            <div className="mt-12 flex justify-center gap-2">
              <button
                onClick={() => setPage(page - 1)}
                disabled={!data.pagination.hasPrev}
                className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition"
              >
                Previous
              </button>
              <span className="px-4 py-2 text-gray-400">
                Page {page} of {data.pagination.totalPages}
              </span>
              <button
                onClick={() => setPage(page + 1)}
                disabled={!data.pagination.hasNext}
                className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition"
              >
                Next
              </button>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
