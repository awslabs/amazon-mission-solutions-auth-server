# CDK Technical Guide - Auth Server

This directory contains the AWS CDK (Cloud Development Kit) code for deploying the Authentication Server infrastructure (Keycloak). This is the comprehensive technical reference for deployment, configuration, and development.

## Overview

The Auth Server uses AWS CDK to define and deploy all required infrastructure for running a Keycloak authentication server. This includes:

- Amazon VPC with public and private subnets (or import existing VPC)
- Aurora MySQL RDS database
- ECS Fargate containers running Keycloak
- Application Load Balancer
- Lambda function for automating Keycloak configuration
- Secrets Manager secrets for credential management
- Route 53 records for custom domains (optional)

## Project Structure

```
cdk/
├── bin/                 # CDK app entry point
├── lib/                 # Core CDK constructs and stacks
│   ├── config/          # Configuration handling
│   ├── constructs/      # Custom CDK constructs
│   └── utils/           # Utility functions
├── config/              # Configuration files
│   ├── app-config.example.json     # Application configuration template
│   └── auth-config.example.json    # Keycloak realm configuration template
├── lambda/              # Lambda function code
│   └── keycloak-config/ # Keycloak configuration Lambda
├── test/                # Jest tests for CDK constructs
├── cdk.json             # CDK configuration
└── package.json         # Node.js dependencies
```

## Getting Started

### Prerequisites

- **Node.js** 24+ (LTS recommended)
- **TypeScript** 5.8.3+
- **AWS CLI** configured with appropriate credentials
- **AWS CDK** 2.207.0+ installed (`npm install -g aws-cdk@^2.207.0`)
- **Docker** (optional, for local Lambda testing)

### Installation

1. Install dependencies:

```bash
cd cdk
npm install
```

2. Configure your deployment by editing configuration files. See the Configuration section below for detailed instructions.

3. Deploy the stack:

```bash
npm run deploy
```

## Configuration

The project uses a hierarchical configuration system with two main configuration files:

### Configuration Hierarchy

1. **Application Configuration** (`config/app-config.json`): Infrastructure settings
2. **Authentication Configuration** (`config/auth-config.json`): Optional, post-install Keycloak settings

### Default Behavior (Fresh Keycloak Install)

By default, without any `auth-config.json` file, the deployment creates:
- A fresh Keycloak installation with only the master realm
- Master realm admin user (configurable username, defaults to "keycloak")
- Admin credentials stored in AWS Secrets Manager

This gives you a clean Keycloak server that you can configure manually through the admin console.

### Application Configuration (`config/app-config.json`)

Copy and customize the example configuration:

```bash
cp config/app-config.example.json config/app-config.json
```

Complete configuration example:

```json
{
  "projectName": "MyProject",
  "account": "123456789012",
  "region": "us-east-1",
  "isProd": false,
  "vpcId": "vpc-1234567890abcdef0",
  "domain": {
    "hostname": "auth.example.com",
    "internetFacing": true,
    "hostedZoneId": "Z1234567890",
    "certificateArn": "arn:aws:acm:region:account-id:certificate/certificate-id",
  },
  "database": {
    "instanceType": "r5.large"
  },
  "keycloak": {
    "adminUsername": "keycloak",
    "keycloakImage": "quay.io/keycloak/keycloak:26.0.7",
    "container": {
      "cpu": 4096,
      "memory": 8192,
      "minCount": 2,
      "maxCount": 10,
      "cpuUtilizationTarget": 75,
      "javaOpts": "-server -Xms1024m -Xmx1638m"
    }
  }
}
```

#### Configuration Parameters

**Core Settings:**
- `projectName`: Used for resource naming and tagging
- `account`: AWS account ID for deployment
- `region`: AWS region for deployment
- `isProd`: Boolean flag affecting security and scaling settings

**VPC Configuration Options:**

The CDK stack supports two VPC deployment modes:

**Use Existing VPC:**
- **Optional parameter**: `vpcId`
- **Behavior**: When `vpcId` is provided, the stack will import and use the specified existing VPC
- **Requirements**: The existing VPC must have both public and private subnets with internet connectivity (NAT Gateway or NAT Instance)
- **Use case**: Integrate with existing AWS infrastructure or share VPC resources across multiple stacks

**Create New VPC (Default):**
- **Default behavior**: When `vpcId` is not specified, the stack creates a new VPC
- **Configuration**: Creates a VPC with public and private subnets, NAT Gateway, and appropriate routing
- **Use case**: Standalone deployment with isolated network infrastructure

