/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { RemovalPolicy } from 'aws-cdk-lib';
import {
  FlowLogDestination,
  FlowLogTrafficType,
  ISecurityGroup,
  ISubnet,
  IVpc,
  SecurityGroup,
  SubnetSelection,
  SubnetType,
  Vpc,
} from 'aws-cdk-lib/aws-ec2';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

import { BaseConfig, ConfigType, OSMLAccount, RegionalConfig } from '../types';

/**
 * Configuration for the Network construct.
 *
 * This class defines networking configuration including VPC settings,
 * security groups, and subnet selection. It extends BaseConfig to support
 * configuration merging with defaults.
 */
export class NetworkConfig extends BaseConfig {
  /**
   * Name for the VPC when creating a new one.
   * @default "auth-server-vpc"
   */
  VPC_NAME?: string;

  /**
   * Existing VPC ID to import instead of creating a new VPC.
   * Format: vpc-[a-f0-9]{8,17}
   * @default undefined (creates new VPC)
   */
  VPC_ID?: string;

  /**
   * Maximum number of availability zones to use for VPC creation.
   * @default 2
   */
  MAX_AZS?: number;

  /**
   * Specific subnet IDs to use for resource deployment.
   * If not specified, all private subnets with egress will be selected.
   * @default undefined (selects all private subnets with egress)
   */
  TARGET_SUBNETS?: string[];

  /**
   * Existing security group ID to import instead of creating a new one.
   * Format: sg-[a-f0-9]{8,17}
   * @default undefined (creates new security group)
   */
  SECURITY_GROUP_ID?: string;

  /**
   * Name for the security group when creating a new one.
   * @default "auth-server-security-group"
   */
  SECURITY_GROUP_NAME?: string;

  /**
   * Creates a new NetworkConfig instance with default values.
   *
   * @param config - Partial configuration to merge with defaults
   */
  constructor(config: ConfigType = {}) {
    super(config);
    // Set defaults after super() call
    this.VPC_NAME = this.VPC_NAME ?? 'auth-server-vpc';
    this.SECURITY_GROUP_NAME = this.SECURITY_GROUP_NAME ?? 'auth-server-security-group';
    this.MAX_AZS = this.MAX_AZS ?? 2;
  }
}

/**
 * Properties for the Network construct.
 */
export interface NetworkProps {
  /**
   * AWS account configuration including region and environment type.
   */
  readonly account: OSMLAccount;

  /**
   * Network configuration settings.
   * If not provided, defaults will be used.
   */
  readonly config?: NetworkConfig;

  /**
   * Pre-existing VPC to use instead of creating or importing one.
   * Takes precedence over config.VPC_ID.
   */
  readonly vpc?: IVpc;
}

/**
 * Network construct that manages VPC and security group resources.
 *
 * This construct provides flexible VPC resolution with three options:
 * 1. Use a provided VPC directly (props.vpc)
 * 2. Import an existing VPC by ID (config.VPC_ID)
 * 3. Create a new VPC with default settings
 *
 * It also manages security groups and subnet selection for application deployment.
 *
 * @example
 * ```typescript
 * // Create with new VPC
 * const network = new Network(this, "Network", {
 *   account: { id: "123456789012", region: "us-west-2", prodLike: false, isAdc: false }
 * });
 *
 * // Import existing VPC
 * const network = new Network(this, "Network", {
 *   account: { id: "123456789012", region: "us-west-2", prodLike: false, isAdc: false },
 *   config: new NetworkConfig({ VPC_ID: "vpc-abc123" })
 * });
 *
 * // Use provided VPC
 * const network = new Network(this, "Network", {
 *   account: { id: "123456789012", region: "us-west-2", prodLike: false, isAdc: false },
 *   vpc: existingVpc
 * });
 * ```
 */
export class Network extends Construct {
  /**
   * The VPC instance (created, imported, or provided).
   */
  public readonly vpc: IVpc;

  /**
   * Selected subnets for resource deployment.
   */
  public readonly selectedSubnets: SubnetSelection;

  /**
   * Security group for application resources.
   */
  public readonly securityGroup: ISecurityGroup;

