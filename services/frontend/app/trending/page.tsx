'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTrending, TrendingType, TrendingPeriod } from '@/hooks/useTrending';
import { formatEther } from 'viem';

const TRENDING_TYPES: { value: TrendingType; label: string; icon: string; description: string }[] = [
  {
    value: 'composite',
    label: 'Hot',
    icon: '🔥',
    description: 'Combined trending score across all signals'
  },
  {
    value: 'views',
    label: 'Most Viewed',
    icon: '👀',
    description: 'Names with the most views'
  },
  {
    value: 'watchlist',
    label: 'Most Watched',
    icon: '⭐',
    description: 'Recently added to watchlists'
  },
  {
    value: 'votes',
    label: 'Most Voted',
    icon: '🗳️',
    description: 'Names with the most voting activity'
  },
  {
    value: 'sales',
    label: 'Top Sales',
    icon: '💰',
    description: 'Names with recent sales'
  },
  {
    value: 'offers',
    label: 'Hot Offers',
    icon: '💎',
    description: 'Names receiving offers'
  },
];

const PERIODS: { value: TrendingPeriod; label: string }[] = [
  { value: '24h', label: '24 Hours' },
  { value: '7d', label: '7 Days' },
];

export default function TrendingPage() {
  const [selectedType, setSelectedType] = useState<TrendingType>('composite');
  const [period, setPeriod] = useState<TrendingPeriod>('24h');

  const { data, isLoading, error } = useTrending(selectedType, period, 50);

  const selectedTypeInfo = TRENDING_TYPES.find(t => t.value === selectedType);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Trending Names</h1>
        <p className="text-gray-400">
          Discover the hottest ENS names right now
        </p>
      </div>

      {/* Type Tabs */}
      <div className="mb-6">
        <div className="flex flex-wrap gap-2">
          {TRENDING_TYPES.map((type) => (
            <button
              key={type.value}
              onClick={() => setSelectedType(type.value)}
              className={`px-4 py-2 rounded-lg font-medium transition flex items-center gap-2 ${
                selectedType === type.value
                  ? 'bg-purple-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              }`}
            >
              <span>{type.icon}</span>
              <span>{type.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Period Filter */}
      <div className="mb-8 flex items-center gap-4">
        <span className="text-gray-400 text-sm">Time Period:</span>
        <div className="flex gap-2">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                period === p.value
                  ? 'bg-gray-700 text-white'
                  : 'bg-gray-800 text-gray-400 hover:bg-gray-700 hover:text-gray-300'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Description */}
      {selectedTypeInfo && (
        <div className="mb-6 p-4 bg-gray-900/50 rounded-lg border border-gray-800">
          <p className="text-gray-300">{selectedTypeInfo.description}</p>
        </div>
      )}

      {/* Loading State */}
      {isLoading && (
        <div className="space-y-3">
          {[...Array(10)].map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="h-20 bg-gray-800 rounded-lg"></div>
            </div>
          ))}
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="text-center py-12">
          <p className="text-red-400 text-lg">Error loading trending names</p>
          <p className="text-gray-500 mt-2">Please try again later</p>
        </div>
      )}

      {/* Results */}
      {!isLoading && !error && data && (
        <>
          {data.data.names.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-400 text-lg">No trending names found</p>
              <p className="text-gray-500 mt-2">Check back later for updates</p>
            </div>
          ) : (
            <div className="space-y-3">
              {data.data.names.map((name, index) => {
                const hasListing = name.listings && name.listings.length > 0;
                const price = hasListing ? name.listings[0].price : null;

                return (
                  <Link
                    key={name.id}
                    href={`/names/${name.name}`}
                    className="block p-5 bg-gray-800/50 rounded-lg border border-gray-700 hover:border-purple-500 hover:bg-gray-800 transition group"
                  >
                    <div className="flex items-center justify-between gap-4">
                      {/* Left: Rank and Name */}
                      <div className="flex items-center gap-4 flex-1 min-w-0">
                        {/* Rank */}
                        <div className="flex-shrink-0 w-12 text-center">
                          <span className={`text-2xl font-bold ${
                            index === 0 ? 'text-yellow-400' :
                            index === 1 ? 'text-gray-300' :
                            index === 2 ? 'text-amber-600' :
                            'text-gray-600'
                          }`}>
                            #{index + 1}
                          </span>
                        </div>

                        {/* Name and Details */}
                        <div className="min-w-0 flex-1">
                          <div className="font-bold text-xl text-white group-hover:text-purple-400 transition truncate">
                            {name.name}
                          </div>
                          <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-gray-400">
                            {/* Trending Metric */}
                            {name.trending_metrics && (
                              <TrendingMetric type={selectedType} metrics={name.trending_metrics} />
                            )}

                            {/* View Count */}
                            {name.view_count > 0 && (
                              <span className="flex items-center gap-1">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                </svg>
                                {name.view_count.toLocaleString()} views
                              </span>
                            )}

                            {/* Watchers */}
                            {name.watchers_count > 0 && (
                              <span className="flex items-center gap-1">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                                </svg>
                                {name.watchers_count.toLocaleString()} watching
                              </span>
                            )}

                            {/* Votes */}
                            {(name.upvotes > 0 || name.downvotes > 0) && (
                              <span className="flex items-center gap-1">
                                <span className="text-green-400">↑{name.upvotes}</span>
                                <span className="text-red-400">↓{name.downvotes}</span>
                              </span>
                            )}

                            {/* Clubs */}
                            {name.clubs && name.clubs.length > 0 && (
                              <span className="flex items-center gap-1">
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                                </svg>
                                {name.clubs[0]}
                                {name.clubs.length > 1 && ` +${name.clubs.length - 1}`}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>

                      {/* Right: Price/Action */}
                      <div className="flex-shrink-0 text-right">
                        {hasListing ? (
                          <div>
                            <div className="text-sm text-gray-400 mb-1">Listed for</div>
                            <div className="font-bold text-xl text-white">
                              {parseFloat(formatEther(BigInt(price))).toFixed(3)} ETH
                            </div>
                            <button className="mt-2 px-4 py-1.5 bg-purple-600 text-white text-sm font-medium rounded-lg hover:bg-purple-700 transition">
                              Buy Now
                            </button>
                          </div>
                        ) : name.highest_offer_wei ? (
                          <div>
                            <div className="text-sm text-gray-400 mb-1">Top Offer</div>
                            <div className="font-bold text-lg text-purple-400">
                              {parseFloat(formatEther(BigInt(name.highest_offer_wei))).toFixed(3)} ETH
                            </div>
                            <div className="mt-2 text-sm text-gray-500">Not listed</div>
                          </div>
                        ) : (
                          <div>
                            <div className="text-sm text-gray-500">Not listed</div>
                            <button className="mt-2 px-4 py-1.5 bg-gray-700 text-white text-sm font-medium rounded-lg hover:bg-gray-600 transition">
                              Make Offer
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TrendingMetric({ type, metrics }: { type: TrendingType; metrics: any }) {
  const getMetricDisplay = () => {
    switch (type) {
      case 'views':
        return `${metrics.period_views.toLocaleString()} new views`;
      case 'watchlist':
        return `${metrics.period_additions.toLocaleString()} new watchers`;
      case 'votes':
        return `${metrics.period_votes.toLocaleString()} new votes`;
      case 'sales':
        return `${metrics.period_sales.toLocaleString()} sales`;
      case 'offers':
        return `${metrics.period_offers.toLocaleString()} offers`;
      case 'composite':
        return `${Math.round(metrics.trending_score).toLocaleString()} trending score`;
      default:
        return null;
    }
  };

  const display = getMetricDisplay();
  if (!display) return null;

  return (
    <span className="px-3 py-1 bg-purple-500/20 text-purple-300 rounded-full font-medium">
      {display}
    </span>
  );
}
