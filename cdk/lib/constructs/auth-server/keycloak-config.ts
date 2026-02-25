/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { IRole } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { KeycloakCustomConfig } from '../../utils/keycloak-config-loader';
import { OSMLAccount } from '../types';
import { LambdaRoles } from './lambda-roles';

export interface KeycloakConfigProps {
  /** The OSML account configuration. */
  account: OSMLAccount;
  /** The project name prefix for resource naming. */
  projectName?: string;
  /** The Keycloak URL for API calls and healthchecks. */
  keycloakUrl: string;
  /** The Keycloak admin credentials secret. */
  keycloakAdminSecret: ISecret;
  /** The VPC to deploy the Lambda into. */
  vpc: IVpc;
  /** The security group for the Lambda. */
  securityGroup: ISecurityGroup;
  /** The Keycloak admin username. */
  keycloakAdminUsername?: string;
  /** Custom auth configuration (from deployment.json dataplaneConfig.KEYCLOAK_AUTH_CONFIG). */
  customAuthConfig?: KeycloakCustomConfig;
  /** Whether to generate passwords for users. */
  generateUserPasswords?: boolean;
  /** The website URI for CORS configuration. */
  websiteUri?: string;
  /** Optional existing config Lambda role. */
  existingConfigLambdaRole?: IRole;
  /** Optional existing provider role. */
  existingProviderRole?: IRole;
}

/**
 * Keycloak Config construct for the Auth Server.
 * Creates a Lambda function that configures Keycloak with realms, clients, and users.
 */
export class KeycloakConfig extends Construct {
  public readonly configFunction: Function;
  public readonly customResource: CustomResource;
  public readonly userPasswordSecrets: Map<string, Secret> = new Map();
  public readonly lambdaRoles: LambdaRoles;

  constructor(scope: Construct, id: string, props: KeycloakConfigProps) {
    super(scope, id);

    const projectName = props.projectName ?? 'keycloak';
    const keycloakAdminUsername = props.keycloakAdminUsername ?? 'keycloak';
    const generateUserPasswords = props.generateUserPasswords !== false;
    const websiteUri = props.websiteUri ?? '*';
    const isProd = props.account.prodLike ?? false;

    // Create Lambda roles using the dedicated construct
    this.lambdaRoles = new LambdaRoles(this, 'Roles', {
      account: props.account,
      configLambdaRoleName: `${projectName}-auth-config-lambda-role`,
      providerRoleName: `${projectName}-auth-config-provider-role`,
      existingConfigLambdaRole: props.existingConfigLambdaRole,
      existingProviderRole: props.existingProviderRole,
    });

    // Use the auth config passed from deployment.json (dataplaneConfig.KEYCLOAK_AUTH_CONFIG)
    const authConfig = props.customAuthConfig;

    if (authConfig && generateUserPasswords && authConfig.users) {
      authConfig.users.forEach(user => {
        if (user.generatePassword) {
          const relativePath = user.ssmPasswordPath || `users/${user.username}/password`;
          const cleanRelativePath = relativePath.replace(/^\//, '');
          const secretName = `${projectName}-auth/${cleanRelativePath}`;

          const secret = new Secret(this, `UserPassword-${user.username}`, {
            secretName: secretName,
            description: `Password for Keycloak user ${user.username}`,
            generateSecretString: {
              passwordLength: 16,
              excludePunctuation: false,
              includeSpace: false,
              requireEachIncludedType: true,
            },
            removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
          });

          this.userPasswordSecrets.set(user.username, secret);
        }
      });
    }

    const lambdaLogGroupName = `/aws/lambda/${projectName}-auth-keycloak-config`;
    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: RetentionDays.ONE_MONTH,
      logGroupName: lambdaLogGroupName,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    logGroup.grantWrite(this.lambdaRoles.configLambdaRole);

    const lambdaPath = join(__dirname, '..', '..', '..', 'lambda', 'keycloak-config');
    const bundlePath = join(lambdaPath, '.bundle');

    if (!existsSync(bundlePath)) {
      throw new Error(
        'Lambda bundle not found at ' + bundlePath + '. Run "npm run build" before "cdk synth".',
      );
    }

    this.configFunction = new Function(this, 'Function', {
      functionName: `${projectName}-AuthConfigLambdaFunction`,
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      role: this.lambdaRoles.configLambdaRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      code: Code.fromAsset(bundlePath),
      timeout: Duration.minutes(15),
      memorySize: 256,
      environment: {
        KEYCLOAK_URL: props.keycloakUrl,
        KEYCLOAK_ADMIN_SECRET_ARN: props.keycloakAdminSecret.secretArn,
        KEYCLOAK_ADMIN_USERNAME: keycloakAdminUsername,
        WEBSITE_URI: websiteUri,
        AUTH_CONFIG: authConfig ? JSON.stringify(authConfig) : '',
        USER_PASSWORD_SECRETS: JSON.stringify(
          Array.from(this.userPasswordSecrets.entries()).reduce(
            (obj, [username, secret]) => {
              obj[username] = secret.secretArn;
              return obj;
            },
            {} as Record<string, string>,
          ),
        ),
      },
      logGroup,
    });

    // Grant secrets access
    props.keycloakAdminSecret.grantRead(this.lambdaRoles.configLambdaRole);

    this.userPasswordSecrets.forEach(secret => {
      secret.grantRead(this.lambdaRoles.configLambdaRole);
      secret.grantWrite(this.lambdaRoles.configLambdaRole);
    });

    const providerLogGroupName = `/aws/lambda/${projectName}-auth-provider`;
    const providerLogGroup = new LogGroup(this, 'ProviderLogGroup', {
      retention: RetentionDays.ONE_MONTH,
      logGroupName: providerLogGroupName,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    providerLogGroup.grantWrite(this.lambdaRoles.providerRole);

    const provider = new Provider(this, 'Provider', {
      onEventHandler: this.configFunction,
      logGroup: providerLogGroup,
      frameworkOnEventRole: this.lambdaRoles.providerRole,
    });

    this.customResource = new CustomResource(this, 'Resource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::KeycloakConfig',
      properties: {
        timestamp: new Date().toISOString(),
      },
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.customResource.node.addDependency(provider);

    // CDK-NAG suppressions
    this.userPasswordSecrets.forEach(secret => {
      NagSuppressions.addResourceSuppressions(secret, [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'User password secrets are generated at deployment time for Keycloak user provisioning. Rotation is not applicable as passwords are managed through Keycloak.',
        },
      ]);
    });

    NagSuppressions.addResourceSuppressions(
      provider,
      [
        {
          id: 'AwsSolutions-L1',
          reason:
            'The CDK Provider framework Lambda runtime is managed by the CDK framework and cannot be directly controlled.',
        },
      ],
      true,
    );

    // Suppress IAM5 on the provider role after the Provider construct has been created,
    // because the Provider's grantInvoke creates a DefaultPolicy on the role with
    // lambda:InvokeFunction on <FunctionArn>:* (version/alias wildcard).
    NagSuppressions.addResourceSuppressions(
      this.lambdaRoles.providerRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'The CDK Provider framework grants lambda:InvokeFunction on the config function ARN with a version/alias wildcard suffix (:*). This is managed by the CDK framework.',
          appliesTo: [
            {
              regex: '/^Resource::.*\\.Arn>:\\*$/g',
            },
          ],
        },
      ],
      true,
    );
  }
}
