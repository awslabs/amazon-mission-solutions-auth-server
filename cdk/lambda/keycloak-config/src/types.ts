/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Type definitions for the Keycloak Configuration Lambda.
 *
 * These types are specific to the Lambda runtime and intentionally separate
 * from CDK-level types (which include deployment-time fields like
 * generatePassword and ssmPasswordPath that don't exist at runtime).
 */

/** CloudFormation Custom Resource event received by the Lambda handler. */
export interface CloudFormationCustomResourceEvent {
  RequestType: 'Create' | 'Update' | 'Delete';
  ServiceToken: string;
  ResponseURL: string;
  StackId: string;
  RequestId: string;
  ResourceType: string;
  LogicalResourceId: string;
  PhysicalResourceId?: string;
  ResourceProperties: Record<string, unknown>;
  OldResourceProperties?: Record<string, unknown>;
}

/** Response returned by the Lambda handler for the Provider framework. */
export interface ProviderResponse {
  Status: 'SUCCESS' | 'FAILED';
  PhysicalResourceId: string;
  Data?: Record<string, unknown>;
  Reason?: string;
}

/** Runtime configuration loaded from environment variables. */
export interface AppConfig {
  SSM_PREFIX: string;
  KEYCLOAK_ADMIN_USERNAME: string;
  WEBSITE_URI: string;
  AUTH_CONFIG: string;
  USER_PASSWORD_SECRETS: string;
  API_TIMEOUT_MS: number;
  HEALTH_CHECK_MAX_ATTEMPTS: number;
  HEALTH_CHECK_INTERVAL_MS: number;
  API_MAX_RETRIES: number;
  API_RETRY_INTERVAL_MS: number;
  getAuthConfig: () => KeycloakRealmConfig | null;
  getUserPasswordSecrets: () => Record<string, string>;
}

/** Parsed Keycloak realm configuration from AUTH_CONFIG env var. */
export interface KeycloakRealmConfig {
  realm: string;
  enabled?: boolean;
  displayName?: string;
  clients?: KeycloakClientConfig[];
  users?: KeycloakUserConfig[];
  roles?: KeycloakRolesConfig;
  [key: string]: unknown;
}

/** Client configuration within a realm. */
export interface KeycloakClientConfig {
  clientId: string;
  name?: string;
  publicClient?: boolean;
  standardFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  redirectUris?: string[];
  webOrigins?: string[];
  websiteUri?: string;
  postLogoutRedirectUris?: string[];
  attributes?: Record<string, string>;
  enabled?: boolean;
  [key: string]: unknown;
}

/** User configuration within a realm. */
export interface KeycloakUserConfig {
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
}

/** Role configuration. */
export interface KeycloakRoleConfig {
  name: string;
  description?: string;
}

/** Roles configuration container. */
export interface KeycloakRolesConfig {
  realm?: KeycloakRoleConfig[];
}

/** Admin credentials retrieved from Secrets Manager. */
export interface AdminCredentials {
  username: string;
  password: string;
}

/** Validation result for a single check. */
export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

/** Full validation result with all details. */
export interface FullValidationResult {
  allValid: boolean;
  failureReason: string;
  details: {
    realmValid: boolean;
    clientsValid: boolean;
    usersValid: boolean;
    rolesValid: boolean;
  };
}

/** Tracks which resources were successfully created/updated. */
export interface VerificationResults {
  realmCreated: boolean;
  clientsCreated: boolean;
  usersCreated: boolean;
  rolesCreated: boolean;
}

/** HTTP methods used by makeAuthenticatedRequest. */
export type HttpMethod = 'get' | 'post' | 'put' | 'delete';

/** Keycloak client as returned by the Keycloak REST API. */
export interface KeycloakClientResponse {
  id: string;
  clientId: string;
  name?: string;
  publicClient?: boolean;
  standardFlowEnabled?: boolean;
  directAccessGrantsEnabled?: boolean;
  redirectUris?: string[];
  webOrigins?: string[];
  attributes?: Record<string, string>;
  enabled?: boolean;
  [key: string]: unknown;
}

/** Keycloak user as returned by the Keycloak REST API. */
export interface KeycloakUserResponse {
  id: string;
  username: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  enabled?: boolean;
  emailVerified?: boolean;
  [key: string]: unknown;
}
