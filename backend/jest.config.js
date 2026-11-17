/**
 * Three jest projects, so the inner loop never waits on Postgres.
 * (docs/architecture/testing.md, "Which tests to run when".)
 *
 *   fast    no database: unit tests and the golden-harness unit tests.  `npm test`
 *   db      `*.target.test.ts` (each clones a golden template into its own
 *           database), `*.pg.test.ts` and `src/__tests__/db/`.          `npm run test:db`
 *   golden  `*.golden.test.ts`: the recorded scenario suites, serial
 *           (they read the shared container's statement log).          `npm run test:golden`
 *
 * A suite that needs a database must be named so that it lands in `db` or
 * `golden`; in `fast` it fails on the first connect.
 *
 * `detectOpenHandles` is not set here: jest then forces --runInBand, which would
 * pin `fast` and `db` to one process. Pass `--detectOpenHandles` when debugging.
 */
const DB_SUITES = ['\\.target\\.test\\.ts$', '\\.pg\\.test\\.ts$', '/src/__tests__/db/'];
const GOLDEN_SUITES = ['\\.golden\\.test\\.ts$'];

const base = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: 'tsconfig.json',
      diagnostics: { ignoreCodes: [151001] },
    }]
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  transformIgnorePatterns: ['node_modules/(?!(yaml|@langchain|langchain)/)'],
  extensionsToTreatAsEsm: ['.ts', '.tsx'],
  moduleNameMapper: {
    '^@meet-without-fear/shared/(.*)$': '<rootDir>/../shared/src/$1',
    '^@shared/(.*)$': '<rootDir>/../shared/src/$1',
    '^@/(.*)$': '<rootDir>/src/$1'
  },
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  setupFiles: ['<rootDir>/src/__tests__/env.ts'],
  testTimeout: 15000,
  clearMocks: true,
  restoreMocks: true,
};

module.exports = {
  // Jest crawls with its own node crawler, not watchman. The repo-root .watchmanconfig
  // ignores .claude/ and .superpowers/ (agent and review worktrees), and watchman resolves a
  // path to the OUTERMOST directory holding a .watchmanconfig, so jest-via-watchman inside a
  // worktree would see zero files. See .watchmanconfig.
  watchman: false,
  // A bare `npx jest` stays serial; the npm scripts pass --maxWorkers per tier.
  maxWorkers: 1,
  // Silence console output during tests - use --verbose flag to see console output when debugging
  silent: true,
  projects: [
    {
      ...base,
      displayName: 'fast',
      testPathIgnorePatterns: ['/node_modules/', ...DB_SUITES, ...GOLDEN_SUITES],
    },
    {
      ...base,
      displayName: 'db',
      testMatch: [
        '**/__tests__/**/*.target.test.ts',
        '**/__tests__/**/*.pg.test.ts',
        '<rootDir>/src/__tests__/db/**/*.test.ts',
      ],
    },
    {
      ...base,
      displayName: 'golden',
      testMatch: ['**/__tests__/**/*.golden.test.ts'],
    },
  ],
};
