import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import prettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';

export default [
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        process: 'readonly',
        global: 'readonly',
        require: 'readonly',
        Buffer: 'readonly',
        window: 'readonly',
        document: 'readonly',
        __DEV__: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettier,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...prettierConfig.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'error',
      'no-console': 'warn',
      'prefer-const': 'error',
      'prettier/prettier': 'error',
      'no-restricted-properties': ['error', { property: 'randomUUID', message: "UUIDv7 only: use uuidv7() from '@meet-without-fear/shared' (shared/src/utils/uuid-v7.ts), never v4." }],
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'uuid', message: "UUIDv7 only: use uuidv7() from '@meet-without-fear/shared' (shared/src/utils/uuid-v7.ts), never v4." },
            { name: 'crypto', importNames: ['randomUUID'], message: "UUIDv7 only: use uuidv7() from '@meet-without-fear/shared' (shared/src/utils/uuid-v7.ts), never v4." },
            { name: 'node:crypto', importNames: ['randomUUID'], message: "UUIDv7 only: use uuidv7() from '@meet-without-fear/shared' (shared/src/utils/uuid-v7.ts), never v4." },
          ],
        },
      ],
    },
  },
  // Test files configuration
  {
    files: ['src/**/*.test.ts', 'src/**/*.spec.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: './tsconfig.json',
      },
      globals: {
        process: 'readonly',
        global: 'readonly',
        require: 'readonly',
        Buffer: 'readonly',
        // Jest globals
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      prettier: prettier,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      ...prettierConfig.rules,
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': 'error',
      'no-console': 'off',
      'prefer-const': 'error',
      'prettier/prettier': 'error',
    },
  },
];
