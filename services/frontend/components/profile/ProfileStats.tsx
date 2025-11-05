'use client';

import { usePersonalStats } from '@/hooks/useAnalytics';
import { formatEther } from 'viem';
import { useState } from 'react';

interface ProfileStatsProps {
  address: string;
}

export function ProfileStats({ address }: ProfileStatsProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { data, isLoading, error } = usePersonalStats();

  // Don't show anything if there's an error or no data
  if (error || !data) {
    return null;
  }

  const stats = data.data;

  // Check if user has any activity
  const hasActivity = stats.activity.names_viewed > 0 ||
    stats.activity.names_watching > 0 ||
    stats.activity.votes_cast > 0 ||
    stats.activity.offers_made > 0 ||
    stats.activity.names_purchased > 0 ||
    stats.activity.names_sold > 0;

  if (!hasActivity) {
    return null; // Don't show if no activity
  }

  return (
    <div className="bg-gray-800/50 rounded-xl p-6 border border-gray-700 mb-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">Your Activity Stats</h2>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="text-sm text-purple-400 hover:text-purple-300 transition"
        >
          {isExpanded ? 'Show Less' : 'Show More'}
        </button>
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="h-24 bg-gray-700 rounded-lg"></div>
            </div>
          ))}
        </div>
      ) : (
        <>
          {/* Primary Stats - Always Visible */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            {/* Engagement */}
            <div className="bg-gradient-to-br from-blue-900/30 to-gray-900/50 rounded-lg p-5 border border-blue-700/50">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-blue-500/20 rounded-lg">
                  <svg className="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm text-blue-400">Names Viewed</div>
                  <div className="text-2xl font-bold text-white">{stats.activity.names_viewed}</div>
                  <div className="text-xs text-gray-400">total views</div>
                </div>
              </div>
            </div>

            {/* Watchlist */}
            <div className="bg-gradient-to-br from-purple-900/30 to-gray-900/50 rounded-lg p-5 border border-purple-700/50">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-purple-500/20 rounded-lg">
                  <svg className="w-6 h-6 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm text-purple-400">Watchlist</div>
                  <div className="text-2xl font-bold text-white">{stats.activity.names_watching}</div>
                  <div className="text-xs text-gray-400">names watching</div>
                </div>
              </div>
            </div>

            {/* Votes */}
            <div className="bg-gradient-to-br from-green-900/30 to-gray-900/50 rounded-lg p-5 border border-green-700/50">
              <div className="flex items-center gap-3 mb-3">
                <div className="p-2 bg-green-500/20 rounded-lg">
                  <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" />
                  </svg>
                </div>
                <div>
                  <div className="text-sm text-green-400">Votes Cast</div>
                  <div className="text-2xl font-bold text-white">{stats.activity.votes_cast}</div>
                  <div className="text-xs text-gray-400">total votes</div>
                </div>
              </div>
            </div>
          </div>

          {/* Secondary Stats - Expandable */}
          {isExpanded && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 pt-4 border-t border-gray-700">
              {/* Offers Made */}
              <div className="bg-gray-900/50 rounded-lg p-5 border border-gray-700">
                <div className="text-sm text-gray-400 mb-2">Offers Made</div>
                <div className="text-2xl font-bold text-white mb-1">
                  {stats.activity.offers_made}
                </div>
              </div>

              {/* Purchases */}
              <div className="bg-gray-900/50 rounded-lg p-5 border border-gray-700">
                <div className="text-sm text-gray-400 mb-2">Names Purchased</div>
                <div className="text-2xl font-bold text-white mb-1">
                  {stats.activity.names_purchased}
                </div>
              </div>

              {/* Sales */}
              <div className="bg-gray-900/50 rounded-lg p-5 border border-gray-700">
                <div className="text-sm text-gray-400 mb-2">Names Sold</div>
                <div className="text-2xl font-bold text-white mb-1">
                  {stats.activity.names_sold}
                </div>
              </div>

              {/* Owned Names */}
              <div className="bg-gray-900/50 rounded-lg p-5 border border-gray-700">
                <div className="text-sm text-gray-400 mb-2">Owned Names</div>
                <div className="text-2xl font-bold text-white">
                  {stats.portfolio.owned_names_count}
                </div>
              </div>

              {/* Active Listings */}
              {stats.portfolio.listed_names_count > 0 && (
                <div className="bg-gray-900/50 rounded-lg p-5 border border-gray-700">
                  <div className="text-sm text-gray-400 mb-2">Active Listings</div>
                  <div className="text-2xl font-bold text-white mb-1">
                    {stats.portfolio.listed_names_count}
                  </div>
                  <div className="text-sm text-purple-400">
                    {parseFloat(formatEther(BigInt(stats.portfolio.total_listing_value_wei || 0))).toFixed(3)} ETH
                  </div>
                </div>
              )}

              {/* Total Offers Received */}
              {parseFloat(stats.portfolio.total_offer_value_wei) > 0 && (
                <div className="bg-gray-900/50 rounded-lg p-5 border border-gray-700">
                  <div className="text-sm text-gray-400 mb-2">Total Offers on Portfolio</div>
                  <div className="text-2xl font-bold text-green-400">
                    {parseFloat(formatEther(BigInt(stats.portfolio.total_offer_value_wei || 0))).toFixed(3)} ETH
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
