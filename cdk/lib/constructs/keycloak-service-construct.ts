/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { IVpc, Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
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
  TargetType,
} from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { CompositePrincipal, ManagedPolicy, Role, ServicePrincipal } from 'aws-cdk-lib/aws-iam';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { ISecret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface KeycloakServiceConstructProps {
  projectName?: string;
  vpc: IVpc;
  databaseHost: string;
  databaseSecret: ISecret;
  keycloakSecret: ISecret;
  keycloakAdminUsername?: string;
  keycloakImage?: string;
  taskCpu?: number;
  taskMemory?: number;
  minContainers?: number;
  maxContainers?: number;
  autoScalingTargetCpuUtilization?: number;
  javaOpts?: string;
  hostname: string;
  certificateArn?: string;
  internetFacing?: boolean;
  isProd?: boolean;
}

export class KeycloakServiceConstruct extends Construct {
  public readonly cluster: ICluster;
  public readonly service: FargateService;
  public readonly loadBalancer: ApplicationLoadBalancer;
  public readonly serviceSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: KeycloakServiceConstructProps) {
    super(scope, id);

    const projectName = props.projectName || 'keycloak';
    const keycloakImage = props.keycloakImage || 'quay.io/keycloak/keycloak:latest';
    const taskCpu = props.taskCpu || 4096;
    const taskMemory = props.taskMemory || 8192;
    const minContainers = props.minContainers || 2;
    const maxContainers = props.maxContainers || 10;
    const autoScalingTargetCpuUtilization = props.autoScalingTargetCpuUtilization || 75;
    const javaOpts = props.javaOpts || '-server -Xms1024m -Xmx1638m';
    const isProd = props.isProd || false;
    const internetFacing = props.internetFacing !== undefined ? props.internetFacing : true;

    this.cluster = new Cluster(this, 'Cluster', {
      vpc: props.vpc,
      containerInsightsV2: ContainerInsights.ENABLED,
      clusterName: `${projectName}-auth-cluster`,
    });

    const logGroup = new LogGroup(this, 'LogGroup', {
      retention: isProd ? RetentionDays.ONE_MONTH : RetentionDays.ONE_WEEK,
      logGroupName: `/aws/ecs/${projectName}-auth-service`,
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

    const taskRole = new Role(this, 'TaskRole', {
      assumedBy: new CompositePrincipal(
        new ServicePrincipal('ecs.amazonaws.com'),
        new ServicePrincipal('ecs-tasks.amazonaws.com'),
      ),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
      roleName: `${projectName}-auth-task-role`,
    });

    const executionRole = new Role(this, 'ExecutionRole', {
      assumedBy: new ServicePrincipal('ecs-tasks.amazonaws.com'),
      roleName: `${projectName}-auth-execution-role`,
    });

    props.databaseSecret.grantRead(taskRole);
    props.keycloakSecret.grantRead(taskRole);

    logGroup.grantWrite(taskRole);

    taskRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
    );

    const taskDef = new FargateTaskDefinition(this, 'TaskDef', {
      cpu: taskCpu,
      memoryLimitMiB: taskMemory,
      taskRole: taskRole,
      executionRole: executionRole,
      family: `${projectName}-auth-task`,
    });

    const environmentVars: { [key: string]: string } = {
      KC_DB: 'mysql',
      KC_DB_URL_DATABASE: 'keycloak',
      KC_DB_URL_HOST: props.databaseHost,
      KC_DB_URL_PORT: '3306',
      KC_DB_USERNAME: 'admin',
      KC_HOSTNAME: props.hostname,
      KC_HOSTNAME_URL: props.certificateArn ? `https://${props.hostname}` : `http://${props.hostname}`,
      KC_HOSTNAME_STRICT_BACKCHANNEL: 'true',
      KC_PROXY: 'edge',
      KC_PROXY_ADDRESS_FORWARDING: 'true',
      KC_PROXY_HEADERS: 'xforwarded',
      KC_CACHE_CONFIG_FILE: 'cache-ispn-jdbc-ping.xml',
      KC_HTTP_ENABLED: 'true',
      JAVA_OPTS: javaOpts,
      _JAVA_OPTIONS: '-Djdk.net.preferIPv4Stack=true -Djdk.net.preferIPv4Addresses=true',
    };

    let entrypointScript = 'touch cache-ispn-jdbc-ping.xml && ';

    entrypointScript +=
      'echo "<?xml version=\\"1.0\\" encoding=\\"UTF-8\\"?> <infinispan    xmlns:xsi=\\"http://www.w3.org/2001/XMLSchema-instance\\"    xsi:schemaLocation=\\"urn:infinispan:config:11.0 http://www.infinispan.org/schemas/infinispan-config-11.0.xsd\\"    xmlns=\\"urn:infinispan:config:11.0\\">  <jgroups>    <stack name=\\"jdbc-ping-tcp\\" extends=\\"tcp\\">      <JDBC_PING connection_driver=\\"com.mysql.cj.jdbc.Driver\\"                 connection_username=\\"\\${env.KC_DB_USERNAME}\\"                  connection_password=\\"\\${env.KC_DB_PASSWORD}\\"                 connection_url=\\"jdbc:mysql://\\${env.KC_DB_URL_HOST}/\\${env.KC_DB_URL_DATABASE}?useSSL=true&amp;requireSSL=false&amp;verifyServerCertificate=false&amp;connectTimeout=30000\\"                                  info_writer_sleep_time=\\"500\\"                 remove_all_data_on_view_change=\\"true\\"                 stack.combine=\\"REPLACE\\"                 stack.position=\\"MPING\\" />    </stack>  </jgroups>  <cache-container name=\\"keycloak\\">    <transport lock-timeout=\\"60000\\" stack=\\"jdbc-ping-tcp\\"/>    <local-cache name=\\"realms\\">      <encoding>        <key media-type=\\"application/x-java-object\\"/>        <value media-type=\\"application/x-java-object\\"/>      </encoding>      <memory max-count=\\"10000\\"/>    </local-cache>    <local-cache name=\\"users\\">      <encoding>        <key media-type=\\"application/x-java-object\\"/>        <value media-type=\\"application/x-java-object\\"/>      </encoding>      <memory max-count=\\"10000\\"/>    </local-cache>    <distributed-cache name=\\"sessions\\" owners=\\"3\\">      <expiration lifespan=\\"-1\\"/>    </distributed-cache>    <distributed-cache name=\\"authenticationSessions\\" owners=\\"3\\">      <expiration lifespan=\\"-1\\"/>    </distributed-cache>    <distributed-cache name=\\"offlineSessions\\" owners=\\"3\\">      <expiration lifespan=\\"-1\\"/>    </distributed-cache>    <distributed-cache name=\\"clientSessions\\" owners=\\"3\\">      <expiration lifespan=\\"-1\\"/>    </distributed-cache>    <distributed-cache name=\\"offlineClientSessions\\" owners=\\"3\\">      <expiration lifespan=\\"-1\\"/>    </distributed-cache>    <distributed-cache name=\\"loginFailures\\" owners=\\"3\\">      <expiration lifespan=\\"-1\\"/>    </distributed-cache>    <local-cache name=\\"authorization\\">      <encoding>        <key media-type=\\"application/x-java-object\\"/>        <value media-type=\\"application/x-java-object\\"/>      </encoding>      <memory max-count=\\"10000\\"/>    </local-cache>    <replicated-cache name=\\"work\\">      <expiration lifespan=\\"-1\\"/>    </replicated-cache>    <local-cache name=\\"keys\\">      <encoding>        <key media-type=\\"application/x-java-object\\"/>        <value media-type=\\"application/x-java-object\\"/>      </encoding>      <expiration max-idle=\\"3600000\\"/>      <memory max-count=\\"1000\\"/>    </local-cache>    <distributed-cache name=\\"actionTokens\\" owners=\\"3\\">      <encoding>        <key media-type=\\"application/x-java-object\\"/>        <value media-type=\\"application/x-java-object\\"/>      </encoding>      <expiration max-idle=\\"-1\\" lifespan=\\"-1\\" interval=\\"300000\\"/>     <memory max-count=\\"-1\\"/>    </distributed-cache>  </cache-container></infinispan>" > cache-ispn-jdbc-ping.xml && ';

    entrypointScript +=
      'cp cache-ispn-jdbc-ping.xml /opt/keycloak/conf/cache-ispn-jdbc-ping.xml && ';

    entrypointScript += 'echo "Keycloak will be configured by Lambda after startup" && ';

    entrypointScript += '/opt/keycloak/bin/kc.sh build && /opt/keycloak/bin/kc.sh start --debug';

    const keycloakEntrypoint = ['sh', '-c', entrypointScript];

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

    this.loadBalancer = new ApplicationLoadBalancer(this, 'ALB', {
      vpc: props.vpc,
      internetFacing: internetFacing,
      loadBalancerName: `${projectName}-auth-alb`,
      deletionProtection: isProd,
    });

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

    if (props.certificateArn) {
      this.loadBalancer.addListener('HttpsListener', {
        port: 443,
        protocol: ApplicationProtocol.HTTPS,
        certificates: [{ certificateArn: props.certificateArn }],
        defaultTargetGroups: [targetGroup],
      });
    } else {
      this.loadBalancer.addListener('HttpListener', {
        port: 80,
        protocol: ApplicationProtocol.HTTP,
        defaultTargetGroups: [targetGroup],
      });
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
  }
}
