import { prisma } from './lib/prisma';

async function main() {
  const sessions = await prisma.session.findMany({
    orderBy: { createdAt: 'desc' },
    take: 3,
    select: { id: true, createdAt: true, status: true },
  });
  for (const s of sessions) {
    console.log(s.id, s.status, s.createdAt.toISOString());
  }
}
main().finally(() => prisma.$disconnect());
