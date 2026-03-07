/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

describe('config', () => {
  const REQUIRED_ENVS: Record<string, string> = {
    SSM_PREFIX: '/test-project/auth',
  };

  beforeEach(() => {
    jest.resetModules();
    // Clear all relevant env vars
    delete process.env.SSM_PREFIX;
    delete process.env.KEYCLOAK_ADMIN_USERNAME;
    delete process.env.WEBSITE_URI;
    delete process.env.AUTH_CONFIG;
    delete process.env.USER_PASSWORD_SECRETS;
    delete process.env.API_TIMEOUT_MS;
    delete process.env.HEALTH_CHECK_MAX_ATTEMPTS;
    delete process.env.HEALTH_CHECK_INTERVAL_MS;
    delete process.env.API_MAX_RETRIES;
    delete process.env.API_RETRY_INTERVAL_MS;
  });

  function loadConfig(envOverrides: Record<string, string> = {}) {
    Object.assign(process.env, REQUIRED_ENVS, envOverrides);
    return require('../src/config');
  }

  describe('environment variable loading', () => {
    test('loads required SSM_PREFIX from env', () => {
      const config = loadConfig();
      expect(config.SSM_PREFIX).toBe('/test-project/auth');
    });

    test('throws when required SSM_PREFIX is missing', () => {
      delete process.env.SSM_PREFIX;
      expect(() => require('../src/config')).toThrow(
        'Required environment variable SSM_PREFIX is not set',
      );
    });

    test('uses default for KEYCLOAK_ADMIN_USERNAME', () => {
      const config = loadConfig();
      expect(config.KEYCLOAK_ADMIN_USERNAME).toBe('keycloak');
    });

    test('uses default for WEBSITE_URI', () => {
      const config = loadConfig();
      expect(config.WEBSITE_URI).toBe('*');
    });

    test('uses default for AUTH_CONFIG', () => {
      const config = loadConfig();
      expect(config.AUTH_CONFIG).toBe('{}');
    });

    test('uses default for USER_PASSWORD_SECRETS', () => {
      const config = loadConfig();
      expect(config.USER_PASSWORD_SECRETS).toBe('{}');
    });

    test('parses integer env vars with defaults', () => {
      const config = loadConfig();
      expect(config.API_TIMEOUT_MS).toBe(30000);
      expect(config.HEALTH_CHECK_MAX_ATTEMPTS).toBe(30);
      expect(config.HEALTH_CHECK_INTERVAL_MS).toBe(20000);
      expect(config.API_MAX_RETRIES).toBe(10);
      expect(config.API_RETRY_INTERVAL_MS).toBe(20000);
    });

    test('uses custom values when env vars are set', () => {
      const config = loadConfig({
        KEYCLOAK_ADMIN_USERNAME: 'myadmin',
        WEBSITE_URI: 'https://myapp.com',
        AUTH_CONFIG: '{"realm":"test"}',
        USER_PASSWORD_SECRETS: '{"user1":"arn:secret"}',
        API_TIMEOUT_MS: '5000',
        HEALTH_CHECK_MAX_ATTEMPTS: '5',
        HEALTH_CHECK_INTERVAL_MS: '1000',
        API_MAX_RETRIES: '3',
        API_RETRY_INTERVAL_MS: '500',
      });
      expect(config.KEYCLOAK_ADMIN_USERNAME).toBe('myadmin');
      expect(config.WEBSITE_URI).toBe('https://myapp.com');
      expect(config.AUTH_CONFIG).toBe('{"realm":"test"}');
      expect(config.USER_PASSWORD_SECRETS).toBe('{"user1":"arn:secret"}');
      expect(config.API_TIMEOUT_MS).toBe(5000);
      expect(config.HEALTH_CHECK_MAX_ATTEMPTS).toBe(5);
      expect(config.HEALTH_CHECK_INTERVAL_MS).toBe(1000);
      expect(config.API_MAX_RETRIES).toBe(3);
      expect(config.API_RETRY_INTERVAL_MS).toBe(500);
    });
  });

  describe('getAuthConfig', () => {
    test('returns null when AUTH_CONFIG is default "{}"', () => {
      const config = loadConfig();
      expect(config.getAuthConfig()).toBeNull();
    });

    test('returns null when AUTH_CONFIG is empty string', () => {
      const config = loadConfig({ AUTH_CONFIG: '' });
      // Empty string is falsy, so getEnvVar falls back to default '{}'
      expect(config.getAuthConfig()).toBeNull();
    });

    test('parses valid JSON config', () => {
      const authData = { realm: 'test', clients: [] as unknown[] };
      const config = loadConfig({ AUTH_CONFIG: JSON.stringify(authData) });
      expect(config.getAuthConfig()).toEqual(authData);
    });

    test('throws on invalid JSON with descriptive message', () => {
      const config = loadConfig({ AUTH_CONFIG: 'not-json' });
      expect(() => config.getAuthConfig()).toThrow('Invalid authentication configuration');
    });
  });

  describe('getUserPasswordSecrets', () => {
    test('returns {} when USER_PASSWORD_SECRETS is default "{}"', () => {
      const config = loadConfig();
      expect(config.getUserPasswordSecrets()).toEqual({});
    });

    test('returns {} when USER_PASSWORD_SECRETS is empty string', () => {
      const config = loadConfig({ USER_PASSWORD_SECRETS: '' });
      expect(config.getUserPasswordSecrets()).toEqual({});
    });

    test('parses valid JSON', () => {
      const secrets = { user1: 'arn:aws:secretsmanager:us-west-2:123:secret:pw' };
      const config = loadConfig({
        USER_PASSWORD_SECRETS: JSON.stringify(secrets),
      });
      expect(config.getUserPasswordSecrets()).toEqual(secrets);
    });

    test('throws on invalid JSON with descriptive message', () => {
      const config = loadConfig({ USER_PASSWORD_SECRETS: '{bad-json' });
      expect(() => config.getUserPasswordSecrets()).toThrow('Invalid user password secrets');
    });
  });
});
