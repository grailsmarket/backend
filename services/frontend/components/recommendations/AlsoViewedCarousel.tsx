'use client';

import { useAlsoViewed } from '@/hooks/useRecommendations';
import Link from 'next/link';
import { formatEther } from 'viem';
import { useState } from 'react';

interface AlsoViewedCarouselProps {
  currentName: string;
}

export function AlsoViewedCarousel({ currentName }: AlsoViewedCarouselProps) {
  const { data, isLoading, error } = useAlsoViewed(currentName, 12);
  const [scrollPosition, setScrollPosition] = useState(0);

  if (error || isLoading) {
    return null; // Fail silently on name detail page
  }

  const names = data?.data.names || [];

  if (names.length === 0) {
    return null; // Don't show if no recommendations
  }

  const scroll = (direction: 'left' | 'right') => {
    const container = document.getElementById('also-viewed-scroll');
    if (!container) return;

    const scrollAmount = 300;
    const newPosition = direction === 'left'
      ? scrollPosition - scrollAmount
      : scrollPosition + scrollAmount;

    container.scrollTo({ left: newPosition, behavior: 'smooth' });
    setScrollPosition(newPosition);
  };

  return (
    <section className="bg-gray-900/50 rounded-xl p-6 border border-gray-800">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white">Collectors Also Viewed</h2>
          <p className="text-gray-400 text-sm mt-1">
            Names viewed by collectors who looked at {currentName}
          </p>
        </div>

        {/* Scroll Controls */}
        {names.length > 3 && (
          <div className="flex gap-2">
            <button
              onClick={() => scroll('left')}
              className="p-2 bg-gray-800 hover:bg-gray-700 rounded-lg border border-gray-700 transition"
              aria-label="Scroll left"
            >
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <button
              onClick={() => scroll('right')}
              className="p-2 bg-gray-800 hover:bg-gray-700 rounded-lg border border-gray-700 transition"
              aria-label="Scroll right"
            >
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Scrollable Carousel */}
      <div
        id="also-viewed-scroll"
        className="flex gap-4 overflow-x-auto scrollbar-hide scroll-smooth pb-2"
        style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
      >
        {names.map((name) => {
          const hasListing = name.listings && name.listings.length > 0;
          const price = hasListing ? name.listings[0].price : null;

          return (
            <Link
              key={name.id}
              href={`/names/${name.name}`}
              className="flex-shrink-0 w-64 bg-gray-800/50 rounded-lg border border-gray-700 hover:border-purple-500 hover:bg-gray-800 transition group p-4"
            >
              {/* Name */}
              <div className="mb-3">
                <div className="font-semibold text-lg text-white group-hover:text-purple-400 transition truncate">
                  {name.name}
                </div>
              </div>

              {/* Stats Row */}
              <div className="flex items-center gap-3 mb-3 text-sm text-gray-400">
                {/* Views */}
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

                {/* Votes */}
                {(name.upvotes > 0 || name.downvotes > 0) && (
                  <span className="flex items-center gap-1">
                    <span className="text-green-400">↑{name.upvotes}</span>
                  </span>
                )}
              </div>

              {/* Clubs */}
              {name.clubs && name.clubs.length > 0 && (
                <div className="mb-3">
                  <div className="flex flex-wrap gap-1">
                    {name.clubs.slice(0, 2).map((club) => (
                      <span
                        key={club}
                        className="px-2 py-1 bg-purple-500/20 text-purple-300 text-xs rounded"
                      >
                        {club}
                      </span>
                    ))}
                    {name.clubs.length > 2 && (
                      <span className="px-2 py-1 bg-gray-700 text-gray-400 text-xs rounded">
                        +{name.clubs.length - 2}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Price / Offer */}
              <div className="border-t border-gray-700 pt-3">
                {hasListing ? (
                  <div>
                    <div className="text-xs text-gray-400 mb-1">Listed for</div>
                    <div className="font-semibold text-white">
                      {parseFloat(formatEther(BigInt(price))).toFixed(3)} ETH
                    </div>
                  </div>
                ) : name.highest_offer_wei ? (
                  <div>
                    <div className="text-xs text-gray-400 mb-1">Top Offer</div>
                    <div className="font-semibold text-purple-400">
                      {parseFloat(formatEther(BigInt(name.highest_offer_wei))).toFixed(3)} ETH
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-gray-500">Not listed</div>
                )}
              </div>
            </Link>
          );
        })}
      </div>

      {/* Gradient Overlays for scroll indication */}
      <style jsx>{`
        #also-viewed-scroll::-webkit-scrollbar {
          display: none;
        }
      `}</style>
    </section>
  );
}
