/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { CloudFormationCustomResourceEvent } from '../src/types';

describe('config', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.API_TIMEOUT_MS;
    delete process.env.HEALTH_CHECK_MAX_ATTEMPTS;
    delete process.env.HEALTH_CHECK_INTERVAL_MS;
    delete process.env.API_MAX_RETRIES;
    delete process.env.API_RETRY_INTERVAL_MS;
  });

  function loadConfig(envOverrides: Record<string, string> = {}) {
    Object.assign(process.env, envOverrides);
    return require('../src/config');
  }

  function makeEvent(props: Record<string, unknown> = {}): CloudFormationCustomResourceEvent {
    return {
      RequestType: 'Create',
      ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:test',
      ResponseURL: 'https://example.com',
      StackId: 'arn:aws:cloudformation:us-east-1:123456789012:stack/test-stack/guid',
      RequestId: 'req-1',
      ResourceType: 'Custom::KeycloakConfig',
      LogicalResourceId: 'KeycloakConfig',
      ResourceProperties: {
        SsmPrefix: '/test-project/auth',
        // Sensible default AuthConfig so tests focused on other properties do
        // not have to declare one. AuthConfig is JSON-encoded on the wire —
        // see the CDK construct — so tests pass a string, not an object.
        // Tests exercising missing AuthConfig override this with
        // `AuthConfig: undefined` or `'{}'`.
        AuthConfig: JSON.stringify({ realm: 'test' }),
        ...props,
      },
    };
  }

  describe('environment tunables', () => {
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
        API_TIMEOUT_MS: '5000',
        HEALTH_CHECK_MAX_ATTEMPTS: '5',
        HEALTH_CHECK_INTERVAL_MS: '1000',
        API_MAX_RETRIES: '3',
        API_RETRY_INTERVAL_MS: '500',
      });
      expect(config.API_TIMEOUT_MS).toBe(5000);
      expect(config.HEALTH_CHECK_MAX_ATTEMPTS).toBe(5);
      expect(config.HEALTH_CHECK_INTERVAL_MS).toBe(1000);
      expect(config.API_MAX_RETRIES).toBe(3);
      expect(config.API_RETRY_INTERVAL_MS).toBe(500);
    });
  });

  describe('loadFromEvent', () => {
    test('returns SsmPrefix from resource properties', () => {
      const config = loadConfig();
      const rc = config.loadFromEvent(makeEvent({ SsmPrefix: '/custom/prefix' }));
      expect(rc.ssmPrefix).toBe('/custom/prefix');
    });

    test('defaults keycloakAdminUsername when absent', () => {
      const config = loadConfig();
      const rc = config.loadFromEvent(makeEvent());
      expect(rc.keycloakAdminUsername).toBe('keycloak');
    });

    test('returns KeycloakAdminUsername from resource properties', () => {
      const config = loadConfig();
      const rc = config.loadFromEvent(makeEvent({ KeycloakAdminUsername: 'myadmin' }));
      expect(rc.keycloakAdminUsername).toBe('myadmin');
    });

    test('parses AuthConfig JSON string back to an object', () => {
      const authData = { realm: 'test', clients: [] as unknown[] };
      const config = loadConfig();
      const rc = config.loadFromEvent(makeEvent({ AuthConfig: JSON.stringify(authData) }));
      expect(rc.authConfig).toEqual(authData);
    });

    test('preserves primitive types (booleans, numbers) through JSON round-trip', () => {
      // Guards against the CFN string-coercion regression: nested booleans
      // must arrive at the Lambda as real booleans, not the string "true".
      const authData = {
        realm: 'test',
        enabled: true,
        clients: [{ clientId: 'c1', publicClient: true, standardFlowEnabled: false }],
      };
      const config = loadConfig();
      const rc = config.loadFromEvent(makeEvent({ AuthConfig: JSON.stringify(authData) }));
      expect(rc.authConfig.enabled).toBe(true);
      expect(typeof rc.authConfig.enabled).toBe('boolean');
      expect(rc.authConfig.clients?.[0].publicClient).toBe(true);
      expect(typeof rc.authConfig.clients?.[0].publicClient).toBe('boolean');
      expect(rc.authConfig.clients?.[0].standardFlowEnabled).toBe(false);
    });

    test('defaults userPasswordSecrets to {} when absent', () => {
      const config = loadConfig();
      const rc = config.loadFromEvent(makeEvent());
      expect(rc.userPasswordSecrets).toEqual({});
    });

    test('returns userPasswordSecrets as-is when provided', () => {
      const secrets = { user1: 'arn:aws:secretsmanager:us-west-2:123:secret:pw' };
      const config = loadConfig();
      const rc = config.loadFromEvent(makeEvent({ UserPasswordSecrets: secrets }));
      expect(rc.userPasswordSecrets).toEqual(secrets);
    });
  });

  describe('AuthConfig is required', () => {
    test('throws when AuthConfig is absent', () => {
      const config = loadConfig();
      expect(() => config.loadFromEvent(makeEvent({ AuthConfig: undefined }))).toThrow(
        'Missing required resource property: AuthConfig',
      );
    });

    test('throws when AuthConfig is an empty JSON object', () => {
      const config = loadConfig();
      expect(() => config.loadFromEvent(makeEvent({ AuthConfig: '{}' }))).toThrow(
        'Missing required resource property: AuthConfig',
      );
    });

    test('throws when AuthConfig is not a string (unexpected object form)', () => {
      const config = loadConfig();
      expect(() => config.loadFromEvent(makeEvent({ AuthConfig: { realm: 'test' } }))).toThrow(
        'Missing required resource property: AuthConfig',
      );
    });

    test('throws with a descriptive error when AuthConfig is not valid JSON', () => {
      const config = loadConfig();
      expect(() => config.loadFromEvent(makeEvent({ AuthConfig: '{not-json' }))).toThrow(
        /Invalid resource property AuthConfig: not valid JSON/,
      );
    });
  });
});
