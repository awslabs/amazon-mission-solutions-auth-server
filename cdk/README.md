# CDK Technical Guide - Auth Server

This directory contains the AWS CDK (Cloud Development Kit) code for deploying the Authentication Server infrastructure (Keycloak). This is the comprehensive technical reference for deployment, configuration, and development.

## Overview

The Auth Server uses AWS CDK to define and deploy all required infrastructure for running a Keycloak authentication server. The infrastructure is organized into two separate stacks following OSML repository patterns:

- **NetworkStack** (`${projectName}-Network`): VPC and networking infrastructure
- **AuthServerStack** (`${projectName}-Dataplane`): Application resources including database, ECS service, and Lambda

### Infrastructure Components

- Amazon VPC with public and private subnets (or import existing VPC)
- Aurora MySQL RDS database
- ECS Fargate containers running Keycloak
- Application Load Balancer
- Lambda function for automating Keycloak configuration
- Secrets Manager secrets for credential management
- Route 53 records for custom domains (optional)
- VPC Flow Logs (retention varies by environment)

## Project Structure

```
cdk/
├── bin/                          # CDK app entry point
│   ├── app.ts                    # Main CDK application
│   └── deployment/               # Deployment configuration
│       ├── deployment.json       # Your deployment config (create from example)
│       ├── deployment.json.example
│       └── load-deployment.ts    # Configuration loader with validation
├── lib/                          # Core CDK constructs and stacks
│   ├── auth-server-stack.ts      # AuthServerStack (Dataplane)
│   ├── network-stack.ts          # NetworkStack
│   ├── constructs/               # Custom CDK constructs
│   │   ├── auth-server/          # Auth server specific constructs
│   │   │   ├── cache-ispn-jdbc-ping.xml # Infinispan cache config
│   │   │   ├── database.ts       # Aurora MySQL database
│   │   │   ├── dataplane.ts      # Dataplane construct
│   │   │   ├── ecs-roles.ts      # ECS IAM roles
│   │   │   ├── keycloak-config.ts # Keycloak configuration Lambda
│   │   │   ├── keycloak-service.ts # ECS Fargate service
│   │   │   ├── lambda-roles.ts   # Lambda IAM roles
│   │   │   └── network.ts        # Network construct
│   │   └── types.ts              # Shared types (OSMLAccount, BaseConfig)
│   └── utils/                    # Utility functions
│       └── keycloak-config-loader.ts # Keycloak auth config loader
├── lambda/                       # Lambda function code
│   └── keycloak-config/          # Keycloak configuration Lambda
├── test/                         # Jest tests for CDK constructs
├── cdk.json                      # CDK configuration
└── package.json                  # Node.js dependencies
```

## Getting Started

### Prerequisites

- **Node.js** 24+ (LTS recommended)
- **TypeScript** 5.8.3+
- **AWS CLI** configured with appropriate credentials
- **AWS CDK** 2.207.0+ installed (`npm install -g aws-cdk@^2.207.0`)
- **Docker** (optional, for local Lambda testing)

### Quick Start

1. Install dependencies:

```bash
cd cdk
npm install
```

2. Create your deployment configuration:

```bash
cp bin/deployment/deployment.json.example bin/deployment/deployment.json
```

