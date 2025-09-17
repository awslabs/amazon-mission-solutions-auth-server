/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KeycloakCustomConfig, KeycloakClient } from '../utils/keycloak-config-loader';
import { BaseConfig, ConfigType } from './base-config';

export class DomainConfig extends BaseConfig {
  public hostedZoneId?: string;
  public hostname: string = 'auth.example.com';
  public certificateArn?: string;
  public websiteUri: string = '*';
  public internetFacing: boolean = true;

  constructor(config: ConfigType = {}) {
    super(config);

    if (config.hostname) {
      this.hostname = config.hostname;
    }

    // Explicitly handle internetFacing to ensure it's set correctly
    if (config.internetFacing !== undefined) {
      this.internetFacing = config.internetFacing;
    }

    // Validate configuration based on internetFacing setting
    this.validateConfiguration();
  }

  /**
   * Validates domain configuration based on internetFacing setting
   * @throws Error if configuration is invalid
   */
  private validateConfiguration(): void {
    if (this.internetFacing) {
      if (!this.hostname || this.hostname === 'auth.example.com') {
        throw new Error(
          'Domain hostname is required for internet-facing deployments and cannot be the default value',
        );
      }
      if (!this.hostedZoneId) {
        throw new Error('Domain hostedZoneId is required for internet-facing deployments');
      }
      if (!this.certificateArn) {
        throw new Error('Domain certificateArn is required for internet-facing deployments');
      }
    } else {
      if (!this.hostname) {
        throw new Error('Domain hostname is required for all deployments');
      }
    }
  }
}

export class DatabaseConfig extends BaseConfig {
  public instanceType: string = 'r5.large';

  constructor(config: ConfigType = {}) {
    super(config);
  }
}

export class ContainerConfig extends BaseConfig {
  public cpu: number = 4096;
  public memory: number = 8192;
  public minCount: number = 2;
  public maxCount: number = 10;
  public cpuUtilizationTarget: number = 75;
  public javaOpts: string = '-server -Xms1024m -Xmx1638m';

  constructor(config: ConfigType = {}) {
    super(config);
  }
}

export class KeycloakConfig extends BaseConfig {
  public adminUsername: string = 'keycloak';
  public keycloakImage: string = 'quay.io/keycloak/keycloak:latest';
  public container: ContainerConfig;

  constructor(config: ConfigType = {}) {
    super(config);
    this.container = new ContainerConfig(config.container || {});
  }
}

export class EnvironmentConfig extends BaseConfig {
  public account?: string;
  public region: string = 'us-west-2';
  public isProd: boolean = false;
  public vpcId?: string;
  public domain: DomainConfig;
  public database: DatabaseConfig;
  public keycloak: KeycloakConfig;

  constructor(config: ConfigType = {}) {
    super(config);
    this.domain = new DomainConfig(config.domain || {});
    this.database = new DatabaseConfig(config.database || {});
    this.keycloak = new KeycloakConfig(config.keycloak || {});
  }
}

export class AppConfig extends BaseConfig {
  /** Project name used as prefix for resource naming */
  public projectName: string;
  public env: EnvironmentConfig;
  /** Custom Keycloak configuration loaded from auth-config.json */
  public keycloakCustomConfig?: KeycloakCustomConfig;

  constructor(projectName: string, config: ConfigType = {}) {
    super(config);
    this.projectName = (config.projectName as string) || projectName;
    this.env = new EnvironmentConfig(config);
    this.keycloakCustomConfig = config.keycloakCustomConfig as KeycloakCustomConfig | undefined;
  }

  public get cdkEnvironment(): { account?: string; region?: string } {
    return {
      account: this.env.account,
      region: this.env.region,
    };
  }
}

