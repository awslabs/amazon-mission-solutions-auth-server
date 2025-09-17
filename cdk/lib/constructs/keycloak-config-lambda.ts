/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { CustomResource, Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Effect, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { spawnSync } from 'node:child_process';
import { Construct } from 'constructs';
import { copySync } from 'fs-extra';
import { join } from 'node:path';

import { KeycloakCustomConfig, loadKeycloakConfig } from '../utils/keycloak-config-loader';

export interface KeycloakConfigLambdaProps {
  projectName?: string;
  keycloakUrl: string;
  keycloakAdminSecret: ISecret;
  loadBalancerDns?: string;
  keycloakAdminUsername?: string;
  customAuthConfig?: KeycloakCustomConfig;
  useDefaultAuthConfig?: boolean;
  generateUserPasswords?: boolean;
  websiteUri?: string;
  isProd?: boolean;
}

export class KeycloakConfigLambda extends Construct {
  public readonly configFunction: Function;
  public readonly customResource: CustomResource;
  public readonly userPasswordSecrets: Map<string, Secret> = new Map();

  constructor(scope: Construct, id: string, props: KeycloakConfigLambdaProps) {
    super(scope, id);

    const projectName = props.projectName || 'keycloak';
    const keycloakAdminUsername = props.keycloakAdminUsername || 'keycloak';
    const useDefaultAuthConfig = props.useDefaultAuthConfig !== false;
    const generateUserPasswords = props.generateUserPasswords !== false;
    const websiteUri = props.websiteUri || '*';
    const isProd = props.isProd || false;

    let authConfig: KeycloakCustomConfig | undefined;
    if (useDefaultAuthConfig) {
      const loadedConfig = loadKeycloakConfig();
      authConfig = loadedConfig !== null ? loadedConfig : undefined;
    }

    if (props.customAuthConfig) {
      authConfig = props.customAuthConfig;
    }

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
    let logGroup;
    try {
      logGroup = LogGroup.fromLogGroupName(this, 'ImportedLogGroup', lambdaLogGroupName);
    } catch {
      logGroup = new LogGroup(this, 'LogGroup', {
        retention: isProd ? RetentionDays.ONE_MONTH : RetentionDays.ONE_WEEK,
        logGroupName: lambdaLogGroupName,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    }

    this.configFunction = new Function(this, 'Function', {
      functionName: `${projectName}-AuthConfigLambdaFunction`,
      runtime: Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: Code.fromAsset(join(__dirname, '..', '..', 'lambda', 'keycloak-config'), {
        bundling: {
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
                const lambdaPath = join(__dirname, '..', '..', 'lambda', 'keycloak-config');
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
              'rm -rf node_modules/aws-sdk',
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
        LOAD_BALANCER_DNS: props.loadBalancerDns || props.keycloakUrl,
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

    props.keycloakAdminSecret.grantRead(this.configFunction);

    this.userPasswordSecrets.forEach(secret => {
      secret.grantRead(this.configFunction);
      secret.grantWrite(this.configFunction);
    });

    const logPolicy = new PolicyStatement({
      effect: Effect.ALLOW,
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'],
      resources: ['*'],
    });

    this.configFunction.addToRolePolicy(logPolicy);

    const providerLogGroupName = `/aws/lambda/${projectName}-auth-provider`;
    let providerLogGroup;
    try {
      providerLogGroup = LogGroup.fromLogGroupName(
        this,
        'ImportedProviderLogGroup',
        providerLogGroupName,
      );
    } catch {
      providerLogGroup = new LogGroup(this, 'ProviderLogGroup', {
        retention: RetentionDays.ONE_WEEK,
        logGroupName: providerLogGroupName,
        removalPolicy: RemovalPolicy.RETAIN,
      });
    }

    const provider = new Provider(this, 'Provider', {
      onEventHandler: this.configFunction,
      logGroup: providerLogGroup,
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
