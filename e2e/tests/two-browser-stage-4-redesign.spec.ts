/**
 * Redesigned Stage 4 deterministic coverage.
 *
 * These tests intentionally seed Stage 4 data instead of relying on prompt output.
 * They exercise the two-user API contract that the mobile two-browser surfaces use:
 * inventory visibility, selection privacy, closure outcomes, and Tending entries.
 */

import { test, expect, APIRequestContext } from '@playwright/test';
import { cleanupE2EData, getE2EHeaders, SessionBuilder } from '../helpers';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

const users = {
  a: { email: 'stage4-redesign-a@e2e.test', name: 'Alice' },
  b: { email: 'stage4-redesign-b@e2e.test', name: 'Bob' },
};

type SeedStage =
  | 'STAGE4_REDESIGN_INVENTORY'
  | 'STAGE4_REDESIGN_SHARED_SELECTIONS'
  | 'STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS'
  | 'STAGE4_REDESIGN_PARTNER_INACTIVE';

interface SeededSession {
  sessionId: string;
  userAId: string;
  userBId: string;
}

function apiFor(request: APIRequestContext, email: string, userId: string) {
  const headers = getE2EHeaders(email, userId);
  return {
    get: (path: string) => request.get(`${API_BASE_URL}${path}`, { headers }),
    post: (path: string, data?: object) => request.post(`${API_BASE_URL}${path}`, { headers, data }),
  };
}

async function readJson<T>(response: { ok(): boolean; status(): number; text(): Promise<string>; json(): Promise<unknown> }, label: string): Promise<T> {
  if (!response.ok()) {
    throw new Error(`${label} failed: ${response.status()} ${await response.text()}`);
  }
  return await response.json() as T;
}

async function seedSession(request: APIRequestContext, targetStage: SeedStage): Promise<SeededSession> {
  const setup = await new SessionBuilder(API_BASE_URL)
    .userA(users.a.email, users.a.name)
    .userB(users.b.email, users.b.name)
    .startingAt(targetStage)
    .setup(request);

  if (!setup.userB) {
    throw new Error('Redesigned Stage 4 fixtures require two users');
  }

  return {
    sessionId: setup.session.id,
    userAId: setup.userA.id,
    userBId: setup.userB.id,
  };
}

