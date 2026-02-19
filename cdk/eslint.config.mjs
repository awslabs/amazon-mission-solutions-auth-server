import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';
import prettierPlugin from 'eslint-plugin-prettier';
import jestPlugin from 'eslint-plugin-jest';
import simpleImportSortPlugin from 'eslint-plugin-simple-import-sort';
import globals from 'globals';

const tsRules = {
  // Import rules
  'import/default': 'off',
  'import/order': 'off',
  'import/no-namespace': 'error',

  // Simple import sort
  'simple-import-sort/imports': 'error',

  // TypeScript rules
  'no-unused-vars': 'off',
  '@typescript-eslint/no-unused-vars': [
    'error',
    {
      argsIgnorePattern: '^_',
      varsIgnorePattern: '^_',
      caughtErrorsIgnorePattern: '^_',
    },
  ],
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true }],
  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/interface-name-prefix': 'off',
  '@typescript-eslint/no-empty-interface': 'off',
  '@typescript-eslint/no-inferrable-types': 'off',
  '@typescript-eslint/no-non-null-assertion': 'off',
  '@typescript-eslint/require-await': 'error',
  '@typescript-eslint/no-empty-function': 'off',

  // Jest rules
  'jest/no-done-callback': 'off',
  'jest/no-conditional-expect': 'off',

  // Prettier
  'prettier/prettier': 'error',

  // Core rules
  'require-await': 'off',
  'no-console': 'off',
  'no-debugger': 'error',
  'prefer-const': 'error',
};

const tsPlugins = {
  '@typescript-eslint': tseslint,
  import: importPlugin,
  prettier: prettierPlugin,
  jest: jestPlugin,
  'simple-import-sort': simpleImportSortPlugin,
};

export default [
  // Global ignores
  {
    ignores: ['node_modules/**', 'cdk.out/**', 'dist/**', 'coverage/**'],
  },

  js.configs.recommended,

  // Configuration for JavaScript files (no type checking)
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2020,
        ...globals.jest,
      },
    },
    plugins: {
      import: importPlugin,
      prettier: prettierPlugin,
      jest: jestPlugin,
      'simple-import-sort': simpleImportSortPlugin,
    },
    rules: {
      // Import rules
      'import/default': 'off',
      'import/order': 'off',
      'import/no-namespace': 'error',

      // Simple import sort
      'simple-import-sort/imports': 'error',

      // Prettier
      'prettier/prettier': 'error',
    },
  },

  // Configuration for CDK TypeScript files (with type checking via CDK tsconfig)
  {
    files: ['bin/**/*.ts', 'lib/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './tsconfig.json',
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2020,
        ...globals.jest,
      },
    },
    plugins: tsPlugins,
    rules: tsRules,
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
      },
    },
  },

  // Configuration for Lambda TypeScript source files (with type checking via Lambda tsconfig)
  {
    files: ['lambda/**/*.ts'],
    ignores: ['lambda/**/test/**'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: './lambda/keycloak-config/tsconfig.json',
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2020,
        ...globals.jest,
      },
    },
    plugins: tsPlugins,
    rules: tsRules,
    settings: {
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
      },
    },
  },

  // Configuration for Lambda TypeScript test files (no type-checked rules — tests use
  // require(), jest.mock factories, and dynamic mocks that don't benefit from project-aware linting)
  {
    files: ['lambda/**/test/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2020,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.es2020,
        ...globals.jest,
      },
    },
    plugins: tsPlugins,
    rules: {
      // Import rules
      'import/default': 'off',
      'import/order': 'off',
      'import/no-namespace': 'error',
      'simple-import-sort/imports': 'error',

      // Prettier
      'prettier/prettier': 'error',

      // Jest rules
      'jest/no-done-callback': 'off',
      'jest/no-conditional-expect': 'off',

      // Core rules
      'no-console': 'off',
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-unused-vars': 'off',
    },
  },
];
