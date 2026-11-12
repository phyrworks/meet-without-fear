/**
 * Quick script to check messages in a session for duplicates
 * Usage: npx tsx scripts/check-session-messages.ts <sessionId>
 */

import { prisma } from '../src/lib/prisma';
import { exemptProcessFromRoleGuard } from '../src/lib/prisma-role-guard';

// Operator script: connects with whatever DATABASE_URL / APP_DATABASE_URL the operator gives it
// (often the admin URL), so the runtime role guard does not apply (work-k5fk.10.3).
exemptProcessFromRoleGuard('operator script check-session-messages.ts');

async function checkSessionMessages() {
  const sessionId = process.argv[2];
  
  if (!sessionId) {
    console.error('Usage: npx tsx scripts/check-session-messages.ts <sessionId>');
    console.error('Example: npx tsx scripts/check-session-messages.ts cmk374gnk000ipxf6pkm9z1z3');
    process.exit(1);
  }

  console.log(`\n🔍 Checking messages in session: ${sessionId}\n`);

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
      forUserId: true,
      timestamp: true,
      stage: true,
    },
  });

  console.log(`📊 Total messages in session: ${messages.length}\n`);

  if (messages.length === 0) {
    console.log('✅ No messages found.');
    await prisma.$disconnect();
    return;
  }

  // Show last 10 messages
  console.log('📝 Last 10 messages:');
  console.log('─'.repeat(80));
  messages.slice(0, 10).forEach((msg, idx) => {
    const contentPreview = msg.content.substring(0, 60).replace(/\n/g, ' ');
    const roleLabel = msg.role === 'USER' ? 'USER' : msg.role === 'AI' ? 'AI  ' : msg.role;
    const senderLabel = msg.senderId ? `user:${msg.senderId.substring(0, 8)}` : msg.forUserId ? `for:${msg.forUserId.substring(0, 8)}` : 'system';
    console.log(`${idx + 1}. [${roleLabel}] ${senderLabel} | ${msg.timestamp.toISOString()}`);
    console.log(`   ID: ${msg.id}`);
    console.log(`   "${contentPreview}${msg.content.length > 60 ? '...' : ''}"`);
    console.log('');
  });

  // Check for duplicate IDs (should never happen)
  const idMap = new Map<string, typeof messages>();
  messages.forEach(m => {
    if (!idMap.has(m.id)) {
      idMap.set(m.id, []);
    }
    idMap.get(m.id)!.push(m);
  });
  const duplicateIds = Array.from(idMap.entries()).filter(([_, msgs]) => msgs.length > 1);
  if (duplicateIds.length > 0) {
    console.log('🚨 CRITICAL: Found messages with duplicate IDs (this should never happen):');
    duplicateIds.forEach(([id, msgs]) => {
      console.log(`   ID: ${id} appears ${msgs.length} times`);
    });
    console.log('');
  }

  // Check for duplicate content (same role, same content)
  const contentMap = new Map<string, typeof messages>();
  messages.forEach(m => {
    const key = `${m.role}:${m.content}`;
    if (!contentMap.has(key)) {
      contentMap.set(key, []);
    }
    contentMap.get(key)!.push(m);
  });

  const duplicates = Array.from(contentMap.entries())
    .filter(([_, msgs]) => msgs.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  if (duplicates.length === 0) {
    console.log('✅ No duplicate messages found in database.');
    console.log('   (If you see duplicates in the UI, they are likely in the React Query cache)');
  } else {
    console.log(`⚠️  Found ${duplicates.length} duplicate message group(s):\n`);
    
    duplicates.forEach((dup, idx) => {
      const [key, msgs] = dup;
      const [role, content] = key.split(':', 2);
      console.log(`${idx + 1}. [${role}] "${content.substring(0, 100)}${content.length > 100 ? '...' : ''}"`);
      console.log(`   Count: ${msgs.length} duplicate(s)`);
      console.log('   Messages:');
      msgs.forEach((msg, msgIdx) => {
        const timeDiff = msgIdx > 0 
          ? ` (${Math.round((msg.timestamp.getTime() - msgs[0].timestamp.getTime()) / 1000)}s after first)`
          : '';
        console.log(`     ${msgIdx + 1}. ID: ${msg.id}`);
        console.log(`        Timestamp: ${msg.timestamp.toISOString()}${timeDiff}`);
        console.log(`        Sender: ${msg.senderId || 'AI'}`);
        console.log(`        For User: ${msg.forUserId || 'N/A'}`);
        console.log(`        Stage: ${msg.stage}`);
      });
      console.log('');
    });
  }

  // Check for rapid duplicates (same content within 5 seconds)
  const rapidDuplicates: Array<{ content: string; role: string; messages: typeof messages }> = [];
  messages.forEach((msg, idx) => {
    const sameContent = messages.filter(m => 
      m.role === msg.role && 
      m.content === msg.content && 
      m.id !== msg.id &&
      Math.abs(m.timestamp.getTime() - msg.timestamp.getTime()) < 5000
    );
    if (sameContent.length > 0) {
      const allMessages = [msg, ...sameContent];
      const key = `${msg.role}:${msg.content}`;
      if (!rapidDuplicates.some(d => d.content === msg.content && d.role === msg.role)) {
        rapidDuplicates.push({
          content: msg.content,
          role: msg.role,
          messages: allMessages,
        });
      }
    }
  });

  if (rapidDuplicates.length > 0) {
    console.log(`⚡ Found ${rapidDuplicates.length} rapid duplicate(s) (same content within 5 seconds):\n`);
    rapidDuplicates.forEach((dup, idx) => {
      console.log(`${idx + 1}. [${dup.role}] "${dup.content.substring(0, 100)}${dup.content.length > 100 ? '...' : ''}"`);
      console.log(`   Count: ${dup.messages.length} message(s) within 5 seconds`);
      dup.messages.forEach((msg, msgIdx) => {
        console.log(`     ${msgIdx + 1}. ID: ${msg.id}, timestamp: ${msg.timestamp.toISOString()}`);
      });
      console.log('');
    });
  }

  await prisma.$disconnect();
}

checkSessionMessages().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});

