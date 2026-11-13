/**
 * Script to check for duplicate messages in the database
 */

import { prisma } from '../src/lib/prisma';
import { exemptProcessFromRoleGuard } from '../src/lib/prisma-role-guard';

// Operator script: connects with whatever DATABASE_URL / APP_DATABASE_URL the operator gives it
// (often the admin URL), so the runtime role guard does not apply (work-k5fk.10.3).
exemptProcessFromRoleGuard('operator script check-duplicate-messages.ts');

async function checkDuplicates() {
  const sessionId = process.argv[2];

  if (!sessionId) {
    console.error('Usage: ts-node check-duplicate-messages.ts <sessionId>');
    console.error('Example: ts-node check-duplicate-messages.ts cmk374gnk000ipxf6pkm9z1z3');
    process.exit(1);
  }

  console.log(`Checking for duplicate messages in session: ${sessionId}\n`);

  // Get all messages for this session
  const messages = await prisma.message.findMany({
    where: {
      sessionId,
    },
    orderBy: {
      timestamp: 'desc',
    },
    select: {
      id: true,
      content: true,
      role: true,
      senderId: true,
      timestamp: true,
      stage: true,
    },
  });

  console.log(`Total messages in session: ${messages.length}\n`);

  // Group messages by content and role
  const contentMap = new Map<string, typeof messages>();

  for (const message of messages) {
    const key = `${message.role}:${message.content}`;
    if (!contentMap.has(key)) {
      contentMap.set(key, []);
    }
    contentMap.get(key)!.push(message);
  }

  // Find duplicates
  const duplicates: Array<{ content: string; role: string; messages: typeof messages }> = [];

  for (const [key, msgs] of contentMap.entries()) {
    if (msgs.length > 1) {
      const [role, content] = key.split(':', 2);
      duplicates.push({ content, role, messages: msgs });
    }
  }

  if (duplicates.length === 0) {
    console.log('✅ No duplicate messages found in database.');
    console.log('The duplicate is likely only in the React Query cache.');
  } else {
    console.log(`⚠️  Found ${duplicates.length} duplicate message(s):\n`);

    for (const dup of duplicates) {
      console.log(`Content: "${dup.content.substring(0, 100)}${dup.content.length > 100 ? '...' : ''}"`);
      console.log(`Role: ${dup.role}`);
      console.log(`Count: ${dup.messages.length}`);
      console.log('Messages:');
      for (const msg of dup.messages) {
        console.log(`  - ID: ${msg.id}`);
        console.log(`    Timestamp: ${msg.timestamp.toISOString()}`);
        console.log(`    Sender: ${msg.senderId || 'AI'}`);
        console.log(`    Stage: ${msg.stage}`);
      }
      console.log('');
    }
  }

  // Also check for messages with identical IDs (shouldn't happen but worth checking)
  const idMap = new Map<string, typeof messages>();
  for (const message of messages) {
    if (!idMap.has(message.id)) {
      idMap.set(message.id, []);
    }
    idMap.get(message.id)!.push(message);
  }

  const duplicateIds = Array.from(idMap.entries()).filter(([_, msgs]) => msgs.length > 1);
  if (duplicateIds.length > 0) {
    console.log('🚨 CRITICAL: Found messages with duplicate IDs (this should never happen):');
    for (const [id, msgs] of duplicateIds) {
      console.log(`  ID: ${id} appears ${msgs.length} times`);
    }
  }

  await prisma.$disconnect();
}

checkDuplicates().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
