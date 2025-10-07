import { useQuery } from '@tanstack/react-query';

export interface ProfileData {
  address: string;
  primaryName: string | null;
  ensRecords: {
    avatar?: string;
    name?: string;
    description?: string;
    email?: string;
    url?: string;
    location?: string;
    twitter?: string;
    github?: string;
    header?: string;
    address?: string;
    records?: Record<string, any>;
  } | null;
  ownedNames: Array<{
    id: number;
    token_id: string;
    name: string;
    expiry_date: string | null;
    registration_date: string | null;
    created_at: string;
    is_listed: boolean;
    active_listing: {
      id: number;
      price_wei: string;
      currency_address: string;
      source: string;
      created_at: string;
    } | null;
  }>;
  stats: {
    totalNames: number;
    listedNames: number;
    totalActivity: number;
  };
}

export interface ActivityEvent {
  id: number;
  ens_name_id: number;
  event_type: string;
  actor_address: string;
  counterparty_address: string | null;
  platform: string;
  chain_id: number;
  price_wei: string | null;
  currency_address: string | null;
  transaction_hash: string | null;
  block_number: number | null;
  metadata: Record<string, any>;
  created_at: string;
  name: string;
  token_id: string;
}

export function useProfile(addressOrName: string) {
  return useQuery({
    queryKey: ['profile', addressOrName],
    queryFn: async () => {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/profiles/${addressOrName}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch profile');
      }

      const data = await response.json();
      return data.data as ProfileData;
    },
    enabled: !!addressOrName,
    staleTime: 30000, // 30 seconds
    retry: 2,
  });
}

export function useProfileActivity(address: string, limit: number = 50) {
  return useQuery({
    queryKey: ['profileActivity', address, limit],
    queryFn: async () => {
      const response = await fetch(
        `${process.env.NEXT_PUBLIC_API_URL}/activity/address/${address}?limit=${limit}`
      );

      if (!response.ok) {
        throw new Error('Failed to fetch activity');
      }

      const data = await response.json();
      return data as { data: ActivityEvent[]; pagination: any };
    },
    enabled: !!address,
    staleTime: 10000, // 10 seconds
    retry: 2,
  });
}
