/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { IVpc, Peer, Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  Cluster,
  ContainerImage,
  ContainerInsights,
  FargateService,
  FargateTaskDefinition,
  ICluster,
  LogDrivers,
  Protocol,
  Secret as EcsSecret,
} from 'aws-cdk-lib/aws-ecs';
import {
  ApplicationLoadBalancer,
  ApplicationProtocol,
  ApplicationTargetGroup,
  SslPolicy,
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { IRole } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { BlockPublicAccess, Bucket, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { join } from 'path';

import { OSMLAccount } from '../types';
import { ECSRoles } from './ecs-roles';

export interface KeycloakServiceProps {
  /** The OSML account configuration. */
  account: OSMLAccount;
  /** The project name prefix for resource naming. */
  projectName?: string;
  /** The VPC to deploy the service into. */
  vpc: IVpc;
  /** The database host endpoint. */
  databaseHost: string;
  /** The database port. */
  databasePort?: number;
  /** The database credentials secret. */
  databaseSecret: ISecret;
  /** The Keycloak admin credentials secret. */
  keycloakSecret: ISecret;
  /** The Keycloak admin username. */
  keycloakAdminUsername?: string;
  /** The Keycloak container image. */
  keycloakImage?: string;
  /** The task CPU units. */
  taskCpu?: number;
  /** The task memory in MiB. */
  taskMemory?: number;
  /** The minimum number of containers. */
  minContainers?: number;
  /** The maximum number of containers. */
  maxContainers?: number;
  /** The target CPU utilization for autoscaling. */
  autoScalingTargetCpuUtilization?: number;
  /** Java options for Keycloak. */
  javaOpts?: string;
  /** The hostname for Keycloak. Required for internet-facing, optional for internal (uses ALB DNS if not provided). */
  hostname?: string;
  /** The ACM certificate ARN for HTTPS. */
  certificateArn?: string;
  /** Whether the load balancer is internet-facing. */
  internetFacing?: boolean;
  /** Optional existing ECS task role. */
  existingTaskRole?: IRole;
  /** Optional existing ECS execution role. */
  existingExecutionRole?: IRole;
}

/**
 * Keycloak Service construct for the Auth Server.
 * Creates an ECS Fargate service running Keycloak with an Application Load Balancer.
 */
export class KeycloakService extends Construct {
  public readonly cluster: ICluster;
  public readonly service: FargateService;
  public readonly loadBalancer: ApplicationLoadBalancer;
  public readonly serviceSecurityGroup: SecurityGroup;
  public readonly ecsRoles: ECSRoles;
  public readonly keycloakUrl: string;

  constructor(scope: Construct, id: string, props: KeycloakServiceProps) {
    super(scope, id);

    const projectName = props.projectName ?? 'keycloak';
    const keycloakImage = props.keycloakImage ?? 'quay.io/keycloak/keycloak:latest';
    const taskCpu = props.taskCpu ?? 4096;
    const taskMemory = props.taskMemory ?? 8192;
    const minContainers = props.minContainers ?? 2;
    const maxContainers = props.maxContainers ?? 10;
    const autoScalingTargetCpuUtilization = props.autoScalingTargetCpuUtilization ?? 75;
    const javaOpts = props.javaOpts ?? '-server -Xms1024m -Xmx1638m';
    const isProd = props.account.prodLike ?? false;
    const internetFacing = props.internetFacing !== undefined ? props.internetFacing : true;

    // Create ECS roles using the dedicated construct
    this.ecsRoles = new ECSRoles(this, 'Roles', {
      account: props.account,
      taskRoleName: `${projectName}-auth-task-role`,
      executionRoleName: `${projectName}-auth-execution-role`,
      existingTaskRole: props.existingTaskRole,
      existingExecutionRole: props.existingExecutionRole,
    });

    this.cluster = new Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ContainerInsights.ENABLED,
      clusterName: `${projectName}-auth-cluster`,
    });

    const ecsLogGroupName = `/aws/ecs/${projectName}-auth-service`;
    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: RetentionDays.ONE_MONTH,
      logGroupName: ecsLogGroupName,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.serviceSecurityGroup = new SecurityGroup(this, 'SecurityGroup', {
      vpc: props.vpc,
      description: `Security group for ${projectName} auth service`,
      securityGroupName: `${projectName}-auth-sg`,
    });

    this.serviceSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      Port.tcp(7800),
      'kc jgroups-tcp',
    );
    this.serviceSecurityGroup.addIngressRule(
      this.serviceSecurityGroup,
      Port.tcp(57800),
      'kc jgroups-tcp-fd',
    );

    // Grant secrets access: execution role injects secrets at task start; task role for app runtime.
    props.databaseSecret.grantRead(this.ecsRoles.executionRole);
    props.keycloakSecret.grantRead(this.ecsRoles.executionRole);
    logGroup.grantWrite(this.ecsRoles.executionRole);

    this.loadBalancer = new ApplicationLoadBalancer(this, 'ALB', {
      vpc: props.vpc,
      internetFacing: internetFacing,
      loadBalancerName: `${projectName}-auth-alb`,
      deletionProtection: isProd,
    });

    const bucketSuffix = `-auth-alb-access-logs-${Stack.of(this).account}-${Stack.of(this).region}`;
    const maxProjectNameLength = 63 - bucketSuffix.length;
    const truncatedProjectName = projectName.slice(0, maxProjectNameLength);

    const accessLogBucket = new Bucket(this, 'ALBAccessLogBucket', {
      bucketName: `${truncatedProjectName}${bucketSuffix}`.toLowerCase(),
      encryption: BucketEncryption.S3_MANAGED,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      objectOwnership: ObjectOwnership.BUCKET_OWNER_PREFERRED,
      enforceSSL: true,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [{ expiration: Duration.days(90) }],
    });

    this.loadBalancer.logAccessLogs(accessLogBucket);

    // Determine the hostname for Keycloak:
    // - If hostname is provided, use it (works for both public and internal with custom hostname)
    // - If hostname is not provided (internal without custom hostname), use ALB DNS
    const keycloakHostname = props.hostname ?? this.loadBalancer.loadBalancerDnsName;
    this.keycloakUrl = props.hostname
      ? props.certificateArn
        ? `https://${props.hostname}`
        : `http://${props.hostname}`
      : `http://${this.loadBalancer.loadBalancerDnsName}`;

    const databasePort = props.databasePort ?? 3306;
    const environmentVars: { [key: string]: string } = {
      KC_DB: 'mysql',
      KC_DB_URL_DATABASE: 'keycloak',
      KC_DB_URL_HOST: props.databaseHost,
      KC_DB_URL_PORT: String(databasePort),
      KC_DB_USERNAME: 'admin',
      KC_HOSTNAME: keycloakHostname,
      KC_HOSTNAME_URL: this.keycloakUrl,
      KC_HOSTNAME_STRICT_BACKCHANNEL: 'true',
      KC_PROXY_ADDRESS_FORWARDING: 'true',
      KC_PROXY_HEADERS: 'xforwarded',
      KC_CACHE_CONFIG_FILE: 'cache-ispn-jdbc-ping.xml',
      KC_HTTP_ENABLED: 'true',
      JAVA_OPTS: javaOpts,
      _JAVA_OPTIONS: '-Djdk.net.preferIPv4Stack=true -Djdk.net.preferIPv4Addresses=true',
    };

    // Read Infinispan XML template from file, escape for shell embedding.
    // Escape $ so ${env.*} in XML are written literally (Infinispan resolves them at runtime).
    const infinispanXml = readFileSync(join(__dirname, 'cache-ispn-jdbc-ping.xml'), 'utf8')
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\$/g, '\\$')
      .replace(/\n/g, ' ');

    let entrypointScript = 'touch cache-ispn-jdbc-ping.xml && ';

    entrypointScript += `echo "${infinispanXml}" > cache-ispn-jdbc-ping.xml && `;

    entrypointScript +=
      'cp cache-ispn-jdbc-ping.xml /opt/keycloak/conf/cache-ispn-jdbc-ping.xml && ';

    entrypointScript += 'echo "Keycloak will be configured by Lambda after startup" && ';

    const startFlags = isProd ? '' : ' --debug';
    entrypointScript += `/opt/keycloak/bin/kc.sh build && /opt/keycloak/bin/kc.sh start${startFlags}`;

    const keycloakEntrypoint = ['sh', '-c', entrypointScript];

    const taskDef = new FargateTaskDefinition(this, 'TaskDef', {
      cpu: taskCpu,
      memoryLimitMiB: taskMemory,
      taskRole: this.ecsRoles.taskRole,
      executionRole: this.ecsRoles.executionRole,
      family: `${projectName}-auth-task`,
    });

    const container = taskDef.addContainer('keycloak', {
      image: ContainerImage.fromRegistry(keycloakImage),
      entryPoint: keycloakEntrypoint,
      containerName: `${projectName}-auth-service`,
      environment: environmentVars,
      secrets: {
        KC_DB_PASSWORD: EcsSecret.fromSecretsManager(props.databaseSecret, 'password'),
        KEYCLOAK_ADMIN: EcsSecret.fromSecretsManager(props.keycloakSecret, 'username'),
        KEYCLOAK_ADMIN_PASSWORD: EcsSecret.fromSecretsManager(props.keycloakSecret, 'password'),
      },
      logging: LogDrivers.awsLogs({
        streamPrefix: 'keycloak',
        logGroup: logGroup,
      }),
      workingDirectory: '/opt/keycloak',
    });

    container.addPortMappings(
      { containerPort: 8080, protocol: Protocol.TCP },
      { containerPort: 7800, protocol: Protocol.TCP },
      { containerPort: 57800, protocol: Protocol.TCP },
    );

    const targetGroup = new ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: 8080,
      protocol: ApplicationProtocol.HTTP,
      targetType: TargetType.IP,
      targetGroupName: `${projectName}-auth-tg`,
      healthCheck: {
        path: '/',
        healthyThresholdCount: 3,
        unhealthyThresholdCount: 3,
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        healthyHttpCodes: '200,302,401',
      },
      slowStart: Duration.seconds(60),
      stickinessCookieDuration: Duration.days(7),
    });

    const listenerOpen = internetFacing;
    if (props.certificateArn) {
      this.loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [{ certificateArn: props.certificateArn }],
        defaultTargetGroups: [targetGroup],
        sslPolicy: SslPolicy.TLS12,
        open: listenerOpen,
      });
    } else {
      this.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
        open: listenerOpen,
      });
    }
    if (!internetFacing) {
      if (props.certificateArn) {
        this.loadBalancer.connections.allowFrom(
          Peer.ipv4(props.vpc.vpcCidrBlock),
          Port.tcp(443),
          'Allow HTTPS from VPC when internal',
        );
      } else {
        this.loadBalancer.connections.allowFrom(
          Peer.ipv4(props.vpc.vpcCidrBlock),
          Port.tcp(80),
          'Allow HTTP from VPC when internal',
        );
      }
    }

    this.service = new FargateService(this, 'Service', {
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: minContainers,
      securityGroups: [this.serviceSecurityGroup],
      assignPublicIp: false,
      serviceName: `${projectName}-auth-service`,
      healthCheckGracePeriod: Duration.seconds(300),
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      minHealthyPercent: 50,
      maxHealthyPercent: 200,
      enableExecuteCommand: true,
    });

    this.service.attachToApplicationTargetGroup(targetGroup);

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: minContainers,
      maxCapacity: maxContainers,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: autoScalingTargetCpuUtilization,
      policyName: `${projectName}-auth-cpu-scaling`,
    });

    // CDK-NAG suppressions
    NagSuppressions.addResourceSuppressions(taskDef, [
      {
        id: 'AwsSolutions-ECS2',
        reason:
          'Environment variables contain non-sensitive Keycloak configuration (database host, ports, cache config). Sensitive values are injected via ECS secrets from Secrets Manager.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(
      this.loadBalancer,
      [
        {
          id: 'AwsSolutions-EC23',
          reason: internetFacing
            ? 'The ALB security group allows inbound access from 0.0.0.0/0 to serve authentication traffic. Access is restricted to HTTP/HTTPS ports only.'
            : 'When internal, access is restricted to VPC CIDR via allowFrom; cdk-nag cannot validate token-based CIDR (vpc.vpcCidrBlock) and throws CdkNagValidationFailure.',
        },
      ],
      true,
    );

    NagSuppressions.addResourceSuppressions(accessLogBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'This is the ALB access logging destination bucket. Enabling server access logging on it would create an infinite logging loop.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(
      this.ecsRoles.taskRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ECS Exec (enableExecuteCommand) requires KMS Decrypt with wildcard resource for SSM session encryption. This is a CDK-managed default policy.',
          appliesTo: ['Resource::*'],
        },
      ],
      true,
    );
  }
}
