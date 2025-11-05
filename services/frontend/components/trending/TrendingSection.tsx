'use client';

import Link from 'next/link';
import { useTrending, TrendingType, TrendingPeriod } from '@/hooks/useTrending';
import { formatEther } from 'viem';

interface TrendingSectionProps {
  title: string;
  type: TrendingType;
  period?: TrendingPeriod;
  limit?: number;
  icon?: React.ReactNode;
}

export function TrendingSection({
  title,
  type,
  period = '24h',
  limit = 6,
  icon,
}: TrendingSectionProps) {
  const { data, isLoading, error } = useTrending(type, period, limit);

  if (error) {
    return null; // Fail silently on homepage
  }

  if (isLoading) {
    return (
      <section className="bg-gray-900/50 rounded-xl p-6 border border-gray-800">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            {icon}
            <h2 className="text-2xl font-bold text-white">{title}</h2>
          </div>
        </div>
        <div className="space-y-3">
          {[...Array(limit)].map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="h-16 bg-gray-800 rounded-lg"></div>
            </div>
          ))}
        </div>
      </section>
    );
  }

  const names = data?.data.names || [];

  if (names.length === 0) {
    return null; // Don't show if no data
  }

  return (
    <section className="bg-gray-900/50 rounded-xl p-6 border border-gray-800 hover:border-gray-700 transition">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          {icon}
          <h2 className="text-2xl font-bold text-white">{title}</h2>
        </div>
        <Link
          href={`/trending?type=${type}&period=${period}`}
          className="text-purple-400 hover:text-purple-300 text-sm font-medium transition"
        >
          View All →
        </Link>
      </div>

      {/* Trending List */}
      <div className="space-y-3">
        {names.map((name, index) => {
          const hasListing = name.listings && name.listings.length > 0;
          const price = hasListing ? name.listings[0].price : null;

          return (
            <Link
              key={name.id}
              href={`/names/${name.name}`}
              className="flex items-center justify-between p-4 bg-gray-800/50 rounded-lg border border-gray-700 hover:border-purple-500 hover:bg-gray-800 transition group"
            >
              {/* Left: Rank and Name */}
              <div className="flex items-center gap-4 flex-1 min-w-0">
                <span className="text-2xl font-bold text-gray-600 w-8 flex-shrink-0">
                  #{index + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-white group-hover:text-purple-400 transition truncate">
                    {name.name}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-sm text-gray-400">
                    {/* Trending Metric */}
                    {name.trending_metrics && (
                      <TrendingMetric type={type} metrics={name.trending_metrics} />
                    )}
                    {/* View Count */}
                    {name.view_count > 0 && (
                      <span className="flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                        </svg>
                        {name.view_count}
                      </span>
                    )}
                    {/* Watchers */}
                    {name.watchers_count > 0 && (
                      <span className="flex items-center gap-1">
                        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                        </svg>
                        {name.watchers_count}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {/* Right: Price/Action */}
              <div className="flex-shrink-0 text-right">
                {hasListing ? (
                  <div>
                    <div className="text-sm text-gray-400">Listed</div>
                    <div className="font-semibold text-white">
                      {parseFloat(formatEther(BigInt(price))).toFixed(3)} ETH
                    </div>
                  </div>
                ) : name.highest_offer_wei ? (
                  <div>
                    <div className="text-sm text-gray-400">Top Offer</div>
                    <div className="font-semibold text-purple-400">
                      {parseFloat(formatEther(BigInt(name.highest_offer_wei))).toFixed(3)} ETH
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">No listing</div>
                )}
              </div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function TrendingMetric({ type, metrics }: { type: TrendingType; metrics: any }) {
  switch (type) {
    case 'views':
      return <span>{metrics.period_views} views</span>;
    case 'watchlist':
      return <span>{metrics.period_additions} watching</span>;
    case 'votes':
      return <span>{metrics.period_votes} votes</span>;
    case 'sales':
      return <span>{metrics.period_sales} sales</span>;
    case 'offers':
      return <span>{metrics.period_offers} offers</span>;
    case 'composite':
      return <span>{Math.round(metrics.trending_score)} score</span>;
    default:
      return null;
  }
}
