'use client';

import Link from 'next/link';
import { ProfileData } from '@/hooks/useProfile';
import { formatEther } from 'viem';

interface OwnedNamesProps {
  names: ProfileData['ownedNames'];
}

export function OwnedNames({ names }: OwnedNamesProps) {
  if (names.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-8 border border-gray-700">
        <h2 className="text-2xl font-bold text-white mb-4">Owned Names</h2>
        <p className="text-gray-400">No ENS names owned by this address.</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg p-8 border border-gray-700">
      <h2 className="text-2xl font-bold text-white mb-6">
        Owned Names ({names.length})
      </h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {names.map((name) => (
          <Link
            key={name.id}
            href={`/names/${name.name}`}
            className="bg-gray-900 rounded-lg p-4 border border-gray-700 hover:border-purple-500 transition group"
          >
            {/* Name */}
            <div className="mb-3">
              <h3 className="text-lg font-semibold text-white group-hover:text-purple-400 transition truncate">
                {name.name}
              </h3>
              <p className="text-xs text-gray-500 font-mono truncate">
                Token ID: {name.token_id.slice(0, 10)}...
              </p>
            </div>

            {/* Status Badge */}
            <div className="mb-3">
              {name.is_listed && name.active_listing ? (
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-green-900/30 text-green-400 text-sm rounded-full border border-green-700">
                  <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse"></span>
                  Listed
                </div>
              ) : (
                <div className="inline-flex items-center gap-2 px-3 py-1 bg-gray-700/30 text-gray-400 text-sm rounded-full border border-gray-600">
                  Not Listed
                </div>
              )}
            </div>

            {/* Price (if listed) */}
            {name.active_listing && (
              <div className="mb-2">
                <p className="text-sm text-gray-400 mb-1">Price</p>
                <p className="text-xl font-bold text-white">
                  {formatEther(BigInt(name.active_listing.price_wei))} ETH
                </p>
                <p className="text-xs text-gray-500 capitalize">
                  on {name.active_listing.source}
                </p>
              </div>
            )}

            {/* Expiry Date */}
            {name.expiry_date && (
              <div className="mt-3 pt-3 border-t border-gray-700">
                <p className="text-xs text-gray-400">
                  Expires: {new Date(name.expiry_date).toLocaleDateString()}
                </p>
              </div>
            )}
          </Link>
        ))}
      </div>
    </div>
  );
}