**VPC Requirements:**
For both existing and new VPCs, the deployment requires:
- Private subnets with egress connectivity (for ECS tasks and RDS database)
- Public subnets (for internet-facing load balancer, if `internetFacing: true`)
- Proper security group configurations will be created automatically

**Domain Configuration Options:**

The `domain` section supports two deployment modes:

**Internet-Facing Deployment (`internetFacing: true`):**
- **Required properties**: `hostname`, `hostedZoneId`, `certificateArn`
- **Creates**: Internet-facing Application Load Balancer with HTTPS listener and Route53 DNS record
- **Use case**: Public-facing Keycloak server accessible from the internet

**Internal-Only Deployment (`internetFacing: false`):**
- **Required properties**: `hostname` only
- **Creates**: Internal Application Load Balancer with HTTP listener, no DNS record
- **Use case**: Keycloak server only accessible within your AWS account/VPC
- **Access method**: Use the ALB's generated DNS name (available as a CloudFormation output: `LoadBalancerDNS`)

**Configuration Validation:**
- If `internetFacing: true`, the deployment will fail immediately if `hostedZoneId` or `certificateArn` are missing
- If `internetFacing: false`, only `hostname` is required
- The default value for `internetFacing` is `true`

**Database Configuration:**
- `instanceType`: RDS Aurora instance type (default: r5.large)

**Keycloak Configuration:**
- `adminUsername`: Master realm admin username
- `keycloakImage`: Docker image to use for Keycloak (default: `quay.io/keycloak/keycloak:latest`)
  - **Default behavior**: Uses the latest Keycloak image to avoid stale versions
  - **Version pinning**: Specify a specific version for reproducible deployments (e.g., `quay.io/keycloak/keycloak:26.0.7`)
  - **Custom images**: Use custom or organization-specific Keycloak images
  
  **Deployment Recommendation:**
  
  While the default uses `:latest` for development convenience, **it is strongly recommended to pin to a specific Keycloak version for  deployments** to ensure stability and predictable behavior.
  
  **Current Testing Status:**
  - This configuration has been tested and verified with **Keycloak v26.x** (current latest version)

  
  **Version Compatibility Notes:**
  - `container`: ECS container resource settings
  - `cpu`: CPU units (1024 = 1 vCPU)
  - `memory`: Memory in MB
  - `minCount`/`maxCount`: Auto-scaling limits
  - `cpuUtilizationTarget`: CPU target for auto-scaling (percentage)
  - `javaOpts`: JVM options for Keycloak

### Custom Authentication Configuration (`config/auth-config.json`)

To customize your Keycloak deployment with additional realms, clients, and users:

```bash
cp config/auth-config.example.json config/auth-config.json
```

Complete authentication configuration example:

```json
{
  "realm": "your-realm",
  "enabled": true,
  "displayName": "Your Authentication Realm",
  "clients": [
    {
      "clientId": "your-web-app",
      "name": "Your Web Application",
      "description": "Client for the web application",
      "websiteUri": "https://app.example.com",
      "publicClient": true,
      "authorizationServicesEnabled": false,
      "standardFlowEnabled": true,
      "directAccessGrantsEnabled": true,
      "implicitFlowEnabled": false,
      "serviceAccountsEnabled": false,
      "redirectUris": ["__PLACEHOLDER_REDIRECT_URI__"],
      "postLogoutRedirectUris": ["__PLACEHOLDER_REDIRECT_URI__"],
      "webOrigins": ["__PLACEHOLDER_WEB_ORIGIN__"]
    }
  ],
  "users": [
    {
      "username": "service-account",
      "generatePassword": true,
      "ssmPasswordPath": "users/service-account/password",
      "email": "service@example.com",
      "firstName": "Service",
      "lastName": "Account",
      "enabled": true
    }
  ]
}
```

**Placeholder Replacement:**
- `__PLACEHOLDER_REDIRECT_URI__` and `__PLACEHOLDER_WEB_ORIGIN__` will be automatically replaced with values from your `websiteUri` configuration
- For `__PLACEHOLDER_REDIRECT_URI__`: Uses `websiteUri + "/*"` (e.g., "https://app.example.com/*")
- For `__PLACEHOLDER_WEB_ORIGIN__`: Uses `websiteUri` origin (e.g., "https://app.example.com")

