module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Jest crawls with its own node crawler, not watchman. The repo-root .watchmanconfig
  // ignores .claude/ and .superpowers/ (agent and review worktrees), and watchman resolves a
  // path to the OUTERMOST directory holding a .watchmanconfig, so jest-via-watchman inside a
  // worktree would see zero files. See .watchmanconfig.
  watchman: false,
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
  maxWorkers: 1,
  clearMocks: true,
  restoreMocks: true,
  detectOpenHandles: true,
  // Silence console output during tests - use --verbose flag to see console output when debugging
  silent: true
};
