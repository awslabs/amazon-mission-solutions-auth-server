/*
 * Copyright Amazon.com, Inc. or its affiliates.
 *
 * Barrel export for AMS Auth Server CDK constructs.
 * Consumers can import directly from the package root:
 *
 *   import { AuthServerStack, DataplaneConfig } from 'ams-auth-server';
 */

export { AuthServerStack } from './lib/auth-server-stack';
export type { AuthServerStackProps } from './lib/auth-server-stack';
export { NetworkStack } from './lib/network-stack';
export type { NetworkStackProps } from './lib/network-stack';
export { Dataplane, DataplaneConfig } from './lib/constructs/auth-server/dataplane';
export type { DataplaneProps } from './lib/constructs/auth-server/dataplane';
export { Network, NetworkConfig } from './lib/constructs/auth-server/network';
export type { NetworkProps } from './lib/constructs/auth-server/network';
export type { OSMLAccount } from './lib/constructs/types';
