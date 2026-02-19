/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

jest.mock('axios');

const axios = require('axios');

// We need to mock config before requiring utils since createHttpsAgent and
// makeAuthenticatedRequest require config at call time
jest.mock('../src/config', () => require('./mock-helpers').createConfigMock());

const {
  sleep,
  retry,
  formatError,
  getHealthCheckUrl,
  getAdminApiUrl,
  createHttpsAgent,
  makeAuthenticatedRequest,
} = require('../src/utils');

describe('utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('sleep', () => {
    test('resolves after specified delay', async () => {
      jest.useFakeTimers();
      const promise = sleep(1000);
      jest.advanceTimersByTime(1000);
      await promise;
      jest.useRealTimers();
    });
  });

  describe('retry', () => {
    test('returns result on first successful attempt', async () => {
      const fn = jest.fn().mockResolvedValue('success');
      const result = await retry(fn, 3, 10, 100);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries and succeeds on later attempt', async () => {
      const fn = jest.fn().mockRejectedValueOnce(new Error('fail1')).mockResolvedValue('success');
      const result = await retry(fn, 3, 10, 100);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('throws after exceeding maxRetries', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('always fails'));
      await expect(retry(fn, 2, 10, 100)).rejects.toThrow('always fails');
      // First call + 2 retries = 3 calls total
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('stops retrying when shouldRetry returns false', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('no retry'));
      const shouldRetry = jest.fn().mockReturnValue(false);
      await expect(retry(fn, 5, 10, 100, shouldRetry)).rejects.toThrow('no retry');
      // First attempt fails, shouldRetry returns false, so only 1 call
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('uses default parameters', async () => {
      const fn = jest.fn().mockResolvedValue('ok');
      const result = await retry(fn);
      expect(result).toBe('ok');
    });
  });

  describe('formatError', () => {
    test('formats error with response containing errorMessage', () => {
      const error = {
        response: { status: 400, data: { errorMessage: 'Bad request' } },
      };
      expect(formatError(error)).toBe('Status 400: Bad request');
    });

    test('formats error with response containing error field', () => {
      const error = {
        response: { status: 401, data: { error: 'unauthorized' } },
      };
      expect(formatError(error)).toBe('Status 401: unauthorized');
    });

    test('formats error with response containing stringified data', () => {
      const error = {
        response: { status: 500, data: { foo: 'bar' } },
      };
      expect(formatError(error)).toBe('Status 500: {"foo":"bar"}');
    });

    test('formats error with request but no response', () => {
      const error = { request: {}, message: 'timeout' };
      expect(formatError(error)).toBe('No response received: timeout');
    });

    test('formats generic error (no request/response)', () => {
      const error = { message: 'something broke' };
      expect(formatError(error)).toBe('Request error: something broke');
    });

    test('returns Unknown error for null/undefined', () => {
      expect(formatError(null)).toBe('Unknown error');
      expect(formatError(undefined)).toBe('Unknown error');
    });

    test('formats error with empty response data', () => {
      const error = { response: { status: 404, data: null } };
      expect(formatError(error)).toBe('Status 404: {}');
    });
  });

  describe('getHealthCheckUrl', () => {
    test('constructs URL from HTTPS base URL', () => {
      expect(getHealthCheckUrl('https://keycloak.example.com')).toBe(
        'https://keycloak.example.com/',
      );
    });

    test('constructs URL from HTTP base URL', () => {
      expect(getHealthCheckUrl('http://localhost:8080')).toBe('http://localhost:8080/');
    });

    test('strips path from base URL', () => {
      expect(getHealthCheckUrl('https://keycloak.example.com/auth')).toBe(
        'https://keycloak.example.com/',
      );
    });
  });

  describe('getAdminApiUrl', () => {
    test('constructs admin URL from base URL', () => {
      expect(getAdminApiUrl('https://keycloak.example.com')).toBe(
        'https://keycloak.example.com/admin',
      );
    });

    test('strips path from base URL', () => {
      expect(getAdminApiUrl('https://keycloak.example.com/auth')).toBe(
        'https://keycloak.example.com/admin',
      );
    });
  });

  describe('createHttpsAgent', () => {
    test('returns HTTPS agent when KEYCLOAK_URL is https', () => {
      const agent = createHttpsAgent();
      expect(agent).not.toBeNull();
      expect(agent.keepAlive).toBe(true);
    });

    test('returns null when KEYCLOAK_URL is http', () => {
      // Override the config module's KEYCLOAK_URL for this test
      const config = require('../src/config');
      const originalUrl = config.KEYCLOAK_URL;
      config.KEYCLOAK_URL = 'http://localhost:8080';
      try {
        expect(createHttpsAgent()).toBeNull();
      } finally {
        config.KEYCLOAK_URL = originalUrl;
      }
    });
  });

  describe('makeAuthenticatedRequest', () => {
    test('sends request with Bearer token and Content-Type headers', async () => {
      axios.mockResolvedValue({ status: 200, data: {} });
      await makeAuthenticatedRequest('get', 'https://example.com/api', null, 'mytoken');
      expect(axios).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'get',
          url: 'https://example.com/api',
          headers: expect.objectContaining({
            Authorization: 'Bearer mytoken',
            'Content-Type': 'application/json',
          }),
          timeout: 5000,
        }),
      );
    });

    test('includes data for POST requests', async () => {
      axios.mockResolvedValue({ status: 201, data: {} });
      const data = { key: 'value' };
      await makeAuthenticatedRequest('post', 'https://example.com/api', data, 'token');
      expect(axios).toHaveBeenCalledWith(expect.objectContaining({ data }));
    });

    test('includes data for PUT requests', async () => {
      axios.mockResolvedValue({ status: 200, data: {} });
      const data = { key: 'value' };
      await makeAuthenticatedRequest('put', 'https://example.com/api', data, 'token');
      expect(axios).toHaveBeenCalledWith(expect.objectContaining({ data }));
    });

    test('omits data for GET requests', async () => {
      axios.mockResolvedValue({ status: 200, data: {} });
      await makeAuthenticatedRequest('get', 'https://example.com/api', { key: 'val' }, 'token');
      const callArg = axios.mock.calls[0][0];
      expect(callArg.data).toBeUndefined();
    });

    test('throws and logs on request failure', async () => {
      const error = new Error('network error');
      axios.mockRejectedValue(error);
      await expect(
        makeAuthenticatedRequest('get', 'https://example.com/api', null, 'token'),
      ).rejects.toThrow('network error');
    });
  });
});
