'use client';

import { useState, useEffect } from 'react';
import { votesAPI, LeaderboardEntry } from '@/services/api/votes';
import Link from 'next/link';
import { formatEther } from 'viem';

export default function LeaderboardPage() {
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [sortBy, setSortBy] = useState<'upvotes' | 'netScore' | 'downvotes'>('netScore');
  const limit = 20;

  useEffect(() => {
    const fetchLeaderboard = async () => {
      setLoading(true);
      setError(null);

      try {
        const data = await votesAPI.getLeaderboard({
          page,
          limit,
          sortBy,
        });

        setLeaderboard(data.leaderboard);
        setTotalPages(data.pagination.totalPages);
      } catch (err: any) {
        console.error('Error fetching leaderboard:', err);
        setError(err.message || 'Failed to load leaderboard');
      } finally {
        setLoading(false);
      }
    };

    fetchLeaderboard();
  }, [page, sortBy]);

  const handleSortChange = (newSortBy: 'upvotes' | 'netScore' | 'downvotes') => {
    setSortBy(newSortBy);
    setPage(1); // Reset to first page when changing sort
  };

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-4xl font-bold text-white mb-2">Vote Leaderboard</h1>
        <p className="text-gray-400">Top voted ENS names by the community</p>
      </div>

      {/* Sort Controls */}
      <div className="mb-6 flex gap-3">
        <button
          onClick={() => handleSortChange('netScore')}
          className={`px-4 py-2 rounded-lg font-semibold transition ${
            sortBy === 'netScore'
              ? 'bg-purple-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Net Score
        </button>
        <button
          onClick={() => handleSortChange('upvotes')}
          className={`px-4 py-2 rounded-lg font-semibold transition ${
            sortBy === 'upvotes'
              ? 'bg-purple-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Most Upvotes
        </button>
        <button
          onClick={() => handleSortChange('downvotes')}
          className={`px-4 py-2 rounded-lg font-semibold transition ${
            sortBy === 'downvotes'
              ? 'bg-purple-600 text-white'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
          }`}
        >
          Most Downvotes
        </button>
      </div>

      {/* Loading State */}
      {loading && (
        <div className="flex justify-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500"></div>
        </div>
      )}

      {/* Error State */}
      {error && (
        <div className="bg-red-900/20 border border-red-700 rounded-lg p-4 mb-6">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {/* Leaderboard Table */}
      {!loading && !error && (
        <>
          <div className="bg-gray-800 rounded-lg overflow-hidden border border-gray-700">
            <table className="w-full">
              <thead className="bg-gray-900">
                <tr>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Rank
                  </th>
                  <th className="px-6 py-4 text-left text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Name
                  </th>
                  <th className="px-6 py-4 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Score
                  </th>
                  <th className="px-6 py-4 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Upvotes
                  </th>
                  <th className="px-6 py-4 text-center text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Downvotes
                  </th>
                  <th className="px-6 py-4 text-right text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Price
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-700">
                {leaderboard.map((entry, index) => {
                  const rank = (page - 1) * limit + index + 1;
                  const hasListing = !!entry.activeListing;

                  return (
                    <tr
                      key={entry.id}
                      className="hover:bg-gray-750 transition-colors"
                    >
                      {/* Rank */}
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          {rank <= 3 ? (
                            <span className="text-2xl">
                              {rank === 1 ? '🥇' : rank === 2 ? '🥈' : '🥉'}
                            </span>
                          ) : (
                            <span className="text-gray-400 font-semibold">
                              #{rank}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Name */}
                      <td className="px-6 py-4">
                        <Link
                          href={`/names/${entry.name}`}
                          className="text-white font-semibold hover:text-purple-400 transition-colors"
                        >
                          {entry.name}
                        </Link>
                      </td>

                      {/* Net Score */}
                      <td className="px-6 py-4 text-center">
                        <span
                          className={`font-bold text-lg ${
                            entry.netScore > 0
                              ? 'text-green-400'
                              : entry.netScore < 0
                              ? 'text-red-400'
                              : 'text-gray-400'
                          }`}
                        >
                          {entry.netScore > 0 ? '+' : ''}
                          {entry.netScore}
                        </span>
                      </td>

                      {/* Upvotes */}
                      <td className="px-6 py-4 text-center">
                        <span className="text-green-400 font-semibold">
                          {entry.upvotes}
                        </span>
                      </td>

                      {/* Downvotes */}
                      <td className="px-6 py-4 text-center">
                        <span className="text-red-400 font-semibold">
                          {entry.downvotes}
                        </span>
                      </td>

                      {/* Price */}
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        {hasListing ? (
                          <div className="flex items-center justify-end gap-1">
                            <span className="text-white font-semibold">
                              {parseFloat(formatEther(BigInt(entry.activeListing!.price_wei))).toFixed(3)}
                            </span>
                            <span className="text-gray-400 text-sm">ETH</span>
                          </div>
                        ) : (
                          <span className="text-gray-500 text-sm">Not listed</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-between">
              <button
                onClick={() => setPage(page - 1)}
                disabled={page === 1}
                className="px-4 py-2 bg-gray-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600 transition"
              >
                Previous
              </button>

              <span className="text-gray-400">
                Page {page} of {totalPages}
              </span>

              <button
                onClick={() => setPage(page + 1)}
                disabled={page === totalPages}
                className="px-4 py-2 bg-gray-700 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-600 transition"
              >
                Next
              </button>
            </div>
          )}

          {/* Empty State */}
          {leaderboard.length === 0 && (
            <div className="text-center py-12">
              <p className="text-gray-400 text-lg">No votes yet. Be the first to vote!</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
