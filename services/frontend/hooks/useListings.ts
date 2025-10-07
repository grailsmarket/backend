import { useQuery } from '@tanstack/react-query';
import { listingsAPI, ListingsParams } from '@/services/api/listings';

export function useListings(params?: ListingsParams, enabled: boolean = true) {
  return useQuery({
    queryKey: ['listings', params],
    queryFn: () => listingsAPI.getListings(params),
    staleTime: 30000, // Consider data stale after 30 seconds
    retry: 2,
    enabled,
  });
}

export function useListingByName(name: string) {
  return useQuery({
    queryKey: ['listing', name],
    queryFn: () => listingsAPI.getListingByName(name),
    enabled: !!name,
    staleTime: 30000,
    retry: 2,
  });
}

export function useListingById(id: string | number) {
  return useQuery({
    queryKey: ['listing', id],
    queryFn: () => listingsAPI.getListingById(id),
    enabled: !!id,
    staleTime: 30000,
    retry: 2,
  });
}

export function useSearchListings(q: string, params?: any, enabled: boolean = true) {
  return useQuery({
    queryKey: ['searchListings', q, params],
    queryFn: () => listingsAPI.searchListings({ q, ...params }),
    enabled: enabled, // Let the parent component control enabled state
    staleTime: 30000,
    retry: 2,
  });
}