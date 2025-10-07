'use client';

import { useState } from 'react';

export interface SearchFilters {
  query?: string;
  minPrice?: string;
  maxPrice?: string;
  minLength?: number;
  maxLength?: number;
  hasEmoji?: boolean;
  hasNumbers?: boolean;
  showAll?: boolean; // true = all names, false/undefined = active listings only
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
  const [showAll, setShowAll] = useState(false);

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
    setShowAll(false);
    onSearch({});
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
          <label className="flex items-center space-x-3 cursor-pointer">
            <div className="relative">
              <select
                value={hasEmoji === undefined ? 'any' : hasEmoji ? 'true' : 'false'}
                onChange={(e) => setHasEmoji(e.target.value === 'any' ? undefined : e.target.value === 'true')}
                className="bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none appearance-none pr-8"
              >
                <option value="any">Any</option>
                <option value="true">With Emoji 😀</option>
                <option value="false">No Emoji</option>
              </select>
            </div>
          </label>
          <label className="flex items-center space-x-3 cursor-pointer">
            <div className="relative">
              <select
                value={hasNumbers === undefined ? 'any' : hasNumbers ? 'true' : 'false'}
                onChange={(e) => setHasNumbers(e.target.value === 'any' ? undefined : e.target.value === 'true')}
                className="bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none appearance-none pr-8"
              >
                <option value="any">Any</option>
                <option value="true">With Numbers (0-9)</option>
                <option value="false">No Numbers</option>
              </select>
            </div>
          </label>
        </div>
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
      {(query || minPrice || maxPrice || minLength || maxLength || hasEmoji !== undefined || hasNumbers !== undefined) && (
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
          </div>
        </div>
      )}
    </div>
  );
}
