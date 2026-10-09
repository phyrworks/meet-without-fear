import { PrismaClient } from '../src/generated/prisma/client';
import { createPrismaPgAdapter } from '../src/lib/prisma-pg';

const prisma = new PrismaClient({ adapter: createPrismaPgAdapter() });

async function main() {
  // Start looking from around the time of the incident
  const startTime = new Date('2026-01-13T06:15:00Z');

  console.log("=== Conversation History (Since Incident) ===");
  const messages = await prisma.message.findMany({
    where: {
      timestamp: {
        gte: startTime
      }
    },
    orderBy: {
      timestamp: 'asc'
    },
    include: {
      sender: true
    }
  });

  for (const m of messages) {
    const role = m.senderId ? "USER" : "AI";
    console.log(`[${m.timestamp.toISOString()}] ${role}: ${m.content.replace(/\n/g, ' ')}`);
    // Check for embeddings on this message (just boolean check)
    // Prisma "Unsupported" types are hard to read directly, but existence is key.
    // We can't easily check for the embedding value itself in JS, but we know messages get embedded.
  }

  console.log("\n=== User Memories (Eloy) ===");
  const memories = await prisma.userMemory.findMany({
    where: {
      content: {
        contains: 'Eloy',
        mode: 'insensitive'
      }
    }
  });

  if (memories.length === 0) {
    console.log("No UserMemories found containing 'Eloy'.");
  } else {
    for (const m of memories) {
      console.log(`[${m.createdAt.toISOString()}] ${m.content} (Status: ${m.status}, Source: ${m.source})`);
    }
  }

  console.log("\n=== Brain Activity (Queries vs Storage) ===");
  // Check if any "Who is Eloy?" text ended up in a storage-like activity (like 'EMBEDDING' for a message)
  // vs just a retrieval query.
  const activities = await prisma.brainActivity.findMany({
    where: {
      createdAt: {
        gte: startTime
      }
    },
    orderBy: {
      createdAt: 'asc'
    }
  });

  const relevantActivities = activities.filter(a => {
    const json = JSON.stringify(a);
    return json.toLowerCase().includes("eloy");
  });

  for (const a of relevantActivities) {
    if (a.activityType === 'RETRIEVAL') {
      console.log(`[${a.createdAt.toISOString()}] QUERY (Ephemeral):`, JSON.stringify(a.input).substring(0, 100) + "...");
    } else if (a.activityType === 'EMBEDDING') {
      // Check if this embedding was for a MESSAGE (stored) or a QUERY (ephemeral)
      // Usually 'EMBEDDING' activity is generic, but let's see context.
      console.log(`[${a.createdAt.toISOString()}] EMBEDDING:`, JSON.stringify(a.input).substring(0, 100) + "...");
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
