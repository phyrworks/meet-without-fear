/* eslint-env node */
const path = require('path');

module.exports = {
  preset: 'jest-expo',
  // Jest crawls with its own node crawler, not watchman. The repo-root .watchmanconfig
  // ignores .claude/ and .superpowers/ (agent and review worktrees), and watchman resolves a
  // path to the OUTERMOST directory holding a .watchmanconfig, so jest-via-watchman inside a
  // worktree would see zero files. See .watchmanconfig.
  watchman: false,
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|lucide-react-native|mixpanel-react-native)',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  moduleNameMapper: {
    '^@meet-without-fear/shared$': '<rootDir>/../shared/src/index.ts',
    '^@meet-without-fear/shared/(.*)$': '<rootDir>/../shared/src/$1',
    '^@shared$': '<rootDir>/../shared/src/index.ts',
    '^@shared/(.*)$': '<rootDir>/../shared/src/$1',
    // Match tsconfig paths: @/* resolves to ./* or ./src/*
    '^@/theme$': '<rootDir>/src/theme',
    '^@/theme/(.*)$': '<rootDir>/src/theme/$1',
    '^@/(.*)$': '<rootDir>/$1',
  },
  // Ensure Jest resolves modules from mobile workspace first, then root
  moduleDirectories: [
    path.resolve(__dirname, 'node_modules'),
    'node_modules',
  ],
  setupFiles: ['<rootDir>/jest.env.js'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
};
