'use client';

import { ProfileData } from '@/hooks/useProfile';

interface ProfileHeaderProps {
  profile: ProfileData;
}

export function ProfileHeader({ profile }: ProfileHeaderProps) {
  const { ensRecords, primaryName, address, stats } = profile;

  return (
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
        {/* Avatar and Name */}
        <div className="flex items-start gap-6 mb-6">
          {ensRecords?.avatar && (
            <img
              src={ensRecords.avatar}
              alt={`${primaryName || address} avatar`}
              className="w-24 h-24 rounded-full border-4 border-purple-500 bg-gray-900"
              onError={(e) => {
                e.currentTarget.style.display = 'none';
              }}
            />
          )}
          <div className="flex-1">
            <h1 className="text-4xl font-bold text-white mb-2">
              {primaryName || `${address.slice(0, 6)}...${address.slice(-4)}`}
            </h1>
            <p className="text-gray-400 font-mono text-sm">{address}</p>
          </div>
        </div>

        {/* ENS Records */}
        {ensRecords && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6 pb-6 border-b border-gray-700">
            {/* Left Column - Main Records */}
            <div className="space-y-4">
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
            </div>

            {/* Right Column - Social Links */}
            <div className="space-y-4">
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

              {/* ETH Address from records */}
              {ensRecords.address && (
                <div>
                  <p className="text-sm text-gray-400 mb-1">ETH Address (from records)</p>
                  <p className="text-white font-mono text-sm break-all">{ensRecords.address}</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
            <p className="text-sm text-gray-400 mb-1">Names Owned</p>
            <p className="text-2xl font-bold text-purple-400">{stats.totalNames}</p>
          </div>
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
            <p className="text-sm text-gray-400 mb-1">Active Listings</p>
            <p className="text-2xl font-bold text-green-400">{stats.listedNames}</p>
          </div>
          <div className="bg-gray-900 rounded-lg p-4 border border-gray-700">
            <p className="text-sm text-gray-400 mb-1">Total Activity</p>
            <p className="text-2xl font-bold text-blue-400">{stats.totalActivity}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
