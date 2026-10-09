// Prisma ORM 8 config for the guide's phase 2.3-2.5 / phase 4 path:
// a contract file written for Prisma 8 (inferred from the live DB) rather
// than prisma7Schema(). Use with `prisma ... --config prisma8.config.ts`.
//
// Why this exists: prisma7Schema("prisma/schema.prisma") cannot read this
// schema (PSL.PRISMA7_UNSUPPORTED_TYPE on the three Unsupported("vector(1024)")
// fields), see prisma.config.ts and the experiment report.
import 'dotenv/config';
import { definePrismaConfig } from 'prisma/config';
import { defineConfig as ormConfig } from '@prisma/orm-postgres/config';
import pgvector from '@prisma/orm-extension-pgvector/control';

export default definePrismaConfig({
  orm: ormConfig({
    extensions: [pgvector],
    contract: './prisma8/contract.prisma',
    migrations: { dir: './prisma8/migrations' },
    db: {
      connection: process.env['DATABASE_URL']!,
    },
  }),
});
