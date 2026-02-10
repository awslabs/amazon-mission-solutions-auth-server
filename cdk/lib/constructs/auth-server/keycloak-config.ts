/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { IRole } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';
import { copySync } from 'fs-extra';

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

    this.configFunction = new Function(this, 'Function', {
      functionName: `${projectName}-AuthConfigLambdaFunction`,
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      role: this.lambdaRoles.configLambdaRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      code: Code.fromAsset(join(__dirname, '..', '..', '..', 'lambda', 'keycloak-config'), {
        bundling: {
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
                const lambdaPath = join(__dirname, '..', '..', '..', 'lambda', 'keycloak-config');
                copySync(lambdaPath, outputDir);

                spawnSync(npmCmd, ['install', '--omit=dev'], {
                  cwd: outputDir,
                  stdio: 'inherit',
                });

                return true;
              } catch {
                return false;
              }
            },
          },
          image: Runtime.NODEJS_22_X.bundlingImage,
          command: [
            'bash',
            '-c',
            [
              'mkdir -p /tmp/npm-cache',
              'npm config set cache /tmp/npm-cache',
              'cp -r /asset-input/* /asset-output/',
              'cd /asset-output',
              'npm install --omit=dev',
            ].join(' && '),
          ],
        },
      }),
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
  }
}
