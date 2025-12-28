#!/usr/bin/env node

/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 *
 * CDK Application Entry Point
 *
 * This is the main entry point for the Auth Server CDK application.
 * It loads deployment configuration and creates the necessary stacks:
 * - NetworkStack: VPC and networking infrastructure
 * - AuthServerStack: Keycloak authentication server and supporting resources
 */

import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { AuthServerStack } from '../lib/auth-server-stack';
import { NetworkStack } from '../lib/network-stack';
import { loadDeploymentConfig } from './deployment/load-deployment';

// Load deployment configuration
const deployment = loadDeploymentConfig();

// Create CDK app
const app = new App();

// Define environment for stacks
const env = {
  account: deployment.account.id,
  region: deployment.account.region,
};

// Create NetworkStack
const networkStack = new NetworkStack(app, `${deployment.projectName}-Network`, {
  deployment,
  env,
});

// Create AuthServerStack with VPC from NetworkStack
const authServerStack = new AuthServerStack(app, `${deployment.projectName}-Dataplane`, {
  deployment,
  vpc: networkStack.network.vpc,
  securityGroup: networkStack.network.securityGroup,
  env,
});

// Establish explicit dependency
authServerStack.addDependency(networkStack);

app.synth();
