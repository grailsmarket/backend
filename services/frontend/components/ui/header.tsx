'use client';

import { useState, useEffect } from 'react';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { useAccount, useEnsName, useEnsAvatar, useDisconnect } from 'wagmi';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import { SignInModal } from '@/components/auth/SignInModal';
import { NotificationsBell } from '@/components/notifications/NotificationsBell';

export function Header() {
  const { isAuthenticated, address: authAddress, signOut, user, isHydrated } = useAuth();
  const { address, isConnected } = useAccount();
  const { openConnectModal } = useConnectModal();
  const { disconnect } = useDisconnect();
  const { data: ensName } = useEnsName({ address, chainId: 1 });
  const { data: ensAvatar } = useEnsAvatar({ name: ensName, chainId: 1 });
  const [showSignInModal, setShowSignInModal] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);

  const handleSignInClick = () => {
    if (!isConnected) {
      openConnectModal?.();
    } else {
      setShowSignInModal(true);
    }
  };

  const handleDisconnect = () => {
    setShowUserMenu(false);
    signOut();
    disconnect();
  };

  const displayName = ensName || (address ? `${address.slice(0, 6)}...${address.slice(-4)}` : '');

  return (
    <>
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-8">
              <Link href="/" className="text-2xl font-bold text-purple-500 hover:text-purple-400 transition">
                Grails
              </Link>
              <nav className="hidden md:flex space-x-6">
                <Link href="/" className="text-gray-300 hover:text-white transition">
                  Marketplace
                </Link>
                <Link href="/portfolio" className="text-gray-300 hover:text-white transition">
                  My Portfolio
                </Link>
                <Link href="/offers" className="text-gray-300 hover:text-white transition">
                  My Offers
                </Link>
              </nav>
            </div>
            <div className="flex items-center gap-3">
              {!isHydrated ? (
                /* Loading skeleton during hydration */
                <div className="px-4 py-2 bg-zinc-800 rounded-lg animate-pulse">
                  <div className="h-5 w-40 bg-zinc-700 rounded"></div>
                </div>
              ) : !isAuthenticated ? (
                /* Sign In With Ethereum Button */
                <button
                  onClick={handleSignInClick}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M11.944 17.97L4.58 13.62 11.943 24l7.37-10.38-7.372 4.35h.003zM12.056 0L4.69 12.223l7.365 4.354 7.365-4.35L12.056 0z"/>
                  </svg>
                  Sign In With Ethereum
                </button>
              ) : (
                <>
                {/* Notifications Bell */}
                <NotificationsBell />

                {/* Authenticated: Show Avatar + ENS/Address in dropdown button */}
                <div className="relative">
                  <button
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    className="flex items-center gap-2 px-3 py-2 bg-zinc-800 hover:bg-zinc-700 text-white text-sm font-medium rounded-lg transition-colors border border-zinc-700"
                  >
                    {ensAvatar ? (
                      <img
                        src={ensAvatar}
                        alt={displayName}
                        className="w-6 h-6 rounded-full"
                        onError={(e) => {
                          e.currentTarget.style.display = 'none';
                        }}
                      />
                    ) : (
                      <div className="w-6 h-6 rounded-full bg-gradient-to-br from-purple-500 to-blue-500 flex items-center justify-center">
                        <span className="text-white text-xs font-bold">
                          {displayName.slice(0, 2).toUpperCase()}
                        </span>
                      </div>
                    )}
                    <span className="text-white text-sm font-medium">{displayName}</span>
                    <svg
                      className={`w-4 h-4 transition-transform ${showUserMenu ? 'rotate-180' : ''}`}
                      fill="none"
                      stroke="currentColor"
                      viewBox="0 0 24 24"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={2}
                        d="M19 9l-7 7-7-7"
                      />
                    </svg>
                  </button>

                  {/* Dropdown Menu */}
                  {showUserMenu && (
                    <div className="absolute right-0 mt-2 w-48 bg-zinc-900 border border-zinc-800 rounded-lg shadow-xl overflow-hidden z-50">
                      <Link
                        href="/settings"
                        onClick={() => setShowUserMenu(false)}
                        className="block px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                      >
                        Settings
                      </Link>
                      <Link
                        href="/watchlist"
                        onClick={() => setShowUserMenu(false)}
                        className="block px-4 py-2 text-sm text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors"
                      >
                        Watchlist
                      </Link>
                      <hr className="border-zinc-800" />
                      <button
                        onClick={handleDisconnect}
                        className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-zinc-800 transition-colors"
                      >
                        Disconnect
                      </button>
                    </div>
                  )}
                </div>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Sign In Modal */}
      <SignInModal
        isOpen={showSignInModal}
        onClose={() => setShowSignInModal(false)}
      />
    </>
  );
}