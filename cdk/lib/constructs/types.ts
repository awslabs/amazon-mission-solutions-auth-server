/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * AWS account configuration for OSML deployments.
 *
 * This interface defines the core account properties used across
 * all OSML CDK constructs and stacks.
 */
export interface OSMLAccount {
  /**
   * AWS account ID (12-digit string)
   */
  id: string;

  /**
   * AWS region for deployment (e.g., "us-west-2")
   */
  region: string;

  /**
   * Whether this is a production-like environment.
   * Affects resource retention, logging, and termination protection.
   * @default false
   */
  prodLike: boolean;

  /**
   * Whether this is an ADC (Air-gapped Data Center) deployment.
   * May affect compliance and security configurations.
   * @default false
   */
  isAdc: boolean;
}

/**
 * Generic configuration object type for dynamic JSON parsing.
 * Allows flexible configuration with string keys and unknown value types.
 */
export type ConfigType = Record<string, unknown>;

/**
 * Base class for configuration objects that provides default value merging.
 *
 * This class enables configuration inheritance by merging provided configuration
 * with default values defined in subclasses. The constructor must be called
 * BEFORE setting default values in the subclass to ensure proper merging.
 *
 * @example
 * ```typescript
 * class MyConfig extends BaseConfig {
 *   MY_SETTING: string;
 *   MY_NUMBER: number;
 *   BOOLEAN_VALUE: boolean;
 *
 *   constructor(config: ConfigType = {}) {
 *     super(config);
 *     // Set defaults after super() call
 *     this.MY_SETTING = this.MY_SETTING ?? "default-value";
 *     this.MY_NUMBER = this.MY_NUMBER ?? 42;
 *     this.BOOLEAN_VALUE = this.BOOLEAN_VALUE ?? true;
 *   }
 * }
 *
 * // Uses defaults
 * const config1 = new MyConfig();
 * // config1.MY_SETTING === "default-value"
 *
 * // Overrides specific values
 * const config2 = new MyConfig({ MY_SETTING: "custom-value" });
 * // config2.MY_SETTING === "custom-value"
 * // config2.MY_NUMBER === 42 (default preserved)
 * ```
 */
export class BaseConfig {
  /**
   * Creates a new configuration instance by merging provided config with defaults.
   *
   * The constructor applies the provided config to the instance first, then
   * subclasses should set their default values using nullish coalescing (??).
   *
   * @param config - Partial configuration object to merge with defaults
   */
  constructor(config: ConfigType = {}) {
    Object.assign(this, config);
  }
}

/**
 * Region-specific configuration settings for AWS deployments.
 *
 * This class provides region-specific defaults such as maximum availability zones
 * and S3 endpoint configurations. Different AWS regions may have different
 * capabilities and service endpoints.
 */
export class RegionalConfig {
  /**
   * Maximum number of availability zones to use for VPC creation.
   * @default 2
   */
  maxVpcAzs: number = 2;

  /**
   * S3 endpoint configuration for the region.
   * May be undefined for regions with standard S3 endpoints.
   * @default undefined
   */
  s3Endpoint?: string;

  /**
   * Retrieves region-specific configuration for a given AWS region.
   *
   * This method returns configuration tailored to the specified region,
   * including any region-specific overrides for availability zones or
   * service endpoints.
   *
   * @param region - AWS region identifier (e.g., "us-west-2", "us-gov-west-1")
   * @returns RegionalConfig instance with region-specific settings
   *
   * @example
   * ```typescript
   * const config = RegionalConfig.getConfig("us-west-2");
   * console.log(config.maxVpcAzs); // 2
   * ```
   */
  static getConfig(region: string): RegionalConfig {
    const config = new RegionalConfig();

    // Apply region-specific overrides
    // GovCloud and other special regions may have different defaults
    if (region.startsWith('us-gov-')) {
      // GovCloud regions may have specific S3 endpoints
      config.s3Endpoint = `s3.${region}.amazonaws.com`;
    }

    return config;
  }
}
