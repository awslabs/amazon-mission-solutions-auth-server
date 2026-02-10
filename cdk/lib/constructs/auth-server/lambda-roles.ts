/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { region_info } from 'aws-cdk-lib';
import {
  Effect,
  IRole,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { OSMLAccount } from '../types';

/**
 * Properties for creating Lambda roles.
 */
export interface LambdaRolesProps {
  /** The OSML account configuration. */
  readonly account: OSMLAccount;
  /** The name for the config Lambda role. */
  readonly configLambdaRoleName: string;
  /** The name for the provider Lambda role. */
  readonly providerRoleName: string;
  /** Optional existing config Lambda role to use instead of creating one. */
  readonly existingConfigLambdaRole?: IRole;
  /** Optional existing provider role to use instead of creating one. */
  readonly existingProviderRole?: IRole;
}

/**
 * Construct that manages Lambda roles for the Auth Server.
 *
 * This construct creates roles for:
 * - Keycloak Config Lambda: Configures Keycloak with realms, clients, and users
 * - Provider Lambda: CloudFormation custom resource provider
 */
export class LambdaRoles extends Construct {
  /** The Keycloak config Lambda role. */
  public readonly configLambdaRole: IRole;

  /** The CloudFormation provider Lambda role. */
  public readonly providerRole: IRole;

  /** The AWS partition in which the roles will operate. */
  public readonly partition: string;

  /**
   * Creates a new LambdaRoles construct.
   *
   * @param scope - The scope/stack in which to define this construct
   * @param id - The id of this construct within the current scope
   * @param props - The properties for configuring this construct
   */
  constructor(scope: Construct, id: string, props: LambdaRolesProps) {
    super(scope, id);

    this.partition = region_info.Fact.find(props.account.region, region_info.FactName.PARTITION)!;

    // Create or use existing config Lambda role
    this.configLambdaRole = props.existingConfigLambdaRole || this.createConfigLambdaRole(props);

    // Create or use existing provider role
    this.providerRole = props.existingProviderRole || this.createProviderRole(props);
  }

  /**
   * Creates the Keycloak config Lambda role.
   *
   * @param props - The Lambda roles properties
   * @returns The created config Lambda role
   */
  private createConfigLambdaRole(props: LambdaRolesProps): IRole {
    const role = new Role(this, 'ConfigLambdaRole', {
      roleName: props.configLambdaRoleName,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Allows the Auth Server Keycloak Config Lambda to access necessary AWS services',
    });

    const policy = new ManagedPolicy(this, 'ConfigLambdaPolicy', {
      managedPolicyName: `${props.configLambdaRoleName}-policy`,
    });

    // CloudWatch Logs permissions for Lambda execution
    const cwLogsPolicyStatement = new PolicyStatement({
      sid: 'CloudWatchLogs',
      effect: Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:${this.partition}:logs:${props.account.region}:${props.account.id}:log-group:*`,
      ],
    });

    // VPC permissions for Lambda to create network interfaces
    const vpcPolicyStatement = new PolicyStatement({
      sid: 'VPCNetworkInterface',
      effect: Effect.ALLOW,
      actions: [
        'ec2:CreateNetworkInterface',
        'ec2:DescribeNetworkInterfaces',
        'ec2:DeleteNetworkInterface',
        'ec2:AssignPrivateIpAddresses',
        'ec2:UnassignPrivateIpAddresses',
      ],
      resources: ['*'],
    });

    policy.addStatements(cwLogsPolicyStatement, vpcPolicyStatement);

    role.addManagedPolicy(policy);

    // Add NAG suppressions
    NagSuppressions.addResourceSuppressions(
      policy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CloudWatch Logs log-group wildcard allows Lambda to create and write to log groups dynamically.',
          appliesTo: [
            `Resource::arn:${this.partition}:logs:${props.account.region}:${props.account.id}:log-group:*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'VPC network interface permissions require wildcard as ENI ARNs are not known at deploy time.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );

    return role;
  }

  /**
   * Creates the CloudFormation provider Lambda role.
   *
   * @param props - The Lambda roles properties
   * @returns The created provider role
   */
  private createProviderRole(props: LambdaRolesProps): IRole {
    const role = new Role(this, 'ProviderRole', {
      roleName: props.providerRoleName,
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description:
        'Allows the Auth Server CloudFormation Provider Lambda to invoke the config Lambda',
    });

    const policy = new ManagedPolicy(this, 'ProviderPolicy', {
      managedPolicyName: `${props.providerRoleName}-policy`,
    });

    // CloudWatch Logs permissions
    const cwLogsPolicyStatement = new PolicyStatement({
      sid: 'CloudWatchLogs',
      effect: Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: [
        `arn:${this.partition}:logs:${props.account.region}:${props.account.id}:log-group:*`,
      ],
    });

    // Lambda invoke permissions - will be scoped to specific function ARN when used
    const lambdaInvokePolicyStatement = new PolicyStatement({
      sid: 'LambdaInvoke',
      effect: Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [
        `arn:${this.partition}:lambda:${props.account.region}:${props.account.id}:function:*`,
      ],
    });

    policy.addStatements(cwLogsPolicyStatement, lambdaInvokePolicyStatement);

    role.addManagedPolicy(policy);

    // Add NAG suppressions
    NagSuppressions.addResourceSuppressions(
      policy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CloudWatch Logs log-group wildcard allows Lambda to create and write to log groups dynamically.',
          appliesTo: [
            `Resource::arn:${this.partition}:logs:${props.account.region}:${props.account.id}:log-group:*`,
          ],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Lambda invoke wildcard scoped to account allows provider to invoke config Lambda functions.',
          appliesTo: [
            `Resource::arn:${this.partition}:lambda:${props.account.region}:${props.account.id}:function:*`,
          ],
        },
      ],
      true,
    );

    return role;
  }
}
