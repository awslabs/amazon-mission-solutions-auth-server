module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test', '<rootDir>/lambda'],
  testMatch: [
    // TypeScript tests for CDK
    '<rootDir>/test/**/*.test.ts',
    // JavaScript tests for Lambda functions
    '<rootDir>/lambda/**/?(*.)(spec|test).js',
    '<rootDir>/lambda/**/__tests__/**/*.js',
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
  collectCoverageFrom: [
    'lambda/keycloak-config/src/**/*.js',
    'lambda/keycloak-config/index.js',
    '!lambda/keycloak-config/test/**',
    '!lambda/**/node_modules/**',
    '!**/node_modules/**',
    '!test/integration/**',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  coveragePathIgnorePatterns: ['/node_modules/', '<rootDir>/cdk.out/'],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 60,
      functions: 70,
      lines: 70,
    },
    // Add specific thresholds for lambda code
    'lambda/keycloak-config/src/**/*.js': {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
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
        '<rootDir>/lambda/keycloak-config/test/**/*.test.js',
        '<rootDir>/lambda/keycloak-config/test/**/*.spec.js',
      ],
      // Use the Lambda's setup file
      setupFilesAfterEnv: ['<rootDir>/lambda/keycloak-config/test/setup.js'],
      // Exclude setup.js from being treated as a test
      testPathIgnorePatterns: [
        '<rootDir>/lambda/keycloak-config/test/setup.js',
        '<rootDir>/cdk.out/',
      ],
      modulePathIgnorePatterns: ['<rootDir>/cdk.out/', '<rootDir>/dist/'],
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
