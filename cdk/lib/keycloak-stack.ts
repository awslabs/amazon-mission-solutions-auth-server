/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { CfnOutput, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { IpAddresses, Port, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { ARecord, HostedZone, RecordTarget } from 'aws-cdk-lib/aws-route53';
import { LoadBalancerTarget } from 'aws-cdk-lib/aws-route53-targets';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

import { AppConfig } from './config/app-config';
import { DatabaseConstruct } from './constructs/database-construct';
import { KeycloakConfigLambda } from './constructs/keycloak-config-lambda';
import { KeycloakServiceConstruct } from './constructs/keycloak-service-construct';

interface KeycloakStackProps extends StackProps {
  config: AppConfig;
}

export class KeycloakStack extends Stack {
  public readonly database: DatabaseConstruct;
  public readonly keycloakService: KeycloakServiceConstruct;
  public readonly configLambda?: KeycloakConfigLambda;

  constructor(scope: Construct, id: string, props: KeycloakStackProps) {
    super(scope, id, {
      ...props,
      env: props.config.cdkEnvironment,
      description: `${props.config.projectName} Keycloak Auth Server`,
    });

    const config = props.config;
    const projectName = config.projectName;
    const isProd = config.env.isProd;

    const hostname = config.env.domain.hostname;
    const certificateArn = config.env.domain.certificateArn;
    const hostedZoneId = config.env.domain.hostedZoneId;
    const internetFacing = config.env.domain.internetFacing;

    const keycloakAdminUsername = config.env.keycloak.adminUsername;
    const keycloakImage = config.env.keycloak.keycloakImage;
    const taskCpu = config.env.keycloak.container.cpu;
    const taskMemory = config.env.keycloak.container.memory;
    const minContainers = config.env.keycloak.container.minCount;
    const maxContainers = config.env.keycloak.container.maxCount;
    const autoScalingTargetCpuUtilization = config.env.keycloak.container.cpuUtilizationTarget;
    const javaOpts = config.env.keycloak.container.javaOpts;

    const databaseInstanceType = config.env.database.instanceType;

    // Either import existing VPC or create a new one
    const vpc = config.env.vpcId
      ? Vpc.fromLookup(this, 'ImportedVpc', {
          vpcId: config.env.vpcId,
        })
      : new Vpc(this, 'Vpc', {
          vpcName: `${projectName}-auth-vpc`,
          ipAddresses: IpAddresses.cidr('10.0.0.0/16'),
          maxAzs: 2,
          subnetConfiguration: [
            {
              cidrMask: 18,
              name: 'Public',
              subnetType: SubnetType.PUBLIC,
            },
            {
              cidrMask: 18,
              name: 'Private',
              subnetType: SubnetType.PRIVATE_WITH_EGRESS,
            },
          ],
          natGateways: 1,
          enableDnsHostnames: true,
          enableDnsSupport: true,
        });

    // Create Keycloak admin secret
    const keycloakSecret = new Secret(this, 'KCSecret', {
      generateSecretString: {
        excludePunctuation: true,
        generateStringKey: 'password',
        passwordLength: 12,
        secretStringTemplate: JSON.stringify({
          username: keycloakAdminUsername,
        }),
      },
      secretName: `${projectName}-auth/keycloak-admin`,
      description: `Credentials for the ${projectName} Keycloak admin user`,
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    // Create Database Construct
    this.database = new DatabaseConstruct(this, 'Database', {
      vpc,
      projectName,
      databaseInstanceType,
      isProd,
    });

    // Create Keycloak Service Construct
    this.keycloakService = new KeycloakServiceConstruct(this, 'KeyCloakService', {
      projectName,
      vpc,
      databaseHost: this.database.databaseCluster.clusterEndpoint.hostname,
      databaseSecret: this.database.databaseSecret,
      keycloakSecret,
      keycloakImage,
      taskCpu,
      taskMemory,
      minContainers,
      maxContainers,
      autoScalingTargetCpuUtilization,
      javaOpts,
      hostname,
      certificateArn,
      internetFacing,
      keycloakAdminUsername,
      isProd,
    });

    // Allow the service to access the database
    this.database.dbSecurityGroup.addIngressRule(
      this.keycloakService.serviceSecurityGroup,
      Port.tcp(3306),
      'Allow access from Keycloak service',
    );

    // Create Lambda to configure Keycloak if realm configuration exists
    if (config.keycloakCustomConfig) {
      const protocol = certificateArn ? 'https' : 'http';
      const keycloakUrl = `${protocol}://${this.keycloakService.loadBalancer.loadBalancerDnsName}`;

      // Create the Lambda to configure Keycloak with auth config
      this.configLambda = new KeycloakConfigLambda(this, 'KeycloakAuthConfigLambda', {
        projectName,
        keycloakUrl: certificateArn ? `https://${hostname}` : keycloakUrl, // Use hostname for SSL
        loadBalancerDns: this.keycloakService.loadBalancer.loadBalancerDnsName,
        keycloakAdminSecret: keycloakSecret,
        keycloakAdminUsername,
        customAuthConfig: config.keycloakCustomConfig,
        generateUserPasswords: true,
        isProd,
      });

      // Add explicit dependencies to ensure Lambda runs only after ALL Keycloak components are ready
      this.configLambda.node.addDependency(this.keycloakService);
      this.configLambda.node.addDependency(this.keycloakService.cluster);
      this.configLambda.node.addDependency(this.keycloakService.service);
      this.configLambda.node.addDependency(this.keycloakService.loadBalancer);

      // Also depend on the database being ready since Keycloak needs it to start
      this.configLambda.node.addDependency(this.database);
      this.configLambda.node.addDependency(this.database.databaseCluster);
    }

    // Create DNS record if hosted zone ID is provided
    if (hostedZoneId) {
      const zoneName = this.getZoneName(hostname);

      const hostedZone = HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
        hostedZoneId,
        zoneName,
      });

      const recordName = this.getRecordName(hostname, zoneName);

      new ARecord(this, 'KeycloakDnsRecord', {
        zone: hostedZone,
        recordName,
        target: RecordTarget.fromAlias(new LoadBalancerTarget(this.keycloakService.loadBalancer)),
      });
    }

    // Add essential infrastructure outputs for external systems
    new CfnOutput(this, 'LoadBalancerDNS', {
      value: this.keycloakService.loadBalancer.loadBalancerDnsName,
      description: 'DNS name of the load balancer',
      exportName: `${projectName}AuthServerLoadBalancerDNS`,
    });

    new CfnOutput(this, 'KeycloakUrl', {
      value: certificateArn
        ? `https://${this.keycloakService.loadBalancer.loadBalancerDnsName}`
        : `http://${this.keycloakService.loadBalancer.loadBalancerDnsName}`,
      description: 'URL of the Keycloak server',
      exportName: `${projectName}AuthServerUrl`,
    });

    new CfnOutput(this, 'KeycloakAdminSecretArn', {
      value: keycloakSecret.secretArn,
      description: 'ARN of the Keycloak admin secret containing the password',
      exportName: `${projectName}AuthServerAdminSecretArn`,
    });
  }

  private getZoneName(hostname: string): string {
    const parts = hostname.split('.');
    if (parts.length <= 2) {
      return hostname;
    } else {
      return parts.slice(1).join('.');
    }
  }

  private getRecordName(hostname: string, zoneName: string): string {
    if (hostname === zoneName) {
      return '';
    }

    if (!hostname.endsWith(`.${zoneName}`)) {
      console.warn(`Hostname ${hostname} does not end with zone name ${zoneName}`);
      const parts = hostname.split('.');
      if (parts.length > 0) {
        return parts[0];
      } else {
        return hostname;
      }
    }

    return hostname.slice(0, hostname.length - zoneName.length - 1);
  }
}
