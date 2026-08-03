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

/**
 * Shape of the properties supplied on the `Custom::KeycloakConfig` CloudFormation
 * Custom Resource.
 *
 * `AuthConfig` is transported as a JSON-encoded string (not a nested object)
 * to preserve primitive types across the CloudFormation Custom Resource wire.
 * CloudFormation stringifies every primitive leaf value inside
 * `ResourceProperties` before delivering the event to the Lambda, which would
 * turn booleans like `enabled: true` into `"true"` and silently break
 * strict-equality validation. Serializing the whole subtree preserves types
 * end-to-end, then `loadFromEvent` parses it back to a real
 * {@link KeycloakRealmConfig}.
 */
export interface KeycloakConfigResourceProperties {
  ServiceToken: string; // Injected by the CloudFormation Provider framework
  SsmPrefix: string;
  KeycloakAdminUsername?: string;
  AuthConfig: string;
  UserPasswordSecrets?: Record<string, string>;
}

/**
 * Normalized per-invocation configuration derived from the Custom Resource
 * properties
 */
export interface ResourceConfig {
  ssmPrefix: string;
  keycloakAdminUsername: string;
  authConfig: KeycloakRealmConfig;
  userPasswordSecrets: Record<string, string>;
}

/** Response returned by the Lambda handler for the Provider framework. */
export interface ProviderResponse {
  Status: 'SUCCESS' | 'FAILED';
  PhysicalResourceId: string;
  Data?: Record<string, unknown>;
  Reason?: string;
}

/**
 * Runtime configuration for the Keycloak Config Lambda.
 *
 * Environment-only tunables (timeouts and retry limits) are loaded once at
 * module load time. Per-invocation values are extracted from the incoming
 * CloudFormation Custom Resource event via `loadFromEvent`, which returns a
 * normalized {@link ResourceConfig} the handler holds for the duration of the
 * invocation.
 */
export interface AppConfig {
  // Environment-only tunables.
  API_TIMEOUT_MS: number;
  HEALTH_CHECK_MAX_ATTEMPTS: number;
  HEALTH_CHECK_INTERVAL_MS: number;
  API_MAX_RETRIES: number;
  API_RETRY_INTERVAL_MS: number;

  /** Extract normalized per-invocation config from the incoming CFN event. */
  loadFromEvent: (event: CloudFormationCustomResourceEvent) => ResourceConfig;
}

/** Parsed Keycloak realm configuration from the AuthConfig resource property. */
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
