#!/usr/bin/env node

/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import 'source-map-support/register';

import { App } from 'aws-cdk-lib';

import { loadConfig } from '../lib/config/app-config';
import { KeycloakStack } from '../lib/keycloak-stack';

const app = new App();
const config = loadConfig('auth-server');
const projectName = config.projectName;

console.log(
  `Deploying stack ${projectName}-AuthServer to region: ${config.env.region || 'default'}, account: ${config.env.account || 'default'}`,
);

new KeycloakStack(app, `${projectName}-AuthServer`, { config });

app.synth();
