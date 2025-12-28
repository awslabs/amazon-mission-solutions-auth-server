/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { Duration } from 'aws-cdk-lib';
import {
  InstanceClass,
  InstanceSize,
  InstanceType,
  IVpc,
  Port,
  SecurityGroup,
  SubnetType,
} from 'aws-cdk-lib/aws-ec2';
import {
  AuroraMysqlEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  SubnetGroup,
} from 'aws-cdk-lib/aws-rds';
import { ISecret, Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';

export interface DatabaseProps {
  vpc: IVpc;
  projectName?: string;
  databaseInstanceType?: string;
  isProd?: boolean;
}

/**
 * Database construct for the Auth Server.
 * Creates an Aurora MySQL database cluster with appropriate security groups and configuration.
 */
export class Database extends Construct {
  public readonly databaseCluster: DatabaseCluster;
  public readonly databaseSecret: ISecret;
  public readonly dbSecurityGroup: SecurityGroup;

  constructor(scope: Construct, id: string, props: DatabaseProps) {
    super(scope, id);

    const projectName = props.projectName || 'keycloak';
    const databaseInstanceType = props.databaseInstanceType || 'r5.large';
    const isProd = props.isProd || false;

    this.dbSecurityGroup = new SecurityGroup(this, 'DBSecurityGroup', {
      vpc: props.vpc,
      description: 'Security group for RDS database',
      securityGroupName: `${projectName}-auth-db-sg`,
    });

    const databaseSecret = new Secret(this, 'DBClusterSecret', {
      secretName: `${projectName}-auth/database-credentials`,
      description: `Credentials for the ${projectName} RDS Aurora MySQL database`,
      generateSecretString: {
        excludePunctuation: true,
        includeSpace: false,
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({
          username: 'admin',
        }),
        generateStringKey: 'password',
      },
    });

    this.databaseSecret = databaseSecret;

    const subnetGroup = new SubnetGroup(this, 'DBSubnets', {
      description: `Subnet group for ${projectName} Keycloak database`,
      vpc: props.vpc,
      subnetGroupName: `${projectName}-auth-db-subnets`,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    });

    const instanceType = InstanceType.of(
      InstanceClass.R5,
      this.getInstanceSize(databaseInstanceType),
    );

    this.databaseCluster = new DatabaseCluster(this, 'DBCluster', {
      engine: DatabaseClusterEngine.auroraMysql({
        version: AuroraMysqlEngineVersion.VER_3_04_0,
      }),
      vpc: props.vpc,
      writer: ClusterInstance.provisioned('writer', {
        instanceType,
        instanceIdentifier: `${projectName}-auth-db-writer`,
      }),
      readers: [
        ClusterInstance.provisioned('reader', {
          instanceType,
          instanceIdentifier: `${projectName}-auth-db-reader`,
        }),
      ],
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [this.dbSecurityGroup],
      defaultDatabaseName: 'keycloak',
      clusterIdentifier: `${projectName}-auth-db-cluster`,
      deletionProtection: isProd,
      credentials: Credentials.fromSecret(databaseSecret),
      storageEncrypted: true,
      copyTagsToSnapshot: true,
      backup: {
        retention: isProd ? Duration.days(7) : Duration.days(1),
      },
      subnetGroup,
    });

    this.dbSecurityGroup.addIngressRule(
      this.dbSecurityGroup,
      Port.tcp(3306),
      'Allow MySQL connections from self',
    );
  }

  private getInstanceSize(instanceType: string): InstanceSize {
    const sizePart = instanceType.split('.')[1];

    switch (sizePart) {
      case 'large':
        return InstanceSize.LARGE;
      case 'xlarge':
        return InstanceSize.XLARGE;
      case '2xlarge':
        return InstanceSize.XLARGE2;
      case '4xlarge':
        return InstanceSize.XLARGE4;
      case '8xlarge':
        return InstanceSize.XLARGE8;
      case '12xlarge':
        return InstanceSize.XLARGE12;
      case '16xlarge':
        return InstanceSize.XLARGE16;
      case '24xlarge':
        return InstanceSize.XLARGE24;
      case 'small':
        return InstanceSize.SMALL;
      case 'medium':
        return InstanceSize.MEDIUM;
      default:
        return InstanceSize.LARGE;
    }
  }
}
