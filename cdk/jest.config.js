module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/lambda'],
  testMatch: [
    // TypeScript tests for CDK
    '<rootDir>/test/**/*.test.ts',
    // TypeScript tests for Lambda functions
    '<rootDir>/lambda/**/?(*.)(spec|test).ts',
    '<rootDir>/lambda/**/__tests__/**/*.ts',
  ],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  // Don't transform JS files in node_modules
  transformIgnorePatterns: ['/node_modules/'],
  // Exclude cdk.out and other build artifacts from module resolution
  modulePathIgnorePatterns: ['<rootDir>/cdk.out/', '<rootDir>/dist/'],
  // Exclude cdk.out and integration tests from default test discovery
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/cdk.out/', '<rootDir>/test/integration/'],
  collectCoverage: true,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/cdk.out/'],
  // Setup projects for multi-project testing
  projects: [
    {
      displayName: 'cdk',
      testMatch: ['<rootDir>/test/**/*.test.ts'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      modulePathIgnorePatterns: ['<rootDir>/cdk.out/', '<rootDir>/dist/'],
      testPathIgnorePatterns: ['/node_modules/', '<rootDir>/cdk.out/', '<rootDir>/test/integration/'],
      globalTeardown: '<rootDir>/test/test-utils.ts',
    },
    {
      displayName: 'keycloak-lambda',
      testMatch: [
        '<rootDir>/lambda/keycloak-config/test/**/*.test.ts',
        '<rootDir>/lambda/keycloak-config/test/**/*.spec.ts',
      ],
      transform: {
        '^.+\\.tsx?$': ['ts-jest', { tsconfig: '<rootDir>/lambda/keycloak-config/tsconfig.test.json' }],
      },
      // Use the Lambda's setup file
      setupFilesAfterEnv: ['<rootDir>/lambda/keycloak-config/test/setup.ts'],
      // Exclude setup.ts from being treated as a test
      testPathIgnorePatterns: [
        '<rootDir>/lambda/keycloak-config/test/setup.ts',
        '<rootDir>/cdk.out/',
      ],
      modulePathIgnorePatterns: ['<rootDir>/cdk.out/', '<rootDir>/dist/'],
      collectCoverageFrom: [
        '<rootDir>/lambda/keycloak-config/src/**/*.ts',
        '<rootDir>/lambda/keycloak-config/index.ts',
        '!<rootDir>/lambda/keycloak-config/src/types.ts',
        '!<rootDir>/lambda/keycloak-config/test/**',
        '!<rootDir>/lambda/**/node_modules/**',
      ],
      coverageThreshold: {
        global: {
          statements: 80,
          branches: 70,
          functions: 80,
          lines: 80,
        },
      },
    },
    {
      displayName: 'integration',
      testMatch: ['<rootDir>/test/integration/**/*.integration.test.ts'],
      transform: {
        '^.+\\.tsx?$': 'ts-jest',
      },
      modulePathIgnorePatterns: ['<rootDir>/cdk.out/', '<rootDir>/dist/'],
      testTimeout: 60000,
    },
  ],
  verbose: true,
};
