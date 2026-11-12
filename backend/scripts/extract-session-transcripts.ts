/**
 * Session Transcript Extractor
 *
 * Extracts formatted transcripts for each user's chat with the AI,
 * including special elements like 'compact signed', 'felt heard',
 * empathy statements, shared context, etc.
 *
 * Usage: npx tsx scripts/extract-session-transcripts.ts <sessionId>
 *
 * Output: Creates formatted transcript files in ./transcripts/
 */

import { prisma } from '../src/lib/prisma';
import { exemptProcessFromRoleGuard } from '../src/lib/prisma-role-guard';

// Operator script: connects with whatever DATABASE_URL / APP_DATABASE_URL the operator gives it
// (often the admin URL), so the runtime role guard does not apply (work-k5fk.10.3).
exemptProcessFromRoleGuard('operator script extract-session-transcripts.ts');
import * as fs from 'fs';
import * as path from 'path';

const sessionId = process.argv[2];

if (!sessionId) {
  console.error('Usage: npx tsx scripts/extract-session-transcripts.ts <sessionId>');
  process.exit(1);
}

interface TranscriptEvent {
  timestamp: Date;
  type: 'message' | 'system' | 'milestone' | 'empathy' | 'shared_context' | 'validation';
  role?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

function timestampBeforeChatStart(timestamp?: Date | string | null): Date {
  const source = timestamp ? new Date(timestamp) : new Date(0);
  const time = source.getTime();
  if (!Number.isFinite(time)) return source;
  return new Date(time - 2000);
}

function inviteeTopicHandoffContent(partnerName: string, topicFrame: string): string {
  return [
    `Before we begin, this is what ${partnerName || 'your partner'} would like to work through with you:`,
    '',
    topicFrame,
    '',
    "This is how things look from their side right now. You don't need to agree with it, respond to it, or do anything with it yet. Instead, I'd like to know what is happening from your point of view.",
  ].join('\n');
}

function displayDecision(decision?: string | null): string {
  switch (decision) {
    case 'WILLING':
      return 'willing';
    case 'NOT_WILLING':
      return 'not willing';
    case 'NEEDS_DISCUSSION':
      return 'needs discussion';
    default:
      return 'not selected';
  }
}

function userLabelFor(sourceUserId: string | null | undefined, userId: string, partnerId?: string): string {
  if (!sourceUserId) return 'unknown';
  if (sourceUserId === userId) return 'you';
  if (sourceUserId === partnerId) return 'partner';
  return 'other';
}

function latestDate(dates: Array<Date | null | undefined>, fallback: Date): Date {
  return dates.reduce((latest, value) => {
    if (!value) return latest;
    return value > latest ? value : latest;
  }, fallback);
}

async function extractTranscripts() {
  console.log(`\n=== Extracting transcripts for session: ${sessionId} ===\n`);

  // Get session with all related data
  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: {
      relationship: {
        include: {
          members: {
            include: {
              user: { select: { id: true, name: true, firstName: true, email: true } }
            }
          }
        }
      },
      stageProgress: {
        orderBy: [{ userId: 'asc' }, { stage: 'asc' }]
      },
      userVessels: true,
      invitations: true,
      empathyDrafts: true,
      empathyAttempts: {
        include: {
          validations: true
        },
        orderBy: { sharedAt: 'asc' }
      }
    }
  });

  if (!session) {
    console.error(`Session ${sessionId} not found`);
    process.exit(1);
  }

  // Get reconciler results
  const reconcilerResults = await prisma.reconcilerResult.findMany({
    where: { sessionId },
    include: { shareOffer: true },
    orderBy: { createdAt: 'asc' }
  });

  const [
    stage4Proposals,
    stage4CoverageRows,
    stage4Closure,
    stage4Agreements,
    stage4ProgressRows,
  ] = await Promise.all([
    prisma.strategyProposal.findMany({
      where: { sessionId },
      include: { selections: true },
      orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.stage4NeedCoverage.findMany({
      where: { sessionId },
      orderBy: [{ updatedAt: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.stage4Closure.findUnique({
      where: { sessionId },
    }),
    prisma.agreement.findMany({
      where: { sharedVessel: { sessionId } },
      orderBy: [{ agreedAt: 'asc' }, { id: 'asc' }],
    }),
    prisma.stageProgress.findMany({
      where: { sessionId, stage: 4 },
      orderBy: [{ userId: 'asc' }],
    }),
  ]);

  // Get all messages
  const messages = await prisma.message.findMany({
    where: { sessionId },
    orderBy: { timestamp: 'asc' },
    include: {
      sender: { select: { id: true, name: true, firstName: true } }
    }
  });

  // Build user lookup
  const users: Record<string, { id: string; name: string; email: string }> = {};
  for (const member of session.relationship.members) {
    const user = member.user;
    users[user.id] = {
      id: user.id,
      name: user.firstName || user.name || 'Unknown',
      email: user.email
    };
  }

  console.log('Participants:');
  for (const [id, user] of Object.entries(users)) {
    console.log(`  ${user.name} (${user.email})`);
  }
  console.log(`\nTotal messages: ${messages.length}`);
  console.log(`Session status: ${session.status}`);
  console.log(`Created: ${session.createdAt.toISOString()}`);

  // Create output directory
  const outputDir = path.join(__dirname, 'transcripts');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Extract transcript for each user
  for (const [userId, user] of Object.entries(users)) {
    const transcript = await buildUserTranscript(
      sessionId,
      userId,
      user.name,
      users,
      session,
      messages,
      reconcilerResults,
      {
        proposals: stage4Proposals,
        coverageRows: stage4CoverageRows,
        closure: stage4Closure,
        agreements: stage4Agreements,
        progressRows: stage4ProgressRows,
      }
    );

    const filename = `transcript_${user.name.replace(/\s+/g, '_')}_${sessionId.slice(0, 8)}.md`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, transcript);
    console.log(`\n✓ Saved: ${filepath}`);
  }

  await prisma.$disconnect();
}

async function buildUserTranscript(
  sessionId: string,
  userId: string,
  userName: string,
  users: Record<string, { id: string; name: string; email: string }>,
  session: any,
  allMessages: any[],
  reconcilerResults: any[],
  stage4Artifacts: {
    proposals: any[];
    coverageRows: any[];
    closure: any | null;
    agreements: any[];
    progressRows: any[];
  }
): Promise<string> {
  const events: TranscriptEvent[] = [];

  // Get partner info
  const partnerId = Object.keys(users).find(id => id !== userId);
  const partnerName = partnerId ? users[partnerId].name : 'Partner';

  // 1. Session created
  events.push({
    timestamp: session.createdAt,
    type: 'milestone',
    content: '📋 SESSION CREATED'
  });

  // 2. Check for invitation
  const invitation = session.invitations[0];
  if (invitation) {
    if (invitation.invitedById === userId && invitation.messageConfirmedAt) {
      events.push({
        timestamp: invitation.messageConfirmedAt,
        type: 'milestone',
        content: `📨 INVITATION SENT to ${partnerName}`,
        metadata: { message: invitation.invitationMessage }
      });
    }
    if (invitation.invitedById !== userId && invitation.acceptedAt) {
      events.push({
        timestamp: invitation.acceptedAt,
        type: 'milestone',
        content: `✅ JOINED SESSION (invited by ${invitation.invitedById === partnerId ? partnerName : 'partner'})`
      });
    }
  }

  // 3. Stage progress milestones
  const userProgress = session.stageProgress.filter((sp: any) => sp.userId === userId);
  const stage0Progress = userProgress.find((sp: any) => sp.stage === 0);
  if (
    invitation &&
    invitation.invitedById !== userId &&
    session.topicFrame &&
    session.topicFrameConfirmedAt &&
    stage0Progress?.gatesSatisfied &&
    typeof stage0Progress.gatesSatisfied === 'object' &&
    stage0Progress.gatesSatisfied.compactSigned
  ) {
    events.push({
      timestamp: timestampBeforeChatStart(
        stage0Progress.startedAt || invitation.acceptedAt || session.createdAt
      ),
      type: 'system',
      role: '🧭 INVITEE TOPIC HANDOFF',
      content: inviteeTopicHandoffContent(partnerName, session.topicFrame),
      metadata: { stage: 0 }
    });
  }

  for (const progress of userProgress) {
    if (progress.startedAt) {
      events.push({
        timestamp: progress.startedAt,
        type: 'milestone',
        content: `🎯 STAGE ${progress.stage} STARTED`
      });
    }
    // Check for gates satisfied
    if (progress.gatesSatisfied && typeof progress.gatesSatisfied === 'object') {
      const gates = progress.gatesSatisfied as Record<string, unknown>;
      if (gates.compactSigned) {
        events.push({
          timestamp: progress.startedAt || session.createdAt,
          type: 'milestone',
          content: '📝 COMPACT SIGNED'
        });
      }
      if (gates.feelHeardConfirmed) {
        events.push({
          timestamp: typeof gates.feelHeardConfirmedAt === 'string'
            ? new Date(gates.feelHeardConfirmedAt)
            : progress.completedAt || session.createdAt,
          type: 'milestone',
          content: `💚 ${userName.toUpperCase()} CONFIRMED THEY FEEL HEARD`
        });
      }
    }
    if (progress.completedAt) {
      events.push({
        timestamp: progress.completedAt,
        type: 'milestone',
        content: `✅ STAGE ${progress.stage} COMPLETED`
      });
    }
  }

  // 4. Messages (filtered to this user's conversation)
  const userMessages = allMessages.filter((msg: any) => {
    if (msg.role === 'USER') {
      return msg.senderId === userId;
    }

    return msg.forUserId === userId;
  });

  for (const msg of userMessages) {
    let eventType: TranscriptEvent['type'] = 'message';
    let roleLabel = msg.role;

    switch (msg.role) {
      case 'USER':
        roleLabel = userName;
        break;
      case 'AI':
        roleLabel = 'AI';
        break;
      case 'EMPATHY_STATEMENT':
        eventType = 'empathy';
        roleLabel = `💜 ${partnerName}'S EMPATHY STATEMENT`;
        break;
      case 'EMPATHY_REVEAL_INTRO':
        eventType = 'empathy';
        roleLabel = '💜 AI (REVEALING EMPATHY)';
        break;
      case 'SHARED_CONTEXT':
        eventType = 'shared_context';
        roleLabel = msg.senderId === userId
          ? `📤 YOU SHARED WITH ${partnerName.toUpperCase()}`
          : `📤 ${partnerName} SHARED WITH YOU`;
        break;
      case 'SHARE_SUGGESTION':
        eventType = 'shared_context';
        roleLabel = '📝 AI (SHARE SUGGESTION)';
        break;
      case 'EMPATHY_VALIDATION_PROMPT':
        eventType = 'validation';
        roleLabel = '❓ AI (VALIDATION PROMPT)';
        break;
      case 'SYSTEM':
        eventType = 'system';
        roleLabel = '⚙️ SYSTEM';
        break;
    }

    events.push({
      timestamp: msg.timestamp,
      type: eventType,
      role: roleLabel,
      content: msg.content,
      metadata: { stage: msg.stage }
    });
  }

  // 5. Empathy attempts by this user
  const userEmpathyAttempts = session.empathyAttempts.filter((ea: any) => ea.sourceUserId === userId);
  for (const attempt of userEmpathyAttempts) {
    events.push({
      timestamp: attempt.sharedAt,
      type: 'empathy',
      content: `📤 YOUR EMPATHY STATEMENT SUBMITTED:\n"${attempt.content}"`,
      metadata: { status: attempt.status, deliveryStatus: attempt.deliveryStatus }
    });

    if (attempt.revealedAt) {
      events.push({
        timestamp: attempt.revealedAt,
        type: 'empathy',
        content: `👁️ YOUR EMPATHY REVEALED TO ${partnerName.toUpperCase()}`
      });
    }

    // Validations received
    for (const validation of attempt.validations) {
      if (validation.validatedAt) {
        events.push({
          timestamp: validation.validatedAt,
          type: 'validation',
          content: validation.validated
            ? `✅ ${partnerName.toUpperCase()} VALIDATED YOUR EMPATHY${validation.feedback ? `: "${validation.feedback}"` : ''}`
            : `⚠️ ${partnerName.toUpperCase()} INDICATED YOUR EMPATHY NEEDS WORK${validation.feedback ? `: "${validation.feedback}"` : ''}`
        });
      }
    }
  }

  // 6. Empathy attempts FOR this user (from partner)
  const partnerEmpathyAttempts = session.empathyAttempts.filter((ea: any) => ea.sourceUserId === partnerId);
  for (const attempt of partnerEmpathyAttempts) {
    if (attempt.revealedAt) {
      events.push({
        timestamp: attempt.revealedAt,
        type: 'empathy',
        content: `💜 RECEIVED ${partnerName.toUpperCase()}'S EMPATHY STATEMENT:\n"${attempt.content}"`
      });
    }

    // Your validations of partner's empathy
    const yourValidation = attempt.validations.find((v: any) => v.userId === userId);
    if (yourValidation?.validatedAt) {
      events.push({
        timestamp: yourValidation.validatedAt,
        type: 'validation',
        content: yourValidation.validated
          ? `✅ YOU VALIDATED ${partnerName.toUpperCase()}'S UNDERSTANDING${yourValidation.feedback ? `: "${yourValidation.feedback}"` : ''}`
          : `⚠️ YOU INDICATED ${partnerName.toUpperCase()}'S UNDERSTANDING NEEDS WORK${yourValidation.feedback ? `: "${yourValidation.feedback}"` : ''}`
      });
    }
  }

  // 7. Reconciler results (share offers)
  for (const result of reconcilerResults) {
    if (result.subjectId === userId && result.shareOffer) {
      const offer = result.shareOffer;
      if (offer.suggestedContent || offer.offerMessage) {
        events.push({
          timestamp: offer.createdAt,
          type: 'shared_context',
          content: `💡 SHARE SUGGESTION (to help ${partnerName} understand you better):\n${offer.suggestedContent || offer.offerMessage}`
        });
      }
      if (offer.sharedAt && offer.sharedContent) {
        events.push({
          timestamp: offer.sharedAt,
          type: 'shared_context',
          content: `📤 YOU SHARED WITH ${partnerName.toUpperCase()}:\n"${offer.sharedContent}"`
        });
      }
      if (offer.declinedAt) {
        events.push({
          timestamp: offer.declinedAt,
          type: 'system',
          content: '⏭️ YOU DECLINED TO SHARE ADDITIONAL CONTEXT'
        });
      }
    }

    // ReconcilerResult internals are scoring/debug metadata, not user-facing chat.
    // Stable transcripts should preserve share offers and shared content without
    // exposing alignment scores or orchestration actions.
  }

  appendStage4ArtifactEvents(events, userId, partnerId, stage4Artifacts, session.createdAt);

  // Sort events by timestamp
  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  // Format as markdown
  return formatTranscriptMarkdown(userName, partnerName, session, events);
}

function appendStage4ArtifactEvents(
  events: TranscriptEvent[],
  userId: string,
  partnerId: string | undefined,
  artifacts: {
    proposals: any[];
    coverageRows: any[];
    closure: any | null;
    agreements: any[];
    progressRows: any[];
  },
  fallbackTimestamp: Date
) {
  const activeProposals = artifacts.proposals.filter((proposal) => proposal.status === 'ACTIVE');
  const removedProposals = artifacts.proposals.filter((proposal) => proposal.status !== 'ACTIVE');
  if (
    activeProposals.length === 0 &&
    removedProposals.length === 0 &&
    artifacts.coverageRows.length === 0 &&
    !artifacts.closure
  ) {
    return;
  }

  const timestamp = latestDate(
    [
      ...artifacts.proposals.map((proposal) => proposal.updatedAt),
      ...artifacts.coverageRows.map((row) => row.updatedAt),
      artifacts.closure?.closedAt,
    ],
    fallbackTimestamp
  );

  const progress = artifacts.progressRows.find((row) => row.userId === userId);
  const partnerProgress = partnerId
    ? artifacts.progressRows.find((row) => row.userId === partnerId)
    : undefined;
  const selectionSubmitted = progress?.gatesSatisfied?.selectionSubmitted === true;
  const partnerSelectionSubmitted = partnerProgress?.gatesSatisfied?.selectionSubmitted === true;

  const lines: string[] = [
    '### STAGE 4 PRODUCT ARTIFACTS',
    '',
    `Selection submitted: ${selectionSubmitted ? 'yes' : 'no'}`,
    `Partner selection submitted: ${partnerSelectionSubmitted ? 'yes' : 'no'}`,
    '',
    '#### STAGE 4 PROPOSAL INVENTORY',
  ];

  if (activeProposals.length === 0) {
    lines.push('- No active proposals captured.');
  } else {
    for (const proposal of activeProposals) {
      const mySelection = proposal.selections?.find((selection: any) => selection.userId === userId);
      const partnerSelection = partnerId
        ? proposal.selections?.find((selection: any) => selection.userId === partnerId)
        : undefined;
      const owner = userLabelFor(proposal.createdByUserId, userId, partnerId);
      const kind = proposal.kind === 'INDIVIDUAL_COMMITMENT' ? 'individual commitment' : 'shared proposal';
      lines.push(`- ${kind} (${owner}): ${proposal.description}`);
      lines.push(`  - Your selection: ${displayDecision(mySelection?.decision)}`);
      lines.push(`  - Partner selection: ${displayDecision(partnerSelection?.decision)}`);
      if (Array.isArray(proposal.needsAddressed) && proposal.needsAddressed.length > 0) {
        lines.push(`  - Needs addressed: ${proposal.needsAddressed.join('; ')}`);
      }
      if (proposal.duration) lines.push(`  - Duration: ${proposal.duration}`);
      if (proposal.measureOfSuccess) lines.push(`  - Measure of success: ${proposal.measureOfSuccess}`);
    }
  }

  if (removedProposals.length > 0) {
    lines.push('', '#### REMOVED OR REVISED PROPOSALS');
    for (const proposal of removedProposals) {
      lines.push(`- ${proposal.status}: ${proposal.description}`);
      if (proposal.removalReason) lines.push(`  - Reason: ${proposal.removalReason}`);
    }
  }

  lines.push('', '#### STAGE 4 NEEDS COVERAGE AUDIT');
  if (artifacts.coverageRows.length === 0) {
    lines.push('- No needs coverage rows captured.');
  } else {
    for (const row of artifacts.coverageRows) {
      const source = userLabelFor(row.sourceUserId, userId, partnerId);
      lines.push(`- ${row.coverageStatus} (${source}): ${row.needLabel}`);
      if (Array.isArray(row.coveringProposalIds) && row.coveringProposalIds.length > 0) {
        lines.push(`  - Covering proposals: ${row.coveringProposalIds.join(', ')}`);
      }
      if (row.note) lines.push(`  - Note: ${row.note}`);
    }
  }

  lines.push('', '#### STAGE 4 CLOSURE');
  if (!artifacts.closure) {
    lines.push('- No Stage 4 closure captured.');
  } else {
    lines.push(`- Kind: ${artifacts.closure.kind}`);
    lines.push(`- Reason: ${artifacts.closure.reason}`);
    lines.push(`- Summary: ${artifacts.closure.summary}`);
    lines.push(`- Shared agreement IDs: ${artifacts.closure.sharedAgreementIds.join(', ') || 'none'}`);
    lines.push(`- Individual commitment IDs: ${artifacts.closure.individualProposalIds.join(', ') || 'none'}`);
    lines.push(`- Open need IDs: ${artifacts.closure.openNeedIds.join(', ') || 'none'}`);
  }

  if (artifacts.agreements.length > 0) {
    lines.push('', '#### AGREEMENTS');
    for (const agreement of artifacts.agreements) {
      lines.push(`- ${agreement.status}: ${agreement.description}`);
      if (agreement.duration) lines.push(`  - Duration: ${agreement.duration}`);
      if (agreement.measureOfSuccess) lines.push(`  - Measure of success: ${agreement.measureOfSuccess}`);
    }
  }

  events.push({
    timestamp,
    type: 'system',
    content: lines.join('\n'),
    metadata: { stage: 4 },
  });
}

function formatTranscriptMarkdown(
  userName: string,
  partnerName: string,
  session: any,
  events: TranscriptEvent[]
): string {
  let md = `# Chat Transcript: ${userName}\n\n`;
  md += `**Session ID:** ${session.id}\n`;
  md += `**Partner:** ${partnerName}\n`;
  md += `**Status:** ${session.status}\n`;
  md += `**Created:** ${session.createdAt.toISOString()}\n`;
  md += `**Resolved:** ${session.resolvedAt?.toISOString() || 'Not yet'}\n\n`;
  md += `---\n\n`;

  let currentStage = 0;

  for (const event of events) {
    // Check for stage changes in metadata
    if (event.metadata?.stage && event.metadata.stage !== currentStage) {
      currentStage = event.metadata.stage as number;
      md += `\n## Stage ${currentStage}\n\n`;
    }

    const time = event.timestamp.toISOString().replace('T', ' ').slice(0, 19);

    switch (event.type) {
      case 'milestone':
        md += `### ${event.content}\n`;
        md += `*${time}*\n\n`;
        if (event.metadata?.message) {
          md += `> "${event.metadata.message}"\n\n`;
        }
        break;

      case 'message':
        md += `**[${time}] ${event.role}:**\n`;
        md += `${event.content}\n\n`;
        break;

      case 'empathy':
        md += `---\n`;
        md += `**${event.content}**\n`;
        md += `*${time}*\n`;
        md += `---\n\n`;
        break;

      case 'shared_context':
        md += `---\n`;
        if (event.role) {
          md += `**${event.role}:**\n`;
        }
        md += `${event.content}\n`;
        md += `*${time}*\n`;
        md += `---\n\n`;
        break;

      case 'validation':
        md += `**${event.content}**\n`;
        md += `*${time}*\n\n`;
        break;

      case 'system':
        if (event.role) {
          md += `**${event.role}:**\n`;
          md += `${event.content}\n`;
        } else {
          md += `*${event.content}*\n`;
        }
        md += `*${time}*\n\n`;
        break;
    }
  }

  return md;
}

extractTranscripts().catch((error) => {
  console.error('Error:', error);
  process.exit(1);
});
