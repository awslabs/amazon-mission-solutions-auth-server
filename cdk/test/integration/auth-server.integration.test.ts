/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  KeycloakClient,
  KeycloakCustomConfig,
  KeycloakUser,
} from '../../lib/utils/keycloak-config-loader';
import {
  AdminCredentials,
  getAdminCredentials,
  getAdminToken,
  getClients,
  getRealmDetails,
  getStackOutputs,
  getUserInfo,
  getUserPassword,
  getUsers,
  performAuthCodeFlow,
  resolveRedirectUri,
  StackOutputs,
  verifyTokenWithJwks,
} from './helpers';

// ---------------------------------------------------------------------------
// Load deployment configuration
// ---------------------------------------------------------------------------

const DEPLOYMENT_JSON_PATH = join(__dirname, '..', '..', 'bin', 'deployment', 'deployment.json');

interface DeploymentJson {
  projectName: string;
  account: { id: string; region: string };
  dataplaneConfig?: {
    KEYCLOAK_AUTH_CONFIG?: KeycloakCustomConfig;
  };
}

function loadDeployment(): DeploymentJson {
  if (!existsSync(DEPLOYMENT_JSON_PATH)) {
    throw new Error(
      `deployment.json not found at ${DEPLOYMENT_JSON_PATH}. ` +
        'Copy deployment.json.example and configure it for your environment.',
    );
  }
  return JSON.parse(readFileSync(DEPLOYMENT_JSON_PATH, 'utf-8'));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Auth Server Integration', () => {
  let deployment: DeploymentJson;
  let stackOutputs: StackOutputs;
  let adminCreds: AdminCredentials;
  let adminToken: string;

  const authConfig = (): KeycloakCustomConfig | undefined =>
    deployment.dataplaneConfig?.KEYCLOAK_AUTH_CONFIG;

  const hasAuthConfig = (): boolean => !!authConfig();

  beforeAll(() => {
    deployment = loadDeployment();
    stackOutputs = getStackOutputs(deployment.projectName, deployment.account.region);
    adminCreds = getAdminCredentials(stackOutputs.adminSecretArn, deployment.account.region);
  });

  // -------------------------------------------------------------------------
  // Health
  // -------------------------------------------------------------------------

  describe('Health', () => {
    test('Keycloak URL is reachable', async () => {
      // A simple GET to the Keycloak base URL should return 200 or redirect
      const resp = await fetch(stackOutputs.keycloakUrl, {
        redirect: 'manual',
      });
      expect([200, 301, 302, 303]).toContain(resp.status);
    });
  });

  // -------------------------------------------------------------------------
  // Admin Credentials
  // -------------------------------------------------------------------------

  describe('Admin Credentials', () => {
    test('can obtain admin token from master realm', async () => {
      adminToken = await getAdminToken(
        stackOutputs.keycloakUrl,
        adminCreds.username,
        adminCreds.password,
      );
      expect(adminToken).toBeTruthy();
      expect(typeof adminToken).toBe('string');
      // JWT has 3 dot-separated parts
      expect(adminToken.split('.').length).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // Realm Configuration
  // -------------------------------------------------------------------------

  describe('Realm Configuration', () => {
    const skipIf = () => {
      if (!hasAuthConfig()) {
        return 'KEYCLOAK_AUTH_CONFIG not set in deployment.json — skipping realm tests';
      }
      return false;
    };

    test('realm exists and is enabled', async () => {
      const reason = skipIf();
      if (reason) return console.log(reason);

      const config = authConfig()!;
      const realm = await getRealmDetails(stackOutputs.keycloakUrl, adminToken, config.realm);
      expect(realm.realm).toBe(config.realm);
      expect(realm.enabled).toBe(true);
    });

    test('each configured client exists with correct settings', async () => {
      const reason = skipIf();
      if (reason) return console.log(reason);

      const config = authConfig()!;
      const remoteClients = await getClients(stackOutputs.keycloakUrl, adminToken, config.realm);

      for (const expected of config.clients) {
        const remote = remoteClients.find(
          (c: Record<string, unknown>) => c.clientId === expected.clientId,
        );
        expect(remote).toBeDefined();
        if (!remote) continue;

        expect(remote.publicClient).toBe(expected.publicClient);
        if (expected.standardFlowEnabled !== undefined) {
          expect(remote.standardFlowEnabled).toBe(expected.standardFlowEnabled);
        }
        if (expected.directAccessGrantsEnabled !== undefined) {
          expect(remote.directAccessGrantsEnabled).toBe(expected.directAccessGrantsEnabled);
        }
      }
    });

    test('each configured user exists', async () => {
      const reason = skipIf();
      if (reason) return console.log(reason);

      const config = authConfig()!;
      const remoteUsers = await getUsers(stackOutputs.keycloakUrl, adminToken, config.realm);

      for (const expected of config.users) {
        const remote = remoteUsers.find(
          (u: Record<string, unknown>) => u.username === expected.username,
        );
        expect(remote).toBeDefined();
        if (!remote) continue;
        expect(remote.enabled).toBe(expected.enabled !== false);
      }
    });
  });

  // -------------------------------------------------------------------------
  // OIDC Credential Vending (Auth Code + PKCE)
  // -------------------------------------------------------------------------

  describe('OIDC Credential Vending', () => {
    /**
     * Find a testable public client (standardFlowEnabled) and a user with
     * a generated password we can retrieve from Secrets Manager.
     */
    function findTestableClientAndUser(): {
      client: KeycloakClient;
      user: KeycloakUser;
      redirectUri: string;
    } | null {
      const config = authConfig();
      if (!config) return null;

      for (const client of config.clients) {
        if (!client.publicClient) continue;
        // standardFlowEnabled defaults to true in Keycloak
        if (client.standardFlowEnabled === false) continue;

        const redirectUri = resolveRedirectUri(client);
        if (!redirectUri) continue;

        const user = config.users.find(u => u.generatePassword && u.enabled !== false);
        if (!user) continue;

        return { client, user, redirectUri };
      }
      return null;
    }

    let testClient: KeycloakClient;
    let testUser: KeycloakUser;
    let testRedirectUri: string;
    let tokens: {
      accessToken: string;
      refreshToken: string;
      idToken: string;
    };

    beforeAll(() => {
      const found = findTestableClientAndUser();
      if (!found) return; // tests will skip
      testClient = found.client;
      testUser = found.user;
      testRedirectUri = found.redirectUri;
    });

    const skipIf = () => {
      if (!hasAuthConfig()) {
        return 'KEYCLOAK_AUTH_CONFIG not set — skipping OIDC tests';
      }
      if (!testClient || !testUser) {
        return 'No testable public client + user with generated password found — skipping OIDC tests';
      }
      return false;
    };

    test('Auth Code + PKCE flow returns tokens', async () => {
      const reason = skipIf();
      if (reason) return console.log(reason);

      const userPassword = getUserPassword(
        deployment.projectName,
        testUser.username,
        deployment.account.region,
        testUser.ssmPasswordPath,
      );

      tokens = await performAuthCodeFlow(
        stackOutputs.keycloakUrl,
        authConfig()!.realm,
        testClient.clientId,
        testRedirectUri,
        testUser.username,
        userPassword,
      );

      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      expect(tokens.idToken).toBeTruthy();
    });

    test('access token passes JWKS signature verification', async () => {
      const reason = skipIf();
      if (reason) return console.log(reason);
      if (!tokens) return console.log('No tokens from previous test — skipping');

      const realm = authConfig()!.realm;
      const jwksUri = `${stackOutputs.keycloakUrl}/realms/${encodeURIComponent(realm)}/protocol/openid-connect/certs`;
      const expectedIssuer = `${stackOutputs.keycloakUrl}/realms/${realm}`;

      const result = await verifyTokenWithJwks(tokens.accessToken, jwksUri, expectedIssuer);
      expect(result.payload.iss).toBe(expectedIssuer);
      expect(result.payload.sub).toBeTruthy();
    });

    test('userinfo endpoint returns user details', async () => {
      const reason = skipIf();
      if (reason) return console.log(reason);
      if (!tokens) return console.log('No tokens from previous test — skipping');

      const userInfo = await getUserInfo(
        stackOutputs.keycloakUrl,
        authConfig()!.realm,
        tokens.accessToken,
      );

      expect(userInfo.sub).toBeTruthy();
      expect(userInfo.preferred_username).toBe(testUser.username);
    });
  });
});
