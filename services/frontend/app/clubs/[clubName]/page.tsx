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
  floor_price_wei: string | null;
  floor_price_currency: string | null;
  total_sales_count: number;
  total_sales_volume_wei: string;
  last_floor_update: string | null;
  last_sales_update: string | null;
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
      {/* Breadcrumb */}
      <div className="mb-6">
        <div className="flex items-center gap-2 text-sm text-gray-400">
          <Link href="/clubs" className="hover:text-purple-400 transition">
            Clubs
          </Link>
          <span>/</span>
          <span className="text-white">{clubName}</span>
        </div>
      </div>

      {/* Header with Title and Description */}
      {data?.club && (
        <>
          <div className="mb-6">
            <h1 className="text-4xl font-bold text-white mb-2">{data.club.name}</h1>
            {data.club.description && (
              <p className="text-gray-400 text-lg">{data.club.description}</p>
            )}
          </div>

          {/* Stats Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {/* Total Members */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
              <div className="flex items-center gap-2 mb-1">
                <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
                <p className="text-gray-400 text-sm">Members</p>
              </div>
              <p className="text-white text-2xl font-bold">{data.club.member_count}</p>
            </div>

            {/* Floor Price */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
              <div className="flex items-center gap-2 mb-1">
                <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                </svg>
                <p className="text-gray-400 text-sm">Floor Price</p>
              </div>
              {data.club.floor_price_wei ? (
                <p className="text-white text-2xl font-bold">
                  {(parseFloat(data.club.floor_price_wei) / 1e18).toFixed(3)} ETH
                </p>
              ) : (
                <p className="text-gray-600 text-2xl font-bold">—</p>
              )}
            </div>

            {/* Total Sales */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
              <div className="flex items-center gap-2 mb-1">
                <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                </svg>
                <p className="text-gray-400 text-sm">Total Sales</p>
              </div>
              <p className="text-white text-2xl font-bold">{data.club.total_sales_count}</p>
            </div>

            {/* Total Volume */}
            <div className="bg-gray-800 rounded-lg border border-gray-700 p-4">
              <div className="flex items-center gap-2 mb-1">
                <svg className="h-5 w-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
                </svg>
                <p className="text-gray-400 text-sm">Total Volume</p>
              </div>
              {data.club.total_sales_volume_wei && parseFloat(data.club.total_sales_volume_wei) > 0 ? (
                <p className="text-white text-2xl font-bold">
                  {(parseFloat(data.club.total_sales_volume_wei) / 1e18).toFixed(1)} ETH
                </p>
              ) : (
                <p className="text-gray-600 text-2xl font-bold">—</p>
              )}
            </div>
          </div>
        </>
      )}

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
