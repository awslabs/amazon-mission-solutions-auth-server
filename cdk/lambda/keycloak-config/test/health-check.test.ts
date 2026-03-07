/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

export {};

jest.mock('axios');
jest.mock('../src/config', () => require('./mock-helpers').createConfigMock());
jest.mock('../src/utils', () => require('./mock-helpers').createUtilsMock());

const axios = require('axios');
const utils = require('../src/utils');
const {
  isKeycloakHealthy,
  isKeycloakReadyForConfig,
  waitForKeycloakHealth,
} = require('../src/health-check');

const KEYCLOAK_URL = 'https://keycloak.example.com';

describe('health-check', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('isKeycloakHealthy', () => {
    test('returns true for 200 response', async () => {
      axios.get.mockResolvedValue({ status: 200 });
      expect(await isKeycloakHealthy(KEYCLOAK_URL)).toBe(true);
    });

    test('returns true for 301 redirect response', async () => {
      axios.get.mockResolvedValue({ status: 301 });
      expect(await isKeycloakHealthy(KEYCLOAK_URL)).toBe(true);
    });

    test('returns false for 400 response', async () => {
      axios.get.mockResolvedValue({ status: 400 });
      expect(await isKeycloakHealthy(KEYCLOAK_URL)).toBe(false);
    });

    test('returns false for 500 response', async () => {
      axios.get.mockResolvedValue({ status: 500 });
      expect(await isKeycloakHealthy(KEYCLOAK_URL)).toBe(false);
    });

    test('returns false on network error', async () => {
      axios.get.mockRejectedValue(new Error('ECONNREFUSED'));
      expect(await isKeycloakHealthy(KEYCLOAK_URL)).toBe(false);
    });
  });

  describe('isKeycloakReadyForConfig', () => {
    test('returns false when isKeycloakHealthy returns false', async () => {
      axios.get.mockResolvedValue({ status: 500 });
      expect(await isKeycloakReadyForConfig(KEYCLOAK_URL)).toBe(false);
    });

    test('returns true when serverinfo returns 200', async () => {
      // First call: health check (200), second call: serverinfo (200)
      axios.get.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 200 });
      expect(await isKeycloakReadyForConfig(KEYCLOAK_URL)).toBe(true);
    });

    test('returns true when serverinfo returns 401', async () => {
      axios.get.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 401 });
      expect(await isKeycloakReadyForConfig(KEYCLOAK_URL)).toBe(true);
    });

    test('returns false when serverinfo returns other status', async () => {
      axios.get.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 503 });
      expect(await isKeycloakReadyForConfig(KEYCLOAK_URL)).toBe(false);
    });

    test('returns false on network error during serverinfo check', async () => {
      axios.get.mockResolvedValueOnce({ status: 200 }).mockRejectedValueOnce(new Error('timeout'));
      expect(await isKeycloakReadyForConfig(KEYCLOAK_URL)).toBe(false);
    });
  });

  describe('waitForKeycloakHealth', () => {
    test('returns true when ready on first attempt', async () => {
      // Health check + serverinfo both succeed
      axios.get.mockResolvedValueOnce({ status: 200 }).mockResolvedValueOnce({ status: 200 });
      const result = await waitForKeycloakHealth(KEYCLOAK_URL);
      expect(result).toBe(true);
      expect(utils.sleep).not.toHaveBeenCalled();
    });

    test('retries and returns true when ready on later attempt', async () => {
      // Attempt 1: health check fails
      axios.get
        .mockResolvedValueOnce({ status: 500 })
        // Attempt 2: health check + serverinfo succeed
        .mockResolvedValueOnce({ status: 200 })
        .mockResolvedValueOnce({ status: 200 });

      const result = await waitForKeycloakHealth(KEYCLOAK_URL);
      expect(result).toBe(true);
      expect(utils.sleep).toHaveBeenCalledTimes(1);
    });

    test('throws after all attempts exhausted', async () => {
      axios.get.mockResolvedValue({ status: 500 });
      await expect(waitForKeycloakHealth(KEYCLOAK_URL)).rejects.toThrow(
        'Keycloak is not ready after 3 health check attempts',
      );
      expect(utils.sleep).toHaveBeenCalledTimes(2);
      expect(utils.sleep).toHaveBeenCalledWith(100);
    });
  });
});
