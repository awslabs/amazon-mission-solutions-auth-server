/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import {
  Certificate,
  CertificateValidation,
  ICertificate,
} from 'aws-cdk-lib/aws-certificatemanager';
import { ISecurityGroup, IVpc, Port, SecurityGroup } from 'aws-cdk-lib/aws-ec2';
import { ARecord, HostedZone, IHostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

import { KeycloakCustomConfig } from '../../utils/keycloak-config-loader';
import { BaseConfig, ConfigType, OSMLAccount } from '../types';
import { Database } from './database';
import { KeycloakConfig } from './keycloak-config';
import { KeycloakService } from './keycloak-service';

/**
 * Configuration for the Dataplane construct.
 *
 * This class defines application-level configuration including Keycloak settings,
 * container configuration, database settings, and domain configuration.
 * It extends BaseConfig to support configuration merging with defaults.
 */
export class DataplaneConfig extends BaseConfig {
  /**
   * Keycloak version string (e.g. "26.0.7" or "latest").
   * Used as the KEYCLOAK_VERSION build arg when building from the local Dockerfile.
   * Only used when KEYCLOAK_WRAPPER_IMAGE is not set.
   * @default "latest"
   */
  KEYCLOAK_VERSION?: string;

  /**
   * Pre-built Keycloak wrapper image URI.
   * When set, uses ContainerImage.fromRegistry() and skips Docker build.
   * When not set, builds the wrapper image from the local Dockerfile.
   * @default undefined (build from local Dockerfile)
   */
  KEYCLOAK_WRAPPER_IMAGE?: string;

  /**
   * Keycloak admin username.
   * @default "keycloak"
   */
  KEYCLOAK_ADMIN_USERNAME?: string;

  /**
   * ECS task CPU units (1024 = 1 vCPU).
   * @default 4096
   */
  ECS_TASK_CPU?: number;

  /**
   * ECS task memory in MB.
   * @default 8192
   */
  ECS_TASK_MEMORY?: number;

  /**
   * Minimum number of ECS containers.
   * @default 2
   */
  ECS_MIN_CONTAINERS?: number;

  /**
   * Maximum number of ECS containers for auto-scaling.
   * @default 10
   */
  ECS_MAX_CONTAINERS?: number;

  /**
   * CPU utilization target percentage for auto-scaling.
   * @default 75
   */
  ECS_CPU_UTILIZATION_TARGET?: number;

  /**
   * Java options for Keycloak JVM.
   * @default "-server -Xms1024m -Xmx1638m"
   */
  JAVA_OPTS?: string;

  /**
   * RDS database instance type.
   * @default "r5.large"
   */
  DATABASE_INSTANCE_TYPE?: string;

  /**
   * Aurora MySQL backtrack window in seconds (enables point-in-time rewind).
   * Max 72 hours (259200). Only supported for Aurora MySQL; set to 0 or omit to disable.
   * @default undefined (disabled)
   */
  BACKTRACK_WINDOW_SECONDS?: number;

  /**
   * RDS database port. Use a non-default port for NAG RDS11 compliance.
   * @default 3306
   */
  DATABASE_PORT?: number;

  /**
   * Hostname for the Keycloak service (e.g., "auth.example.com").
   * Required for proper Keycloak URL configuration.
   */
  DOMAIN_HOSTNAME?: string;

  /**
   * ACM certificate ARN for HTTPS configuration.
   * If not provided, HTTP will be used.
   */
  DOMAIN_CERTIFICATE_ARN?: string;

  /**
   * Route53 hosted zone ID for DNS record creation.
   * If provided, an A record will be created pointing to the load balancer.
   */
  DOMAIN_HOSTED_ZONE_ID?: string;

  /**
   * Route53 hosted zone name (e.g., "example.com").
   * Required when DOMAIN_HOSTED_ZONE_ID is provided.
   * If DOMAIN_HOSTNAME is not provided, it defaults to "auth.{DOMAIN_HOSTED_ZONE_NAME}".
   */
  DOMAIN_HOSTED_ZONE_NAME?: string;

  /**
   * Whether the load balancer should be internet-facing.
   * @default true
   */
  DOMAIN_INTERNET_FACING?: boolean;

  /**
   * Keycloak authentication configuration for realms, clients, and users.
   * If provided, the Keycloak config Lambda will be created.
   */
  KEYCLOAK_AUTH_CONFIG?: KeycloakCustomConfig;

  /**
   * Creates a new DataplaneConfig instance with default values.
   *
   * @param config - Partial configuration to merge with defaults
   */
  constructor(config: ConfigType = {}) {
    super(config);
    // Set defaults after super() call
    this.KEYCLOAK_VERSION = this.KEYCLOAK_VERSION ?? 'latest';
    this.KEYCLOAK_ADMIN_USERNAME = this.KEYCLOAK_ADMIN_USERNAME ?? 'keycloak';
    this.ECS_TASK_CPU = this.ECS_TASK_CPU ?? 4096;
    this.ECS_TASK_MEMORY = this.ECS_TASK_MEMORY ?? 8192;
    this.ECS_MIN_CONTAINERS = this.ECS_MIN_CONTAINERS ?? 2;
    this.ECS_MAX_CONTAINERS = this.ECS_MAX_CONTAINERS ?? 10;
    this.ECS_CPU_UTILIZATION_TARGET = this.ECS_CPU_UTILIZATION_TARGET ?? 75;
    this.JAVA_OPTS = this.JAVA_OPTS ?? '-server -Xms1024m -Xmx1638m';
    this.DATABASE_INSTANCE_TYPE = this.DATABASE_INSTANCE_TYPE ?? 'r5.large';
    this.DATABASE_PORT = this.DATABASE_PORT ?? 3306;
    this.DOMAIN_INTERNET_FACING = this.DOMAIN_INTERNET_FACING ?? true;
  }
}

/**
 * Properties for the Dataplane construct.
 */
export interface DataplaneProps {
  /**
   * AWS account configuration including region and environment type.
   */
  readonly account: OSMLAccount;

  /**
   * VPC for deploying application resources.
   */
  readonly vpc: IVpc;

  /**
   * Security group for application resources.
   */
  readonly securityGroup: ISecurityGroup;

  /**
   * Dataplane configuration settings.
   * If not provided, defaults will be used.
   */
  readonly config?: DataplaneConfig;

  /**
   * Project name for resource naming.
   * @default "keycloak"
   */
  readonly projectName?: string;
}

/**
 * Dataplane construct that encapsulates all application resources.
 *
 * This construct creates and manages:
 * - Aurora MySQL database for Keycloak persistence
 * - ECS Fargate service running Keycloak
 * - Application Load Balancer for traffic routing
 * - Optional Keycloak configuration Lambda for realm/client setup
 * - Optional DNS records for custom domain
 *
 * @example
 * ```typescript
 * const dataplane = new Dataplane(this, "Dataplane", {
 *   account: { id: "123456789012", region: "us-west-2", prodLike: false, isAdc: false },
 *   vpc: network.vpc,
 *   securityGroup: network.securityGroup,
 *   config: new DataplaneConfig({
 *     DOMAIN_HOSTNAME: "auth.example.com",
 *     DOMAIN_CERTIFICATE_ARN: "arn:aws:acm:...",
 *     KEYCLOAK_AUTH_CONFIG: { realm: "my-realm", clients: [...], users: [...] },
 *   }),
 * });
 * ```
 */
export class Dataplane extends Construct {
  /**
   * The database construct containing Aurora MySQL cluster.
   */
  public readonly database: Database;

  /**
   * The Keycloak service construct containing ECS service and load balancer.
   */
  public readonly keycloakService: KeycloakService;

  /**
   * The Keycloak configuration Lambda (only created if authConfig is provided).
   */
  public readonly configLambda?: KeycloakConfig;

  /**
   * The dataplane configuration used by this construct.
   */
  public readonly config: DataplaneConfig;

  /**
   * The ACM certificate (only created if DOMAIN_CERTIFICATE_ARN is not provided
   * but DOMAIN_HOSTED_ZONE_ID and DOMAIN_HOSTNAME are provided).
   */
  public readonly certificate?: ICertificate;

  /**
   * Creates a new Dataplane construct.
   *
   * @param scope - CDK scope
   * @param id - Construct ID
   * @param props - Dataplane properties
   */
  constructor(scope: Construct, id: string, props: DataplaneProps) {
    super(scope, id);

    const projectName = props.projectName ?? 'keycloak';
    const isProd = props.account.prodLike;

    // Initialize configuration with defaults
    this.config = props.config ?? new DataplaneConfig();

    const isInternetFacing = this.config.DOMAIN_INTERNET_FACING ?? true;

    // Validate hosted zone configuration:
    // If DOMAIN_HOSTED_ZONE_ID is provided, DOMAIN_HOSTED_ZONE_NAME is required
    if (this.config.DOMAIN_HOSTED_ZONE_ID && !this.config.DOMAIN_HOSTED_ZONE_NAME) {
      throw new Error(
        'DOMAIN_HOSTED_ZONE_NAME is required when DOMAIN_HOSTED_ZONE_ID is provided.',
      );
    }

    // Resolve hostname: use provided value or default to "auth.{zoneName}"
    const hostname =
      this.config.DOMAIN_HOSTNAME ??
      (this.config.DOMAIN_HOSTED_ZONE_NAME
        ? `auth.${this.config.DOMAIN_HOSTED_ZONE_NAME}`
        : undefined);

    // Validate hostname requirements:
    // - Public-facing: hostname is required (either explicit or derived from zone name)
    // - Internal: hostname is optional (will use ALB DNS if not provided)
    if (isInternetFacing && !hostname) {
      throw new Error(
        'DOMAIN_HOSTNAME or DOMAIN_HOSTED_ZONE_NAME is required when DOMAIN_INTERNET_FACING is true (public-facing deployment)',
      );
    }

    // Validate TLS requirements for public-facing deployments:
    // - Must have either DOMAIN_CERTIFICATE_ARN or DOMAIN_HOSTED_ZONE_ID (to auto-create cert)
    // - HTTP-only is not allowed for internet-facing deployments
    if (
      isInternetFacing &&
      !this.config.DOMAIN_CERTIFICATE_ARN &&
      !this.config.DOMAIN_HOSTED_ZONE_ID
    ) {
      throw new Error(
        'TLS is required for public-facing deployments. Provide either DOMAIN_CERTIFICATE_ARN ' +
          'or DOMAIN_HOSTED_ZONE_ID (to auto-create an ACM certificate with DNS validation).',
      );
    }

    // Resolve hosted zone if DOMAIN_HOSTED_ZONE_ID is provided
    // This is used for both certificate creation and DNS record creation
    let hostedZone: IHostedZone | undefined;
    if (this.config.DOMAIN_HOSTED_ZONE_ID && this.config.DOMAIN_HOSTED_ZONE_NAME) {
      hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId: this.config.DOMAIN_HOSTED_ZONE_ID,
        zoneName: this.config.DOMAIN_HOSTED_ZONE_NAME,
      });
    }

    // Resolve certificate: use provided ARN or create new certificate with DNS validation
    let certificate: ICertificate | undefined;
    let certificateArn: string | undefined = this.config.DOMAIN_CERTIFICATE_ARN;

    if (!certificateArn && hostedZone && hostname) {
      // Create ACM certificate with automatic DNS validation
      certificate = new Certificate(this, 'Certificate', {
        domainName: hostname,
        validation: CertificateValidation.fromDns(hostedZone),
      });

      // Apply removal policy based on environment
      // Retain certificates in production to prevent accidental deletion
      certificate.applyRemovalPolicy(isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

      certificateArn = certificate.certificateArn;

      // Expose the created certificate
      this.certificate = certificate;
    }

    // Create Keycloak admin secret
    const keycloakAdminSecret = new Secret(this, 'KeycloakAdminSecret', {
      secretName: `${projectName}-auth/keycloak-admin`,
      description: `Admin credentials for ${projectName} Keycloak`,
      generateSecretString: {
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({
          username: this.config.KEYCLOAK_ADMIN_USERNAME,
        }),
        generateStringKey: 'password',
      },
    });

    NagSuppressions.addResourceSuppressions(keycloakAdminSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'Keycloak admin secret rotation is not configured. The admin password is set at initial deployment and managed manually.',
      },
    ]);

    const databasePort = this.config.DATABASE_PORT ?? 3306;

    // Create database construct
    this.database = new Database(this, 'Database', {
      vpc: props.vpc,
      projectName: projectName,
      databaseInstanceType: this.config.DATABASE_INSTANCE_TYPE,
      isProd: isProd,
      backtrackWindowSeconds: this.config.BACKTRACK_WINDOW_SECONDS,
      port: databasePort,
    });

    // Configure security group ingress for database access
    this.database.dbSecurityGroup.addIngressRule(
      props.securityGroup,
      Port.tcp(databasePort),
      'Allow MySQL connections from application security group',
    );

    // Create Keycloak service construct
    this.keycloakService = new KeycloakService(this, 'KeycloakService', {
      account: props.account,
      projectName: projectName,
      vpc: props.vpc,
      databaseSecret: this.database.databaseSecret,
      keycloakSecret: keycloakAdminSecret,
      keycloakAdminUsername: this.config.KEYCLOAK_ADMIN_USERNAME,
      keycloakVersion: this.config.KEYCLOAK_VERSION,
      wrapperImage: this.config.KEYCLOAK_WRAPPER_IMAGE,
      taskCpu: this.config.ECS_TASK_CPU,
      taskMemory: this.config.ECS_TASK_MEMORY,
      minContainers: this.config.ECS_MIN_CONTAINERS,
      maxContainers: this.config.ECS_MAX_CONTAINERS,
      autoScalingTargetCpuUtilization: this.config.ECS_CPU_UTILIZATION_TARGET,
      javaOpts: this.config.JAVA_OPTS,
      hostname: hostname,
      certificateArn: certificateArn,
      internetFacing: this.config.DOMAIN_INTERNET_FACING,
    });

    // Allow Keycloak service to connect to database
    this.database.dbSecurityGroup.addIngressRule(
      this.keycloakService.serviceSecurityGroup,
      Port.tcp(databasePort),
      'Allow MySQL connections from Keycloak service',
    );

    // Conditionally create Keycloak config Lambda if KEYCLOAK_AUTH_CONFIG is provided
    if (this.config.KEYCLOAK_AUTH_CONFIG) {
      // Create security group for the config Lambda
      const configLambdaSecurityGroup = new SecurityGroup(this, 'ConfigLambdaSecurityGroup', {
        vpc: props.vpc,
        description: `Security group for ${projectName} auth config Lambda`,
        securityGroupName: `${projectName}-auth-config-lambda-sg`,
      });

      // Allow Lambda to reach the ALB on the appropriate port
      const albPort = hostname && certificateArn ? 443 : 80;
      this.keycloakService.loadBalancer.connections.allowFrom(
        configLambdaSecurityGroup,
        Port.tcp(albPort),
        'Allow config Lambda to reach Keycloak ALB',
      );

      this.configLambda = new KeycloakConfig(this, 'KeycloakConfig', {
        account: props.account,
        projectName: projectName,
        keycloakAdminSecret: keycloakAdminSecret,
        vpc: props.vpc,
        securityGroup: configLambdaSecurityGroup,
        keycloakAdminUsername: this.config.KEYCLOAK_ADMIN_USERNAME,
        customAuthConfig: this.config.KEYCLOAK_AUTH_CONFIG,
        generateUserPasswords: true,
        websiteUri: this.keycloakService.keycloakUrl,
      });

      // Scope dependency to the custom resource so the Lambda can destroy in parallel with the service
      this.configLambda.customResource.node.addDependency(this.keycloakService);
    }

    // Create DNS A record if hosted zone is available
    if (hostedZone && hostname) {
      new ARecord(this, 'DnsRecord', {
        zone: hostedZone,
        recordName: hostname,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(this.keycloakService.loadBalancer)),
      });
    }

    // Add CloudFormation outputs for backward compatibility
    new CfnOutput(this, 'LoadBalancerDNS', {
      value: this.keycloakService.loadBalancer.loadBalancerDnsName,
      description: 'DNS name of the Application Load Balancer',
      exportName: `${projectName}-LoadBalancerDNS`,
    });

    new CfnOutput(this, 'KeycloakUrl', {
      value: this.keycloakService.keycloakUrl,
      description: 'URL to access Keycloak',
      exportName: `${projectName}-KeycloakUrl`,
    });

    new CfnOutput(this, 'KeycloakAdminSecretArn', {
      value: keycloakAdminSecret.secretArn,
      description: 'ARN of the Keycloak admin credentials secret',
      exportName: `${projectName}-KeycloakAdminSecretArn`,
    });
  }
}
