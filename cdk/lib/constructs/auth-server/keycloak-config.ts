/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { CustomResource, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Effect, IRole, PolicyStatement } from 'aws-cdk-lib/aws-iam';
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
  /** The VPC to deploy the Lambda into. */
  vpc: IVpc;
  /** The security group for the Lambda. */
  securityGroup: ISecurityGroup;
  /** The Keycloak admin credentials secret (used only for IAM granting). */
  keycloakAdminSecret: ISecret;
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
  /** SSM prefix for reading keycloak params. Defaults to /{projectName}/auth. */
  ssmPrefix?: string;
}

/**
 * Keycloak Config construct for the Auth Server.
 * Creates a Lambda function triggered by a CloudFormation Custom Resource
 * to configure Keycloak with realms, clients, and users.
 */
export class KeycloakConfig extends Construct {
  public readonly configFunction: Function;
  public readonly userPasswordSecrets: Map<string, Secret> = new Map();
  public readonly lambdaRoles: LambdaRoles;
  public readonly customResource: CustomResource;

  constructor(scope: Construct, id: string, props: KeycloakConfigProps) {
    super(scope, id);

    const projectName = props.projectName ?? 'keycloak';
    const keycloakAdminUsername = props.keycloakAdminUsername ?? 'keycloak';
    const generateUserPasswords = props.generateUserPasswords !== false;
    const websiteUri = props.websiteUri ?? '*';
    const isProd = props.account.prodLike ?? false;
    const ssmPrefix = props.ssmPrefix ?? `/${projectName}/auth`;

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
        SSM_PREFIX: ssmPrefix,
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

    // Grant Lambda role ssm:GetParameter scoped to /{projectName}/auth/keycloak/*
    const stack = Stack.of(this);
    this.lambdaRoles.configLambdaRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'SSMGetKeycloakParams',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:${stack.partition}:ssm:${stack.region}:${stack.account}:parameter${ssmPrefix}/keycloak/*`,
        ],
      }),
    );

    // Create Provider log group
    const providerLogGroup = new LogGroup(this, 'ProviderLogGroup', {
      retention: RetentionDays.ONE_MONTH,
      logGroupName: `/aws/lambda/${projectName}-auth-keycloak-config-provider`,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Create Provider for the Custom Resource
    const provider = new Provider(this, 'Provider', {
      onEventHandler: this.configFunction,
      logGroup: providerLogGroup,
      role: this.lambdaRoles.providerRole,
    });

    // Create the Custom Resource
    this.customResource = new CustomResource(this, 'CustomResource', {
      serviceToken: provider.serviceToken,
      resourceType: 'Custom::KeycloakConfig',
    });

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
      this.lambdaRoles.configLambdaRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'SSM GetParameter uses a wildcard suffix on the keycloak parameter prefix (/{projectName}/auth/keycloak/*) to allow reading keycloak URL and admin secret ARN. This is scoped to the minimum required prefix.',
          appliesTo: [
            {
              regex: '/^Resource::arn:.*:ssm:.*:parameter/.*/auth/keycloak/\\*$/g',
            },
          ],
        },
      ],
      true,
    );

    // Provider framework NAG suppressions
    NagSuppressions.addResourceSuppressions(
      provider,
      [
        {
          id: 'AwsSolutions-L1',
          reason:
            'The Provider framework Lambda runtime is managed by CDK and may not use the latest runtime version.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(
      this.lambdaRoles.providerRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Provider role requires permissions to invoke the config Lambda and write logs. Wildcard is scoped to the provider log group.',
        },
      ],
      true,
    );
  }
}
