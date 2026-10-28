/**
 * Session Analysis Script
 *
 * Usage: npx ts-node src/scripts/analyze-session.ts <sessionId>
 *
 * This script provides a comprehensive view of a session's state and timeline,
 * useful for debugging flow issues. Operator tooling: it reads every
 * participant's rows, so run it with an operator DATABASE_URL, never as the
 * request role.
 *
 * Target shape (TS-12): participants and their milestones (the stage is
 * derived from them), drafts, empathy rounds with their reviews, reconciler
 * results with their share offers, and the AI/marker messages of every
 * participant's conversation.
 */

import { prisma } from '../lib/prisma';
import { loadStageStates } from '../services/stage-shim';

const sessionId = process.argv[2];

if (!sessionId) {
  console.error('Usage: npx ts-node src/scripts/analyze-session.ts <sessionId>');
  process.exit(1);
}

interface TimelineEvent {
  timestamp: Date;
  type: string;
  actor?: string;
  details: string;
}

async function analyzeSession() {
  console.log('='.repeat(80));
  console.log(`SESSION ANALYSIS: ${sessionId}`);
  console.log('='.repeat(80));

  const session = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!session) {
    console.error(`Session ${sessionId} not found`);
    process.exit(1);
  }

  const participants = await prisma.participant.findMany({
    where: { sessionId },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      userId: true,
      kind: true,
      displayName: true,
      joinedAt: true,
      leftAt: true,
      user: { select: { name: true } },
    },
  });
  const names: Record<string, string> = {};
  for (const p of participants) names[p.id] = p.displayName || p.user?.name || p.userId || p.id;
  const nameOf = (participantId: string | null | undefined) => (participantId && names[participantId]) || 'Unknown';

  console.log('\n## PARTICIPANTS');
  console.log('-'.repeat(40));
  for (const p of participants) {
    console.log(
      `  ${names[p.id]}: participant ${p.id} (user ${p.userId ?? '—'}, ${p.kind}${p.leftAt ? `, left ${p.leftAt.toISOString()}` : ''})`,
    );
  }

  console.log('\n## SESSION STATUS');
  console.log('-'.repeat(40));
  console.log(`  Status: ${session.status}`);
  console.log(`  Created: ${session.createdAt.toISOString()}`);

  // Stage progress, reconstructed from milestones (stage shim)
  console.log('\n## STAGE PROGRESS (from milestones)');
  console.log('-'.repeat(40));
  const states = await loadStageStates(participants.map(p => ({ id: p.id, joinedAt: p.joinedAt })));
  for (const p of participants) {
    const state = states.get(p.id);
    console.log(`\n  ${names[p.id]}: current stage ${state?.current.stage ?? 0}`);
    for (const row of state?.rows ?? []) {
      console.log(`    Stage ${row.stage}: ${row.status} (started: ${row.startedAt?.toISOString() || 'N/A'})`);
    }
    for (const m of state?.milestones ?? []) console.log(`      ✓ ${m.key} at ${m.reachedAt.toISOString()}`);
  }

  // Drafts
  console.log('\n## DRAFTS');
  console.log('-'.repeat(40));
  const drafts = await prisma.draft.findMany({ where: { participant: { sessionId } }, orderBy: { updatedAt: 'asc' } });
  for (const draft of drafts) {
    console.log(`\n  ${nameOf(draft.participantId)}'s ${draft.kind} draft:`);
    console.log(`    Ready to Share: ${draft.readyToShare}`);
    console.log(`    Version: ${draft.version}`);
    console.log(`    Content: "${draft.content?.substring(0, 80)}..."`);
    console.log(`    Updated: ${draft.updatedAt.toISOString()}`);
  }

  // Empathy rounds
  console.log('\n## EMPATHY ATTEMPTS (rounds)');
  console.log('-'.repeat(40));
  const attempts = await prisma.empathyAttempt.findMany({
    where: { authorParticipant: { sessionId } },
    include: { reviews: true },
    orderBy: [{ submittedAt: 'asc' }, { round: 'asc' }],
  });
  for (const attempt of attempts) {
    console.log(
      `\n  ${nameOf(attempt.authorParticipantId)} → ${nameOf(attempt.subjectParticipantId)}, round ${attempt.round}:`,
    );
    console.log(`    ID: ${attempt.id}`);
    console.log(`    Status: ${attempt.status} (v${attempt.statusVersion})`);
    console.log(`    Delivery: ${attempt.deliveryStatus}`);
    console.log(`    Content: "${attempt.content.substring(0, 80)}..."`);
    console.log(`    Submitted At: ${attempt.submittedAt.toISOString()}`);
    console.log(`    Revealed At: ${attempt.revealedAt?.toISOString() || 'N/A'}`);
    console.log(`    Delivered At: ${attempt.deliveredAt?.toISOString() || 'N/A'}`);
    console.log(`    Seen At: ${attempt.seenAt?.toISOString() || 'N/A'}`);
    for (const v of attempt.reviews) {
      console.log(
        `    Review by ${nameOf(v.reviewerParticipantId)}: validated=${v.validated} at ${v.createdAt.toISOString()}`,
      );
      if (v.feedback) console.log(`      Feedback: "${v.feedback.substring(0, 50)}..."`);
    }
  }

  // Reconciler results
  console.log('\n## RECONCILER RESULTS');
  console.log('-'.repeat(40));
  const results = await prisma.reconcilerResult.findMany({
    where: { attemptId: { in: attempts.map(a => a.id) } },
    include: { shareOffers: { orderBy: { iteration: 'asc' } }, attempt: { select: { authorParticipantId: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const direction = (r: (typeof results)[number]) =>
    `${nameOf(r.attempt.authorParticipantId)} → ${nameOf(r.subjectParticipantId)}`;
  for (const result of results) {
    console.log(
      `\n  [${direction(result)}] iteration ${result.iteration}${result.supersededAt ? ' (superseded)' : ''}`,
    );
    console.log(`    ID: ${result.id}`);
    console.log(`    Created: ${result.createdAt.toISOString()}`);
    console.log(`    Alignment: ${result.alignmentScore}%`);
    console.log(`    Gap Severity: ${result.gapSeverity}`);
    console.log(`    Recommended Action: ${result.recommendedAction}`);
    console.log(`    Most Important Gap: ${result.mostImportantGap?.substring(0, 80) || 'N/A'}`);
    console.log(`    suggestedShareContent: ${result.suggestedShareContent?.substring(0, 50) || 'NONE'}`);
    console.log(`    suggestedShareReason: ${result.suggestedShareReason?.substring(0, 50) || 'NONE'}`);
    for (const offer of result.shareOffers) {
      console.log(`    Share Offer ${offer.iteration}:`);
      console.log(`      ID: ${offer.id}`);
      console.log(`      Status: ${offer.status}`);
      console.log(`      Created: ${offer.createdAt.toISOString()}`);
      console.log(`      suggestedContent: ${offer.suggestedContent?.substring(0, 50) || 'NONE'}`);
      console.log(`      offerMessage: ${offer.offerMessage?.substring(0, 50) || 'NONE'}`);
      console.log(`      Declined At: ${offer.declinedAt?.toISOString() || 'N/A'}`);
      console.log(`      Shared At: ${offer.sharedAt?.toISOString() || 'N/A'}`);
      console.log(`      Delivery: ${offer.deliveryStatus}`);
    }
  }

  // Timeline
  console.log('\n## TIMELINE');
  console.log('-'.repeat(40));
  const timeline: TimelineEvent[] = [{ timestamp: session.createdAt, type: 'SESSION', details: 'Session created' }];
  for (const p of participants) {
    for (const m of states.get(p.id)?.milestones ?? []) {
      timeline.push({ timestamp: m.reachedAt, type: 'MILESTONE', actor: names[p.id], details: `Reached ${m.key}` });
    }
  }
  for (const attempt of attempts) {
    const name = nameOf(attempt.authorParticipantId);
    timeline.push({
      timestamp: attempt.submittedAt,
      type: 'EMPATHY',
      actor: name,
      details: `Submitted round ${attempt.round}`,
    });
    if (attempt.revealedAt) {
      timeline.push({
        timestamp: attempt.revealedAt,
        type: 'EMPATHY',
        actor: name,
        details: `Round ${attempt.round} revealed (status: ${attempt.status})`,
      });
    }
    for (const v of attempt.reviews) {
      timeline.push({
        timestamp: v.createdAt,
        type: 'VALIDATION',
        actor: nameOf(v.reviewerParticipantId),
        details: `Reviewed ${name}'s round ${attempt.round}: ${v.validated ? 'ACCURATE' : 'INACCURATE'}`,
      });
    }
  }
  for (const result of results) {
    timeline.push({
      timestamp: result.createdAt,
      type: 'RECONCILER',
      details: `Analyzed ${direction(result)}: ${result.recommendedAction} (${result.alignmentScore}%)`,
    });
    for (const offer of result.shareOffers) {
      const subject = nameOf(offer.subjectParticipantId);
      timeline.push({
        timestamp: offer.createdAt,
        type: 'SHARE_OFFER',
        actor: subject,
        details: `Share offer created (status: ${offer.status})`,
      });
      if (offer.declinedAt)
        timeline.push({
          timestamp: offer.declinedAt,
          type: 'SHARE_OFFER',
          actor: subject,
          details: 'Share offer DECLINED',
        });
      if (offer.sharedAt)
        timeline.push({
          timestamp: offer.sharedAt,
          type: 'SHARE_OFFER',
          actor: subject,
          details: 'Context shared with partner',
        });
    }
  }

  // Key messages: AI replies and markers across every participant's conversation
  const keyMessages = await prisma.message.findMany({
    where: {
      conversation: { participant: { sessionId } },
      OR: [{ role: 'AI' }, { kind: { not: 'CHAT' } }, { content: { contains: 'feel heard' } }],
    },
    select: {
      content: true,
      role: true,
      kind: true,
      createdAt: true,
      senderParticipantId: true,
      conversation: { select: { participantId: true } },
    },
    orderBy: { createdAt: 'asc' },
    take: 50,
  });
  for (const msg of keyMessages) {
    const actor = msg.senderParticipantId
      ? nameOf(msg.senderParticipantId)
      : `AI → ${nameOf(msg.conversation.participantId)}`;
    timeline.push({
      timestamp: msg.createdAt,
      type: msg.kind === 'CHAT' ? 'MESSAGE' : msg.kind,
      actor,
      details: msg.content.substring(0, 100),
    });
  }

  timeline.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  for (const event of timeline) {
    const time = event.timestamp.toISOString().replace('T', ' ').substring(0, 23);
    const actor = event.actor ? `[${event.actor}]` : '';
    console.log(`  ${time} ${event.type.padEnd(12)} ${actor.padEnd(15)} ${event.details}`);
  }

  // Potential issues
  console.log('\n## POTENTIAL ISSUES');
  console.log('-'.repeat(40));
  let issues = 0;
  for (const result of results) {
    if (result.recommendedAction === 'OFFER_SHARING' && !result.suggestedShareContent) {
      console.log(`  [!] ${direction(result)}: OFFER_SHARING but no suggestedShareContent`);
      issues++;
    }
    for (const offer of result.shareOffers) {
      if (result.recommendedAction === 'OFFER_SHARING' && !offer.suggestedContent && !offer.offerMessage) {
        console.log(`  [!] ${direction(result)}: Share offer ${offer.iteration} has no content`);
        issues++;
      }
      if (offer.status === 'DECLINED' && offer.declinedAt) {
        const gapMs = offer.declinedAt.getTime() - offer.createdAt.getTime();
        if (gapMs > 60000) {
          console.log(
            `  [?] ${nameOf(offer.subjectParticipantId)}'s share offer: created ${offer.createdAt.toISOString()}, declined ${offer.declinedAt.toISOString()} (${Math.round(gapMs / 1000)}s gap)`,
          );
          issues++;
        }
      }
    }
  }
  for (const attempt of attempts) {
    if ((attempt.status === 'REVEALED' || attempt.status === 'VALIDATED') && !attempt.revealedAt) {
      console.log(
        `  [!] ${nameOf(attempt.authorParticipantId)}'s round ${attempt.round}: status ${attempt.status} but no revealedAt`,
      );
      issues++;
    }
  }
  if (issues === 0) console.log('  No obvious issues detected');

  console.log('\n' + '='.repeat(80));
}

analyzeSession()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
