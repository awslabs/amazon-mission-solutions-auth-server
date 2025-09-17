/** @type {import('jest').Config} */
const config = {
  verbose: true,
  testEnvironment: 'node',
  collectCoverage: true,
  collectCoverageFrom: ['src/**/*.js', 'index.js'],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 80,
      statements: 80,
    },
  },
  testMatch: ['**/test/**/*.js', '**/?(*.)+(spec|test).js'],
  transform: {},
  moduleFileExtensions: ['js', 'json', 'node'],
  // Setup files will run before each test file
  setupFiles: ['<rootDir>/test/setup.js'],
  // Map node_modules to the parent project when run within the CDK project
  moduleDirectories: ['node_modules', '../../node_modules'],
  // Map module aliases
  moduleNameMapper: {
    '^axios$': '<rootDir>/../../node_modules/axios',
    '^@aws-sdk/(.*)$': '<rootDir>/../../node_modules/@aws-sdk/$1',
  },
};

module.exports = config;
