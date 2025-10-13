'use client';

import { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function SettingsPage() {
  const { user, isAuthenticated, updateProfile } = useAuth();
  const router = useRouter();

  const [formData, setFormData] = useState({
    email: '',
    telegram: '',
    discord: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Redirect if not authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      router.push('/');
    }
  }, [isAuthenticated, router]);

  // Load user data
  useEffect(() => {
    if (user) {
      setFormData({
        email: user.email || '',
        telegram: user.telegram || '',
        discord: user.discord || '',
      });
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setSuccess(false);

    try {
      // Only send fields that have values
      const updates: any = {};
      if (formData.email) updates.email = formData.email;
      if (formData.telegram) updates.telegram = formData.telegram;
      if (formData.discord) updates.discord = formData.discord;

      await updateProfile(updates);
      setSuccess(true);

      // Clear success message after 3 seconds
      setTimeout(() => setSuccess(false), 3000);
    } catch (err: any) {
      console.error('Update profile error:', err);
      setError(err?.message || 'Failed to update profile');
    } finally {
      setIsLoading(false);
    }
  };

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div className="container mx-auto px-4 py-8 max-w-4xl">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Settings</h1>
        <p className="text-zinc-400">Manage your profile and notification preferences</p>
      </div>

      {/* Profile Section */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 mb-6">
        <h2 className="text-xl font-semibold text-white mb-4">Profile Information</h2>

        {/* Wallet Address (read-only) */}
        <div className="mb-6">
          <label className="block text-sm font-medium text-zinc-400 mb-2">
            Wallet Address
          </label>
          <div className="px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-white font-mono text-sm">
            {user?.address}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Email */}
          <div>
            <label htmlFor="email" className="block text-sm font-medium text-zinc-400 mb-2">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={formData.email}
              onChange={(e) => setFormData({ ...formData, email: e.target.value })}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="your@email.com"
            />
            {user?.emailVerified === false && formData.email && (
              <p className="mt-1 text-xs text-yellow-500">Email not verified</p>
            )}
          </div>

          {/* Telegram */}
          <div>
            <label htmlFor="telegram" className="block text-sm font-medium text-zinc-400 mb-2">
              Telegram Username
            </label>
            <input
              id="telegram"
              type="text"
              value={formData.telegram}
              onChange={(e) => setFormData({ ...formData, telegram: e.target.value })}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="@username"
            />
          </div>

          {/* Discord */}
          <div>
            <label htmlFor="discord" className="block text-sm font-medium text-zinc-400 mb-2">
              Discord Username
            </label>
            <input
              id="discord"
              type="text"
              value={formData.discord}
              onChange={(e) => setFormData({ ...formData, discord: e.target.value })}
              className="w-full px-4 py-3 bg-zinc-800 border border-zinc-700 rounded-lg text-white placeholder-zinc-500 focus:outline-none focus:border-blue-500 transition-colors"
              placeholder="username#0000"
            />
          </div>

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}

          {/* Success Message */}
          {success && (
            <div className="p-3 bg-green-500/10 border border-green-500/20 rounded-lg">
              <p className="text-sm text-green-400">Profile updated successfully!</p>
            </div>
          )}

          {/* Submit Button */}
          <button
            type="submit"
            disabled={isLoading}
            className="w-full px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-zinc-700 disabled:cursor-not-allowed text-white font-medium rounded-lg transition-colors"
          >
            {isLoading ? 'Saving...' : 'Save Changes'}
          </button>
        </form>
      </div>

      {/* Notification Preferences Info */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6">
        <h2 className="text-xl font-semibold text-white mb-4">Notification Preferences</h2>
        <p className="text-zinc-400 text-sm mb-4">
          Notification preferences are managed per ENS name in your watchlist. Visit the{' '}
          <Link href="/watchlist" className="text-blue-500 hover:text-blue-400">
            Watchlist page
          </Link>{' '}
          to customize notifications for specific names.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="p-3 bg-zinc-800/50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <svg className="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-sm font-medium text-white">Sale Notifications</span>
            </div>
            <p className="text-xs text-zinc-500">Get notified when names sell</p>
          </div>
          <div className="p-3 bg-zinc-800/50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <svg className="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-sm font-medium text-white">Offer Notifications</span>
            </div>
            <p className="text-xs text-zinc-500">Get notified of new offers</p>
          </div>
          <div className="p-3 bg-zinc-800/50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <svg className="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-sm font-medium text-white">Listing Notifications</span>
            </div>
            <p className="text-xs text-zinc-500">Get notified when listed</p>
          </div>
          <div className="p-3 bg-zinc-800/50 rounded-lg">
            <div className="flex items-center gap-2 mb-1">
              <svg className="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
              </svg>
              <span className="text-sm font-medium text-white">Price Changes</span>
            </div>
            <p className="text-xs text-zinc-500">Track price movements</p>
          </div>
        </div>
      </div>
    </div>
  );
}
