module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Jest crawls with its own node crawler, not watchman. The repo-root .watchmanconfig
  // ignores .claude/ and .superpowers/ (agent and review worktrees), and watchman resolves a
  // path to the OUTERMOST directory holding a .watchmanconfig, so jest-via-watchman inside a
  // worktree would see zero files. See .watchmanconfig.
  watchman: false,
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
};
