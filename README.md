# AMS Auth Server

A complete authentication server for Amazon Mission Solutions (AMS) using Keycloak, deployed with AWS CDK.

## Overview

AMS Auth Server is a fully managed Keycloak deployment for handling authentication and authorization. It leverages AWS CDK to deploy a scalable, fault-tolerant Keycloak server on AWS with the following components:

- Keycloak server running on ECS Fargate
- Aurora MySQL database backend
- Application Load Balancer with HTTPS support
- Optional automatic realm, client, and user configuration
- Secure password management with AWS Secrets Manager

The project is designed to be **project-agnostic** with all project-specific settings externalized to configuration files, making it reusable for any authentication needs.

## Quick Start

### Prerequisites

Ensure you have the following tools and versions installed:

- **AWS Account** with appropriate permissions
- **AWS CLI** configured with credentials
- **Node.js** 24+ (LTS recommended)
- **AWS CDK** 2.207.0+ (`npm install -g aws-cdk@^2.207.0`)
- **Docker** (optional, for local Lambda testing)

### Basic Deployment

1. **Clone and install dependencies**
   ```bash
   git clone https://github.com/awslabs/ams-auth-server.git
   cd osml-auth-server/cdk
   npm install
   ```

2. **Configure your deployment**
   ```bash
   # Copy and customize application configuration
   cp config/app-config.example.json config/app-config.json

   # (Optional) Copy and customize authentication configuration
   cp config/auth-config.example.json config/auth-config.json
   ```

3. **Deploy the stack**
   ```bash
   npm run deploy
   ```

## Documentation

Further documentation is broken down by section.

### **Main Documentation**

- **[CDK Technical Guide](cdk/README.md)** - Complete deployment and development reference
  - Detailed configuration options and examples
  - Development workflows and testing procedures
  - CDK architecture and project structure
  - Troubleshooting and advanced usage

- **[Architecture Documentation](docs/README.md)** - System design and architecture
  - Architecture diagrams and component relationships
  - High availability and security features
  - Network topology and data flow
  - Deployment modes and scaling considerations

### **Component Documentation**

- **[Keycloak Configuration Lambda](cdk/lambda/keycloak-config/README.md)** - Lambda function details
  - Lambda architecture and functionality
  - Configuration options and environment variables
  - API integration and security considerations


## Default Behavior

By default, without any `auth-config.json` file, the deployment creates:
- A fresh Keycloak installation with only the master realm
- Master realm admin user (configurable username, defaults to "keycloak")
- Admin credentials stored in AWS Secrets Manager

This gives you a clean Keycloak server that you can configure manually through the admin console.

## Security

- All credentials are stored in AWS Secrets Manager
- Keycloak admin password is randomly generated during deployment
- Database is encrypted at rest and in transit
- All traffic uses HTTPS (when certificateArn is provided)
- Private subnets are used for all resources except the load balancer
- Least-privilege IAM policies for all resources

## License

This project is licensed under the Apache License 2.0 - see the [LICENSE](LICENSE) file for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for details on our code of conduct and the process for submitting pull requests.