  /**
   * Network configuration used by this construct.
   */
  public readonly config: NetworkConfig;

  /**
   * Creates a new Network construct.
   *
   * @param scope - CDK scope
   * @param id - Construct ID
   * @param props - Network properties
   */
  constructor(scope: Construct, id: string, props: NetworkProps) {
    super(scope, id);

    // Initialize configuration with defaults
    this.config = props.config ?? new NetworkConfig();

    // Resolve VPC using three-way logic
    this.vpc = this.resolveVpc(props);

    // Resolve security group
    this.securityGroup = this.resolveSecurityGroup();

    // Resolve subnet selection
    this.selectedSubnets = this.resolveSubnets();
  }

  /**
   * Resolves the VPC to use based on configuration.
   *
   * Resolution order:
   * 1. Use props.vpc if provided
   * 2. Import VPC if config.VPC_ID is provided
   * 3. Create new VPC with default settings
   *
   * @param props - Network properties
   * @returns The resolved VPC instance
   */
  private resolveVpc(props: NetworkProps): IVpc {
    // Option 1: Use provided VPC directly
    if (props.vpc) {
      return props.vpc;
    }

    // Option 2: Import existing VPC by ID
    if (this.config.VPC_ID) {
      return Vpc.fromLookup(this, 'ImportedVpc', {
        vpcId: this.config.VPC_ID,
      });
    }

    // Option 3: Create new VPC
    const regionalConfig = RegionalConfig.getConfig(props.account.region);
    const maxAzs = this.config.MAX_AZS ?? regionalConfig.maxVpcAzs;

    const vpc = new Vpc(this, 'Vpc', {
      vpcName: this.config.VPC_NAME,
      maxAzs: maxAzs,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // Add VPC flow logs with conditional retention based on environment
    const flowLogGroupName = `/aws/vpc/flowlogs/${this.config.VPC_NAME}`;
    const flowLogGroup = new LogGroup(this, 'VPCFlowLogGroup', {
      logGroupName: flowLogGroupName,
      retention: RetentionDays.ONE_MONTH,
      removalPolicy: props.account.prodLike ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });

    vpc.addFlowLog('VPCFlowLog', {
      destination: FlowLogDestination.toCloudWatchLogs(flowLogGroup),
      trafficType: FlowLogTrafficType.ALL,
    });

    return vpc;
  }

  /**
   * Resolves the security group to use based on configuration.
   *
   * Resolution order:
   * 1. Import security group if config.SECURITY_GROUP_ID is provided
   * 2. Create new security group with allowAllOutbound
   *
   * @returns The resolved security group instance
   */
  private resolveSecurityGroup(): ISecurityGroup {
    // Option 1: Import existing security group by ID
    if (this.config.SECURITY_GROUP_ID) {
      return SecurityGroup.fromSecurityGroupId(
        this,
        'ImportedSecurityGroup',
        this.config.SECURITY_GROUP_ID,
      );
    }

    // Option 2: Create new security group
    return new SecurityGroup(this, 'SecurityGroup', {
      vpc: this.vpc,
      securityGroupName: this.config.SECURITY_GROUP_NAME,
      description: 'Security group for auth server resources',
      allowAllOutbound: true,
    });
  }

  /**
   * Resolves the subnet selection based on configuration.
   *
   * Resolution order:
   * 1. Select specific subnets if config.TARGET_SUBNETS is provided
   * 2. Select all private subnets with egress
   *
   * @returns The subnet selection configuration
   */
  private resolveSubnets(): SubnetSelection {
    // Option 1: Select specific subnets by ID
    if (this.config.TARGET_SUBNETS && this.config.TARGET_SUBNETS.length > 0) {
      return {
        subnets: this.config.TARGET_SUBNETS.map(subnetId =>
          this.vpc
            .selectSubnets({ subnetFilters: [] })
            .subnets.find(subnet => subnet.subnetId === subnetId),
        ).filter((subnet): subnet is ISubnet => subnet !== undefined),
      };
    }

    // Option 2: Select all private subnets with egress
    return {
      subnetType: SubnetType.PRIVATE_WITH_EGRESS,
    };
  }
}
