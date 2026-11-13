import { prisma } from '../lib/prisma';
import { exemptProcessFromRoleGuard } from '../lib/prisma-role-guard';

// Operator script: connects with whatever DATABASE_URL / APP_DATABASE_URL the operator gives it
// (often the admin URL), so the runtime role guard does not apply (work-k5fk.10.3).
exemptProcessFromRoleGuard('operator script reset-db-data.ts');

async function main() {
  if (!process.argv.includes('--i-understand-this-deletes-everything')) {
    console.error(
      'Refusing to run without --i-understand-this-deletes-everything flag.\n' +
        'This script TRUNCATEs every application table. Set DATABASE_URL explicitly.',
    );
    process.exit(1);
  }

  const dbUrl = process.env.DATABASE_URL ?? '';
  const host = dbUrl.match(/@([^/:]+)/)?.[1] ?? '(unknown)';
  console.log(`Connected to DB host: ${host}`);

  const rows = (await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename != '_prisma_migrations'
    ORDER BY tablename
  `) as Array<{ tablename: string }>;

  if (rows.length === 0) {
    console.log('No application tables found. Nothing to do.');
    return;
  }

  const names = rows.map((r: { tablename: string }) => r.tablename);
  const quoted = names.map(n => `"${n}"`).join(', ');
  console.log(`Truncating ${rows.length} tables: ${names.join(', ')}`);

  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  console.log('Done.');
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
