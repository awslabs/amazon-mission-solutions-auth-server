/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { Duration, RemovalPolicy, Stack, Validations } from 'aws-cdk-lib';
import { ISecurityGroup, IVpc, SubnetType } from 'aws-cdk-lib/aws-ec2';
import { Effect, IRole, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { CfnFunction, Code, Function, Runtime } from 'aws-cdk-lib/aws-lambda';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Provider } from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

import { OSMLAccount } from '../types';
import { LambdaRoles } from './lambda-roles';

export interface KeycloakConfigLambdaProps {
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
  /** Optional existing config Lambda role. */
  existingConfigLambdaRole?: IRole;
  /** Optional existing provider role. */
  existingProviderRole?: IRole;
  /** SSM prefix for reading keycloak params. Defaults to /{projectName}/auth. */
  ssmPrefix?: string;
  /**
   * Whether to explicitly manage the Provider framework Lambda's log group.
   *
   * When true (default), a LogGroup is created with a DESTROY removal policy
   * in non-prod accounts so `cdk destroy` cleans it up and subsequent
   * deployments do not fail with "log group already exists".
   *
   * Set to false when an external mechanism (e.g. a CDK Aspect) manages log
   * retention for the Provider framework Lambda, to avoid duplicate
   * configuration. When false, the framework Lambda auto-creates its log
   * group at runtime; retention and cleanup become the caller's
   * responsibility.
   */
  manageProviderLogGroup?: boolean;
}

/**
 * Keycloak Config Lambda construct for the Auth Server.
 *
 * Provisions the one-time infrastructure required to configure Keycloak from
 * CloudFormation: the config Lambda function, its IAM roles, log group, and
 * the Custom Resource Provider framework. This construct is intentionally
 * decoupled from any particular realm configuration so a single deployed
 * Lambda can back multiple {@link KeycloakConfig} instances — one per realm.
 */
export class KeycloakConfigLambda extends Construct {
  /** The Keycloak config Lambda function. */
  public readonly configFunction: Function;
  /** The Lambda roles construct (config Lambda role + Provider role). */
  public readonly lambdaRoles: LambdaRoles;
  /** The Custom Resource Provider that routes events to the config Lambda. */
  public readonly provider: Provider;
  /** Resolved project name used for resource naming. */
  public readonly projectName: string;
  /** Resolved Keycloak admin username. */
  public readonly keycloakAdminUsername: string;
  /** Resolved SSM prefix (e.g. `/{projectName}/auth`). */
  public readonly ssmPrefix: string;
  /** The account configuration this Lambda was deployed with. */
  public readonly account: OSMLAccount;
  /** Whether this deployment targets a prod-like account. */
  public readonly isProd: boolean;

  constructor(scope: Construct, id: string, props: KeycloakConfigLambdaProps) {
    super(scope, id);

    this.account = props.account;
    this.projectName = props.projectName ?? 'keycloak';
    this.keycloakAdminUsername = props.keycloakAdminUsername ?? 'keycloak';
    this.isProd = props.account.prodLike ?? false;
    this.ssmPrefix = props.ssmPrefix ?? `/${this.projectName}/auth`;

    // Create Lambda roles using the dedicated construct
    this.lambdaRoles = new LambdaRoles(this, 'Roles', {
      account: props.account,
      configLambdaRoleName: `${this.projectName}-auth-config-lambda-role`,
      providerRoleName: `${this.projectName}-auth-config-provider-role`,
      existingConfigLambdaRole: props.existingConfigLambdaRole,
      existingProviderRole: props.existingProviderRole,
    });

    const lambdaLogGroupName = `/aws/lambda/${this.projectName}-auth-keycloak-config`;
    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: RetentionDays.ONE_MONTH,
      logGroupName: lambdaLogGroupName,
      removalPolicy: this.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
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
      functionName: `${this.projectName}-AuthConfigLambdaFunction`,
      runtime: Runtime.NODEJS_24_X,
      handler: 'index.handler',
      role: this.lambdaRoles.configLambdaRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.securityGroup],
      code: Code.fromAsset(bundlePath),
      timeout: Duration.minutes(15),
      memorySize: 256,
      logGroup,
    });

    // Grant admin secret read to the Lambda role
    props.keycloakAdminSecret.grantRead(this.lambdaRoles.configLambdaRole);

    // Grant Lambda role ssm:GetParameter scoped to /{projectName}/auth/keycloak/*.
    // Built from literal partition/region/account (not stack tokens) so the resulting
    // cdk-nag finding name is token-free and can be acknowledged granularly below.
    const keycloakParamsArn = `arn:${this.lambdaRoles.partition}:ssm:${props.account.region}:${props.account.id}:parameter${this.ssmPrefix}/keycloak/*`;
    this.lambdaRoles.configLambdaRole.addToPrincipalPolicy(
      new PolicyStatement({
        sid: 'SSMGetKeycloakParams',
        effect: Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [keycloakParamsArn],
      }),
    );

    // Optionally own the Provider framework Lambda's log group so it is
    // cleaned up on `cdk destroy`. See `manageProviderLogGroup` prop.
    const providerLogGroup =
      props.manageProviderLogGroup === false
        ? undefined
        : new LogGroup(this, 'ProviderLogGroup', {
            retention: RetentionDays.ONE_MONTH,
            logGroupName: `/aws/lambda/${this.projectName}-auth-keycloak-config-provider`,
            removalPolicy: this.isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
          });

    // Create Provider for the Custom Resource
    this.provider = new Provider(this, 'Provider', {
      onEventHandler: this.configFunction,
      ...(providerLogGroup ? { logGroup: providerLogGroup } : {}),
      role: this.lambdaRoles.providerRole,
    });

    this.acknowledgeNagFindings(keycloakParamsArn);
  }

  /**
   * Acknowledges the cdk-nag findings this construct knowingly accepts.
   *
   * IAM5 is a granular rule: each finding is named with the offending permission and
   * the acknowledgment id must match that exact name, so each ack below accepts only
   * the named wildcard. Any new wildcard added to these roles fails validation.
   */
  private acknowledgeNagFindings(keycloakParamsArn: string): void {
    Validations.of(this.lambdaRoles.configLambdaRole).acknowledge({
      id: `AwsSolutions-IAM5[Resource::${keycloakParamsArn}]`,
      reason:
        'SSM GetParameter uses a wildcard suffix on the keycloak parameter prefix (/{projectName}/auth/keycloak/*) to allow reading keycloak URL and admin secret ARN. This is scoped to the minimum required prefix.',
    });

    Validations.of(this.provider).acknowledge({
      id: 'AwsSolutions-L1',
      reason:
        'The Provider framework Lambda runtime is managed by CDK and may not use the latest runtime version.',
    });

    // grantInvoke on the config function produces '<FnLogicalId>.Arn:*' — the ':*'
    // covers the function's version/alias qualifiers, which is how the CDK Provider
    // framework grants invoke.
    const configFnLogicalId = Stack.of(this).getLogicalId(
      this.configFunction.node.defaultChild as CfnFunction,
    );
    Validations.of(this.lambdaRoles.providerRole).acknowledge({
      id: `AwsSolutions-IAM5[Resource::<${configFnLogicalId}.Arn>:*]`,
      reason:
        'The Provider framework grants invoke on the config Lambda including its version/alias qualifiers. This is scoped to that single function.',
    });
  }
}
