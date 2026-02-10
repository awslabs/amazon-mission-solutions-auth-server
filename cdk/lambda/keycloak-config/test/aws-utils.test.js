/**
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

const mockSend = jest.fn();

jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: jest.fn((input) => ({ input })),
}));

jest.mock('../src/config', () => require('./mock-helpers').createConfigMock());

const config = require('../src/config');
const { getAdminCredentials, getOrCreateUserPassword } = require('../src/aws-utils');

describe('aws-utils', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    config.KEYCLOAK_ADMIN_SECRET_ARN =
      'arn:aws:secretsmanager:us-west-2:123456789012:secret:admin';
    config.KEYCLOAK_ADMIN_USERNAME = 'keycloak';
  });

  describe('getAdminCredentials', () => {
    test('retrieves and parses JSON secret with username and password', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ username: 'keycloak', password: 'secret123' }),
      });
      const result = await getAdminCredentials();
      expect(result).toEqual({ username: 'keycloak', password: 'secret123' });
      expect(mockSend).toHaveBeenCalledWith({
        input: { SecretId: config.KEYCLOAK_ADMIN_SECRET_ARN },
      });
    });

    test('throws when KEYCLOAK_ADMIN_SECRET_ARN is falsy', async () => {
      config.KEYCLOAK_ADMIN_SECRET_ARN = '';
      await expect(getAdminCredentials()).rejects.toThrow(
        'Keycloak admin secret ARN is not provided',
      );
    });

    test('throws for binary secret (no SecretString)', async () => {
      mockSend.mockResolvedValue({ SecretBinary: Buffer.from('binary') });
      await expect(getAdminCredentials()).rejects.toThrow(
        'Failed to retrieve admin credentials',
      );
    });

    test('throws when secret missing username key', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ password: 'secret123' }),
      });
      await expect(getAdminCredentials()).rejects.toThrow(
        'Failed to retrieve admin credentials',
      );
    });

    test('throws when secret missing password key', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ username: 'keycloak' }),
      });
      await expect(getAdminCredentials()).rejects.toThrow(
        'Failed to retrieve admin credentials',
      );
    });

    test('warns but succeeds when username does not match config', async () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({
          username: 'different-admin',
          password: 'secret123',
        }),
      });
      const result = await getAdminCredentials();
      expect(result).toEqual({ username: 'different-admin', password: 'secret123' });
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('does not match configured admin username'),
      );
    });

    test('wraps errors with descriptive message', async () => {
      mockSend.mockRejectedValue(new Error('AWS SDK error'));
      await expect(getAdminCredentials()).rejects.toThrow(
        'Failed to retrieve admin credentials: AWS SDK error',
      );
    });
  });

  describe('getOrCreateUserPassword', () => {
    beforeEach(() => {
      config.getUserPasswordSecrets.mockReturnValue({
        testuser: 'arn:aws:secretsmanager:us-west-2:123:secret:testuser-pw',
      });
    });

    test('retrieves plain string password', async () => {
      mockSend.mockResolvedValue({ SecretString: 'my-plain-password' });
      const result = await getOrCreateUserPassword('testuser');
      expect(result).toBe('my-plain-password');
    });

    test('retrieves JSON secret with password key', async () => {
      mockSend.mockResolvedValue({
        SecretString: JSON.stringify({ password: 'json-password' }),
      });
      const result = await getOrCreateUserPassword('testuser');
      expect(result).toBe('json-password');
    });

    test('uses raw string when JSON has no password key', async () => {
      const raw = JSON.stringify({ other: 'value' });
      mockSend.mockResolvedValue({ SecretString: raw });
      const result = await getOrCreateUserPassword('testuser');
      expect(result).toBe(raw);
    });

    test('uses raw string when JSON parse fails for string starting with "{"', async () => {
      const badJson = '{not-valid-json';
      mockSend.mockResolvedValue({ SecretString: badJson });
      const result = await getOrCreateUserPassword('testuser');
      expect(result).toBe(badJson);
    });

    test('throws when no secret ARN found for username', async () => {
      await expect(getOrCreateUserPassword('unknown-user')).rejects.toThrow(
        'No secret ARN found for user: unknown-user',
      );
    });

    test('returns placeholder on ResourceNotFoundException', async () => {
      const error = new Error('not found');
      error.name = 'ResourceNotFoundException';
      mockSend.mockRejectedValue(error);
      const result = await getOrCreateUserPassword('testuser');
      expect(result).toBe('placeholder-password-will-be-created-by-cdk');
    });

    test('throws on other AWS errors with context message', async () => {
      mockSend.mockRejectedValue(new Error('access denied'));
      await expect(getOrCreateUserPassword('testuser')).rejects.toThrow(
        'Failed to retrieve password for user testuser: access denied',
      );
    });

    test('handles binary secret error', async () => {
      mockSend.mockResolvedValue({ SecretBinary: Buffer.from('binary') });
      await expect(getOrCreateUserPassword('testuser')).rejects.toThrow(
        'Failed to retrieve password for user testuser',
      );
    });
  });
});
