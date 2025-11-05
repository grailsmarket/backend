'use client';

import { TrendingSection } from '@/components/trending/TrendingSection';

export default function HomePage() {
  return (
    <div className="max-w-[1600px] mx-auto px-4 py-8">
      {/* Trending Sections */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <TrendingSection
          title="Most Viewed"
          type="views"
          period="24h"
          limit={7}
          icon={
            <svg className="w-6 h-6 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          }
        />
        <TrendingSection
          title="Top Sales"
          type="sales"
          period="7d"
          limit={7}
          icon={
            <svg className="w-6 h-6 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          }
        />
        <TrendingSection
          title="🔥 Trending Names"
          type="composite"
          period="24h"
          limit={7}
          icon={
            <div className="text-3xl">🔥</div>
          }
        />
      </div>
    </div>
  );
}
