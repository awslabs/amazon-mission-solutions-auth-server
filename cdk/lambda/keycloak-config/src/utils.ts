/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/** Utility functions for Keycloak configuration */

import axios, { AxiosResponse } from 'axios';
import https from 'https';

import { HttpMethod } from './types';

/** Pause execution for specified milliseconds */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Retry function with exponential backoff */
async function retry<T>(
  fn: () => Promise<T>,
  maxRetries: number = 5,
  initialDelay: number = 1000,
  maxDelay: number = 60000,
  shouldRetry: (error: unknown) => boolean = () => true,
): Promise<T> {
  let retries = 0;
  let delay = initialDelay;

  while (true) {
    try {
      return await fn();
    } catch (error) {
      retries += 1;

      if (retries > maxRetries || !shouldRetry(error)) {
        console.error(`Retry failed after ${retries} attempts:`, error);
        throw error;
      }

      console.log(`Retry attempt ${retries}/${maxRetries} after ${delay}ms`);

      await sleep(delay);

      // Exponential backoff with a random factor
      delay = Math.min(maxDelay, delay * 1.5 * (1 + Math.random() * 0.2));
    }
  }
}

/** Format error with response details */
function formatError(error: unknown): string {
  if (!error) {
    return 'Unknown error';
  }

  const err = error as Record<string, unknown>;

  if (err.response) {
    // The request was made and the server responded with a status code
    // that falls out of the range of 2xx
    const response = err.response as { status: number; data?: Record<string, unknown> | null };
    const data = response.data || {};
    const message =
      (data as Record<string, unknown>).errorMessage ||
      (data as Record<string, unknown>).error ||
      JSON.stringify(data);
    return `Status ${response.status}: ${message}`;
  } else if (err.request) {
    // The request was made but no response was received
    return `No response received: ${(err as { message: string }).message}`;
  } else {
    // Something happened in setting up the request that triggered an Error
    return `Request error: ${(err as { message: string }).message}`;
  }
}

/** Get Keycloak health check URL */
function getHealthCheckUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/`;
}

/** Get Keycloak admin API URL */
function getAdminApiUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}/admin`;
}

/** Create configured HTTPS agent for SSL */
function createHttpsAgent(keycloakUrl?: string): https.Agent | null {
  // Only create HTTPS agent for HTTPS URLs
  if (!keycloakUrl || !keycloakUrl.startsWith('https://')) {
    return null;
  }

  // In a production environment, we want proper SSL validation
  // The hostname should match the certificate
  return new https.Agent({
    // Keep connections alive for better performance
    keepAlive: true,
    // Don't reject unauthorized certificates during development/startup
    // In production, this should be true for security
    rejectUnauthorized: true,
  });
}

/** Make authenticated HTTP request */
async function makeAuthenticatedRequest(
  method: HttpMethod,
  url: string,
  data: unknown,
  accessToken: string,
): Promise<AxiosResponse> {
  const config = require('./config') as Record<string, unknown>;

  const requestConfig: Record<string, unknown> = {
    method,
    url,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    timeout: config.API_TIMEOUT_MS,
    validateStatus: (status: number) => status < 500, // Don't throw for 4xx errors
    httpsAgent: createHttpsAgent(url),
  };

  if (data && (method === 'post' || method === 'put')) {
    requestConfig.data = data;
  }

  try {
    const response: AxiosResponse = await axios(
      requestConfig as unknown as Parameters<typeof axios>[0],
    );
    return response;
  } catch (error) {
    console.error(`HTTP request failed: ${method.toUpperCase()} ${url}`, formatError(error));
    throw error;
  }
}

export = {
  sleep,
  retry,
  formatError,
  getHealthCheckUrl,
  getAdminApiUrl,
  createHttpsAgent,
  makeAuthenticatedRequest,
};
