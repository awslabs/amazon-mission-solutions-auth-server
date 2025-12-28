/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

import { BaseConfig, ConfigType, OSMLAccount, RegionalConfig } from '../lib/constructs/types';

describe('types', () => {
  describe('OSMLAccount', () => {
    it('should define the correct interface structure', () => {
      const account: OSMLAccount = {
        id: '123456789012',
        region: 'us-west-2',
        prodLike: true,
        isAdc: false,
      };

      expect(account.id).toBe('123456789012');
      expect(account.region).toBe('us-west-2');
      expect(account.prodLike).toBe(true);
      expect(account.isAdc).toBe(false);
    });
  });

  describe('BaseConfig', () => {
    class TestConfig extends BaseConfig {
      DEFAULT_VALUE!: string;
      NUMBER_VALUE!: number;
      BOOLEAN_VALUE!: boolean;

      constructor(config: ConfigType = {}) {
        super(config);
        // Set defaults after super() call using nullish coalescing
        this.DEFAULT_VALUE = this.DEFAULT_VALUE ?? 'default';
        this.NUMBER_VALUE = this.NUMBER_VALUE ?? 42;
        this.BOOLEAN_VALUE = this.BOOLEAN_VALUE ?? true;
      }
    }

    it('should use default values when no config provided', () => {
      const config = new TestConfig();

      expect(config.DEFAULT_VALUE).toBe('default');
      expect(config.NUMBER_VALUE).toBe(42);
      expect(config.BOOLEAN_VALUE).toBe(true);
    });

    it('should merge provided config with defaults', () => {
      const config = new TestConfig({
        DEFAULT_VALUE: 'custom',
        NUMBER_VALUE: 100,
      });

      expect(config.DEFAULT_VALUE).toBe('custom');
      expect(config.NUMBER_VALUE).toBe(100);
      expect(config.BOOLEAN_VALUE).toBe(true); // Default preserved
    });

    it('should allow adding new properties', () => {
      const config = new TestConfig({
        NEW_PROPERTY: 'new-value',
      });

      expect((config as unknown as Record<string, unknown>).NEW_PROPERTY).toBe('new-value');
    });
  });

  describe('RegionalConfig', () => {
    it('should provide default values', () => {
      const config = new RegionalConfig();

      expect(config.maxVpcAzs).toBe(2);
      expect(config.s3Endpoint).toBeUndefined();
    });

    it('should return config for standard regions', () => {
      const config = RegionalConfig.getConfig('us-west-2');

      expect(config.maxVpcAzs).toBe(2);
      expect(config.s3Endpoint).toBeUndefined();
    });

    it('should return config with S3 endpoint for GovCloud regions', () => {
      const config = RegionalConfig.getConfig('us-gov-west-1');

      expect(config.maxVpcAzs).toBe(2);
      expect(config.s3Endpoint).toBe('s3.us-gov-west-1.amazonaws.com');
    });

    it('should handle different GovCloud regions', () => {
      const config = RegionalConfig.getConfig('us-gov-east-1');

      expect(config.s3Endpoint).toBe('s3.us-gov-east-1.amazonaws.com');
    });
  });
});
