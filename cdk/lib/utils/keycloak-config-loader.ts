/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface KeycloakUser {
  username: string;
  generatePassword: boolean;
  ssmPasswordPath?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
}

export interface KeycloakClient {
  clientId: string;
  name?: string;
  description?: string;
  websiteUri?: string;
  publicClient: boolean;
  authorizationServicesEnabled: boolean;
  standardFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  implicitFlowEnabled?: boolean;
  serviceAccountsEnabled?: boolean;
  redirectUris?: string[];
  postLogoutRedirectUris?: string[];
  webOrigins?: string[];
}

export interface KeycloakCustomConfig {
  realm: string;
  enabled: boolean;
  displayName?: string;
  clients: KeycloakClient[];
  users: KeycloakUser[];
}

export function loadKeycloakConfig(): KeycloakCustomConfig | null {
  const projectRoot = join(__dirname, '..', '..');
  const configPath = join(projectRoot, 'config', 'auth-config.json');

  let config: KeycloakCustomConfig | null = null;

  try {
    const configStr = readFileSync(configPath, 'utf8');
    config = JSON.parse(configStr) as KeycloakCustomConfig;
  } catch {
    return null;
  }

  if (config === null) {
    return null;
  }

  if (config.clients) {
    config.clients.forEach(client => {
      const websiteUri = client.websiteUri || '*';
      const redirectUri = websiteUri === '*' ? '*' : `${websiteUri}/*`;
      const webOrigin = websiteUri;

      if (client.redirectUris) {
        client.redirectUris = client.redirectUris.map(uri =>
          uri === '__PLACEHOLDER_REDIRECT_URI__' ? redirectUri : uri,
        );
      }

      if (client.postLogoutRedirectUris) {
        client.postLogoutRedirectUris = client.postLogoutRedirectUris.map(uri =>
          uri === '__PLACEHOLDER_REDIRECT_URI__' ? redirectUri : uri,
        );
      }

      if (client.webOrigins) {
        client.webOrigins = client.webOrigins.map(origin =>
          origin === '__PLACEHOLDER_WEB_ORIGIN__' ? webOrigin : origin,
        );
      }
    });
  }

  return config;
}
