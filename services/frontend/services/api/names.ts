import { apiClient } from './client';
import { APIResponse, ENSName, Transaction, Pagination } from '@/types';

export interface NamesParams {
  page?: number;
  limit?: number;
  owner?: string;
  status?: 'available' | 'listed' | 'expiring';
  sort?: 'name' | 'price' | 'expiry' | 'created';
  order?: 'asc' | 'desc';
}

export interface SearchNamesParams {
  q: string;
  page?: number;
  limit?: number;
  filters?: {
    minPrice?: string;
    maxPrice?: string;
    minLength?: number;
    maxLength?: number;
    hasNumbers?: boolean;
    hasEmoji?: boolean;
  };
}

class NamesAPI {
  async getNames(params?: NamesParams): Promise<{ names: ENSName[]; pagination: Pagination }> {
    const response = await apiClient.get<APIResponse<{ names: ENSName[]; pagination: Pagination }>>('/names', params);
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to fetch names');
    }
    return response.data!;
  }

  async getNameByName(name: string): Promise<ENSName> {
    const response = await apiClient.get<APIResponse<ENSName>>(`/names/${name}`);
    if (!response.success) {
      throw new Error(response.error?.message || 'Name not found');
    }
    return response.data!;
  }

  async searchNames(params: SearchNamesParams): Promise<any> {
    const response = await apiClient.get<APIResponse>('/names/search', params);
    if (!response.success) {
      throw new Error(response.error?.message || 'Search failed');
    }
    return response.data;
  }

  async getNameHistory(name: string, page = 1, limit = 20): Promise<{ transactions: Transaction[]; pagination: Pagination }> {
    const response = await apiClient.get<APIResponse<{ transactions: Transaction[]; pagination: Pagination }>>(`/names/${name}/history`, { page, limit });
    if (!response.success) {
      throw new Error(response.error?.message || 'Failed to fetch history');
    }
    return response.data!;
  }
}

export const namesAPI = new NamesAPI();