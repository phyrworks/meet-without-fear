module.exports = {
  extends: 'expo',
  ignorePatterns: ['/dist/*'],
  rules: {
    'no-restricted-properties': ['error', { property: 'randomUUID', message: "UUIDv7 only: use uuidv7() from '@meet-without-fear/shared' (shared/src/utils/uuid-v7.ts), never v4." }],
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: 'uuid', message: "UUIDv7 only: use uuidv7() from '@meet-without-fear/shared' (shared/src/utils/uuid-v7.ts), never v4." },
          { name: 'crypto', importNames: ['randomUUID'], message: "UUIDv7 only: use uuidv7() from '@meet-without-fear/shared' (shared/src/utils/uuid-v7.ts), never v4." },
        ],
      },
    ],
  },
  overrides: [
    {
      files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'],
      rules: { 'no-restricted-properties': 'off', 'no-restricted-imports': 'off' },
    },
  ],
  settings: {
    'import/extensions': ['.js', '.jsx', '.ts', '.tsx'],
    'import/resolver': {
      typescript: {
        project: './tsconfig.json',
      },
    },
  },
};
