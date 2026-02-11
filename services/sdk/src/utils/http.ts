/**
 * HTTP Client for API requests
 */

import type { ResolvedConfig } from '../config.js';
import type { APIResponse } from '../types/api.js';
import {
  createAPIError,
  NetworkError,
  TimeoutError,
  RateLimitError,
} from '../errors/api-error.js';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
  /** Skip automatic auth header injection */
  skipAuth?: boolean;
  /** Custom timeout for this request */
  timeout?: number;
  /** Skip retries for this request */
  skipRetry?: boolean;
}

/**
 * HTTP client with retry logic and auth header injection
 */
export class HttpClient {
  constructor(private readonly config: ResolvedConfig) {}

  /**
   * Build full URL for API endpoint
   */
  buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const fullUrl = `${this.config.baseUrl}/api/${this.config.apiVersion}${normalizedPath}`;
    const url = new URL(fullUrl);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  /**
   * Make an HTTP request to the API
   */
  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const {
      method = 'GET',
      body,
      headers = {},
      skipAuth = false,
      timeout = this.config.timeout,
      skipRetry = false,
    } = options;

    const url = this.buildUrl(path);

    // Build headers
    const requestHeaders: Record<string, string> = {
      'Content-Type': 'application/json',
      ...headers,
    };

    // Add auth header if we have a token
    if (!skipAuth) {
      const token = this.config.tokenStorage.getToken();
      if (token) {
        requestHeaders['Authorization'] = `Bearer ${token}`;
      }
    }

    // Make request with retries
    let lastError: Error | undefined;
    const maxAttempts = skipRetry ? 1 : this.config.retries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await this.fetchWithTimeout(url, {
          method,
          headers: requestHeaders,
          body: body ? JSON.stringify(body) : undefined,
        }, timeout);

        // Parse response
        const data = await response.json() as APIResponse<T>;

        // Handle error responses
        if (!response.ok || !data.success) {
          const error = data.error || {
            code: 'UNKNOWN_ERROR',
            message: `Request failed with status ${response.status}`,
          };

          const retryAfter = response.headers.get('Retry-After');
          const requestId = data.meta?.requestId;

          const apiError = createAPIError(
            response.status,
            error,
            requestId,
            retryAfter ? parseInt(retryAfter, 10) : undefined
          );

          // Don't retry on client errors (except rate limit)
          if (response.status < 500 && response.status !== 429) {
            throw apiError;
          }

          // Retry on rate limit with backoff
          if (response.status === 429 && apiError instanceof RateLimitError) {
            const delay = apiError.retryAfter
              ? apiError.retryAfter * 1000
              : this.config.retryDelay * Math.pow(2, attempt - 1);

            if (attempt < maxAttempts) {
              await this.sleep(delay);
              continue;
            }
          }

          lastError = apiError;
          throw apiError;
        }

        return data.data as T;
      } catch (error) {
        lastError = error as Error;

        // Don't retry on non-retryable errors
        if (
          error instanceof Error &&
          !(error instanceof NetworkError) &&
          !(error instanceof TimeoutError)
        ) {
          // Check if it's a server error that we might want to retry
          const statusCode = 'statusCode' in error ? (error as { statusCode: number }).statusCode : undefined;
          if (error.name !== 'GrailsAPIError' || (statusCode !== undefined && statusCode < 500)) {
            throw error;
          }
        }

        // Exponential backoff for retries
        if (attempt < maxAttempts) {
          const delay = this.config.retryDelay * Math.pow(2, attempt - 1);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new NetworkError('Request failed after retries');
  }

  /**
   * Make a GET request
   */
  async get<T>(path: string, params?: Record<string, string | number | boolean | undefined>, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    let fullPath = path;
    if (params) {
      const url = new URL(path, 'http://placeholder');
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
      fullPath = url.pathname + url.search;
    }
    return this.request<T>(fullPath, { ...options, method: 'GET' });
  }

  /**
   * Make a POST request
   */
  async post<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'POST', body });
  }

  /**
   * Make a PUT request
   */
  async put<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PUT', body });
  }

  /**
   * Make a PATCH request
   */
  async patch<T>(path: string, body?: unknown, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'PATCH', body });
  }

  /**
   * Make a DELETE request
   */
  async delete<T>(path: string, options?: Omit<RequestOptions, 'method' | 'body'>): Promise<T> {
    return this.request<T>(path, { ...options, method: 'DELETE' });
  }

  /**
   * Fetch with timeout
   */
  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeout: number
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await this.config.fetch(url, {
        ...init,
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          throw new TimeoutError();
        }
        throw new NetworkError(error.message, error);
      }
      throw new NetworkError('Unknown network error');
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Sleep for specified milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