test.describe('Stage 4 redesign: deterministic two-user coverage', () => {
  test.beforeEach(async () => {
    await cleanupE2EData().catch(() => {});
  });

  test('inventory fixture exposes active proposals and hides removed proposals from partner-active inventory', async ({ request }) => {
    const seeded = await seedSession(request, 'STAGE4_REDESIGN_INVENTORY');
    const apiA = apiFor(request, users.a.email, seeded.userAId);

    const state = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/stage4`),
      'get redesigned Stage 4 inventory'
    );

    const sharedDescriptions = state.data.inventory.sharedProposals.map((proposal: any) => proposal.description);
    const individualDescriptions = state.data.inventory.individualCommitments.map((proposal: any) => proposal.description);

    expect(sharedDescriptions).toContain('Try a Sunday evening planning check-in for the next two weeks');
    expect(sharedDescriptions).toContain('Use a pause phrase when either person starts to shut down');
    expect(sharedDescriptions).not.toContain('Track every chore in a shared spreadsheet every night');
    expect(individualDescriptions).toContain('I will name when I am overloaded before I disappear');
    expect(state.data.inventory.removedProposalCount).toBe(1);
    expect(state.data.coverageAudit.open.map((row: any) => row.label)).toContain('Appreciation');
  });

  test('selection privacy holds while one partner is inactive and shared closure is rejected', async ({ request }) => {
    const seeded = await seedSession(request, 'STAGE4_REDESIGN_PARTNER_INACTIVE');
    const apiA = apiFor(request, users.a.email, seeded.userAId);
    const apiB = apiFor(request, users.b.email, seeded.userBId);

    const stateA = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/stage4`),
      'get one-sided Stage 4 state for user A'
    );
    const stateB = await readJson<any>(
      await apiB.get(`/api/sessions/${seeded.sessionId}/stage4`),
      'get one-sided Stage 4 state for user B'
    );

    expect(stateA.data.partnerSelectionStatus).toBe('NOT_STARTED');
    expect(stateB.data.partnerSelectionStatus).toBe('SUBMITTED');
    for (const proposal of stateA.data.inventory.sharedProposals) {
      expect(proposal.partnerDecisionVisible).toBeUndefined();
    }
    for (const proposal of stateB.data.inventory.sharedProposals) {
      expect(proposal.partnerDecisionVisible).toBeUndefined();
    }

    const closeResponse = await apiA.post(`/api/sessions/${seeded.sessionId}/stage4/close`, {
      kind: 'SHARED_AGREEMENT',
    });
    expect(closeResponse.status()).toBe(400);
    const closeData = await closeResponse.json() as any;
    expect(closeData.error?.message ?? closeData.message).toMatch(/Both partners must submit selections/i);
  });

  test('mutual shared selection closes with scheduled Tending', async ({ request }) => {
    const seeded = await seedSession(request, 'STAGE4_REDESIGN_SHARED_SELECTIONS');
    const apiA = apiFor(request, users.a.email, seeded.userAId);

    const beforeClose = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/stage4`),
      'get mutual Stage 4 state'
    );
    const sharedProposal = beforeClose.data.inventory.sharedProposals.find((proposal: any) =>
      proposal.description.includes('Sunday evening planning check-in')
    );
    expect(sharedProposal).toBeTruthy();
    expect(sharedProposal.partnerDecisionVisible).toBe('WILLING');

    const followUpDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const closeData = await readJson<any>(
      await apiA.post(`/api/sessions/${seeded.sessionId}/stage4/close`, {
        kind: 'SHARED_AGREEMENT',
        followUpDatesByProposalId: { [sharedProposal.id]: followUpDate },
      }),
      'close shared-agreement Stage 4'
    );

    expect(closeData.data.closed).toBe(true);
    expect(closeData.data.outcome.kind).toBe('SHARED_AGREEMENT');
    expect(closeData.data.outcome.agreements).toHaveLength(1);
    expect(closeData.data.state.tendingPreview.scheduledCount).toBe(2);

    const tendingData = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/tending`),
      'list scheduled Tending entries'
    );
    expect(tendingData.data.entries).toHaveLength(2);
    const sharedTending = tendingData.data.entries.find((entry: any) =>
      entry.type === 'SCHEDULED_SHARED_AGREEMENT_CHECKIN'
    );
    expect(sharedTending).toBeTruthy();
    expect(sharedTending.status).toBe('SCHEDULED');
    expect(sharedTending.agreementId).toBe(closeData.data.outcome.agreements[0].id);
  });

  test('due shared Tending check-in holds private choices until both partners submit', async ({ request }) => {
    const seeded = await seedSession(request, 'STAGE4_REDESIGN_SHARED_SELECTIONS');
    const apiA = apiFor(request, users.a.email, seeded.userAId);
    const apiB = apiFor(request, users.b.email, seeded.userBId);

    const beforeClose = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/stage4`),
      'get mutual Stage 4 state before due Tending close'
    );
    const sharedProposal = beforeClose.data.inventory.sharedProposals.find((proposal: any) =>
      proposal.description.includes('Sunday evening planning check-in')
    );
    expect(sharedProposal).toBeTruthy();
    // A need outcome names a real shared need: the coverage row the mobile
    // check-in screen reads its need ids from (work-yvt0).
    const coverage = beforeClose.data.coverageAudit;
    const partnershipNeed = [...coverage.covered, ...coverage.partial, ...coverage.open].find((row: any) =>
      row.label === 'Partnership'
    );
    expect(partnershipNeed?.id).toBeTruthy();

    const dueDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await readJson<any>(
      await apiA.post(`/api/sessions/${seeded.sessionId}/stage4/close`, {
        kind: 'SHARED_AGREEMENT',
        followUpDatesByProposalId: { [sharedProposal.id]: dueDate },
      }),
      'close shared-agreement Stage 4 with due Tending'
    );

    const tendingData = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/tending`),
      'list open due Tending entries'
    );
    const sharedTending = tendingData.data.entries.find((entry: any) =>
      entry.type === 'SCHEDULED_SHARED_AGREEMENT_CHECKIN'
    );
    expect(sharedTending).toBeTruthy();
    expect(sharedTending.status).toBe('OPEN');

    const checkinData = await readJson<any>(
      await apiA.post(`/api/sessions/${seeded.sessionId}/tending/checkin`, {
        orientations: {
          whatWorked: {
            reflection: 'We tried to plan, but it only happened once.',
            perEntryNotes: {
              [sharedTending.id]: 'The check-in did not become a routine.',
            },
          },
          whereMoreSupport: {
            reflection: 'We need a smaller commitment and clearer ownership.',
            perEntryNotes: {
              [sharedTending.id]: 'Partner follow-through was inconsistent.',
            },
          },
          whatComesNext: {
            continueChoice: 'ANOTHER_ROUND',
            nextAction: 'REOPEN_STRATEGY_WORK',
          },
        },
        entryOutcomes: [
          {
            tendingEntryId: sharedTending.id,
            followThroughStatus: 'PARTLY_HAPPENED',
            helpfulnessStatus: 'DID_NOT_HELP',
            blockerCategories: ['PARTNER_DID_NOT_DO_PART', 'UNCLEAR'],
            whatHappened: 'It happened once, then fell off.',
            helpedNeed: 'The partnership need still feels open.',
            stillWorthTrying: false,
          },
        ],
        needOutcomes: [
          {
            needId: partnershipNeed.id,
            needLabel: 'Partnership',
            sourceUserId: seeded.userAId,
            resolutionStatus: 'STILL_OPEN',
            note: 'Planning is still not reliable.',
            nextAction: 'REOPEN_STRATEGY_WORK',
          },
        ],
        nextAction: 'REOPEN_STRATEGY_WORK',
      }),
      'submit structured Tending check-in'
    );

    expect(checkinData.data.continueChoice).toBe('ANOTHER_ROUND');
    expect(checkinData.data.checkin.nextAction).toBe('REOPEN_STRATEGY_WORK');
    expect(checkinData.data.checkin.coordinationCycleId).toBeTruthy();
    expect(checkinData.data.coordinationCycle).toEqual(expect.objectContaining({
      status: 'WAITING_FOR_PARTNER',
      submittedUserIds: [seeded.userAId],
    }));
    // The outcome is linked to the shared need and carries its need_share
    // text, not the owner's private label: a SHARED follow-up's check-in is
    // readable by the partner (R4). The synthetic id this spec used to send
    // matched nothing, so the client label was stored unlinked.
    expect(checkinData.data.checkin.needOutcomes[0]).toEqual(expect.objectContaining({
      needId: partnershipNeed.id,
      needLabel: 'Carrying the load as a team',
      resolutionStatus: 'STILL_OPEN',
      nextAction: 'REOPEN_STRATEGY_WORK',
    }));
    const refreshedSharedEntry = checkinData.data.entries.find((entry: any) => entry.id === sharedTending.id);
    expect(refreshedSharedEntry.status).toBe('PARTIAL');
    expect(refreshedSharedEntry.latestOutcome).toEqual(expect.objectContaining({
      followThroughStatus: 'PARTLY_HAPPENED',
      helpfulnessStatus: 'DID_NOT_HELP',
      blockerCategories: expect.arrayContaining(['PARTNER_DID_NOT_DO_PART', 'UNCLEAR']),
      stillWorthTrying: false,
    }));

    const heldState = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/stage4`),
      'get held Stage 4 state after one-sided Tending'
    );
    expect(heldState.data.outcome.kind).toBe('SHARED_AGREEMENT');

    const heldTending = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/tending`),
      'list held Tending coordination after first submission'
    );
    expect(heldTending.data.coordinationCycles[0]).toEqual(expect.objectContaining({
      status: 'WAITING_FOR_PARTNER',
      submittedUserIds: [seeded.userAId],
    }));

    const partnerCheckin = await readJson<any>(
      await apiB.post(`/api/sessions/${seeded.sessionId}/tending/checkin`, {
        orientations: {
          whatWorked: { reflection: 'I also think it needs another pass.' },
          whereMoreSupport: { reflection: 'The agreement was too vague.' },
          whatComesNext: {
            continueChoice: 'ANOTHER_ROUND',
            nextAction: 'REOPEN_STRATEGY_WORK',
          },
        },
        entryOutcomes: [
          {
            tendingEntryId: sharedTending.id,
            followThroughStatus: 'PARTLY_HAPPENED',
            helpfulnessStatus: 'DID_NOT_HELP',
            blockerCategories: ['UNCLEAR'],
            whatHappened: 'It happened once but did not stick.',
            stillWorthTrying: false,
          },
        ],
        needOutcomes: [
          {
            needId: partnershipNeed.id,
            needLabel: 'Partnership',
            sourceUserId: seeded.userBId,
            resolutionStatus: 'STILL_OPEN',
            nextAction: 'REOPEN_STRATEGY_WORK',
          },
        ],
        nextAction: 'REOPEN_STRATEGY_WORK',
      }),
      'submit partner structured Tending check-in'
    );

    expect(partnerCheckin.data.coordinationCycle).toEqual(expect.objectContaining({
      status: 'READY_TO_RESOLVE',
      submittedUserIds: expect.arrayContaining([seeded.userAId, seeded.userBId]),
    }));
  });

  test('due shared Tending check-in renders the rich mobile check-in flow', async ({ request, page }) => {
    const seeded = await seedSession(request, 'STAGE4_REDESIGN_SHARED_SELECTIONS');
    const apiA = apiFor(request, users.a.email, seeded.userAId);

    const beforeClose = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/stage4`),
      'get mutual Stage 4 state before UI check-in'
    );
    const sharedProposal = beforeClose.data.inventory.sharedProposals.find((proposal: any) =>
      proposal.description.includes('Sunday evening planning check-in')
    );
    expect(sharedProposal).toBeTruthy();

    const dueDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await readJson<any>(
      await apiA.post(`/api/sessions/${seeded.sessionId}/stage4/close`, {
        kind: 'SHARED_AGREEMENT',
        followUpDatesByProposalId: { [sharedProposal.id]: dueDate },
      }),
      'close shared-agreement Stage 4 with due Tending for UI smoke'
    );

    const tendingData = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/tending`),
      'list open due Tending entries for UI smoke'
    );
    const sharedTending = tendingData.data.entries.find((entry: any) =>
      entry.type === 'SCHEDULED_SHARED_AGREEMENT_CHECKIN'
    );
    expect(sharedTending).toBeTruthy();

    const params = new URLSearchParams({
      tendingEntryId: sharedTending.id,
      'e2e-user-id': seeded.userAId,
      'e2e-user-email': users.a.email,
    });
    await page.goto(`/session/${seeded.sessionId}/tending-checkin?${params.toString()}`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByTestId('tending-checkin-step-followThrough')).toBeVisible();
    await expect(page.getByTestId(`tending-checkin-entry-${sharedTending.id}`)).toBeVisible();
    await expect(page.getByTestId(`tending-follow-through-${sharedTending.id}-PARTLY_HAPPENED`)).toBeVisible();

    await page.getByTestId('tending-checkin-next').click();
    await expect(page.getByTestId(`tending-helpfulness-${sharedTending.id}-DID_NOT_HELP`)).toBeVisible();
    await expect(page.getByTestId(`tending-blocker-${sharedTending.id}-PARTNER_DID_NOT_DO_PART`)).toBeVisible();

    await page.getByTestId('tending-checkin-next').click();
    await expect(page.getByTestId('tending-checkin-step-needsReview')).toBeVisible();
    await expect(page.getByText('Appreciation')).toBeVisible();

    await page.getByTestId('tending-checkin-next').click();
    await expect(page.getByTestId('tending-checkin-choice-REOPEN_STRATEGY_WORK')).toBeVisible();
    await expect(page.getByTestId('tending-reminder-controls')).toBeVisible();
  });

  test('between-period notes stay private and are offered for check-in carry-forward', async ({ request, page }) => {
    const seeded = await seedSession(request, 'STAGE4_REDESIGN_SHARED_SELECTIONS');
    const apiA = apiFor(request, users.a.email, seeded.userAId);
    const apiB = apiFor(request, users.b.email, seeded.userBId);

    const beforeClose = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/stage4`),
      'get mutual Stage 4 state before private note check'
    );
    const sharedProposal = beforeClose.data.inventory.sharedProposals.find((proposal: any) =>
      proposal.description.includes('Sunday evening planning check-in')
    );
    expect(sharedProposal).toBeTruthy();

    const dueDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    await readJson<any>(
      await apiA.post(`/api/sessions/${seeded.sessionId}/stage4/close`, {
        kind: 'SHARED_AGREEMENT',
        followUpDatesByProposalId: { [sharedProposal.id]: dueDate },
      }),
      'close shared-agreement Stage 4 before private note'
    );

    const noteContent = 'Eve private note: I felt myself bracing after we set the plan.';
    const noteData = await readJson<any>(
      await apiA.post(`/api/sessions/${seeded.sessionId}/tending/notes`, {
        content: noteContent,
      }),
      'create private between-period note'
    );
    expect(noteData.data.note).toEqual(expect.objectContaining({
      userId: seeded.userAId,
      content: noteContent,
      carryForwardSelected: false,
      consentToShareWithPartner: false,
    }));

    const tendingForA = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/tending`),
      'list Tending with private note for owner'
    );
    expect(tendingForA.data.betweenPeriodNotes.map((note: any) => note.content)).toContain(noteContent);

    const tendingForB = await readJson<any>(
      await apiB.get(`/api/sessions/${seeded.sessionId}/tending`),
      'list Tending without partner private note'
    );
    expect(tendingForB.data.betweenPeriodNotes ?? []).toHaveLength(0);
    expect(JSON.stringify(tendingForB.data)).not.toContain(noteContent);

    const sharedTending = tendingForA.data.entries.find((entry: any) =>
      entry.type === 'SCHEDULED_SHARED_AGREEMENT_CHECKIN'
    );
    expect(sharedTending).toBeTruthy();

    const params = new URLSearchParams({
      tendingEntryId: sharedTending.id,
      'e2e-user-id': seeded.userAId,
      'e2e-user-email': users.a.email,
    });
    await page.goto(`/session/${seeded.sessionId}/tending-checkin?${params.toString()}`);
    await page.waitForLoadState('domcontentloaded');

    await expect(page.getByTestId('tending-checkin-step-privateNotes')).toBeVisible();
    await expect(page.getByText(noteContent)).toBeVisible();
    await expect(page.getByTestId(`tending-include-note-${noteData.data.note.id}-include`)).toBeVisible();
    await expect(page.getByTestId(`tending-share-note-${noteData.data.note.id}-share`)).toBeVisible();

    await page.getByTestId(`tending-include-note-${noteData.data.note.id}-include`).click();
    await page.getByTestId(`tending-share-note-${noteData.data.note.id}-share`).click();
    await page.getByTestId('tending-checkin-next').click();
    await expect(page.getByTestId('tending-checkin-step-followThrough')).toBeVisible();
  });

  test('no shared agreement preserves individual Tending and supports passive re-entry', async ({ request }) => {
    const seeded = await seedSession(request, 'STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS');
    const apiA = apiFor(request, users.a.email, seeded.userAId);

    const closeData = await readJson<any>(
      await apiA.post(`/api/sessions/${seeded.sessionId}/stage4/close`, {
        kind: 'NO_SHARED_AGREEMENT',
        reason: 'NO_OVERLAP',
      }),
      'close no-shared-agreement Stage 4'
    );

    expect(closeData.data.outcome.kind).toBe('NO_SHARED_AGREEMENT');
    expect(closeData.data.outcome.agreements).toHaveLength(0);
    expect(closeData.data.state.tendingPreview.scheduledCount).toBe(1);
    expect(closeData.data.state.tendingPreview.passiveReentryAvailable).toBe(true);

    const initialTending = await readJson<any>(
      await apiA.get(`/api/sessions/${seeded.sessionId}/tending`),
      'list Tending before passive re-entry'
    );
    expect(initialTending.data.entries).toHaveLength(1);
    expect(initialTending.data.entries[0].type).toBe('SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN');

    const reentryData = await readJson<any>(
      await apiA.post(`/api/sessions/${seeded.sessionId}/tending/reentry`, {
        intent: 'I want to revisit the open appreciation need without forcing an agreement.',
      }),
      'create passive Tending re-entry'
    );
    expect(reentryData.data.entry.type).toBe('USER_INITIATED_REENTRY');
    expect(reentryData.data.entry.status).toBe('OPEN');
    expect(reentryData.data.entry.agreementId).toBeNull();
  });
});
