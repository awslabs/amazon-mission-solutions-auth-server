/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { InstanceType, IVpc, Port, SecurityGroup, SubnetType } from 'aws-cdk-lib/aws-ec2';
import {
  AuroraMysqlEngineVersion,
  ClusterInstance,
  Credentials,
  DatabaseCluster,
  DatabaseClusterEngine,
  SubnetGroup,
} from 'aws-cdk-lib/aws-rds';
import {
  ISecret,
  Secret,
  SecretRotation,
  SecretRotationApplication,
  SecretTargetAttachment,
} from 'aws-cdk-lib/aws-secretsmanager';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface DatabaseProps {
  vpc: IVpc;
  projectName?: string;
  databaseInstanceType?: string;
  isProd?: boolean;
  /**
   * Aurora MySQL backtrack window in seconds (0 or undefined = disabled).
   * Max 72 hours (259200).
   */
  backtrackWindowSeconds?: number;
  /**
   * Port for the database cluster. Use non-default for NAG RDS11 compliance.
   * @default 3306
   */
  port?: number;
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

    const projectName = props.projectName ?? 'keycloak';
    const databaseInstanceType = props.databaseInstanceType ?? 'r5.large';
    const isProd = props.isProd ?? false;
    const backtrackWindowSeconds = props.backtrackWindowSeconds;
    const dbPort = props.port ?? 3306;

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
      removalPolicy: isProd ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    this.databaseSecret = databaseSecret;

    const subnetGroup = new SubnetGroup(this, 'DBSubnets', {
      description: `Subnet group for ${projectName} Keycloak database`,
      vpc: props.vpc,
      subnetGroupName: `${projectName}-auth-db-subnets`,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
    });

    const instanceType = new InstanceType(databaseInstanceType);

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
      removalPolicy: isProd ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
      credentials: Credentials.fromSecret(databaseSecret),
      storageEncrypted: true,
      copyTagsToSnapshot: true,
      backup: {
        retention: isProd ? Duration.days(7) : Duration.days(1),
      },
      subnetGroup,
      port: dbPort,
      ...(backtrackWindowSeconds != null &&
        backtrackWindowSeconds > 0 && {
          backtrackWindow: Duration.seconds(backtrackWindowSeconds),
        }),
    });

    this.dbSecurityGroup.addIngressRule(
      this.dbSecurityGroup,
      Port.tcp(dbPort),
      'Allow MySQL connections from self',
    );

    if (isProd) {
      new SecretTargetAttachment(this, 'SecretAttachment', {
        secret: databaseSecret,
        target: this.databaseCluster,
      });

      new SecretRotation(this, 'Rotation', {
        application: SecretRotationApplication.MYSQL_ROTATION_SINGLE_USER,
        secret: databaseSecret,
        target: this.databaseCluster,
        vpc: props.vpc,
        vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
        automaticallyAfter: Duration.days(30),
      });
    } else {
      NagSuppressions.addResourceSuppressions(databaseSecret, [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'Secret rotation is only enabled for production environments. Non-prod environments are frequently torn down and do not require automatic rotation.',
        },
      ]);
    }

    NagSuppressions.addResourceSuppressions(this.databaseCluster, [
      {
        id: 'AwsSolutions-RDS6',
        reason:
          'Keycloak uses password-based authentication to connect to the database; IAM database authentication is not supported by the application.',
      },
      {
        id: 'AwsSolutions-RDS10',
        reason:
          'Deletion protection is conditionally enabled based on the prodLike flag. Non-prod environments intentionally disable it for easier teardown.',
      },
    ]);

    this.writeSSMParameters(projectName);
  }

  /**
   * Writes database connection details to SSM Parameter Store for runtime discovery.
   */
  private writeSSMParameters(projectName: string): void {
    const prefix = `/${projectName}/auth/database`;

    new StringParameter(this, 'EndpointParam', {
      parameterName: `${prefix}/endpoint`,
      stringValue: this.databaseCluster.clusterEndpoint.hostname,
      description: `Database endpoint for ${projectName} auth server`,
    });

    new StringParameter(this, 'PortParam', {
      parameterName: `${prefix}/port`,
      stringValue: String(this.databaseCluster.clusterEndpoint.port),
      description: `Database port for ${projectName} auth server`,
    });

    new StringParameter(this, 'SecretArnParam', {
      parameterName: `${prefix}/secret-arn`,
      stringValue: this.databaseSecret.secretArn,
      description: `Database secret ARN for ${projectName} auth server`,
    });
  }
}
