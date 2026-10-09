// Prisma CLI configuration (Prisma 7+). The CLI no longer reads the
// datasource URL from schema.prisma, nor loads .env on its own.
//
// The CLI looks for this file in the current working directory, so run
// prisma from backend/ (npm run prisma / --workspace=backend do), or pass
// --config backend/prisma.config.ts. It ships in the production image at
// /app/backend/prisma.config.ts, where deploy.sh runs `migrate deploy`.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // process.env rather than prisma/config's env(): env() throws when the
    // variable is unset, and `prisma generate` runs in the image build
    // without a DATABASE_URL. Commands that need a database still fail
    // clearly when it is missing.
    url: process.env.DATABASE_URL,
  },
});
