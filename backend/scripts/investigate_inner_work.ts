import { PrismaClient } from '../src/generated/prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-pg';

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

async function main() {
  console.log("Fetching recent Inner Work Sessions...");

  const recentSessions = await prisma.innerWorkSession.findMany({
    take: 3,
    orderBy: {
      updatedAt: 'desc'
    },
    include: {
      messages: {
        orderBy: {
          timestamp: 'asc'
        }
      }
    }
  });

  if (recentSessions.length === 0) {
    console.log("No inner work sessions found.");
    return;
  }

  for (const session of recentSessions) {
    console.log(`\nSession ID: ${session.id} (updated: ${session.updatedAt.toISOString()})`);
    console.log(`Summary: ${session.summary || 'N/A'}`);

    for (const msg of session.messages) {
      console.log(`  [${msg.timestamp.toISOString()}] ${msg.role}: ${msg.content.substring(0, 100).replace(/\n/g, ' ')}...`);
    }

    // Check brain activity during this session window
    const startTime = session.messages[0]?.timestamp;
    const endTime = session.messages[session.messages.length - 1]?.timestamp;

    if (!startTime || !endTime) continue;

    console.log("  -- Activity Analysis --");
    const activities = await prisma.brainActivity.findMany({
      where: {
        createdAt: {
          gte: new Date(startTime.getTime() - 2000), // Buffer
          lte: new Date(endTime.getTime() + 10000)   // Buffer for AI response time
        }
      }
    });

    const retrievals = activities.filter(a => a.activityType === 'RETRIEVAL');
    console.log(`  Found ${retrievals.length} retrieval events.`);

    for (const r of retrievals) {
      const input = r.input as any;
      console.log(`    [${r.createdAt.toISOString()}] Queries: ${JSON.stringify(input.searchQueries)}`);
      if (input.referencesDetected) {
        console.log(`    Detected References: ${JSON.stringify(input.referencesDetected)}`);
      }
      const output = r.output as any;
      console.log(`    Results: Within=${output.withinSessionResultsCount}, Cross=${output.crossSessionResultsCount}`);
      if (output.crossSessionResultsCount === 0 && output.withinSessionResultsCount === 0) {
        console.log(`    ZERO RESULTS.`);
      }
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
