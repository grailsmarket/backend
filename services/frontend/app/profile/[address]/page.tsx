'use client';

import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useProfile } from '@/hooks/useProfile';
import { ProfileHeader } from '@/components/profile/ProfileHeader';
import { OwnedNames } from '@/components/profile/OwnedNames';
import { ProfileActivity } from '@/components/profile/ProfileActivity';

export default function ProfilePage() {
  const params = useParams();
  const addressOrName = params.address as string;

  const { data: profile, isLoading, error } = useProfile(addressOrName);

  if (isLoading) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="animate-pulse">
          <div className="h-12 bg-gray-800 rounded w-1/3 mb-8"></div>
          <div className="h-64 bg-gray-800 rounded mb-6"></div>
          <div className="h-96 bg-gray-800 rounded"></div>
        </div>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="container mx-auto px-4 py-8">
        <div className="text-center">
          <h1 className="text-3xl font-bold text-white mb-4">Profile Not Found</h1>
          <p className="text-gray-400 mb-8">
            No profile found for "{addressOrName}"
          </p>
          <Link href="/" className="text-purple-400 hover:text-purple-300">
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto px-4 py-8">
      {/* Back Link */}
      <Link href="/" className="text-purple-400 hover:text-purple-300 mb-6 inline-block">
        ← Back to Search
      </Link>

      {/* Profile Header with ENS Records */}
      <ProfileHeader profile={profile} />

      {/* Owned Names Section */}
      <div className="mb-6">
        <OwnedNames names={profile.ownedNames} />
      </div>

      {/* Activity Feed with Live Updates */}
      <div className="mb-6">
        <ProfileActivity address={profile.address} limit={50} />
      </div>
    </div>
  );
}
