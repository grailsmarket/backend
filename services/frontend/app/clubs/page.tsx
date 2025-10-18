'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Club {
  name: string;
  description: string;
  member_count: number;
  created_at: string;
  updated_at: string;
}

export default function ClubsPage() {
  const [clubs, setClubs] = useState<Club[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchClubs = async () => {
      try {
        setLoading(true);
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1'}/clubs`);
        const data = await response.json();

        if (data.success) {
          setClubs(data.data.clubs || []);
        }
      } catch (error) {
        console.error('Error fetching clubs:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchClubs();
  }, []);

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-4">ENS Clubs</h1>
        <p className="text-gray-400">Browse collections of curated ENS names organized by theme and category</p>
      </div>

      {loading ? (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto"></div>
          <p className="text-gray-400 mt-4">Loading clubs...</p>
        </div>
      ) : clubs.length === 0 ? (
        <div className="text-center py-12 bg-gray-800 rounded-lg border border-gray-700">
          <p className="text-gray-400 mb-4">No clubs found.</p>
          <Link
            href="/"
            className="inline-block bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
          >
            Browse ENS Names
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {clubs.map((club) => (
            <Link
              key={club.name}
              href={`/clubs/${club.name}`}
              className="bg-gray-800 rounded-lg border border-gray-700 p-6 hover:border-purple-500 transition group"
            >
              <div className="flex items-start justify-between mb-3">
                <h2 className="text-xl font-bold text-white group-hover:text-purple-400 transition">
                  {club.name}
                </h2>
                <span className="bg-purple-900/30 text-purple-400 px-3 py-1 rounded-full text-sm font-semibold">
                  {club.member_count}
                </span>
              </div>

              {club.description && (
                <p className="text-gray-400 text-sm mb-4 line-clamp-2">
                  {club.description}
                </p>
              )}

              <div className="flex items-center text-sm text-gray-500">
                <svg className="h-4 w-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                {club.member_count} {club.member_count === 1 ? 'member' : 'members'}
              </div>

              <div className="mt-4 pt-4 border-t border-gray-700">
                <span className="text-purple-400 text-sm font-semibold group-hover:text-purple-300 transition">
                  View Collection →
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