**Client Configuration Options:**
- `publicClient`: true for frontend applications, false for backend services
- `authorizationServicesEnabled`: Enable fine-grained authorization
- `standardFlowEnabled`: Enable authorization code flow (OAuth2)
- `directAccessGrantsEnabled`: Enable username/password authentication
- `implicitFlowEnabled`: Enable implicit flow (not recommended for production)
- `serviceAccountsEnabled`: Enable service account for client credentials flow

**User Configuration Options:**
- `generatePassword`: Automatically generate a secure password
- `ssmPasswordPath`: Store password in AWS Systems Manager Parameter Store
- All standard Keycloak user attributes are supported

## Development

### CDK Architecture

The CDK architecture is organized into several key components:

1. **KeycloakStack** (`lib/keycloak-stack.ts`): The main stack that coordinates all resources
2. **DatabaseConstruct** (`lib/constructs/database-construct.ts`): Creates the Aurora MySQL database
3. **KeycloakServiceConstruct** (`lib/constructs/keycloak-service-construct.ts`): Creates the Keycloak ECS Fargate service
4. **KeycloakConfigLambda** (`lib/constructs/keycloak-config-lambda.ts`): Creates the Lambda function for post-install Keycloak configuration

### Development Setup

1. **Install dependencies**
   ```bash
   cd cdk
   npm install
   ```

2. **Available Scripts**
   ```bash
   # Build TypeScript
   npm run build

   # Run all tests
   npm test

   # Run tests with coverage report
   npm run test:coverage

   # Run only Lambda-specific tests
   npm run test:lambda

   # Lint code (includes auto-fix)
   npm run lint

   # Lint code (check only, no auto-fix)
   npm run lint:check

   # Format code with Prettier
   npm run format

   # Check code formatting (no changes)
   npm run format:check

   # Synthesize CloudFormation template
   npm run synth

   # Watch mode for development
   npm run watch

   # Deploy to AWS
   npm run deploy

   # Direct CDK commands
   npm run cdk -- <command>
   ```

### Testing Framework

The project includes comprehensive testing:

#### CDK Infrastructure Tests
Located in `test/` directory:
- **Stack Construction Tests**: Verify CDK constructs create expected resources
- **Configuration Validation**: Test configuration loading and validation logic
- **Resource Property Tests**: Ensure resources have correct properties and relationships

#### Lambda Unit Tests
Located in `lambda/keycloak-config/test/`:
- **API Client Tests**: Keycloak Admin API integration
- **Configuration Tests**: Realm, client, and user configuration logic
- **AWS Integration Tests**: Secrets Manager and parameter store operations
- **Utility Function Tests**: Retry mechanisms, error handling, and validation

#### Test Categories
- **Configuration validation and loading**
- **Keycloak API integration**
- **AWS services integration (Secrets Manager)**
- **Health checks and error handling**
- **Utility functions**

#### Running Tests

```bash
# From CDK directory - run all tests
npm test

# Run only Lambda tests
npm run test:lambda

# Run with coverage report
npm run test:coverage

# Run specific test file
npm test -- keycloak-stack.test.ts
```

#### Test Organization

Tests can be run either from the CDK directory or from within the Lambda function directory:

**From the CDK directory:**
```bash
npm test                # Run all tests (CDK and Lambda)
npm run test:lambda     # Run only Lambda tests
npm run test:coverage   # Run all tests with coverage report
```

**From the Lambda directory:**
```bash
cd lambda/keycloak-config
npm test               # Run Lambda tests only
```

#### Coverage Goals
- **Branch coverage**: 70%+
- **Function coverage**: 80%+
- **Line coverage**: 80%+
- **Statement coverage**: 80%+

### Local Lambda Testing

For testing the Keycloak configuration Lambda locally:

```bash
cd lambda/keycloak-config
npm install

# Run unit tests
npm test

# Test Lambda handler locally (requires Docker and local environment setup)
node -e "require('./src/index').handler({}, {})"
```

### Adding Features

When adding new features:

1. **Create new constructs** in `lib/constructs/`
2. **Update the main stack** in `lib/keycloak-stack.ts`
3. **Add configuration options** to `lib/config/app-config.ts`
4. **Add comprehensive tests** in `test/`
5. **Update documentation** as needed

### Code Quality

The project enforces high code quality standards:

- **ESLint** with TypeScript support and strict rules
- **Prettier** for consistent code formatting
- **TypeScript** strict mode configuration
- **Pre-commit hooks** for code quality enforcement

### CI/CD Pipeline

The project includes GitHub Actions workflow (`.github/workflows/cdk.yml`) for:
- Automated testing on pull requests
- Code quality checks (linting, formatting)
- Security scanning
