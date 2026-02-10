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

// Suppress console output during tests to keep output clean.
// Individual tests can spy on console methods when they need to verify logging.
beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'error').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
});

afterEach(() => {
  jest.restoreAllMocks();
});
