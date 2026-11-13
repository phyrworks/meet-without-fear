/**
 * Stage 3→4 Prompt Test Script
 *
 * Exercises the full two-user Stage 3 (Need Mapping) → Stage 4 (Strategic Repair)
 * flow against a running backend with real AI. Uses the E2E seed endpoint to
 * create a session at EMPATHY_REVEALED, then walks both users through needs
 * exploration, common ground, strategy proposals, ranking, and agreements.
 *
 * Usage:
 *   cd backend && npx tsx scripts/prompt-test-stage-3-4.ts
 *
 * Requires:
 *   - Backend running on localhost:3000 with E2E_AUTH_BYPASS=true, NODE_ENV=development
 *     (or test; the bypass is off and the server refuses to start otherwise,
 *     see src/lib/e2e-bypass.ts), MOCK_LLM=false
 */

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';

// ============================================================================
// Pre-written messages (Alex/Sam scenario)
// ============================================================================

const STAGE_3_ALEX = [
  'Now that I understand Sam better, I realize what I really need is not for things to go back exactly how they were. I need us to have a way to stay connected even when life gets hard.',
  "I used to say Sam never makes time for me. But the real need underneath is that I want to feel like we're a team. Even when Sam is exhausted, I need to know we're in this together.",
  "At the core, I need to feel like I matter to Sam. Not through grand gestures, but through small moments of acknowledgment.",
];

const STAGE_3_SAM = [
  "I've been so focused on surviving at work that I forgot to check in with how Alex is doing. I think I need to feel safe admitting when I'm struggling.",
  "When Alex brings up what's missing, I hear it as criticism. But what I really need is to feel like it's okay to not have it all together.",
  "I need to feel supported without judgment. When I come home depleted, I need Alex to know that my withdrawal isn't rejection — it's exhaustion.",
];

const STAGE_4_ALEX = [
  'I think we should just communicate better about how we are feeling each day.',
  "Okay, how about this: every evening before bed, we each share one thing about our day — good or bad. Just 5 minutes. We try it for one week.",
];

const STAGE_4_SAM = [
  'Maybe when I get home from work, I could have 10 minutes to decompress before we talk about anything.',
  'The experiment: when I get home, I take 10 minutes alone to decompress, then I come find Alex and we check in briefly. One week trial.',
];

// ============================================================================
// Helpers
// ============================================================================

interface UserInfo {
  id: string;
  email: string;
  name: string;
}

function headers(user: UserInfo): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-e2e-user-id': user.id,
    'x-e2e-user-email': user.email,
  };
}

