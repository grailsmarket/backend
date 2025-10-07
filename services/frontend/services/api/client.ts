import axios, { AxiosInstance } from 'axios';
import { API_BASE_URL } from '@/lib/constants';

class APIClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: API_BASE_URL,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor
    this.client.interceptors.request.use(
      (config) => {
        // Add auth token if available (future enhancement)
        return config;
      },
      (error) => {
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.client.interceptors.response.use(
      (response) => {
        return response.data;
      },
      (error) => {
        if (error.response) {
          // API returned an error response
          const errorMessage = error.response.data?.error?.message || 'An error occurred';
          const errorCode = error.response.data?.error?.code || 'UNKNOWN_ERROR';

          return Promise.reject({
            code: errorCode,
            message: errorMessage,
            status: error.response.status,
          });
        } else if (error.request) {
          // Request was made but no response received
          return Promise.reject({
            code: 'NETWORK_ERROR',
            message: 'Network error. Please check your connection.',
            status: 0,
          });
        } else {
          // Something else happened
          return Promise.reject({
            code: 'CLIENT_ERROR',
            message: error.message || 'An unexpected error occurred',
            status: 0,
          });
        }
      }
    );
  }

  get<T = any>(url: string, params?: any) {
    return this.client.get<T, T>(url, { params });
  }

  post<T = any>(url: string, data?: any) {
    return this.client.post<T, T>(url, data);
  }

  put<T = any>(url: string, data?: any) {
    return this.client.put<T, T>(url, data);
  }

  delete<T = any>(url: string) {
    return this.client.delete<T, T>(url);
  }
}

export const apiClient = new APIClient();