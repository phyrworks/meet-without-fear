import { prisma } from '../lib/prisma';

async function main() {
  // Operator tooling (every participant's facts): the NOTABLE_FACTS documents
  // of ai_memory (TS-12; was UserVessel.notableFacts)
  const allVessels = await prisma.aiMemory.findMany({
    where: { kind: 'NOTABLE_FACTS' },
    select: {
      doc: true,
      updatedAt: true,
      participant: { select: { userId: true, sessionId: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 10,
  });

  console.log(`Total NOTABLE_FACTS documents found: ${allVessels.length}\n`);

  for (const v of allVessels) {
    console.log(`Session: ${v.participant?.sessionId}`);
    console.log(`User: ${v.participant?.userId}`);
    console.log(`Updated: ${v.updatedAt}`);
    const facts = (v.doc as { facts?: unknown } | null)?.facts;
    if (Array.isArray(facts)) {
      console.log(`Facts (${facts.length}):`, facts);
    } else {
      console.log('Facts: null');
    }
    console.log('---');
  }
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
