/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/** Generic configuration object type for dynamic JSON parsing */
export type ConfigType = Record<string, any>;

/**
 * Base class for configuration objects that copies properties
 * from the provided config to the instance
 */
export class BaseConfig {
  constructor(config: ConfigType = {}) {
    Object.assign(this, config);
  }
}
