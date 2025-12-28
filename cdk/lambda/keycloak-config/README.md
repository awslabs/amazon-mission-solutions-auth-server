# Keycloak Configuration Lambda

This Lambda function provides automated post-deployment configuration for Keycloak authentication servers. It eliminates the need for manual setup through the admin console by programmatically configuring realms, clients, users, and roles.

> **Note**: This Lambda is only deployed if the optional `auth-config.json` configuration file is present at the time of initial deployment. Without this file, the CDK stack creates a fresh Keycloak installation with only the master realm.

## Functionality

The Lambda performs the following operations in sequence:

1. **Health Check**: Waits for Keycloak server to be fully ready and operational
2. **Authentication**: Authenticates with Keycloak admin API using stored credentials
3. **Realm Management**: Creates or updates custom realms with specified settings
4. **Client Configuration**: Sets up OAuth/OIDC clients with proper redirect URIs and permissions
5. **User Management**: Creates users with secure passwords stored in AWS Secrets Manager
6. **Validation**: Verifies all configurations were applied successfully

## Lambda Architecture

The function code is organized into focused modules:

- **`index.js`** - Main Lambda handler and workflow orchestration
- **`config.js`** - Environment variable validation and configuration parsing
- **`aws-utils.js`** - AWS SDK utilities (Secrets Manager, Parameter Store)
- **`health-check.js`** - Keycloak server health monitoring and readiness checks
- **`keycloak-api.js`** - Keycloak Admin REST API client implementation
- **`utils.js`** - Retry logic, error handling, and validation utilities

## Environment Variables

The Lambda is configured through the following environment variables:

| Variable                    | Description                                                  | Required |
| --------------------------- | ------------------------------------------------------------ | -------- |
| `KEYCLOAK_URL`              | Base URL of the Keycloak server                              | Yes      |
| `KEYCLOAK_ADMIN_SECRET_ARN` | ARN of Secrets Manager secret containing admin credentials   | Yes      |
| `KEYCLOAK_ADMIN_USERNAME`   | Master realm admin username (must match secret)              | Yes      |
| `WEBSITE_URI`               | Base URI for client redirect/origin configuration            | Yes      |
| `REALM_CONFIG`              | JSON string containing realm, client, and user configuration | No       |
| `USER_PASSWORD_SECRETS`     | JSON mapping of usernames to password secret ARNs            | No       |
| `LOAD_BALANCER_DNS`         | Alternative DNS name if different from KEYCLOAK_URL          | No       |

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
- **Validation**: Configuration verification and health checks

### AWS Services Integration

- **Secrets Manager**: Retrieval of admin credentials and user passwords
- **Parameter Store**: Optional storage of configuration parameters
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

## Dependencies

| Package       | Version  | Purpose                                   |
| ------------- | -------- | ----------------------------------------- |
| `aws-sdk`     | Latest   | AWS service integration (Secrets Manager) |
| `axios`       | ^1.x     | HTTP client for Keycloak API requests     |
| `querystring` | Built-in | URL encoding for form data                |

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
