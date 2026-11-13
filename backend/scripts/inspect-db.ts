
import dotenv from 'dotenv';
import path from 'path';

// Load env before imports
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { prisma } from '../src/lib/prisma';
import { exemptProcessFromRoleGuard } from '../src/lib/prisma-role-guard';

// Operator script: connects with whatever DATABASE_URL / APP_DATABASE_URL the operator gives it
// (often the admin URL), so the runtime role guard does not apply (work-k5fk.10.3).
exemptProcessFromRoleGuard('operator script inspect-db.ts');

async function inspect() {
  console.log('Inspecting recent AuditLogs...');

  try {
    const logs = await prisma.auditLog.findMany({
      take: 20,
      orderBy: { timestamp: 'desc' },
    });

    if (logs.length === 0) {
      console.log('No logs found.');
      return;
    }

    console.log(`Found ${logs.length} logs. Most recent first:`);

    logs.forEach(log => {
      console.log('---------------------------------------------------');
      console.log(`[${log.timestamp.toISOString()}] ${log.section} (ID: ${log.id})`);
      console.log(`Message: ${log.message}`);
      console.log(`TurnID: ${log.turnId}`);
      console.log(`SessionID: ${log.sessionId}`);
      console.log(`Data Keys:`, log.data ? Object.keys(log.data as object) : 'null');
      if (log.section === 'COST' && log.data) {
        const d = log.data as any;
        console.log(`   -> Operation: ${d.operation}, Model: ${d.model}, Cost: ${d.totalCost}`);
      }
      // console.log(`Full Data:`, JSON.stringify(log.data, null, 2));
    });

  } catch (error) {
    console.error('CRITICAL ERROR:', error);
  } finally {
    await prisma.$disconnect();
  }
}

inspect();
