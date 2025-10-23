'use client';

import { useState, useEffect } from 'react';

export interface SearchFilters {
  query?: string;
  minPrice?: string;
  maxPrice?: string;
  minLength?: number;
  maxLength?: number;
  hasEmoji?: boolean;
  hasNumbers?: boolean;
  showAll?: boolean; // true = all names, false/undefined = active listings only
  clubs?: string[]; // Filter by clubs
  isExpired?: boolean;
  isGracePeriod?: boolean;
  isPremiumPeriod?: boolean;
  expiringWithinDays?: number;
  hasSales?: boolean;
  minDaysSinceLastSale?: number;
  maxDaysSinceLastSale?: number;
}

interface Club {
  name: string;
  description: string;
  member_count: number;
}

interface SearchPanelProps {
  onSearch: (filters: SearchFilters) => void;
  isOpen?: boolean;
  onClose?: () => void;
}

export function SearchPanel({ onSearch, isOpen = true, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState('');
  const [minPrice, setMinPrice] = useState('');
  const [maxPrice, setMaxPrice] = useState('');
  const [minLength, setMinLength] = useState<number | ''>('');
  const [maxLength, setMaxLength] = useState<number | ''>('');
  const [hasEmoji, setHasEmoji] = useState<boolean | undefined>(undefined);
  const [hasNumbers, setHasNumbers] = useState<boolean | undefined>(undefined);
  const [showAll, setShowAll] = useState(true);
  const [selectedClubs, setSelectedClubs] = useState<string[]>([]);
  const [clubs, setClubs] = useState<Club[]>([]);
  const [clubsLoading, setClubsLoading] = useState(true);
  const [showClubsFilter, setShowClubsFilter] = useState(false);
  const [showExpirationFilter, setShowExpirationFilter] = useState(false);
  const [isExpired, setIsExpired] = useState<boolean | undefined>(undefined);
  const [isGracePeriod, setIsGracePeriod] = useState<boolean | undefined>(undefined);
  const [isPremiumPeriod, setIsPremiumPeriod] = useState<boolean | undefined>(undefined);
  const [expiringWithinDays, setExpiringWithinDays] = useState<number | ''>('');
  const [showSaleHistoryFilter, setShowSaleHistoryFilter] = useState(false);
  const [hasSales, setHasSales] = useState<boolean | undefined>(undefined);
  const [minDaysSinceLastSale, setMinDaysSinceLastSale] = useState<number | ''>('');
  const [maxDaysSinceLastSale, setMaxDaysSinceLastSale] = useState<number | ''>('');

  // Fetch clubs on mount
  useEffect(() => {
    async function fetchClubs() {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1'}/clubs`);
        const data = await response.json();
        if (data.success) {
          setClubs(data.data.clubs || []);
        }
      } catch (error) {
        console.error('Failed to fetch clubs:', error);
      } finally {
        setClubsLoading(false);
      }
    }
    fetchClubs();
  }, []);

  const handleSearch = () => {
    const filters: SearchFilters = {
      query: query.trim() || undefined,
      minPrice: minPrice ? (parseFloat(minPrice) * 1e18).toString() : undefined,
      maxPrice: maxPrice ? (parseFloat(maxPrice) * 1e18).toString() : undefined,
      minLength: minLength || undefined,
      maxLength: maxLength || undefined,
      hasEmoji,
      hasNumbers,
      showAll,
      clubs: selectedClubs.length > 0 ? selectedClubs : undefined,
      isExpired,
      isGracePeriod,
      isPremiumPeriod,
      expiringWithinDays: expiringWithinDays || undefined,
      hasSales,
      minDaysSinceLastSale: minDaysSinceLastSale || undefined,
      maxDaysSinceLastSale: maxDaysSinceLastSale || undefined,
    };
    onSearch(filters);
  };

  const handleClear = () => {
    setQuery('');
    setMinPrice('');
    setMaxPrice('');
    setMinLength('');
    setMaxLength('');
    setHasEmoji(undefined);
    setHasNumbers(undefined);
    setShowAll(true);
    setSelectedClubs([]);
    setIsExpired(undefined);
    setIsGracePeriod(undefined);
    setIsPremiumPeriod(undefined);
    setExpiringWithinDays('');
    setHasSales(undefined);
    setMinDaysSinceLastSale('');
    setMaxDaysSinceLastSale('');
    onSearch({});
  };

  const toggleClub = (clubName: string) => {
    setSelectedClubs(prev =>
      prev.includes(clubName)
        ? prev.filter(c => c !== clubName)
        : [...prev, clubName]
    );
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="bg-gray-800 rounded-lg p-6 space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold text-white">Search & Filters</h2>
        {onClose && (
          <button
            onClick={onClose}
            className="lg:hidden text-gray-400 hover:text-white transition"
          >
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Search Input */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Search ENS Names
        </label>
        <div className="relative">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="e.g., vitalik, abc123..."
            className="w-full bg-gray-900 text-white px-4 py-2 pl-10 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
          />
          <svg className="absolute left-3 top-2.5 h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </div>
      </div>

      {/* Show Filter */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Show
        </label>
        <select
          value={showAll ? 'all' : 'listings'}
          onChange={(e) => setShowAll(e.target.value === 'all')}
          className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
        >
          <option value="listings">Active Listings Only</option>
          <option value="all">All Names</option>
        </select>
      </div>

      {/* Price Range */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Price Range (ETH)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <input
            type="number"
            value={minPrice}
            onChange={(e) => setMinPrice(e.target.value)}
            placeholder="Min"
            step="0.01"
            min="0"
            className="bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
          />
          <input
            type="number"
            value={maxPrice}
            onChange={(e) => setMaxPrice(e.target.value)}
            placeholder="Max"
            step="0.01"
            min="0"
            className="bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Name Length */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Name Length (characters)
        </label>
        <div className="grid grid-cols-2 gap-3">
          <input
            type="number"
            value={minLength}
            onChange={(e) => setMinLength(e.target.value ? parseInt(e.target.value) : '')}
            placeholder="Min"
            min="1"
            className="bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
          />
          <input
            type="number"
            value={maxLength}
            onChange={(e) => setMaxLength(e.target.value ? parseInt(e.target.value) : '')}
            placeholder="Max"
            min="1"
            className="bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
          />
        </div>
      </div>

      {/* Character Type Filters */}
      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Character Types
        </label>
        <div className="space-y-2">
          <select
            value={hasEmoji === undefined ? 'any' : hasEmoji ? 'true' : 'false'}
            onChange={(e) => setHasEmoji(e.target.value === 'any' ? undefined : e.target.value === 'true')}
            className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
          >
            <option value="any">Any</option>
            <option value="true">With Emoji 😀</option>
            <option value="false">No Emoji</option>
          </select>
          <select
            value={hasNumbers === undefined ? 'any' : hasNumbers ? 'true' : 'false'}
            onChange={(e) => setHasNumbers(e.target.value === 'any' ? undefined : e.target.value === 'true')}
            className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
          >
            <option value="any">Any</option>
            <option value="true">With Numbers (0-9)</option>
            <option value="false">No Numbers</option>
          </select>
        </div>
      </div>

      {/* Club Filters */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-300">
            Filter by Clubs
          </label>
          <button
            onClick={() => setShowClubsFilter(!showClubsFilter)}
            className="text-purple-400 hover:text-purple-300 transition flex items-center gap-1"
          >
            <span className="text-xs font-semibold">
              {showClubsFilter ? 'Hide' : 'Show'}
            </span>
            <svg
              className={`h-4 w-4 transition-transform ${showClubsFilter ? 'rotate-45' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
        {showClubsFilter && (
          <>
            {clubsLoading ? (
              <div className="text-gray-400 text-sm">Loading clubs...</div>
            ) : clubs.length > 0 ? (
              <div className="max-h-48 overflow-y-auto space-y-2 bg-gray-900 rounded-lg p-3 border border-gray-700">
                {clubs.map((club) => (
                  <label key={club.name} className="flex items-start space-x-3 cursor-pointer hover:bg-gray-800 p-2 rounded transition">
                    <input
                      type="checkbox"
                      checked={selectedClubs.includes(club.name)}
                      onChange={() => toggleClub(club.name)}
                      className="mt-1 h-4 w-4 rounded border-gray-600 bg-gray-700 text-purple-600 focus:ring-purple-500 focus:ring-offset-gray-900"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white font-medium">{club.name}</div>
                      {club.description && (
                        <div className="text-xs text-gray-400 mt-0.5">{club.description}</div>
                      )}
                      <div className="text-xs text-gray-500 mt-0.5">{club.member_count} members</div>
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <div className="text-gray-400 text-sm">No clubs available</div>
            )}
          </>
        )}
      </div>

      {/* Expiration Filters */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-300">
            Expiration Filters
          </label>
          <button
            onClick={() => setShowExpirationFilter(!showExpirationFilter)}
            className="text-purple-400 hover:text-purple-300 transition flex items-center gap-1"
          >
            <span className="text-xs font-semibold">
              {showExpirationFilter ? 'Hide' : 'Show'}
            </span>
            <svg
              className={`h-4 w-4 transition-transform ${showExpirationFilter ? 'rotate-45' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
        {showExpirationFilter && (
          <>
            <div className="space-y-2">
              <select
                value={isExpired === undefined ? 'any' : isExpired ? 'true' : 'false'}
                onChange={(e) => setIsExpired(e.target.value === 'any' ? undefined : e.target.value === 'true')}
                className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
              >
                <option value="any">Any Expiration Status</option>
                <option value="true">Expired Names</option>
                <option value="false">Active Names</option>
              </select>
              <select
                value={isGracePeriod === undefined ? 'any' : isGracePeriod ? 'true' : 'false'}
                onChange={(e) => setIsGracePeriod(e.target.value === 'any' ? undefined : e.target.value === 'true')}
                className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
              >
                <option value="any">Any Grace Period Status</option>
                <option value="true">In Grace Period (90 days)</option>
                <option value="false">Not In Grace Period</option>
              </select>
              <select
                value={isPremiumPeriod === undefined ? 'any' : isPremiumPeriod ? 'true' : 'false'}
                onChange={(e) => setIsPremiumPeriod(e.target.value === 'any' ? undefined : e.target.value === 'true')}
                className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
              >
                <option value="any">Any Premium Period Status</option>
                <option value="true">In Premium Period (Dutch auction)</option>
                <option value="false">Not In Premium Period</option>
              </select>
            </div>

            {/* Expiring Within Days */}
            <div className="mt-3">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Expiring Within (Days)
              </label>
              <input
                type="number"
                value={expiringWithinDays}
                onChange={(e) => setExpiringWithinDays(e.target.value ? parseInt(e.target.value) : '')}
                placeholder="e.g., 30 for names expiring within 30 days"
                min="0"
                className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
              />
              <p className="text-xs text-gray-400 mt-1">Only shows active names expiring within the specified days</p>
            </div>
          </>
        )}
      </div>

      {/* Sale History Filters */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="block text-sm font-medium text-gray-300">
            Sale History Filters
          </label>
          <button
            onClick={() => setShowSaleHistoryFilter(!showSaleHistoryFilter)}
            className="text-purple-400 hover:text-purple-300 transition flex items-center gap-1"
          >
            <span className="text-xs font-semibold">
              {showSaleHistoryFilter ? 'Hide' : 'Show'}
            </span>
            <svg
              className={`h-4 w-4 transition-transform ${showSaleHistoryFilter ? 'rotate-45' : ''}`}
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
        {showSaleHistoryFilter && (
          <>
            <div className="space-y-2">
              <select
                value={hasSales === undefined ? 'any' : hasSales ? 'true' : 'false'}
                onChange={(e) => setHasSales(e.target.value === 'any' ? undefined : e.target.value === 'true')}
                className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
              >
                <option value="any">Any Sale History</option>
                <option value="true">Has Been Sold Before</option>
                <option value="false">Never Been Sold</option>
              </select>
            </div>

            {/* Days Since Last Sale Range */}
            <div className="mt-3">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Days Since Last Sale
              </label>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="number"
                  value={minDaysSinceLastSale}
                  onChange={(e) => setMinDaysSinceLastSale(e.target.value ? parseInt(e.target.value) : '')}
                  placeholder="Min"
                  min="0"
                  className="bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
                />
                <input
                  type="number"
                  value={maxDaysSinceLastSale}
                  onChange={(e) => setMaxDaysSinceLastSale(e.target.value ? parseInt(e.target.value) : '')}
                  placeholder="Max"
                  min="0"
                  className="bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
                />
              </div>
              <p className="text-xs text-gray-400 mt-1">
                Filter by how long ago the name was last sold (e.g., 7-30 for sold 1-4 weeks ago)
              </p>
            </div>
          </>
        )}
      </div>

      {/* Action Buttons */}
      <div className="flex gap-3 pt-2">
        <button
          onClick={handleSearch}
          className="flex-1 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg font-semibold transition"
        >
          Apply Filters
        </button>
        <button
          onClick={handleClear}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-white rounded-lg transition"
        >
          Clear
        </button>
      </div>

      {/* Active Filters Display */}
      {(query || minPrice || maxPrice || minLength || maxLength || hasEmoji !== undefined || hasNumbers !== undefined || selectedClubs.length > 0 || isExpired !== undefined || isGracePeriod !== undefined || isPremiumPeriod !== undefined || expiringWithinDays) && (
        <div className="pt-4 border-t border-gray-700">
          <p className="text-xs text-gray-400 mb-2">Active Filters:</p>
          <div className="flex flex-wrap gap-2">
            {query && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                Query: {query}
              </span>
            )}
            {minPrice && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                Min: {minPrice} ETH
              </span>
            )}
            {maxPrice && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                Max: {maxPrice} ETH
              </span>
            )}
            {minLength && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                Min Length: {minLength}
              </span>
            )}
            {maxLength && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                Max Length: {maxLength}
              </span>
            )}
            {hasEmoji !== undefined && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                {hasEmoji ? 'With Emoji 😀' : 'No Emoji'}
              </span>
            )}
            {hasNumbers !== undefined && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                {hasNumbers ? 'With Numbers' : 'No Numbers'}
              </span>
            )}
            {selectedClubs.map(club => (
              <span key={club} className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                Club: {club}
              </span>
            ))}
            {isExpired !== undefined && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                {isExpired ? 'Expired' : 'Active'}
              </span>
            )}
            {isGracePeriod !== undefined && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                {isGracePeriod ? 'In Grace Period' : 'Not In Grace Period'}
              </span>
            )}
            {isPremiumPeriod !== undefined && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                {isPremiumPeriod ? 'In Premium Period' : 'Not In Premium Period'}
              </span>
            )}
            {expiringWithinDays && (
              <span className="text-xs bg-purple-900/50 text-purple-300 px-2 py-1 rounded">
                Expiring within {expiringWithinDays} days
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