export class ConfigUtils {
  /** Deep merge configuration objects */
  public static mergeConfigs(target: any, source: any): any {
    if (!source) return target;

    const output = { ...target };

    if (ConfigUtils.isObject(target) && ConfigUtils.isObject(source)) {
      Object.keys(source).forEach(key => {
        if (ConfigUtils.isObject(source[key])) {
          if (!(key in target)) {
            Object.assign(output, { [key]: source[key] });
          } else {
            output[key] = ConfigUtils.mergeConfigs(target[key], source[key]);
          }
        } else {
          Object.assign(output, { [key]: source[key] });
        }
      });
    }

    return output;
  }

  public static isObject(item: any): boolean {
    return item && typeof item === 'object' && !Array.isArray(item);
  }

  public static processCustomConfigPlaceholders(
    customConfig: KeycloakCustomConfig,
    websiteUri: string,
  ): void {
    if (customConfig.clients && Array.isArray(customConfig.clients)) {
      customConfig.clients.forEach(client => {
        ConfigUtils.processClientPlaceholders(client, websiteUri);
      });
    }
  }

  public static processClientPlaceholders(client: KeycloakClient, websiteUri: string): void {
    const redirectUri = websiteUri === '*' ? '*' : `${websiteUri}/*`;
    const webOrigin = websiteUri;

    if (client.redirectUris) {
      client.redirectUris = client.redirectUris.map((uri: string) =>
        uri === '__PLACEHOLDER_REDIRECT_URI__' ? redirectUri : uri,
      );
    }

    if (client.postLogoutRedirectUris) {
      client.postLogoutRedirectUris = client.postLogoutRedirectUris.map((uri: string) =>
        uri === '__PLACEHOLDER_REDIRECT_URI__' ? redirectUri : uri,
      );
    }

    if (client.webOrigins) {
      client.webOrigins = client.webOrigins.map((origin: string) =>
        origin === '__PLACEHOLDER_WEB_ORIGIN__' ? webOrigin : origin,
      );
    }
  }
}

export function loadConfig(defaultProjectName: string, environment: string = 'dev'): AppConfig {
  // Create an initial config with env vars
  const envAccount = process.env.CDK_DEPLOY_ACCOUNT || process.env.CDK_DEFAULT_ACCOUNT;
  const envRegion = process.env.CDK_DEPLOY_REGION || process.env.CDK_DEFAULT_REGION;

  // Start with an empty config that only has account and region
  let mergedConfig: any = {
    account: envAccount,
    region: envRegion,
    projectName: defaultProjectName, // Initialize with the default project name
  };

  // Try to load configuration from app-config.json
  try {
    const projectRoot = join(__dirname, '..', '..');
    const appConfigPath = join(projectRoot, 'config', 'app-config.json');

    if (existsSync(appConfigPath)) {
      const configFileContent = readFileSync(appConfigPath, 'utf8');
      const appConfig = JSON.parse(configFileContent);

      if (appConfig.projectName) {
        mergedConfig.projectName = appConfig.projectName;
      }

      mergedConfig = ConfigUtils.mergeConfigs(mergedConfig, appConfig);
    }
  } catch (error) {
    console.warn(`Failed to load environment config for ${environment}:`, error);
  }

  let customConfig: KeycloakCustomConfig | undefined;
  try {
    const projectRoot = join(__dirname, '..', '..');
    const customConfigPath = join(projectRoot, 'config', 'auth-config.json');
    if (existsSync(customConfigPath)) {
      customConfig = JSON.parse(readFileSync(customConfigPath, 'utf8'));

      if (customConfig && customConfig.clients) {
        customConfig.clients.forEach(client => {
          const websiteUri = client.websiteUri || '*';
          if (websiteUri && websiteUri !== '*') {
            ConfigUtils.processClientPlaceholders(client, websiteUri);
          }
        });
      }

      mergedConfig.keycloakCustomConfig = customConfig;
    }
  } catch (error) {
    console.warn('Failed to load custom auth config:', error);
  }

  // Create and return the app config
  return new AppConfig(defaultProjectName, mergedConfig);
}
