'use client';

import { useState, useEffect } from 'react';
import { votesAPI } from '@/services/api/votes';
import { useAuth } from '@/hooks/useAuth';

interface VoteButtonsProps {
  ensName: string;
  initialUpvotes: number;
  initialDownvotes: number;
  initialNetScore: number;
  userVote?: number | null;
}

export function VoteButtons({
  ensName,
  initialUpvotes,
  initialDownvotes,
  initialNetScore,
  userVote: initialUserVote,
}: VoteButtonsProps) {
  const { token, isAuthenticated } = useAuth();
  const [upvotes, setUpvotes] = useState(initialUpvotes);
  const [downvotes, setDownvotes] = useState(initialDownvotes);
  const [netScore, setNetScore] = useState(initialNetScore);
  const [userVote, setUserVote] = useState<number | null>(initialUserVote ?? null);
  const [isVoting, setIsVoting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Update state when props change or when auth state changes
  useEffect(() => {
    setUpvotes(initialUpvotes);
    setDownvotes(initialDownvotes);
    setNetScore(initialNetScore);
    setUserVote(initialUserVote ?? null);
  }, [initialUpvotes, initialDownvotes, initialNetScore, initialUserVote, isAuthenticated]);

  const handleVote = async (voteValue: number) => {
    if (!token) {
      setError('Please sign in to vote');
      return;
    }

    // Prevent double-clicking the same vote
    if (isVoting) {
      return;
    }

    setError(null);
    setIsVoting(true);

    try {
      // Determine the vote to cast
      // If clicking the same vote, remove it (vote = 0)
      // Otherwise, cast the new vote
      const newVote = userVote === voteValue ? 0 : voteValue;

      // Optimistic update
      const prevUpvotes = upvotes;
      const prevDownvotes = downvotes;
      const prevNetScore = netScore;
      const prevUserVote = userVote;

      // Update UI optimistically
      let upvoteDelta = 0;
      let downvoteDelta = 0;

      // Remove old vote
      if (userVote === 1) {
        upvoteDelta -= 1;
      } else if (userVote === -1) {
        downvoteDelta -= 1;
      }

      // Add new vote
      if (newVote === 1) {
        upvoteDelta += 1;
      } else if (newVote === -1) {
        downvoteDelta += 1;
      }

      setUpvotes(upvotes + upvoteDelta);
      setDownvotes(downvotes + downvoteDelta);
      setNetScore(netScore + (newVote - (userVote || 0)));
      setUserVote(newVote === 0 ? null : newVote);

      // Cast vote via API
      const result = await votesAPI.castVote(ensName, newVote, token);

      // Update with actual server values
      setUpvotes(result.voteCounts.upvotes);
      setDownvotes(result.voteCounts.downvotes);
      setNetScore(result.voteCounts.netScore);
      setUserVote(result.vote.vote === 0 ? null : result.vote.vote);
    } catch (err: any) {
      console.error('Error casting vote:', err);
      setError(err.message || 'Failed to cast vote');

      // Revert optimistic update on error
      setUpvotes(prevUpvotes);
      setDownvotes(prevDownvotes);
      setNetScore(prevNetScore);
      setUserVote(prevUserVote);
    } finally {
      setIsVoting(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      {/* Only show upvote button if logged in */}
      {isAuthenticated && (
        <button
          onClick={() => handleVote(1)}
          disabled={isVoting}
          className={`flex items-center justify-center w-12 h-12 rounded-lg font-semibold transition ${
            userVote === 1
              ? 'bg-green-600 text-white hover:bg-green-700'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
          } ${
            isVoting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          }`}
          title={userVote === 1 ? 'Remove upvote' : 'Upvote'}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path d="M2 10.5a1.5 1.5 0 113 0v6a1.5 1.5 0 01-3 0v-6zM6 10.333v5.43a2 2 0 001.106 1.79l.05.025A4 4 0 008.943 18h5.416a2 2 0 001.962-1.608l1.2-6A2 2 0 0015.56 8H12V4a2 2 0 00-2-2 1 1 0 00-1 1v.667a4 4 0 01-.8 2.4L6.8 7.933a4 4 0 00-.8 2.4z" />
          </svg>
        </button>
      )}

      {/* Net Score Display - always visible */}
      <div className="flex flex-col items-center min-w-[60px]">
        <span className="text-xs text-gray-400">Score</span>
        <span className={`text-lg font-bold ${
          netScore > 0 ? 'text-green-400' :
          netScore < 0 ? 'text-red-400' :
          'text-gray-400'
        }`}>
          {netScore > 0 ? '+' : ''}{netScore}
        </span>
      </div>

      {/* Only show downvote button if logged in */}
      {isAuthenticated && (
        <button
          onClick={() => handleVote(-1)}
          disabled={isVoting}
          className={`flex items-center justify-center w-12 h-12 rounded-lg font-semibold transition ${
            userVote === -1
              ? 'bg-red-600 text-white hover:bg-red-700'
              : 'bg-gray-700 text-gray-300 hover:bg-gray-600 hover:text-white'
          } ${
            isVoting ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
          }`}
          title={userVote === -1 ? 'Remove downvote' : 'Downvote'}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path d="M18 9.5a1.5 1.5 0 11-3 0v-6a1.5 1.5 0 013 0v6zM14 9.667v-5.43a2 2 0 00-1.105-1.79l-.05-.025A4 4 0 0011.055 2H5.64a2 2 0 00-1.962 1.608l-1.2 6A2 2 0 004.44 12H8v4a2 2 0 002 2 1 1 0 001-1v-.667a4 4 0 01.8-2.4l1.4-1.866a4 4 0 00.8-2.4z" />
          </svg>
        </button>
      )}

      {/* Error Display */}
      {error && (
        <div className="absolute top-full mt-2 left-0 right-0 text-red-400 text-sm bg-red-900/20 border border-red-700 rounded px-3 py-2">
          {error}
        </div>
      )}
    </div>
  );
}
