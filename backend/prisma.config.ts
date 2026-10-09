// Prisma ORM 8 CLI configuration (experiment: phoenix/prisma-8-contract).
//
// `prisma` now runs Prisma ORM 8; Prisma ORM 7 runs as `prisma7` with its own
// config in prisma7.config.ts (auto-discovered by the prisma7 binary).
// prisma7Schema() makes the existing Prisma 7 schema.prisma the contract source.
import 'dotenv/config';
import { definePrismaConfig } from 'prisma/config';
import { defineConfig as ormConfig, prisma7Schema } from '@prisma/orm-postgres/config';
import pgvector from '@prisma/orm-extension-pgvector/control';

export default definePrismaConfig({
  orm: ormConfig({
    extensions: [pgvector],
    contract: prisma7Schema('prisma/schema.prisma'),
    migrations: { dir: './prisma8/migrations' },
    db: {
      connection: process.env['DATABASE_URL']!,
    },
  }),
});
