# Keycloak Configuration Lambda

This Lambda function provides automated post-deployment configuration for Keycloak authentication servers. It eliminates the need for manual setup through the admin console by programmatically configuring realms, clients, users, and roles.

> **Note**: This Lambda is only deployed if `KEYCLOAK_AUTH_CONFIG` is present in `deployment.json` at the time of deployment. Without this configuration, the CDK stack creates a fresh Keycloak installation with only the master realm.

## Functionality

The Lambda performs the following operations in sequence:

1. **Health Check**: Waits for Keycloak server to be fully ready and operational
2. **Authentication**: Authenticates with Keycloak admin API using stored credentials
3. **Realm Management**: Creates or updates custom realms with specified settings
4. **Client Configuration**: Sets up OAuth/OIDC clients with proper redirect URIs and permissions
5. **User Management**: Creates users with secure passwords stored in AWS Secrets Manager
6. **Role Management**: Creates or updates realm roles defined in configuration
7. **Validation**: Verifies all configurations were applied successfully

## Lambda Architecture

The function is organized into focused modules:

- **`index.ts`** — Main Lambda handler and workflow orchestration
- **`src/types.ts`** — Runtime type definitions (events, responses, Keycloak config interfaces)
- **`src/config.ts`** — Environment variable validation and configuration parsing
- **`src/config-validation.ts`** — Configuration validation after deployment
- **`src/aws-utils.ts`** — AWS SDK utilities (Secrets Manager)
- **`src/health-check.ts`** — Keycloak server health monitoring and readiness checks
- **`src/keycloak-api.ts`** — Keycloak Admin REST API client implementation
- **`src/utils.ts`** — Retry logic, error handling, and validation utilities

## Build Process

The Lambda source is TypeScript, compiled to JavaScript before deployment:

- **Source**: `index.ts` + `src/*.ts`
- **Compiler config**: `tsconfig.json`
- **Output**: `dist/` directory (compiled JS)
- **Runtime**: Node.js 24 (`NODEJS_24_X`)
- **Bundling**: CDK runs `npm ci`, `npx tsc`, then copies `dist/` with production-only `node_modules` into the Lambda deployment package

## Environment Variables

The Lambda is configured through the following environment variables:

| Variable                    | Description                                                  | Required | Default    |
| --------------------------- | ------------------------------------------------------------ | -------- | ---------- |
| `KEYCLOAK_URL`              | Base URL of the Keycloak server                              | Yes      | —          |
| `KEYCLOAK_ADMIN_SECRET_ARN` | ARN of Secrets Manager secret containing admin credentials   | Yes      | —          |
| `KEYCLOAK_ADMIN_USERNAME`   | Master realm admin username (must match secret)              | No       | `keycloak` |
| `AUTH_CONFIG`               | JSON string containing realm, client, and user configuration | No       | `{}`       |
| `USER_PASSWORD_SECRETS`     | JSON mapping of usernames to password secret ARNs            | No       | `{}`       |
| `API_TIMEOUT_MS`            | Timeout in milliseconds for Keycloak API requests            | No       | `30000`    |
| `HEALTH_CHECK_MAX_ATTEMPTS` | Maximum number of health check retry attempts                | No       | `30`       |
| `HEALTH_CHECK_INTERVAL_MS`  | Interval in milliseconds between health check attempts       | No       | `20000`    |
| `API_MAX_RETRIES`           | Maximum number of retries for API calls (e.g., login)        | No       | `10`       |
| `API_RETRY_INTERVAL_MS`     | Interval in milliseconds between API call retries            | No       | `20000`    |

## Health Check Strategy

The Lambda implements robust health checking with retry logic:

- **Basic Health Check**: Validates Keycloak server is responding to requests
- **Admin API Check**: Confirms admin API is accessible and authentication works
- **Retry Logic**: Exponential backoff with configurable maximum attempts
- **Jitter**: Random delay variation to prevent thundering herd issues

## API Integration

### Keycloak Admin REST API

The Lambda interacts with Keycloak's Admin REST API for:

- **Authentication**: OAuth2 client credentials flow for admin access
- **Realm Management**: CRUD operations on realms and their settings
- **Client Management**: OAuth/OIDC client configuration and permissions
- **User Management**: User creation, password setting, and profile updates
- **Role Management**: Creation and updates of realm-level roles
- **Validation**: Configuration verification and health checks

### AWS Services Integration

- **Secrets Manager**: Retrieval of admin credentials and user passwords
- **CloudFormation**: Custom Resource integration for deployment automation

## Error Handling and Security

### Error Categories

- **Configuration Errors**: Invalid environment variables or malformed JSON
- **Connection Errors**: Network connectivity issues with Keycloak or AWS services
- **Authentication Errors**: Invalid credentials or permission issues
- **API Errors**: Keycloak API failures or validation errors

### Security Features

- **Credential Protection**: Never logs passwords or sensitive information
- **AWS IAM Integration**: Uses IAM roles for secure AWS service access
- **Encrypted Storage**: All credentials stored encrypted in Secrets Manager
- **Least Privilege**: Minimal required permissions for operation

## Usage Patterns

### CloudFormation Custom Resource

Primary usage is as a CloudFormation Custom Resource:

```typescript
const configFunction = new CustomResource(this, 'KeycloakConfig', {
  serviceToken: lambdaFunction.functionArn,
  properties: {
    KeycloakUrl: loadBalancer.loadBalancerDnsName,
    AdminSecretArn: adminSecret.secretArn,
    // ... other configuration
  },
});
```

### Standalone Invocation

Can also be invoked directly for configuration updates:

```bash
aws lambda invoke \
  --function-name keycloak-config-function \
  --payload '{"RequestType": "Update"}' \
  response.json
```

## Development and Testing

For comprehensive development workflows, testing procedures, and contribution guidelines, see the **[CDK Technical Guide](../../README.md)**.

Key development considerations:

- Follow the established modular architecture
- Add comprehensive unit tests for new functionality
- Validate all environment variables and configuration inputs
- Implement appropriate error handling and logging
- Test thoroughly with actual Keycloak deployments

## Integration with CDK Stack

This Lambda is deployed and managed as part of the broader CDK infrastructure stack. For deployment configuration, monitoring setup, and operational procedures, refer to the main CDK documentation.
