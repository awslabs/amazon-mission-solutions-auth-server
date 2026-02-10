/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { Stack, StackProps } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

import { DeploymentConfig } from '../bin/deployment/load-deployment';
import { Dataplane, DataplaneConfig } from './constructs/auth-server/dataplane';

/**
 * Properties for the AuthServerStack.
 */
export interface AuthServerStackProps extends StackProps {
  /**
   * Deployment configuration containing project settings and dataplane config.
   */
  readonly deployment: DeploymentConfig;

  /**
   * VPC for deploying application resources.
   * This is required and should come from the NetworkStack.
   */
  readonly vpc: IVpc;

  /**
   * Security group for application resources.
   * If not provided, the Dataplane will create its own security group.
   */
  readonly securityGroup?: ISecurityGroup;
}

/**
 * AuthServerStack deploys the Keycloak authentication server and supporting resources.
 *
 * This stack creates the application layer (Dataplane) containing:
 * - Aurora MySQL database for Keycloak persistence
 * - ECS Fargate service running Keycloak
 * - Application Load Balancer for traffic routing
 * - Optional Keycloak configuration Lambda for realm/client setup
 * - Optional DNS records for custom domain
 *
 * For production deployments (prodLike=true), termination protection is enabled
 * to prevent accidental stack deletion.
 *
 * @example
 * ```typescript
 * // Create AuthServerStack with VPC from NetworkStack
 * const authServerStack = new AuthServerStack(app, "MyProject-Dataplane", {
 *   deployment: deploymentConfig,
 *   vpc: networkStack.network.vpc,
 *   env: { account: "123456789012", region: "us-west-2" }
 * });
 *
 * // Establish dependency on NetworkStack
 * authServerStack.addDependency(networkStack);
 * ```
 */
export class AuthServerStack extends Stack {
  /**
   * The Dataplane construct containing all application resources.
   */
  public readonly dataplane: Dataplane;

  /**
   * Creates a new AuthServerStack.
   *
   * @param scope - CDK scope (typically the App instance)
   * @param id - Stack identifier (typically `${projectName}-Dataplane`)
   * @param props - Stack properties including deployment configuration and VPC
   */
  constructor(scope: Construct, id: string, props: AuthServerStackProps) {
    super(scope, id, {
      ...props,
      description: `${props.deployment.projectName} Dataplane`,
      terminationProtection: props.deployment.account.prodLike,
    });

    // Create DataplaneConfig from deployment config or use defaults
    const dataplaneConfig = props.deployment.dataplaneConfig
      ? new DataplaneConfig(props.deployment.dataplaneConfig)
      : new DataplaneConfig();

    // Create a default security group if not provided
    const securityGroup =
      props.securityGroup ??
      new SecurityGroup(this, 'DataplaneSecurityGroup', {
        vpc: props.vpc,
        description: `Security group for ${props.deployment.projectName}`,
        allowAllOutbound: true,
      });

    // Create Dataplane construct
    this.dataplane = new Dataplane(this, 'Dataplane', {
      account: props.deployment.account,
      vpc: props.vpc,
      securityGroup,
      config: dataplaneConfig,
      projectName: props.deployment.projectName,
    });
  }
}