async function api(
  method: 'GET' | 'POST',
  path: string,
  user: UserInfo,
  body?: unknown,
): Promise<any> {
  const url = `${API_BASE}/api${path}`;
  const opts: RequestInit = {
    method,
    headers: headers(user),
  };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${method} ${path} → ${res.status}: ${text}`);
  }
  const json = await res.json();
  // All API responses wrap in { success, data }. Return data directly.
  return json.data !== undefined ? json.data : json;
}

/**
 * Send a message via the streaming endpoint and collect the full AI response.
 * Returns { aiText, metadata }.
 */
async function sendMessage(
  sessionId: string,
  user: UserInfo,
  content: string,
): Promise<{ aiText: string; metadata: Record<string, unknown> }> {
  const url = `${API_BASE}/api/sessions/${sessionId}/messages/stream`;
  const res = await fetch(url, {
    method: 'POST',
    headers: headers(user),
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`POST /messages/stream → ${res.status}: ${text}`);
  }

  // Parse SSE stream
  const body = await res.text();
  let aiText = '';
  let metadata: Record<string, unknown> = {};

  for (const line of body.split('\n')) {
    if (line.startsWith('data: ')) {
      try {
        const data = JSON.parse(line.slice(6));
        if (data.text !== undefined) {
          // chunk event
          aiText += data.text;
        }
        if (data.metadata) {
          metadata = data.metadata;
        }
      } catch {
        // skip unparseable lines
      }
    }
  }

  return { aiText, metadata };
}

function log(tag: string, msg: string) {
  console.log(`\n[${'='.repeat(60)}]`);
  console.log(`[${tag}]`);
  console.log(`${'='.repeat(62)}`);
  console.log(msg);
}

function logTurn(user: string, direction: 'USER' | 'AI', text: string) {
  const prefix = direction === 'USER' ? `  ${user} →` : `  AI →`;
  console.log(`\n${prefix} ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`);
}

// ============================================================================
// Main flow
// ============================================================================

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Stage 3→4 Prompt Test (Real AI, Two Users)                ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\nAPI: ${API_BASE}\n`);

  // ── 1. SETUP ──────────────────────────────────────────────────────────
  log('SETUP', 'Cleaning up and seeding session at EMPATHY_REVEALED...');

  await api('POST', '/e2e/cleanup', { id: '', email: 'cleanup@e2e.test', name: '' });

  const seedResult = await api('POST', '/e2e/seed-session', { id: '', email: 'seed@e2e.test', name: '' }, {
    userA: { email: 'alex@e2e.test', name: 'Alex' },
    userB: { email: 'sam@e2e.test', name: 'Sam' },
    targetStage: 'EMPATHY_REVEALED',
  });

  const sessionId = seedResult.session.id;
  const alex: UserInfo = seedResult.userA;
  const sam: UserInfo = seedResult.userB;

  console.log(`  Session: ${sessionId}`);
  console.log(`  Alex: ${alex.id} (${alex.email})`);
  console.log(`  Sam:  ${sam.id} (${sam.email})`);

  // ── 2. STAGE 3 CHAT — Alex ───────────────────────────────────────────
  log('STAGE 3 — ALEX', 'Exploring needs (3 turns)...');

  for (const msg of STAGE_3_ALEX) {
    logTurn('Alex', 'USER', msg);
    const { aiText, metadata } = await sendMessage(sessionId, alex, msg);
    logTurn('Alex', 'AI', aiText);
    if (Object.keys(metadata).length > 0) {
      console.log(`  [metadata] ${JSON.stringify(metadata)}`);
    }
  }

  // ── 3. STAGE 3 CHAT — Sam ────────────────────────────────────────────
  log('STAGE 3 — SAM', 'Exploring needs (3 turns)...');

  for (const msg of STAGE_3_SAM) {
    logTurn('Sam', 'USER', msg);
    const { aiText, metadata } = await sendMessage(sessionId, sam, msg);
    logTurn('Sam', 'AI', aiText);
    if (Object.keys(metadata).length > 0) {
      console.log(`  [metadata] ${JSON.stringify(metadata)}`);
    }
  }

  // ── 4. NEEDS FLOW ────────────────────────────────────────────────────
  log('NEEDS FLOW', 'Extracting, confirming, and sharing needs...');

  // Get AI-synthesized needs for both users
  console.log('\n  Getting needs for Alex...');
  const alexNeedsResult = await api('GET', `/sessions/${sessionId}/needs`, alex);
  console.log(`  Alex's needs (${alexNeedsResult.needs.length}):`);
  for (const n of alexNeedsResult.needs) {
    console.log(`    - [${n.category}] ${n.need}`);
  }

  console.log('\n  Getting needs for Sam...');
  const samNeedsResult = await api('GET', `/sessions/${sessionId}/needs`, sam);
  console.log(`  Sam's needs (${samNeedsResult.needs.length}):`);
  for (const n of samNeedsResult.needs) {
    console.log(`    - [${n.category}] ${n.need}`);
  }

  // If AI extraction returned no needs, add custom ones as fallback
  let alexNeedIds = alexNeedsResult.needs.map((n) => n.id);
  let samNeedIds = samNeedsResult.needs.map((n) => n.id);

  if (alexNeedIds.length === 0) {
    console.log('\n  ⚠ No AI-extracted needs for Alex — adding custom needs...');
    const n1 = await api('POST', `/sessions/${sessionId}/needs`, alex, {
      need: 'Connection even during hard times',
      category: 'CONNECTION',
    });
    const n2 = await api('POST', `/sessions/${sessionId}/needs`, alex, {
      need: 'Feeling like I matter through small moments',
      category: 'RECOGNITION',
    });
    alexNeedIds = [n1.need.id, n2.need.id];
  }

  if (samNeedIds.length === 0) {
    console.log('\n  ⚠ No AI-extracted needs for Sam — adding custom needs...');
    const n1 = await api('POST', `/sessions/${sessionId}/needs`, sam, {
      need: 'Safety to be vulnerable about struggles',
      category: 'SAFETY',
    });
    const n2 = await api('POST', `/sessions/${sessionId}/needs`, sam, {
      need: 'Support without judgment',
      category: 'CONNECTION',
    });
    samNeedIds = [n1.need.id, n2.need.id];
  }

  // Confirm needs
  console.log('\n  Confirming needs...');
  await api('POST', `/sessions/${sessionId}/needs/confirm`, alex, { needIds: alexNeedIds });
  console.log('  ✓ Alex confirmed needs');
  await api('POST', `/sessions/${sessionId}/needs/confirm`, sam, { needIds: samNeedIds });
  console.log('  ✓ Sam confirmed needs');

  // Consent to share
  console.log('\n  Consenting to share needs...');
  await api('POST', `/sessions/${sessionId}/needs/consent`, alex, { needIds: alexNeedIds });
  console.log('  ✓ Alex consented');
  const samConsent = await api('POST', `/sessions/${sessionId}/needs/consent`, sam, { needIds: samNeedIds });
  console.log(`  ✓ Sam consented (commonGroundReady: ${samConsent.commonGroundReady})`);

  // Get common ground
  console.log('\n  Getting common ground analysis...');
  const commonGroundResult = await api('GET', `/sessions/${sessionId}/common-ground`, alex);
  console.log(`  Common ground (${commonGroundResult.commonGround.length} items, complete: ${commonGroundResult.analysisComplete}):`);
  const commonGroundIds: string[] = [];
  for (const cg of commonGroundResult.commonGround) {
    console.log(`    - [${cg.category}] ${cg.need}`);
    commonGroundIds.push(cg.id);
  }

  // If no common ground was found, this is fine — confirm what we have
  if (commonGroundIds.length === 0) {
    console.log('  ⚠ No common ground found — may need to add manually or skip confirmation');
  } else {
    // Confirm common ground
    console.log('\n  Confirming common ground...');
    await api('POST', `/sessions/${sessionId}/common-ground/confirm`, alex, { commonGroundIds });
    console.log('  ✓ Alex confirmed common ground');
    const samCgConfirm = await api('POST', `/sessions/${sessionId}/common-ground/confirm`, sam, { commonGroundIds });
    console.log(`  ✓ Sam confirmed common ground (allConfirmedByBoth: ${samCgConfirm.allConfirmedByBoth}, canAdvance: ${samCgConfirm.canAdvance})`);
  }

  // ── 5. ADVANCE TO STAGE 4 ────────────────────────────────────────────
  log('ADVANCE', 'Advancing both users to Stage 4...');

  try {
    const advanceA = await api('POST', `/sessions/${sessionId}/stages/advance`, alex);
    console.log(`  Alex: advanced=${advanceA.advanced}, newStage=${advanceA.newStage}${advanceA.blockedReason ? `, blocked: ${advanceA.blockedReason}` : ''}`);
  } catch (e) {
    console.log(`  Alex advance failed: ${(e as Error).message}`);
    console.log('  Trying force advance...');
    const forceA = await api('POST', `/sessions/${sessionId}/stages/advance`, alex, { force: true });
    console.log(`  Alex (force): advanced=${forceA.advanced}, newStage=${forceA.newStage}`);
  }

  try {
    const advanceB = await api('POST', `/sessions/${sessionId}/stages/advance`, sam);
    console.log(`  Sam: advanced=${advanceB.advanced}, newStage=${advanceB.newStage}${advanceB.blockedReason ? `, blocked: ${advanceB.blockedReason}` : ''}`);
  } catch (e) {
    console.log(`  Sam advance failed: ${(e as Error).message}`);
    console.log('  Trying force advance...');
    const forceB = await api('POST', `/sessions/${sessionId}/stages/advance`, sam, { force: true });
    console.log(`  Sam (force): advanced=${forceB.advanced}, newStage=${forceB.newStage}`);
  }

  // ── 6. STAGE 4 CHAT — Alex ───────────────────────────────────────────
  log('STAGE 4 — ALEX', 'Proposing strategies (2 turns)...');

  for (const msg of STAGE_4_ALEX) {
    logTurn('Alex', 'USER', msg);
    const { aiText, metadata } = await sendMessage(sessionId, alex, msg);
    logTurn('Alex', 'AI', aiText);
    if (Object.keys(metadata).length > 0) {
      console.log(`  [metadata] ${JSON.stringify(metadata)}`);
    }
  }

  // ── 7. STAGE 4 CHAT — Sam ────────────────────────────────────────────
  log('STAGE 4 — SAM', 'Proposing strategies (2 turns)...');

  for (const msg of STAGE_4_SAM) {
    logTurn('Sam', 'USER', msg);
    const { aiText, metadata } = await sendMessage(sessionId, sam, msg);
    logTurn('Sam', 'AI', aiText);
    if (Object.keys(metadata).length > 0) {
      console.log(`  [metadata] ${JSON.stringify(metadata)}`);
    }
  }

  // ── 8. STRATEGY FLOW ─────────────────────────────────────────────────
  log('STRATEGY FLOW', 'Proposing, ranking, and finding overlap...');

  // Both users propose strategies via API
  console.log('\n  Proposing strategies...');
  const alexStrategy = await api('POST', `/sessions/${sessionId}/strategies`, alex, {
    description: 'Every evening before bed, we each share one thing about our day — good or bad. Just 5 minutes. One week trial.',
    needsAddressed: alexNeedIds.slice(0, 1),
    duration: '1 week',
    measureOfSuccess: 'We both showed up for the check-in at least 5 out of 7 evenings.',
  });
  console.log(`  ✓ Alex proposed: "${alexStrategy.strategy.description.slice(0, 80)}..."`);

  const samStrategy = await api('POST', `/sessions/${sessionId}/strategies`, sam, {
    description: 'When I get home, I take 10 minutes alone to decompress, then I come find Alex and we check in briefly. One week trial.',
    needsAddressed: samNeedIds.slice(0, 1),
    duration: '1 week',
    measureOfSuccess: 'Both of us feel less tense during the evening.',
  });
  console.log(`  ✓ Sam proposed: "${samStrategy.strategy.description.slice(0, 80)}..."`);

  // Both mark ready
  console.log('\n  Marking ready...');
  await api('POST', `/sessions/${sessionId}/strategies/ready`, alex);
  console.log('  ✓ Alex ready');
  await api('POST', `/sessions/${sessionId}/strategies/ready`, sam);
  console.log('  ✓ Sam ready');

  // Get the anonymous pool to get strategy IDs for ranking
  const pool = await api('GET', `/sessions/${sessionId}/strategies`, alex);
  console.log(`\n  Strategy pool (phase: ${pool.phase}, count: ${pool.strategies.length}):`);
  for (const s of pool.strategies) {
    console.log(`    - [${s.id.slice(0, 8)}] ${s.description.slice(0, 80)}...`);
  }

  // Both rank (same order — both prefer both)
  const rankedIds = pool.strategies.map((s) => s.id);
  console.log('\n  Ranking strategies...');
  await api('POST', `/sessions/${sessionId}/strategies/rank`, alex, { rankedIds });
  console.log('  ✓ Alex ranked');
  const samRank = await api('POST', `/sessions/${sessionId}/strategies/rank`, sam, { rankedIds });
  console.log(`  ✓ Sam ranked (canReveal: ${samRank.canReveal})`);

  // Get overlap
  console.log('\n  Getting overlap...');
  const overlap = await api('GET', `/sessions/${sessionId}/strategies/overlap`, alex);
  console.log(`  Overlap: ${overlap.overlap?.length ?? 0} strategies`);
  if (overlap.overlap) {
    for (const s of overlap.overlap) {
      console.log(`    - ${s.description.slice(0, 80)}...`);
    }
  }

  // ── 9. AGREEMENT FLOW ────────────────────────────────────────────────
  log('AGREEMENT', 'Creating and confirming agreement...');

  const agreementStrategyId = overlap.agreementCandidates?.[0]?.id || overlap.overlap?.[0]?.id || alexStrategy.strategy.id;
  const agreementDescription = overlap.agreementCandidates?.[0]?.description || overlap.overlap?.[0]?.description || alexStrategy.strategy.description;

  console.log(`\n  Creating agreement from: "${agreementDescription.slice(0, 80)}..."`);
  const agreement = await api('POST', `/sessions/${sessionId}/agreements`, alex, {
    strategyId: agreementStrategyId,
    description: agreementDescription,
    type: 'MICRO_EXPERIMENT',
    duration: '1 week',
    followUpDate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  });
  console.log(`  ✓ Agreement created: ${agreement.agreement.id} (status: ${agreement.agreement.status})`);

  // Alex confirms
  await api('POST', `/sessions/${sessionId}/agreements/${agreement.agreement.id}/confirm`, alex, { confirmed: true });
  console.log('  ✓ Alex confirmed');

  // Sam confirms
  const samConfirm = await api('POST', `/sessions/${sessionId}/agreements/${agreement.agreement.id}/confirm`, sam, { confirmed: true });
  console.log(`  ✓ Sam confirmed (sessionComplete: ${samConfirm.sessionComplete})`);

  // ── 10. DONE ──────────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║  ✓ FULL FLOW COMPLETE                                      ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`\n  Session: ${sessionId}`);
  console.log(`  Review transcript: npx tsx scripts/extract-session-transcripts.ts ${sessionId}\n`);
}

main().catch((err) => {
  console.error('\n❌ FAILED:', err.message || err);
  process.exit(1);
});
