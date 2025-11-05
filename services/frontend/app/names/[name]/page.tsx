'use client';

import { useParams } from 'next/navigation';
import { useAccount } from 'wagmi';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { OfferModal } from '@/components/offers/OfferModal';
import { CreateListingModal } from '@/components/orders/CreateListingModal';
import { OrderModal } from '@/components/orders/OrderModal';
import { ListingInfo } from '@/components/listings/ListingInfo';
import { OffersSection } from '@/components/offers/OffersSection';
import { ActivityHistory } from '@/components/activity/ActivityHistory';
import { AddToWatchlist } from '@/components/watchlist/AddToWatchlist';
import { VoteButtons } from '@/components/votes/VoteButtons';
import { AlsoViewedCarousel } from '@/components/recommendations/AlsoViewedCarousel';
import { useEnsName } from 'wagmi';
import { mainnet } from 'wagmi/chains';
import { useAuth } from '@/hooks/useAuth';

export default function NameProfile() {
  const params = useParams();
  const name = params.name as string;
  const { address } = useAccount();
  const { token } = useAuth();
  const [nameData, setNameData] = useState<any>(null);
  const [ensRecords, setEnsRecords] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [recordsLoading, setRecordsLoading] = useState(true);
  const [isOfferModalOpen, setIsOfferModalOpen] = useState(false);
  const [isListingModalOpen, setIsListingModalOpen] = useState(false);
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);

  // Resolve owner's address to ENS name
  const { data: ownerEnsName } = useEnsName({
    address: nameData?.owner as `0x${string}` | undefined,
    chainId: mainnet.id,
  });

  // Fetch name data
  useEffect(() => {
    const fetchNameData = async () => {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        // Include auth token if available to get user's vote
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/names/${name}`, {
          headers,
        });
        const data = await response.json();

        if (data.success) {
          setNameData(data.data);
        }
      } catch (error) {
        console.error('Error fetching name data:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchNameData();
  }, [name, token]);

  // Fetch ENS records from EFP API
  useEffect(() => {
    const fetchEnsRecords = async () => {
      try {
        const response = await fetch(`https://api.ethfollow.xyz/api/v1/users/${name}/details`);
        if (response.ok) {
          const data = await response.json();
          // Extract ENS records from the nested structure
          if (data.ens?.records) {
            const records = data.ens.records;
            setEnsRecords({
              avatar: records.avatar,
              name: records.name,
              description: records.description,
              email: records.email,
              url: records.url,
              location: records.location,
              twitter: records['com.twitter'],
              github: records['com.github'],
              header: records.header,
              address: data.address,
              records: records,
            });
          }
        }
      } catch (error) {
        console.error('Error fetching ENS records:', error);
      } finally {
        setRecordsLoading(false);
      }
    };

    fetchEnsRecords();
  }, [name]);

  if (loading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-12 bg-gray-800 rounded w-1/3 mb-8"></div>
          <div className="h-64 bg-gray-800 rounded"></div>
        </div>
      </div>
    );
  }

  if (!nameData) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-4">Name Not Found</h1>
          <p className="text-gray-400 mb-8">The ENS name "{name}" could not be found.</p>
          <Link href="/" className="text-purple-400 hover:text-purple-300">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  const isOwner = address && nameData.owner && address.toLowerCase() === nameData.owner.toLowerCase();

  // Check for database listing (could be Grails or OpenSea)
  const databaseListing = nameData.listings && nameData.listings.length > 0 && nameData.listings[0].status === 'active' ? {
    id: nameData.listings[0].id,
    price_wei: nameData.listings[0].price,
    currency_address: nameData.listings[0].currency_address || '0x0000000000000000000000000000000000000000',
    status: nameData.listings[0].status,
    source: nameData.listings[0].source || 'grails',
    expires_at: nameData.listings[0].expires_at,
    seller_address: nameData.listings[0].seller_address,
    order_data: nameData.listings[0].order_data,
    order_hash: nameData.listings[0].order_hash,
    created_at: nameData.listings[0].created_at,
  } : null;

  // Check for OpenSea listing from API (real-time)
  const apiOpenSeaListing = nameData.opensea_listing ? {
    id: nameData.id,
    price_wei: nameData.opensea_listing.price?.current?.value || '0',
    currency_address: nameData.opensea_listing.price?.current?.currency || '0x0000000000000000000000000000000000000000',
    status: 'active',
    source: 'opensea' as const,
    seller_address: nameData.opensea_listing.maker?.address,
    order_data: nameData.opensea_listing.protocol_data, // This is the Seaport protocol data
    order_hash: nameData.opensea_listing.order_hash,
    created_at: nameData.created_at,
  } : null;

  // Prefer database listing (could be Grails or synced OpenSea), fallback to API OpenSea listing
  const activeListing = databaseListing || apiOpenSeaListing;
  const hasListing = !!activeListing;

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Back Link */}
      <Link href="/" className="text-purple-400 hover:text-purple-300 mb-6 inline-block">
        ← Back to Search
      </Link>

      {/* Name Header with ENS Records */}
      <div className="bg-gray-800 rounded-lg p-8 mb-6 border border-gray-700 relative overflow-hidden">
        {/* Header image with gradient overlay */}
        {ensRecords?.header && (
          <div
            className="absolute top-0 left-0 right-0 max-h-80 overflow-hidden rounded-t-lg"
            style={{
              width: '100%',
              backgroundImage: `linear-gradient(to bottom, rgb(17 24 39 / 0.3), color-mix(in oklab, rgb(31 41 55) 85%, #00000000), rgb(31 41 55)), url(${ensRecords.header})`,
              backgroundSize: '100% auto',
              backgroundPosition: 'top center',
              backgroundRepeat: 'no-repeat',
              aspectRatio: '3/1',
            }}
          ></div>
        )}

        {/* Content wrapper with relative positioning to appear above header */}
        <div className="relative z-10">
        <div className="flex flex-wrap items-start justify-between gap-4 mb-4">
          <div className="flex flex-col gap-3">
            <h1 className="text-4xl font-bold text-white">{nameData.name}</h1>

            {/* Clubs under the name */}
            {nameData.clubs && nameData.clubs.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {nameData.clubs.map((club: string) => (
                  <Link
                    key={club}
                    href={`/clubs/${club}`}
                    className="px-3 py-1 bg-purple-900/30 text-purple-400 text-sm font-semibold rounded-full border border-purple-700 hover:bg-purple-900/50 hover:border-purple-600 transition"
                  >
                    {club}
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col items-end gap-3">
            {/* Vote Buttons and Stats in same row */}
            <div className="flex items-center gap-3">
              {/* View count */}
              <div className="flex items-center gap-2 px-4 py-2 bg-gray-900/50 rounded-lg border border-gray-700">
                <svg className="w-5 h-5 text-blue-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                <span className="text-gray-300 text-sm font-semibold">
                  {nameData.view_count || 0} {nameData.view_count === 1 ? 'view' : 'views'}
                </span>
              </div>

              {/* Watchers count with add to watchlist */}
              <div className="flex items-center gap-2">
                <AddToWatchlist ensName={nameData.name} />
                <div className="flex items-center gap-2 px-4 py-2 bg-gray-900/50 rounded-lg border border-gray-700">
                  <svg className="w-5 h-5 text-purple-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
                  </svg>
                  <span className="text-gray-300 text-sm font-semibold">
                    {nameData.watchers_count || 0} {nameData.watchers_count === 1 ? 'watcher' : 'watchers'}
                  </span>
                </div>
              </div>

              <VoteButtons
                ensName={nameData.name}
                initialUpvotes={nameData.upvotes || 0}
                initialDownvotes={nameData.downvotes || 0}
                initialNetScore={nameData.net_score || 0}
                userVote={nameData.user_vote}
              />
            </div>
          </div>
        </div>

        {/* Token ID */}
        <div className="mb-4 pb-4 border-b border-gray-700">
          <div>
            <span className="text-gray-400">Token ID: </span>
            <span className="text-white font-mono text-xs break-all">
              {nameData.token_id}
            </span>
          </div>
        </div>

        {/* Owner Info */}
        <div className="mb-6">
          <div>
            <span className="text-gray-400">Owned by: </span>
            {nameData.owner ? (
              <Link
                href={`/profile/${ownerEnsName || nameData.owner}`}
                className="text-purple-400 hover:text-purple-300 font-semibold transition"
              >
                {ownerEnsName || `${nameData.owner.slice(0, 6)}...${nameData.owner.slice(-4)}`}
              </Link>
            ) : (
              <span className="text-white font-mono text-sm">Unknown</span>
            )}
            {isOwner && (
              <span className="ml-2 px-2 py-1 bg-green-900/30 text-green-400 text-xs rounded-full border border-green-700">
                You
              </span>
            )}
          </div>
        </div>

        {recordsLoading ? (
          <div className="animate-pulse space-y-3">
            <div className="h-4 bg-gray-700 rounded w-3/4"></div>
            <div className="h-4 bg-gray-700 rounded w-1/2"></div>
            <div className="h-4 bg-gray-700 rounded w-2/3"></div>
          </div>
        ) : ensRecords ? (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left Column - Main Records */}
            <div className="space-y-4">
              {/* Avatar */}
              {ensRecords.avatar && (
                <div className="flex items-center gap-4">
                  <img
                    src={ensRecords.avatar}
                    alt={`${name} avatar`}
                    className="w-16 h-16 rounded-full border-2 border-purple-500"
                    onError={(e) => {
                      e.currentTarget.style.display = 'none';
                    }}
                  />
                  <div>
                    <p className="text-sm text-gray-400">Avatar</p>
                    <a
                      href={ensRecords.avatar}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-purple-400 hover:text-purple-300 text-sm break-all"
                    >
                      {ensRecords.avatar}
                    </a>
                  </div>
                </div>
              )}

              {/* Display Name */}
              {ensRecords.name && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">Display Name</p>
                  <p className="text-white">{ensRecords.name}</p>
                </div>
              )}

              {/* Description */}
              {ensRecords.description && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">Description</p>
                  <p className="text-white">{ensRecords.description}</p>
                </div>
              )}

              {/* Email */}
              {ensRecords.email && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">Email</p>
                  <a href={`mailto:${ensRecords.email}`} className="text-purple-400 hover:text-purple-300">
                    {ensRecords.email}
                  </a>
                </div>
              )}

              {/* URL */}
              {ensRecords.url && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">Website</p>
                  <a
                    href={ensRecords.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300 break-all"
                  >
                    {ensRecords.url}
                  </a>
                </div>
              )}

              {/* Location */}
              {ensRecords.location && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">Location</p>
                  <p className="text-white">{ensRecords.location}</p>
                </div>
              )}

              {/* Twitter/X */}
              {ensRecords.twitter && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">Twitter/X</p>
                  <a
                    href={`https://twitter.com/${ensRecords.twitter}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300"
                  >
                    @{ensRecords.twitter}
                  </a>
                </div>
              )}

              {/* GitHub */}
              {ensRecords.github && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">GitHub</p>
                  <a
                    href={`https://github.com/${ensRecords.github}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:text-purple-300"
                  >
                    {ensRecords.github}
                  </a>
                </div>
              )}

              {/* ETH Address */}
              {ensRecords.address && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">Ethereum Address</p>
                  <p className="text-white font-mono text-sm break-all">{ensRecords.address}</p>
                </div>
              )}
            </div>

            {/* Right Column - Additional Records */}
            {ensRecords.records && Object.keys(ensRecords.records).length > 0 && (
              <div>
                <p className="text-sm text-gray-400 mb-3">Additional Records</p>
                <div className="space-y-2">
                  {Object.entries(ensRecords.records).map(([key, value]: [string, any]) => (
                    <div key={key} className="bg-gray-900 rounded p-3 border border-gray-700">
                      <p className="text-xs text-gray-500 mb-1">{key}</p>
                      <p className="text-white text-sm break-all">{String(value)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="text-gray-400">No ENS records found for this name.</p>
        )}
        </div>
      </div>

      {/* Listing and Offers Info Section */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Show listing if active */}
        {activeListing && (
          <ListingInfo
            listing={activeListing}
            ensName={nameData.name}
            onBuyClick={() => setIsOrderModalOpen(true)}
          />
        )}

        {/* Show offers section */}
        <OffersSection ensName={nameData.name} isOwner={isOwner} />
      </div>

      {/* Activity History */}
      <div className="mb-6">
        <ActivityHistory name={nameData.name} limit={10} />
      </div>

      {/* Also Viewed Carousel */}
      {nameData.name && (
        <div className="mb-6">
          <AlsoViewedCarousel currentName={nameData.name} />
        </div>
      )}

      {/* Name Characteristics */}
      <div className="bg-gray-800 rounded-lg p-8 mb-6 border border-gray-700">
        <h2 className="text-2xl font-bold text-white mb-4">Characteristics</h2>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
            <p className="text-sm text-gray-400 mb-1">Length</p>
            <p className="text-2xl font-bold text-purple-400">
              {nameData.name.replace('.eth', '').length}
            </p>
          </div>

          <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
            <p className="text-sm text-gray-400 mb-1">Type</p>
            <p className="text-lg font-semibold text-white">
              {/^\d+$/.test(nameData.name.replace('.eth', '')) ? 'Numeric' :
               /^[a-zA-Z]+$/.test(nameData.name.replace('.eth', '')) ? 'Alpha' :
               'Alphanumeric'}
            </p>
          </div>

          <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
            <p className="text-sm text-gray-400 mb-1">Status</p>
            <p className="text-lg font-semibold text-white">
              {hasListing ? 'Listed' : 'Not Listed'}
            </p>
          </div>

          {activeListing && (
            <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
              <p className="text-sm text-gray-400 mb-1">Platform</p>
              <p className="text-lg font-semibold text-white capitalize">
                {activeListing.source}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="bg-gray-800 rounded-lg p-8 border border-gray-700">
        <h2 className="text-2xl font-bold text-white mb-6">Actions</h2>

        <div className="flex flex-col sm:flex-row gap-4">
          {!isOwner && (
            <button
              onClick={() => setIsOfferModalOpen(true)}
              className="flex-1 bg-purple-600 hover:bg-purple-700 text-white px-6 py-3 rounded-lg font-semibold transition"
            >
              Make an Offer
            </button>
          )}

          {isOwner && !hasListing && (
            <button
              onClick={() => setIsListingModalOpen(true)}
              className="flex-1 bg-green-600 hover:bg-green-700 text-white px-6 py-3 rounded-lg font-semibold transition"
            >
              Create Listing
            </button>
          )}

          <a
            href={`https://app.ens.domains/${nameData.name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex-1 bg-gray-700 hover:bg-gray-600 text-white px-6 py-3 rounded-lg font-semibold text-center transition"
          >
            View on ENS App
          </a>
        </div>
      </div>

      {/* Offer Modal */}
      {nameData && (
        <OfferModal
          isOpen={isOfferModalOpen}
          onClose={() => setIsOfferModalOpen(false)}
          ensName={nameData.name}
          tokenId={nameData.token_id}
          currentOwner={nameData.owner}
        />
      )}

      {/* Create Listing Modal */}
      {nameData && (
        <CreateListingModal
          isOpen={isListingModalOpen}
          onClose={() => setIsListingModalOpen(false)}
          tokenId={nameData.token_id}
          ensName={nameData.name}
        />
      )}

      {/* Order Modal (Buy Now) */}
      {activeListing && (
        <OrderModal
          isOpen={isOrderModalOpen}
          onClose={() => setIsOrderModalOpen(false)}
          listing={{
            ...activeListing,
            ens_name: nameData.name,
            token_id: nameData.token_id,
          }}
        />
      )}
    </div>
  );
}
