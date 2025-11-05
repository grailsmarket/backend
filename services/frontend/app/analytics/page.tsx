'use client';

import { useState } from 'react';
import {
  useMarketAnalytics,
  usePriceTrends,
  useVolumeMetrics,
  usePersonalStats,
} from '@/hooks/useAnalytics';
import { formatEther } from 'viem';
import { useAuth } from '@/hooks/useAuth';

export default function AnalyticsPage() {
  const [period, setPeriod] = useState<'24h' | '7d' | '30d' | '90d'>('7d');
  const { user } = useAuth();

  const { data: marketData, isLoading: marketLoading } = useMarketAnalytics(period);
  const { data: priceData, isLoading: priceLoading } = usePriceTrends(period);
  const { data: volumeData, isLoading: volumeLoading } = useVolumeMetrics(period, 'day');
  const { data: personalData, isLoading: personalLoading } = usePersonalStats();

  const market = marketData?.data;
  const prices = priceData?.data?.trends || [];
  const volumeMetrics = volumeData?.data?.metrics || [];
  const personal = personalData?.data;

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Market Analytics</h1>
        <p className="text-gray-400">
          Insights and statistics about the ENS marketplace
        </p>
      </div>

      {/* Period Selector */}
      <div className="mb-8 flex gap-2">
        {(['24h', '7d', '30d', '90d'] as const).map((p) => (
          <button
            key={p}
            onClick={() => setPeriod(p)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
              period === p
                ? 'bg-purple-600 text-white'
                : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
            }`}
          >
            {p === '24h' ? '24 Hours' : p === '7d' ? '7 Days' : p === '30d' ? '30 Days' : '90 Days'}
          </button>
        ))}
      </div>

      {/* Market Overview */}
      <section className="mb-8">
        <h2 className="text-2xl font-bold text-white mb-4">Market Overview</h2>
        {marketLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="animate-pulse">
                <div className="h-24 bg-gray-800 rounded-lg"></div>
              </div>
            ))}
          </div>
        ) : market ? (
          <>
            {/* Primary Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
              {/* Total Names */}
              <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
                <div className="text-sm text-gray-400 mb-1">Total Names</div>
                <div className="text-3xl font-bold text-white">
                  {market.overview.total_names.toLocaleString()}
                </div>
              </div>

              {/* Active Listings */}
              <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
                <div className="text-sm text-gray-400 mb-1">Active Listings</div>
                <div className="text-3xl font-bold text-white">
                  {market.overview.active_listings.toLocaleString()}
                </div>
              </div>

              {/* Active Offers */}
              <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
                <div className="text-sm text-gray-400 mb-1">Active Offers</div>
                <div className="text-3xl font-bold text-white">
                  {market.overview.active_offers.toLocaleString()}
                </div>
              </div>

              {/* Total Views */}
              <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
                <div className="text-sm text-gray-400 mb-1">Total Views</div>
                <div className="text-3xl font-bold text-white">
                  {market.overview.total_views.toLocaleString()}
                </div>
              </div>
            </div>

            {/* Volume Stats */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
              {/* Sales Count */}
              <div className="bg-gradient-to-br from-green-900/30 to-gray-800/50 rounded-lg p-6 border border-green-700/50">
                <div className="text-sm text-green-400 mb-1">Sales ({period})</div>
                <div className="text-3xl font-bold text-white">
                  {market.volume.sales_count.toLocaleString()}
                </div>
              </div>

              {/* Total Volume */}
              <div className="bg-gradient-to-br from-purple-900/30 to-gray-800/50 rounded-lg p-6 border border-purple-700/50">
                <div className="text-sm text-purple-400 mb-1">Total Volume</div>
                <div className="text-2xl font-bold text-white">
                  {parseFloat(formatEther(BigInt(market.volume.total_volume_wei || 0))).toFixed(2)} ETH
                </div>
              </div>

              {/* Average Price */}
              <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
                <div className="text-sm text-gray-400 mb-1">Avg Sale Price</div>
                <div className="text-2xl font-bold text-white">
                  {parseFloat(formatEther(BigInt(market.volume.avg_sale_price_wei || 0))).toFixed(3)} ETH
                </div>
              </div>

              {/* Unique Buyers */}
              <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
                <div className="text-sm text-gray-400 mb-1">Unique Buyers</div>
                <div className="text-3xl font-bold text-white">
                  {market.volume.unique_buyers.toLocaleString()}
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="text-center py-8 text-gray-400">
            Unable to load market data
          </div>
        )}
      </section>

      {/* Personal Stats (if authenticated) */}
      {user && personal && (
        <section className="mb-8">
          <h2 className="text-2xl font-bold text-white mb-4">Your Statistics</h2>
          {personalLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="animate-pulse">
                  <div className="h-24 bg-gray-800 rounded-lg"></div>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
              {/* Views */}
              <div className="bg-gradient-to-br from-blue-900/30 to-gray-800/50 rounded-lg p-6 border border-blue-700/50">
                <div className="text-sm text-blue-400 mb-1">Names Viewed</div>
                <div className="text-3xl font-bold text-white">
                  {personal.activity.names_viewed.toLocaleString()}
                </div>
              </div>

              {/* Watchlist */}
              <div className="bg-gradient-to-br from-purple-900/30 to-gray-800/50 rounded-lg p-6 border border-purple-700/50">
                <div className="text-sm text-purple-400 mb-1">Watchlist</div>
                <div className="text-3xl font-bold text-white">
                  {personal.activity.names_watching.toLocaleString()}
                </div>
              </div>

              {/* Votes */}
              <div className="bg-gradient-to-br from-green-900/30 to-gray-800/50 rounded-lg p-6 border border-green-700/50">
                <div className="text-sm text-green-400 mb-1">Votes Cast</div>
                <div className="text-3xl font-bold text-white">
                  {personal.activity.votes_cast.toLocaleString()}
                </div>
              </div>

              {/* Offers */}
              <div className="bg-gradient-to-br from-yellow-900/30 to-gray-800/50 rounded-lg p-6 border border-yellow-700/50">
                <div className="text-sm text-yellow-400 mb-1">Offers Made</div>
                <div className="text-3xl font-bold text-white">
                  {personal.activity.offers_made.toLocaleString()}
                </div>
              </div>

              {/* Purchases */}
              <div className="bg-gradient-to-br from-pink-900/30 to-gray-800/50 rounded-lg p-6 border border-pink-700/50">
                <div className="text-sm text-pink-400 mb-1">Purchases</div>
                <div className="text-3xl font-bold text-white">
                  {personal.activity.names_purchased.toLocaleString()}
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {/* Price Trends */}
      <section className="mb-8">
        <h2 className="text-2xl font-bold text-white mb-4">Price Trends</h2>
        {priceLoading ? (
          <div className="animate-pulse">
            <div className="h-64 bg-gray-800 rounded-lg"></div>
          </div>
        ) : prices.length > 0 ? (
          <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700 overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="text-left text-gray-400 text-sm border-b border-gray-700">
                  <th className="pb-3">Date</th>
                  <th className="pb-3">Sales</th>
                  <th className="pb-3">Volume (ETH)</th>
                  <th className="pb-3">Avg Price (ETH)</th>
                  <th className="pb-3">Min Price (ETH)</th>
                  <th className="pb-3">Max Price (ETH)</th>
                </tr>
              </thead>
              <tbody>
                {prices.map((trend, index) => (
                  <tr
                    key={index}
                    className="text-white border-b border-gray-700/50 hover:bg-gray-700/30 transition"
                  >
                    <td className="py-3">{new Date(trend.date).toLocaleDateString()}</td>
                    <td className="py-3 font-semibold">{trend.sales_count}</td>
                    <td className="py-3 text-green-400">
                      {parseFloat(formatEther(BigInt(trend.volume_wei || 0))).toFixed(3)}
                    </td>
                    <td className="py-3">
                      {parseFloat(formatEther(BigInt(Math.floor(parseFloat(trend.avg_price_wei || 0))))).toFixed(3)}
                    </td>
                    <td className="py-3 text-gray-400">
                      {parseFloat(formatEther(BigInt(trend.min_price_wei || 0))).toFixed(3)}
                    </td>
                    <td className="py-3 text-purple-400">
                      {parseFloat(formatEther(BigInt(trend.max_price_wei || 0))).toFixed(3)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-gray-400">
            No price trend data available for this period
          </div>
        )}
      </section>

      {/* Activity Metrics */}
      {market && (
        <section className="mb-8">
          <h2 className="text-2xl font-bold text-white mb-4">Activity ({period})</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
            <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
              <div className="text-sm text-gray-400 mb-1">Views</div>
              <div className="text-3xl font-bold text-blue-400">
                {market.activity.views.toLocaleString()}
              </div>
            </div>

            <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
              <div className="text-sm text-gray-400 mb-1">Watchlist Adds</div>
              <div className="text-3xl font-bold text-purple-400">
                {market.activity.watchlist_adds.toLocaleString()}
              </div>
            </div>

            <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
              <div className="text-sm text-gray-400 mb-1">Votes</div>
              <div className="text-3xl font-bold text-green-400">
                {market.activity.votes.toLocaleString()}
              </div>
            </div>

            <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
              <div className="text-sm text-gray-400 mb-1">Offers</div>
              <div className="text-3xl font-bold text-yellow-400">
                {market.activity.offers.toLocaleString()}
              </div>
            </div>

            <div className="bg-gray-800/50 rounded-lg p-6 border border-gray-700">
              <div className="text-sm text-gray-400 mb-1">New Listings</div>
              <div className="text-3xl font-bold text-pink-400">
                {market.activity.listings.toLocaleString()}
              </div>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
