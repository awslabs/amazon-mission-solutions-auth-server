/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Type definitions for Keycloak configuration.
 *
 * These types define the structure of Keycloak authentication configuration
 * including realms, clients, and users. The configuration is now loaded from
 * deployment.json under dataplaneConfig.KEYCLOAK_AUTH_CONFIG.
 */

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

export interface KeycloakRole {
  name: string;
  description?: string;
}

export interface KeycloakRolesConfig {
  realm?: KeycloakRole[];
}

export interface KeycloakCustomConfig {
  realm: string;
  enabled: boolean;
  displayName?: string;
  clients: KeycloakClient[];
  users: KeycloakUser[];
  roles?: KeycloakRolesConfig;
}
