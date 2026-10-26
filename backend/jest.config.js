const fs = require('fs');
const path = require('path');

// TS-9 (phoenix/target-shape only; REMOVE at TS-13): while the app is rewritten
// cluster by cluster against the target schema, clusters not yet rewritten do
// not type-check, and ts-jest's per-file diagnostics would fail every suite
// that imports the app — at import, before any assertion. On the target shape
// the suite therefore transpiles only (`isolatedModules`); the rewritten files
// are type-checked by `npx tsc --noEmit -p tsconfig.ts9.json` instead (scoped to
// them; see the TS-9 report). Detected from the schema the generated client was
// built from, so phoenix/base is unaffected.
const targetShape = /@@map\("participant"\)/.test(
  fs.readFileSync(path.join(__dirname, 'prisma/schema.prisma'), 'utf8')
);

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      useESM: true,
      tsconfig: 'tsconfig.json',
      diagnostics: { ignoreCodes: [151001] },
      ...(targetShape ? { isolatedModules: true } : {}),
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
