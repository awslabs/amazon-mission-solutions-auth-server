/*
 * Copyright 2025 Amazon.com, Inc. or its affiliates.
 */

/**
 * Jest setup file for keycloak-config Lambda tests
 * This file runs before each test file
 */

// Set test environment variables
process.env.NODE_ENV = 'test';

// Increase timeout for async operations if needed
jest.setTimeout(10000);

// Global test utilities can be added here
