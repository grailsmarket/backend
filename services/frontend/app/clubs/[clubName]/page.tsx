'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { ListingGrid } from '@/components/listings/ListingGrid';
import { ListingTable } from '@/components/listings/ListingTable';
import { ViewToggle } from '@/components/listings/ViewToggle';
import { useParams } from 'next/navigation';

interface Club {
  name: string;
  description: string;
  member_count: number;
  created_at: string;
}

interface ClubData {
  club: Club;
  names: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export default function ClubDetailPage() {
  const params = useParams();
  const clubName = params?.clubName as string;
  const [data, setData] = useState<ClubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'grid' | 'table'>('grid');

  useEffect(() => {
    const savedView = localStorage.getItem('marketplace-view');
    if (savedView === 'table' || savedView === 'grid') {
      setView(savedView);
    }
  }, []);

  const handleViewChange = (newView: 'grid' | 'table') => {
    setView(newView);
    localStorage.setItem('marketplace-view', newView);
  };

  useEffect(() => {
    const fetchClubData = async () => {
      try {
        setLoading(true);
        setError(null);
        const response = await fetch(
          `${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api/v1'}/clubs/${clubName}?page=${page}&limit=12`
        );
        const result = await response.json();

        if (!response.ok || !result.success) {
          setError(result.error || 'Failed to load club data');
          return;
        }

        // Transform search results to match listing format expected by components
        const transformedNames = result.data.names.map((item: any) => ({
          ...item,
          ens_name: item.name,
          price_wei: item.price,
          seller_address: item.owner,
          currency_address: item.currency_address || '0x0000000000000000000000000000000000000000',
          created_at: item.listing_created_at,
          current_owner: item.owner,
        }));

        setData({
          club: result.data.club,
          names: transformedNames,
          pagination: result.data.pagination,
        });
      } catch (err) {
        console.error('Error fetching club data:', err);
        setError('Failed to load club data');
      } finally {
        setLoading(false);
      }
    };

    if (clubName) {
      fetchClubData();
    }
  }, [clubName, page]);

  if (error) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center py-12">
          <p className="text-red-400 text-lg mb-4">{error}</p>
          <Link
            href="/clubs"
            className="inline-block bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
          >
            Back to Clubs
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-2 mb-4 text-sm text-gray-400">
          <Link href="/clubs" className="hover:text-purple-400 transition">
            Clubs
          </Link>
          <span>/</span>
          <span className="text-white">{clubName}</span>
        </div>

        {data?.club && (
          <>
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-3xl font-bold text-white">{data.club.name}</h1>
              <span className="bg-purple-900/30 text-purple-400 px-4 py-2 rounded-full text-sm font-semibold border border-purple-700">
                {data.club.member_count} {data.club.member_count === 1 ? 'member' : 'members'}
              </span>
            </div>
            {data.club.description && (
              <p className="text-gray-400 text-lg">{data.club.description}</p>
            )}
          </>
        )}
      </div>

      {/* View Toggle and Pagination */}
      {data && data.names.length > 0 && (
        <div className="mb-6 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div className="text-gray-400">
            <p>Showing {data.names.length} of {data.pagination.total} names</p>
          </div>
          <div className="flex items-center gap-4">
            {/* Pagination */}
            {data.pagination.totalPages > 1 && (
              <div className="flex items-center gap-2">
                <span className="text-gray-400 text-sm">
                  Page {page} of {data.pagination.totalPages}
                </span>
                <button
                  onClick={() => setPage(page - 1)}
                  disabled={!data.pagination.hasPrev}
                  className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition border border-gray-700"
                >
                  ←
                </button>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={!data.pagination.hasNext}
                  className="px-4 py-2 bg-gray-800 text-white rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-700 transition border border-gray-700"
                >
                  →
                </button>
              </div>
            )}
            <ViewToggle view={view} onViewChange={handleViewChange} />
          </div>
        </div>
      )}

      {/* Loading State */}
      {loading && (
        <div className="text-center py-12">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto"></div>
          <p className="text-gray-400 mt-4">Loading club members...</p>
        </div>
      )}

      {/* Empty State */}
      {!loading && data && data.names.length === 0 && (
        <div className="text-center py-12 bg-gray-800 rounded-lg border border-gray-700">
          <p className="text-gray-400 mb-4">No names found in this club.</p>
          <Link
            href="/clubs"
            className="inline-block bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
          >
            Browse Other Clubs
          </Link>
        </div>
      )}

      {/* Listings View */}
      {!loading && data && data.names.length > 0 && (
        <>
          {view === 'grid' ? (
            <ListingGrid listings={data.names} loading={false} />
          ) : (
            <ListingTable listings={data.names} loading={false} />
          )}
        </>
      )}
    </div>
  );
}