3. Update `deployment.json` with your environment settings (see [Configuration](#configuration) below).

4. Bootstrap CDK (first-time only per account/region):

```bash
cdk bootstrap aws://ACCOUNT_ID/REGION
```

Use the same `account.id` and `account.region` from your `deployment.json`. Skip this if the account/region is already bootstrapped.

5. Deploy the stacks:

```bash
npm run build
cdk synth
cdk deploy --all
```

## Configuration

All configuration is managed through a single file: `bin/deployment/deployment.json`. This includes infrastructure settings, account configuration, and optional Keycloak realm/client/user setup.

### Complete Configuration Example

```json
{
  "projectName": "MyAuthServer",
  "account": {
    "id": "123456789012",
    "region": "us-west-2",
    "prodLike": false,
    "isAdc": false
  },
  "networkConfig": {
    "VPC_NAME": "auth-server-vpc",
    "MAX_AZS": 2,
    "SECURITY_GROUP_NAME": "auth-server-security-group"
  },
  "dataplaneConfig": {
    "KEYCLOAK_IMAGE": "quay.io/keycloak/keycloak:latest",
    "KEYCLOAK_ADMIN_USERNAME": "keycloak",
    "ECS_TASK_CPU": 4096,
    "ECS_TASK_MEMORY": 8192,
    "ECS_MIN_CONTAINERS": 2,
    "ECS_MAX_CONTAINERS": 10,
    "ECS_CPU_UTILIZATION_TARGET": 75,
    "JAVA_OPTS": "-server -Xms1024m -Xmx1638m",
    "DATABASE_INSTANCE_TYPE": "r5.large",
    "DOMAIN_INTERNET_FACING": true,
    "DOMAIN_HOSTED_ZONE_ID": "Z0123456789ABCDEFGHIJ",
    "DOMAIN_HOSTED_ZONE_NAME": "example.com",
    "KEYCLOAK_AUTH_CONFIG": {
      "realm": "my-realm",
      "enabled": true,
      "displayName": "My Authentication Realm",
      "clients": [
        {
          "clientId": "my-web-app",
          "name": "My Web Application",
          "websiteUri": "https://app.example.com",
          "publicClient": true,
          "authorizationServicesEnabled": false,
          "redirectUris": ["__PLACEHOLDER_REDIRECT_URI__"],
          "postLogoutRedirectUris": ["__PLACEHOLDER_REDIRECT_URI__"],
          "webOrigins": ["__PLACEHOLDER_WEB_ORIGIN__"]
        }
      ],
      "users": [
        {
          "username": "service-account",
          "generatePassword": true,
          "email": "service@example.com"
        }
      ]
    }
  }
}
```

**Note:** In this example, both `DOMAIN_CERTIFICATE_ARN` and `DOMAIN_HOSTNAME` are omitted. When `DOMAIN_HOSTED_ZONE_ID` and `DOMAIN_HOSTED_ZONE_NAME` are provided:

- The hostname defaults to `auth.{DOMAIN_HOSTED_ZONE_NAME}` (e.g., `auth.example.com`)
- An ACM certificate is automatically created with DNS validation
- ACM handles automatic certificate renewal

### Configuration Parameters

**Required Fields:**

| Field            | Description                                             | Validation                                  |
| ---------------- | ------------------------------------------------------- | ------------------------------------------- |
| `projectName`    | Project name used for stack naming and resource tagging | Non-empty string                            |
| `account.id`     | AWS Account ID                                          | Exactly 12 digits                           |
| `account.region` | AWS Region for deployment                               | Valid AWS region format (e.g., `us-west-2`) |

**Account Configuration:**

| Field              | Type    | Default | Description                                                                |
| ------------------ | ------- | ------- | -------------------------------------------------------------------------- |
| `account.prodLike` | boolean | `false` | Enables production settings (termination protection, longer log retention) |
| `account.isAdc`    | boolean | `false` | Indicates ADC (Air-gapped Data Center) environment                         |

**Network Configuration (`networkConfig`):**

| Field                 | Type     | Default                        | Description                                     |
| --------------------- | -------- | ------------------------------ | ----------------------------------------------- |
| `VPC_NAME`            | string   | `"auth-server-vpc"`            | Name for new VPC                                |
| `VPC_ID`              | string   | -                              | Import existing VPC (requires `TARGET_SUBNETS`) |
| `MAX_AZS`             | number   | `2`                            | Maximum Availability Zones                      |
| `TARGET_SUBNETS`      | string[] | -                              | Specific subnet IDs (required with `VPC_ID`)    |
| `SECURITY_GROUP_ID`   | string   | -                              | Import existing security group                  |
| `SECURITY_GROUP_NAME` | string   | `"auth-server-security-group"` | Name for new security group                     |

**Dataplane Configuration (`dataplaneConfig`):**

| Field                        | Type    | Default                              | Description                                                                           |
| ---------------------------- | ------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `KEYCLOAK_IMAGE`             | string  | `"quay.io/keycloak/keycloak:latest"` | Keycloak Docker image                                                                 |
| `KEYCLOAK_ADMIN_USERNAME`    | string  | `"keycloak"`                         | Admin username                                                                        |
| `ECS_TASK_CPU`               | number  | `4096`                               | CPU units (1024 = 1 vCPU)                                                             |
| `ECS_TASK_MEMORY`            | number  | `8192`                               | Memory in MB                                                                          |
| `ECS_MIN_CONTAINERS`         | number  | `2`                                  | Minimum container count                                                               |
| `ECS_MAX_CONTAINERS`         | number  | `10`                                 | Maximum container count                                                               |
| `ECS_CPU_UTILIZATION_TARGET` | number  | `75`                                 | Auto-scaling CPU target (%)                                                           |
| `JAVA_OPTS`                  | string  | `"-server -Xms1024m -Xmx1638m"`      | JVM options                                                                           |
| `DATABASE_INSTANCE_TYPE`     | string  | `"r5.large"`                         | RDS instance type                                                                     |
| `DOMAIN_HOSTNAME`            | string  | -                                    | Custom domain hostname (defaults to `auth.{DOMAIN_HOSTED_ZONE_NAME}` if not provided) |
| `DOMAIN_INTERNET_FACING`     | boolean | `true`                               | Internet-facing load balancer                                                         |
| `DOMAIN_CERTIFICATE_ARN`     | string  | -                                    | ACM certificate ARN (optional if `DOMAIN_HOSTED_ZONE_ID` provided)                    |
| `DOMAIN_HOSTED_ZONE_ID`      | string  | -                                    | Route53 hosted zone ID for DNS records and auto-certificate creation                  |
| `DOMAIN_HOSTED_ZONE_NAME`    | string  | -                                    | Route53 hosted zone name (required with `DOMAIN_HOSTED_ZONE_ID`)                      |
| `KEYCLOAK_AUTH_CONFIG`       | object  | -                                    | Keycloak realm configuration                                                          |

**Keycloak Auth Configuration (`dataplaneConfig.KEYCLOAK_AUTH_CONFIG`):**

This optional section configures Keycloak realms, clients, and users. When provided, a Lambda function is created to automatically configure Keycloak on deployment.

| Field         | Type    | Description                    |
| ------------- | ------- | ------------------------------ |
| `realm`       | string  | Realm name                     |
| `enabled`     | boolean | Whether the realm is enabled   |
| `displayName` | string  | Display name for the realm     |
| `clients`     | array   | Array of client configurations |
| `users`       | array   | Array of user configurations   |

**Placeholder Replacement in Auth Config:**

- `__PLACEHOLDER_REDIRECT_URI__` → `${websiteUri}/*`
- `__PLACEHOLDER_WEB_ORIGIN__` → `${websiteUri}`

### Common Deployment Scenarios

#### Scenario 1: New VPC (Default)

Create a new VPC with default settings:

```json
{
  "projectName": "MyAuthServer",
  "account": {
    "id": "123456789012",
    "region": "us-west-2",
    "prodLike": false,
    "isAdc": false
  }
}
```

This creates:

- New VPC named `auth-server-vpc` with 2 AZs
- Public and private subnets with NAT Gateway
- New security group
- VPC Flow Logs with 1-month retention

#### Scenario 2: Existing VPC

Use an existing VPC with specific subnets:

```json
{
  "projectName": "MyAuthServer",
  "account": {
    "id": "123456789012",
    "region": "us-west-2",
    "prodLike": false,
    "isAdc": false
  },
  "networkConfig": {
    "VPC_ID": "vpc-0123456789abcdef0",
    "TARGET_SUBNETS": ["subnet-11111111", "subnet-22222222"],
    "SECURITY_GROUP_ID": "sg-0123456789abcdef0"
  }
}
```

**Note:** When using `VPC_ID`, you must also provide `TARGET_SUBNETS`.

#### Scenario 3: Production Environment

Production deployment with enhanced security:

```json
{
  "projectName": "ProdAuthServer",
  "account": {
    "id": "123456789012",
    "region": "us-west-2",
    "prodLike": true,
    "isAdc": false
  },
  "dataplaneConfig": {
    "KEYCLOAK_IMAGE": "quay.io/keycloak/keycloak:26.0.7",
    "ECS_MIN_CONTAINERS": 3,
    "ECS_MAX_CONTAINERS": 20,
    "DATABASE_INSTANCE_TYPE": "r5.xlarge",
    "DOMAIN_HOSTNAME": "auth.example.com",
    "DOMAIN_INTERNET_FACING": true,
    "DOMAIN_CERTIFICATE_ARN": "arn:aws:acm:...",
    "DOMAIN_HOSTED_ZONE_ID": "Z..."
  }
}
```

Production settings enable:

- Stack termination protection
- Database deletion protection
- VPC Flow Logs with 1-month retention (log group retained on stack deletion)

#### Scenario 4: Internal-Only Deployment

Internal load balancer without public DNS:

```json
{
  "projectName": "InternalAuth",
  "account": {
    "id": "123456789012",
    "region": "us-west-2",
    "prodLike": false,
    "isAdc": false
  },
  "dataplaneConfig": {
    "DOMAIN_INTERNET_FACING": false
  }
}
```

**Note:** When `DOMAIN_INTERNET_FACING` is `false`, `DOMAIN_HOSTNAME` is optional (will use ALB DNS) and TLS is not required.

#### Scenario 5: Public Deployment with Auto-Created Certificate

For public-facing deployments, TLS is required. You can either provide an existing certificate ARN or let CDK create one automatically using DNS validation:

```json
{
  "projectName": "PublicAuth",
  "account": {
    "id": "123456789012",
    "region": "us-west-2",
    "prodLike": false,
    "isAdc": false
  },
  "dataplaneConfig": {
    "DOMAIN_INTERNET_FACING": true,
    "DOMAIN_HOSTED_ZONE_ID": "Z0123456789ABCDEFGHIJ",
    "DOMAIN_HOSTED_ZONE_NAME": "example.com"
  }
}
```

When `DOMAIN_HOSTED_ZONE_ID` and `DOMAIN_HOSTED_ZONE_NAME` are provided without `DOMAIN_CERTIFICATE_ARN`:

- The hostname defaults to `auth.{DOMAIN_HOSTED_ZONE_NAME}` (e.g., `auth.example.com`)
- An ACM certificate is automatically created with DNS validation
- The certificate is validated using Route53 DNS records (created automatically)
- ACM handles automatic certificate renewal (no manual intervention needed)
- In production (`prodLike: true`), the certificate is retained on stack deletion
- In non-production, the certificate is deleted with the stack

**Note:** If you prefer to manage certificates separately, provide `DOMAIN_CERTIFICATE_ARN` instead. You can also override the default hostname by providing `DOMAIN_HOSTNAME`.

### Stack Naming Convention

Stacks are named using the pattern `${projectName}-<StackType>`:

| Stack     | Name Pattern               | Example                  |
| --------- | -------------------------- | ------------------------ |
| Network   | `${projectName}-Network`   | `MyAuthServer-Network`   |
| Dataplane | `${projectName}-Dataplane` | `MyAuthServer-Dataplane` |

## Migration from Old Configuration

If you're migrating from the old `config/app-config.json` format:

### Step 1: Create New Configuration

```bash
cp bin/deployment/deployment.json.example bin/deployment/deployment.json
```

### Step 2: Map Old Fields to New Format

| Old Field (`app-config.json`)             | New Field (`deployment.json`)                |
| ----------------------------------------- | -------------------------------------------- |
| `projectName`                             | `projectName`                                |
| `account`                                 | `account.id`                                 |
| `region`                                  | `account.region`                             |
| `isProd`                                  | `account.prodLike`                           |
| `vpcId`                                   | `networkConfig.VPC_ID`                       |
| `domain.hostname`                         | `dataplaneConfig.DOMAIN_HOSTNAME`            |
| `domain.internetFacing`                   | `dataplaneConfig.DOMAIN_INTERNET_FACING`     |
| `domain.hostedZoneId`                     | `dataplaneConfig.DOMAIN_HOSTED_ZONE_ID`      |
| `domain.certificateArn`                   | `dataplaneConfig.DOMAIN_CERTIFICATE_ARN`     |
| `database.instanceType`                   | `dataplaneConfig.DATABASE_INSTANCE_TYPE`     |
| `keycloak.adminUsername`                  | `dataplaneConfig.KEYCLOAK_ADMIN_USERNAME`    |
| `keycloak.keycloakImage`                  | `dataplaneConfig.KEYCLOAK_IMAGE`             |
| `keycloak.container.cpu`                  | `dataplaneConfig.ECS_TASK_CPU`               |
| `keycloak.container.memory`               | `dataplaneConfig.ECS_TASK_MEMORY`            |
| `keycloak.container.minCount`             | `dataplaneConfig.ECS_MIN_CONTAINERS`         |
| `keycloak.container.maxCount`             | `dataplaneConfig.ECS_MAX_CONTAINERS`         |
| `keycloak.container.cpuUtilizationTarget` | `dataplaneConfig.ECS_CPU_UTILIZATION_TARGET` |
| `keycloak.container.javaOpts`             | `dataplaneConfig.JAVA_OPTS`                  |

### Step 3: Migrate Auth Configuration

If you had a separate `config/auth-config.json`, move its contents into `dataplaneConfig.KEYCLOAK_AUTH_CONFIG`:

```json
{
  "dataplaneConfig": {
    "KEYCLOAK_AUTH_CONFIG": {
      // Contents of your old auth-config.json
    }
  }
}
```

### Step 4: Update Stack References

The stack names have changed:

- Old: `KeycloakStack`
- New: `${projectName}-Network` and `${projectName}-Dataplane`

Update any external references to CloudFormation outputs.

### Step 5: Delete Old Configuration Files

After successful migration:

```bash
rm config/app-config.json
rm config/auth-config.json  # If it existed
```

## Troubleshooting

### Common Errors

#### Missing deployment.json

```
DeploymentConfigError: Missing deployment.json file at /path/to/bin/deployment/deployment.json.
Please create it by copying deployment.json.example
```

**Solution:** Copy the example file:

```bash
cp bin/deployment/deployment.json.example bin/deployment/deployment.json
```

#### Invalid AWS Account ID

```
DeploymentConfigError: Invalid AWS account ID format: 'abc123'. Must be exactly 12 digits.
```

**Solution:** Ensure `account.id` is exactly 12 digits (e.g., `"123456789012"`).

#### Invalid AWS Region

```
DeploymentConfigError: Invalid AWS region format: 'invalid'. Must follow pattern like 'us-east-1'.
```

**Solution:** Use a valid AWS region format (e.g., `us-west-2`, `eu-west-1`).

#### Invalid VPC ID Format

```
DeploymentConfigError: Invalid VPC ID format: 'my-vpc'. Must start with 'vpc-' followed by 8 or 17 hexadecimal characters.
```

**Solution:** Use the correct VPC ID format (e.g., `vpc-0123456789abcdef0`).

#### Missing TARGET_SUBNETS with VPC_ID

```
DeploymentConfigError: When VPC_ID is provided, TARGET_SUBNETS must also be specified with at least one subnet ID
```

**Solution:** Add `TARGET_SUBNETS` array when using an existing VPC:

```json
{
  "networkConfig": {
    "VPC_ID": "vpc-...",
    "TARGET_SUBNETS": ["subnet-...", "subnet-..."]
  }
}
```

#### Invalid Security Group ID

```
DeploymentConfigError: Invalid security group ID format: 'my-sg'. Must start with 'sg-' followed by 8 or 17 hexadecimal characters.
```

**Solution:** Use the correct security group ID format (e.g., `sg-0123456789abcdef0`).

#### DOMAIN_HOSTNAME Required for Internet-Facing

```
Error: DOMAIN_HOSTNAME or DOMAIN_HOSTED_ZONE_NAME is required when DOMAIN_INTERNET_FACING is true (public-facing deployment)
```

**Solution:** Either provide a `DOMAIN_HOSTNAME`, `DOMAIN_HOSTED_ZONE_NAME` (hostname defaults to `auth.{zoneName}`), or set `DOMAIN_INTERNET_FACING` to `false`:

```json
{
  "dataplaneConfig": {
    "DOMAIN_INTERNET_FACING": false
  }
}
```

#### DOMAIN_HOSTED_ZONE_NAME Required with DOMAIN_HOSTED_ZONE_ID

```
Error: DOMAIN_HOSTED_ZONE_NAME is required when DOMAIN_HOSTED_ZONE_ID is provided.
```

**Solution:** When using `DOMAIN_HOSTED_ZONE_ID`, you must also provide `DOMAIN_HOSTED_ZONE_NAME`:

```json
{
  "dataplaneConfig": {
    "DOMAIN_HOSTED_ZONE_ID": "Z0123456789ABCDEFGHIJ",
    "DOMAIN_HOSTED_ZONE_NAME": "example.com"
  }
}
```

#### TLS Required for Public-Facing Deployments

```
Error: TLS is required for public-facing deployments. Provide either DOMAIN_CERTIFICATE_ARN or DOMAIN_HOSTED_ZONE_ID (to auto-create an ACM certificate with DNS validation).
```

**Solution:** For internet-facing deployments, you must configure TLS. Either:

1. Provide an existing certificate:

```json
{
  "dataplaneConfig": {
    "DOMAIN_HOSTNAME": "auth.example.com",
    "DOMAIN_INTERNET_FACING": true,
    "DOMAIN_CERTIFICATE_ARN": "arn:aws:acm:us-west-2:123456789012:certificate/..."
  }
}
```

2. Or let CDK create one automatically (recommended):

```json
{
  "dataplaneConfig": {
    "DOMAIN_INTERNET_FACING": true,
    "DOMAIN_HOSTED_ZONE_ID": "Z0123456789ABCDEFGHIJ",
    "DOMAIN_HOSTED_ZONE_NAME": "example.com"
  }
}
```

**Note:** HTTP-only is allowed for internal deployments (`DOMAIN_INTERNET_FACING: false`).

### Deployment Issues

#### VPC Not Found During Import

If CDK fails to find your VPC during synthesis:

1. Verify the VPC ID is correct
2. Ensure you're deploying to the correct region
3. Check that your AWS credentials have permission to describe VPCs

#### Stack Dependency Errors

The AuthServerStack depends on NetworkStack. If you see dependency errors:

1. Ensure both stacks are being deployed
2. Check that the Network stack completes before Dataplane

## Development

### Available Scripts

```bash
# Build TypeScript
npm run build

# Run all tests
npm test

# Watch mode for development
npm run watch

# Run any CDK command
cdk synth
cdk deploy --all
cdk diff
cdk destroy
```

#### Development Commands

These commands can be run directly with `npx`:

```bash
# Run only Lambda tests
npx jest --selectProjects keycloak-lambda

# Run tests with coverage
npx jest --coverage

# Lint code (with auto-fix)
npx eslint --max-warnings 10 --fix "**/*.{js,ts}"

# Check linting (no auto-fix)
npx eslint --max-warnings 10 "**/*.{js,ts}"

# Format code
npx prettier --write "**/*.{ts,js}"

# Check formatting
npx prettier --check "**/*.{ts,js}"
```

### Testing

The project includes comprehensive tests:

- **CDK Infrastructure Tests** (`test/`): Stack and construct tests
- **Lambda Unit Tests** (`lambda/keycloak-config/test/`): Keycloak configuration Lambda tests

```bash
# Run all tests
npm test

# Run specific test file
npm test -- auth-server-stack.test.ts

# Run with verbose output
npm test -- --verbose
```

### Adding Features

1. Create new constructs in `lib/constructs/auth-server/`
2. Update the appropriate stack (`network-stack.ts` or `auth-server-stack.ts`)
3. Add configuration options to `load-deployment.ts`
4. Add comprehensive tests in `test/`
5. Update this documentation

## CloudFormation Outputs

The AuthServerStack exports the following outputs:

| Output                   | Description                                  |
| ------------------------ | -------------------------------------------- |
| `LoadBalancerDNS`        | DNS name of the Application Load Balancer    |
| `KeycloakUrl`            | URL to access Keycloak                       |
| `KeycloakAdminSecretArn` | ARN of the Keycloak admin credentials secret |

Access outputs via AWS CLI:

```bash
aws cloudformation describe-stacks \
  --stack-name MyAuthServer-Dataplane \
  --query 'Stacks[0].Outputs'
```
