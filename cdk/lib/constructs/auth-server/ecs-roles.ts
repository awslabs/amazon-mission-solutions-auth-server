/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { region_info } from 'aws-cdk-lib';
import {
  CompositePrincipal,
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
 * Properties for creating ECS roles.
 */
export interface ECSRolesProps {
  /** The OSML account configuration. */
  readonly account: OSMLAccount;
  /** The name for the task role. */
  readonly taskRoleName: string;
  /** The name for the execution role. */
  readonly executionRoleName: string;
  /** Optional existing task role to use instead of creating one. */
  readonly existingTaskRole?: IRole;
  /** Optional existing execution role to use instead of creating one. */
  readonly existingExecutionRole?: IRole;
}

/**
 * Construct that manages both ECS task and execution roles for the Auth Server.
 *
 * This construct encapsulates the creation and configuration of both the ECS
 * task role and execution role, providing a unified interface for role management.
 */
export class ECSRoles extends Construct {
  /** The ECS task role. */
  public readonly taskRole: IRole;

  /** The ECS execution role. */
  public readonly executionRole: IRole;

  /** The AWS partition in which the roles will operate. */
  public readonly partition: string;

  /**
   * Creates a new ECSRoles construct.
   *
   * @param scope - The scope/stack in which to define this construct
   * @param id - The id of this construct within the current scope
   * @param props - The properties for configuring this construct
   */
  constructor(scope: Construct, id: string, props: ECSRolesProps) {
    super(scope, id);

    this.partition = region_info.Fact.find(props.account.region, region_info.FactName.PARTITION)!;

    // Create or use existing task role
    this.taskRole = props.existingTaskRole || this.createTaskRole(props);

    // Create or use existing execution role
    this.executionRole = props.existingExecutionRole || this.createExecutionRole(props);
  }

  /**
   * Creates the ECS task role for Keycloak containers.
   *
   * @param props - The ECS roles properties
   * @returns The created task role
   */
  private createTaskRole(props: ECSRolesProps): IRole {
    const taskRole = new Role(this, 'TaskRole', {
      roleName: props.taskRoleName,
      assumedBy: new CompositePrincipal(
        new ServicePrincipal('ecs.amazonaws.com'),
        new ServicePrincipal('ecs-tasks.amazonaws.com'),
      ),
      description: 'Allows the Auth Server Keycloak containers to access necessary AWS services',
    });

    return taskRole;
  }

  /**
   * Creates the ECS execution role.
   *
   * @param props - The ECS roles properties
   * @returns The created execution role
   */
  private createExecutionRole(props: ECSRolesProps): IRole {
    const executionRole = new Role(this, 'ExecutionRole', {
      roleName: props.executionRoleName,
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Allows ECS to pull container images and write logs for Auth Server tasks',
    });

    const executionPolicy = new ManagedPolicy(this, 'ExecutionPolicy', {
      managedPolicyName: `${props.executionRoleName}-policy`,
    });

    // ECR GetAuthorizationToken - account-level operation
    const ecrAuthPolicyStatement = new PolicyStatement({
      sid: 'ECRAuth',
      effect: Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'],
    });

    // ECR repository access for pulling images
    const ecrPolicyStatement = new PolicyStatement({
      sid: 'ECRPull',
      effect: Effect.ALLOW,
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:DescribeRepositories',
      ],
      resources: [
        `arn:${this.partition}:ecr:${props.account.region}:${props.account.id}:repository/*`,
      ],
    });

    executionPolicy.addStatements(ecrAuthPolicyStatement, ecrPolicyStatement);

    executionRole.addManagedPolicy(executionPolicy);

    // Add NAG suppressions for necessary wildcard permissions
    NagSuppressions.addResourceSuppressions(
      executionPolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'ECR GetAuthorizationToken is an account-level operation requiring wildcard.',
          appliesTo: ['Resource::*'],
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ECR repository wildcard needed for pulling images from various repositories including public Keycloak images.',
          appliesTo: [
            `Resource::arn:${this.partition}:ecr:${props.account.region}:${props.account.id}:repository/*`,
          ],
        },
      ],
      true,
    );

    return executionRole;
  }
}
