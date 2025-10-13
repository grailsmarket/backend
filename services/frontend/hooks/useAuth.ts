'use client';

import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SiweMessage } from 'siwe';
import { useAccount, useSignMessage } from 'wagmi';

interface User {
  id: number;
  address: string;
  email: string | null;
  emailVerified: boolean;
  telegram: string | null;
  discord: string | null;
  createdAt: string;
  lastSignIn: string;
}

interface AuthStore {
  token: string | null;
  user: User | null;
  setAuth: (token: string, user: User) => void;
  clearAuth: () => void;
  updateUser: (user: Partial<User>) => void;
}

// Zustand store with persistence
const useAuthStore = create<AuthStore>()(
  persist(
    (set) => ({
      token: null,
      user: null,
      setAuth: (token, user) => set({ token, user }),
      clearAuth: () => set({ token: null, user: null }),
      updateUser: (updates) =>
        set((state) => ({
          user: state.user ? { ...state.user, ...updates } : null,
        })),
    }),
    {
      name: 'grails-auth',
      skipHydration: false,
    }
  )
);

export function useAuth() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { token, user, setAuth, clearAuth, updateUser } = useAuthStore();
  const [isHydrated, setIsHydrated] = useState(false);
  const [hasHydrated, setHasHydrated] = useState(false);

  const isAuthenticated = !!token && !!user;

  // Wait for Zustand persist to rehydrate
  useEffect(() => {
    const unsubFinishHydration = useAuthStore.persist.onFinishHydration(() => {
      setHasHydrated(true);
    });

    // If already hydrated
    if (useAuthStore.persist.hasHydrated()) {
      setHasHydrated(true);
    }

    return unsubFinishHydration;
  }, []);

  // Mark client-side hydration complete
  useEffect(() => {
    setIsHydrated(hasHydrated);
  }, [hasHydrated]);

  // Verify token is still valid on mount/rehydration
  useEffect(() => {
    if (!isHydrated || !token) return;

    const verifyToken = async () => {
      try {
        const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/me`, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (!response.ok) {
          // Token is invalid, clear auth
          console.log('Token validation failed, clearing auth');
          clearAuth();
        }
      } catch (error) {
        console.error('Token validation error:', error);
        // Don't clear auth on network errors
      }
    };

    verifyToken();
  }, [isHydrated, token, clearAuth]);

  // Monitor for account changes and clear auth if address doesn't match
  useEffect(() => {
    if (!isHydrated) return;

    if (user && address && user.address.toLowerCase() !== address.toLowerCase()) {
      // Address changed - clear authentication
      console.log('Address changed, clearing auth');
      clearAuth();
    }
  }, [isHydrated, address, user, clearAuth]);

  // Clear auth when wallet disconnects
  useEffect(() => {
    if (!isHydrated) return;

    if (!isConnected && isAuthenticated) {
      console.log('Wallet disconnected, clearing auth');
      clearAuth();
    }
  }, [isHydrated, isConnected, isAuthenticated, clearAuth]);

  /**
   * Sign in with Ethereum using SIWE
   */
  const signIn = async () => {
    if (!address || !isConnected) {
      throw new Error('Wallet not connected');
    }

    try {
      // Step 1: Request nonce
      console.log('Requesting nonce for address:', address);
      const nonceResponse = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/auth/nonce?address=${address}`
      );

      if (!nonceResponse.ok) {
        throw new Error('Failed to get nonce');
      }

      const { data: nonceData } = await nonceResponse.json();
      const nonce = nonceData.nonce;
      console.log('Received nonce:', nonce);

      // Step 2: Build SIWE message
      const domain = window.location.host;
      const origin = window.location.origin;

      const siweMessage = new SiweMessage({
        domain,
        address,
        statement: 'Sign in to Grails ENS Marketplace to manage your profile and watchlist.',
        uri: origin,
        version: '1',
        chainId: 1,
        nonce,
        issuedAt: new Date().toISOString(),
        expirationTime: new Date(Date.now() + 5 * 60 * 1000).toISOString(), // 5 minutes
      });

      const message = siweMessage.prepareMessage();

      // Step 3: Request signature from wallet
      const signature = await signMessageAsync({ message });

      // Step 4: Verify signature with backend
      const verifyResponse = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/auth/verify`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            message,
            signature,
          }),
        }
      );

      if (!verifyResponse.ok) {
        const error = await verifyResponse.json();
        throw new Error(error.error?.message || 'Failed to verify signature');
      }

      const { data } = await verifyResponse.json();

      // Step 5: Store token and user data
      setAuth(data.token, data.user);

      return data.user;
    } catch (error: any) {
      console.error('Sign in error:', error);
      throw error;
    }
  };

  /**
   * Sign out
   */
  const signOut = async () => {
    // Optional: call logout endpoint
    if (token) {
      try {
        await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/logout`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });
      } catch (error) {
        console.error('Logout error:', error);
      }
    }

    clearAuth();
  };

  /**
   * Update user profile
   */
  const updateProfile = async (updates: {
    email?: string;
    telegram?: string;
    discord?: string;
  }) => {
    if (!token) {
      throw new Error('Not authenticated');
    }

    const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/users/me`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(updates),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Failed to update profile');
    }

    const { data } = await response.json();
    updateUser(data);

    return data;
  };

  /**
   * Fetch current user from API
   */
  const refreshUser = async () => {
    if (!token) {
      return null;
    }

    try {
      const response = await fetch(`${process.env.NEXT_PUBLIC_API_URL}/auth/me`, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        // Token invalid, clear auth
        clearAuth();
        return null;
      }

      const { data } = await response.json();
      updateUser(data);

      return data;
    } catch (error) {
      console.error('Refresh user error:', error);
      clearAuth();
      return null;
    }
  };

  return {
    user,
    token,
    isAuthenticated,
    isConnected,
    address,
    isHydrated,
    signIn,
    signOut,
    updateProfile,
    refreshUser,
  };
}
