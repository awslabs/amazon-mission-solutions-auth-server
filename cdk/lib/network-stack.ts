/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { Stack, StackProps } from 'aws-cdk-lib';
import { IVpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

import { DeploymentConfig } from '../bin/deployment/load-deployment';
import { Network, NetworkConfig } from './constructs/auth-server/network';

/**
 * Properties for the NetworkStack.
 */
export interface NetworkStackProps extends StackProps {
  /**
   * Deployment configuration containing project settings and network config.
   */
  readonly deployment: DeploymentConfig;

  /**
   * Optional pre-existing VPC to use instead of creating or importing one.
   * Takes precedence over deployment.networkConfig.VPC_ID.
   */
  readonly vpc?: IVpc;
}

/**
 * NetworkStack manages VPC and networking infrastructure.
 *
 * This stack creates or imports VPC resources, security groups, and configures
 * networking for the auth server deployment. It follows the OSML pattern of
 * separating network infrastructure from application resources.
 *
 * The stack supports three VPC resolution modes:
 * 1. Use a provided VPC directly (props.vpc)
 * 2. Import an existing VPC by ID (deployment.networkConfig.VPC_ID)
 * 3. Create a new VPC with default settings
 *
 * @example
 * ```typescript
 * // Create with new VPC
 * const networkStack = new NetworkStack(app, "MyProject-Network", {
 *   deployment: deploymentConfig,
 *   env: { account: "123456789012", region: "us-west-2" }
 * });
 *
 * // Create with existing VPC
 * const networkStack = new NetworkStack(app, "MyProject-Network", {
 *   deployment: deploymentConfig,
 *   vpc: existingVpc,
 *   env: { account: "123456789012", region: "us-west-2" }
 * });
 * ```
 */
export class NetworkStack extends Stack {
  /**
   * The Network construct containing VPC, security groups, and subnet selection.
   */
  public readonly network: Network;

  /**
   * Creates a new NetworkStack.
   *
   * @param scope - CDK scope (typically the App instance)
   * @param id - Stack identifier (typically `${projectName}-Network`)
   * @param props - Stack properties including deployment configuration
   */
  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    // Create NetworkConfig from deployment config or use defaults
    const networkConfig = props.deployment.networkConfig ?? new NetworkConfig();

    // Create Network construct
    this.network = new Network(this, 'Network', {
      account: props.deployment.account,
      config: networkConfig,
      vpc: props.vpc,
    });
  }
}
