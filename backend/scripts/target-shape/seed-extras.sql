-- ============================================================================
-- seed-extras.sql — current-shape rows the state factory never writes, so a
-- scratch run (run-target-migration.sh --extras) exercises every copy path of
-- the target_shape migration: shared needs (ConsentedContent, one revoked),
-- the repair walkthrough and declinations, proposals with needsAddressed and
-- StrategyProposalNeed, choices, a revision, an agreement, a closure (with an
-- unshared open-need id: the expected difference), a sub-chat, reconciler
-- guidance + a declined share offer with refined text, unsent and sent
-- validation feedback, a ValidationFeedbackDraft, tending (cycle, check-in
-- covering two entries, outcomes, need outcome, adjustment, partial closure,
-- orphan response, notes, reminder), mood, exercise, memory, reflection with
-- takeaways and a link, the four wellbeing features, brain activity, two
-- vanished members (E in session Y: messages only; E2 in session V: an
-- attempt with its author nulled, a review with its reviewer nulled, an
-- accepted invitation, a reconciler result and an agreement), a pre-2026-style
-- ownerless AI message in a live session (backfilled by the fix-data
-- template), an ownerless USER message in a vanished-member session (dropped,
-- kept in app_migration.dropped_content), a USER message with a nulled
-- sender, PAUSED / WAITING sessions, and (TS-7b) session S, whose needs both
-- members shared the production way (ConsentRecord only, no ConsentedContent).
-- Fixed ids (…7e…) make the rows easy to find.
-- Scratch-only: refuses anything but a ts7_* database.
-- ============================================================================
DO $$
BEGIN
  IF current_database() !~ '^ts7_[a-z0-9_]+$' THEN
    RAISE EXCEPTION 'seed-extras.sql only runs on a ts7_* scratch database, not %', current_database();
  END IF;
END
$$;

-- Users C (Cara Diaz) and D (Dev Patel); E is the vanished member (no row).
INSERT INTO "User" (id, "clerkId", email, name, "firstName", "lastName", "pushToken", "biometricEnabled", "memoryPreferences",
                    "privacyPreferences", "globalFacts", "lastMoodIntensity", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000000c1', 'clerk_extras_c', 'c.extras@e2e.test', 'Cara Diaz', 'Cara', 'Diaz', 'ExponentPushToken[c]', true,
   '{"crossSessionRecall": true}', '{"showActivityStatus": false}',
   '{"facts": [{"category": "People", "fact": "has a sister"}], "consolidatedAt": "2026-09-01T00:00:00Z", "sessionCount": 1}', 6,
   '2026-09-01 09:00+00', '2026-09-01 09:00+00'),
  ('00000000-0000-7e00-8000-0000000000d1', 'clerk_extras_d', 'd.extras@e2e.test', 'Dev Patel', 'Dev', 'Patel', NULL, false,
   NULL, NULL, NULL, NULL, '2026-09-01 09:00+00', '2026-09-01 09:00+00');

-- Relationship R1 / session X (stage 4, everything), R2 / Y (vanished member), R3 / Z (PAUSED), R4 / W (WAITING).
INSERT INTO "Relationship" (id, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000000a1', '2026-09-01 09:00+00', '2026-09-01 09:00+00'),
  ('00000000-0000-7e00-8000-0000000000a2', '2026-09-01 09:00+00', '2026-09-01 09:00+00'),
  ('00000000-0000-7e00-8000-0000000000a3', '2026-09-01 09:00+00', '2026-09-01 09:00+00'),
  ('00000000-0000-7e00-8000-0000000000a4', '2026-09-01 09:00+00', '2026-09-01 09:00+00');
INSERT INTO "RelationshipMember" ("relationshipId", "userId", "joinedAt", role, nickname) VALUES
  ('00000000-0000-7e00-8000-0000000000a1', '00000000-0000-7e00-8000-0000000000c1', '2026-09-01 09:00+00', 'owner', 'Dev'),
  ('00000000-0000-7e00-8000-0000000000a1', '00000000-0000-7e00-8000-0000000000d1', '2026-09-01 09:05+00', 'member', 'Cara'),
  ('00000000-0000-7e00-8000-0000000000a2', '00000000-0000-7e00-8000-0000000000c1', '2026-09-01 09:00+00', 'member', NULL),
  ('00000000-0000-7e00-8000-0000000000a3', '00000000-0000-7e00-8000-0000000000c1', '2026-09-01 09:00+00', 'member', NULL),
  ('00000000-0000-7e00-8000-0000000000a3', '00000000-0000-7e00-8000-0000000000d1', '2026-09-01 09:00+00', 'member', NULL),
  ('00000000-0000-7e00-8000-0000000000a4', '00000000-0000-7e00-8000-0000000000c1', '2026-09-01 09:00+00', 'member', NULL),
  ('00000000-0000-7e00-8000-0000000000a4', '00000000-0000-7e00-8000-0000000000d1', '2026-09-01 09:01+00', 'member', NULL);
INSERT INTO "Session" (id, "relationshipId", status, "topicFrame", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000a1', 'ACTIVE', 'Who does the dishes', '2026-09-01 09:00+00', '2026-09-10 09:00+00'),
  ('00000000-0000-7e00-8000-0000000005e2', '00000000-0000-7e00-8000-0000000000a2', 'ACTIVE', NULL, '2026-09-01 09:00+00', '2026-09-02 09:00+00'),
  ('00000000-0000-7e00-8000-0000000005e3', '00000000-0000-7e00-8000-0000000000a3', 'PAUSED', NULL, '2026-09-01 09:00+00', '2026-09-03 09:00+00'),
  ('00000000-0000-7e00-8000-0000000005e4', '00000000-0000-7e00-8000-0000000000a4', 'WAITING', NULL, '2026-09-01 09:00+00', '2026-09-03 09:00+00');
INSERT INTO "SharedVessel" (id, "sessionId", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-00000000005a', '00000000-0000-7e00-8000-0000000005e1', '2026-09-01 09:00+00');
INSERT INTO "Invitation" (id, "sessionId", "invitedById", name, status, "expiresAt", "acceptedAt", "messageConfirmed", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000001a1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'Dev', 'ACCEPTED',
   '2026-09-08 09:00+00', '2026-09-01 09:05+00', true, '2026-09-01 09:01+00');

INSERT INTO "UserVessel" (id, "userId", "sessionId", "conversationSummary", "notableFacts", "lastViewedAt", "lastSeenChatItemId", "lastActiveAt", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000007c1', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000005e1',
   '{"text": "Cara feels unseen", "messageCount": 4, "generatedAt": "2026-09-02T00:00:00Z", "keyThemes": ["fairness"]}',
   '[{"category": "Conflict", "fact": "dishes pile up"}]', '2026-09-09 09:00+00', '00000000-0000-7e00-8000-00000000e5c1', '2026-09-09 09:00+00',
   '2026-09-01 09:00+00', '2026-09-09 09:00+00'),
  ('00000000-0000-7e00-8000-0000000007d1', '00000000-0000-7e00-8000-0000000000d1', '00000000-0000-7e00-8000-0000000005e1',
   NULL, NULL, NULL, 'not-a-message-id', NULL, '2026-09-01 09:05+00', '2026-09-01 09:05+00');

-- Needs: C — N1 Recognition (shared), N2 Rest (unshared); D — N3 Autonomy (shared, revoked), N4 Safety (shared).
INSERT INTO "IdentifiedNeed" (id, "vesselId", need, category, evidence, confirmed, "aiConfidence", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000000e1', '00000000-0000-7e00-8000-0000000007c1', 'Recognition', 'RECOGNITION', '{"I do it all"}', true, 0.9, '2026-09-03 09:00+00'),
  ('00000000-0000-7e00-8000-0000000000e2', '00000000-0000-7e00-8000-0000000007c1', 'Rest', 'SAFETY', '{}', true, 0.7, '2026-09-03 09:00+00'),
  ('00000000-0000-7e00-8000-0000000000e3', '00000000-0000-7e00-8000-0000000007d1', 'Autonomy', 'AUTONOMY', '{}', true, 0.8, '2026-09-03 09:00+00'),
  ('00000000-0000-7e00-8000-0000000000e4', '00000000-0000-7e00-8000-0000000007d1', 'Safety', 'SAFETY', '{}', false, 0.6, '2026-09-03 09:00+00');
INSERT INTO "ConsentRecord" (id, "userId", "sessionId", "targetType", "targetId", "requestedByUserId", decision, "decidedAt", "revokedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-000000000cc1', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000005e1', 'IDENTIFIED_NEED',
   '00000000-0000-7e00-8000-0000000000e1', '00000000-0000-7e00-8000-0000000000c1', 'GRANTED', '2026-09-04 09:00+00', NULL, '2026-09-04 09:00+00'),
  ('00000000-0000-7e00-8000-000000000cc3', '00000000-0000-7e00-8000-0000000000d1', NULL, 'IDENTIFIED_NEED',
   '00000000-0000-7e00-8000-0000000000e3', '00000000-0000-7e00-8000-0000000000d1', 'REVOKED', '2026-09-04 09:00+00', '2026-09-05 09:00+00', '2026-09-04 09:00+00'),
  ('00000000-0000-7e00-8000-000000000cc4', '00000000-0000-7e00-8000-0000000000d1', '00000000-0000-7e00-8000-0000000005e1', 'IDENTIFIED_NEED',
   '00000000-0000-7e00-8000-0000000000e4', '00000000-0000-7e00-8000-0000000000c1', 'GRANTED', '2026-09-04 09:00+00', NULL, '2026-09-04 09:00+00');
INSERT INTO "ConsentedContent" (id, "sharedVesselId", "sourceUserId", "transformedContent", "consentedAt", "consentActive", "revokedAt", "consentRecordId") VALUES
  ('00000000-0000-7e00-8000-0000000c0c01', '00000000-0000-7e00-8000-00000000005a', '00000000-0000-7e00-8000-0000000000c1',
   'I want my effort to be noticed', '2026-09-04 09:00+00', true, NULL, '00000000-0000-7e00-8000-000000000cc1'),
  ('00000000-0000-7e00-8000-0000000c0c03', '00000000-0000-7e00-8000-00000000005a', '00000000-0000-7e00-8000-0000000000d1',
   'I need room to decide', '2026-09-04 09:00+00', false, '2026-09-05 09:00+00', '00000000-0000-7e00-8000-000000000cc3'),
  ('00000000-0000-7e00-8000-0000000c0c04', '00000000-0000-7e00-8000-00000000005a', '00000000-0000-7e00-8000-0000000000d1',
   'I need to feel safe at home', '2026-09-04 09:00+00', true, NULL, '00000000-0000-7e00-8000-000000000cc4');

-- Progress: stages 0–3 complete with the app's gate keys; stage 4 in progress with the walkthrough.
INSERT INTO "StageProgress" ("sessionId", "userId", stage, status, "startedAt", "completedAt", "gatesSatisfied") VALUES
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 0, 'COMPLETED', '2026-09-01 09:00+00', '2026-09-01 09:10+00',
   '{"compactSigned": true, "signedAt": "2026-09-01T09:10:00Z", "invitationSent": true}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 1, 'COMPLETED', '2026-09-01 09:10+00', '2026-09-02 09:00+00',
   '{"feelHeardConfirmed": true, "feelHeardConfirmedAt": "2026-09-02T09:00:00Z", "finalEmotionalReading": null, "feedback": "felt heard", "feelHeardCheckOffered": true}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 2, 'COMPLETED', '2026-09-02 09:00+00', '2026-09-03 08:00+00',
   '{"empathyValidated": true, "validatedAt": "2026-09-03T08:00:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 3, 'COMPLETED', '2026-09-03 08:00+00', '2026-09-05 09:00+00',
   '{"needsConfirmed": true, "confirmedAt": "2026-09-03T09:00:00Z", "needsIdentifiedAt": "2026-09-03T09:00:00Z", "needsCaptured": true, "needsCapturedAt": "2026-09-03T09:00:00Z", "needsShared": true, "sharedAt": "2026-09-04T09:00:00Z", "needsValidated": true, "needsValidatedAt": "2026-09-05T09:00:00Z", "needsRevealReviewedAt": "2026-09-05T09:00:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 4, 'IN_PROGRESS', '2026-09-05 09:00+00', NULL,
   '{"readyToRank": true, "readyAt": "2026-09-05T10:00:00Z", "selectionSubmitted": true, "selectionSubmittedAt": "2026-09-06T09:00:00Z", "stage4Walkthrough": {"phase": "PARTNER_NEEDS", "currentNeedId": "00000000-0000-7e00-8000-0000000000e4", "coveredNeedIds": ["00000000-0000-7e00-8000-0000000000e1"], "skippedNeedIds": ["00000000-0000-7e00-8000-0000000000e2"], "updatedAt": "2026-09-05T11:00:00Z", "updatedFrom": "ai_walkthrough_action", "lastAction": "covered", "lastReason": null}}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 0, 'COMPLETED', '2026-09-01 09:05+00', '2026-09-01 09:20+00',
   '{"compactSigned": true, "signedAt": "2026-09-01T09:20:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 1, 'COMPLETED', '2026-09-01 09:20+00', '2026-09-02 10:00+00',
   '{"feelHeardConfirmed": true, "confirmedAt": "2026-09-02T10:00:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 2, 'COMPLETED', '2026-09-02 10:00+00', '2026-09-03 08:30+00',
   '{"empathyValidated": true, "skippedRefinement": true, "willingToAccept": true, "skipReason": "close enough"}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 3, 'COMPLETED', '2026-09-03 08:30+00', '2026-09-05 09:30+00',
   '{"needsConfirmed": true, "confirmedAt": "2026-09-03T09:30:00Z", "needsShared": true, "sharedAt": "2026-09-04T09:30:00Z", "needsValidated": true, "needsValidatedAt": "2026-09-05T09:30:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 4, 'IN_PROGRESS', '2026-09-05 09:30+00', NULL,
   '{"selectionSubmitted": true, "selectionSubmittedAt": "2026-09-06T09:30:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e2', '00000000-0000-7e00-8000-0000000000c1', 0, 'IN_PROGRESS', '2026-09-01 09:00+00', NULL, '{}'),
  ('00000000-0000-7e00-8000-0000000005e3', '00000000-0000-7e00-8000-0000000000c1', 0, 'IN_PROGRESS', '2026-09-01 09:00+00', NULL, NULL),
  ('00000000-0000-7e00-8000-0000000005e3', '00000000-0000-7e00-8000-0000000000d1', 0, 'IN_PROGRESS', '2026-09-01 09:00+00', NULL, NULL),
  ('00000000-0000-7e00-8000-0000000005e4', '00000000-0000-7e00-8000-0000000000c1', 0, 'IN_PROGRESS', '2026-09-01 09:00+00', NULL, NULL);

-- Empathy: both directions revealed and validated; C's review of D sent with
-- feedback, D's review of C unsent (and C holds a ValidationFeedbackDraft).
INSERT INTO "EmpathyDraft" (id, "sessionId", "userId", content, "readyToShare", version, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000d0fc1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'Dev feels squeezed', true, 2, '2026-09-02 09:00+00', '2026-09-02 10:00+00'),
  ('00000000-0000-7e00-8000-0000000d0fd1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 'Cara feels unseen', true, 1, '2026-09-02 10:00+00', '2026-09-02 10:00+00');
INSERT INTO "EmpathyAttempt" (id, "draftId", "sessionId", "sourceUserId", content, "sharedAt", status, "revealedAt", "revisionCount", "deliveryStatus", "deliveredAt") VALUES
  ('00000000-0000-7e00-8000-00000000a7c1', '00000000-0000-7e00-8000-0000000d0fc1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1',
   'Dev feels squeezed', '2026-09-02 10:00+00', 'VALIDATED', '2026-09-02 12:00+00', 1, 'DELIVERED', '2026-09-02 12:00+00'),
  ('00000000-0000-7e00-8000-00000000a7d1', '00000000-0000-7e00-8000-0000000d0fd1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1',
   'Cara feels unseen', '2026-09-02 10:30+00', 'VALIDATED', '2026-09-02 12:00+00', 0, 'SEEN', '2026-09-02 12:00+00');
INSERT INTO "ConsentRecord" (id, "userId", "sessionId", "targetType", "targetId", "requestedByUserId", decision, "decidedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-000000000cc5', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000005e1', 'EMPATHY_ATTEMPT',
   '00000000-0000-7e00-8000-00000000a7c1', '00000000-0000-7e00-8000-0000000000d1', 'GRANTED', '2026-09-02 10:00+00', '2026-09-02 10:00+00'),
  ('00000000-0000-7e00-8000-000000000cc6', '00000000-0000-7e00-8000-0000000000d1', '00000000-0000-7e00-8000-0000000005e1', 'EMPATHY_DRAFT',
   '00000000-0000-7e00-8000-0000000d0fd1', '00000000-0000-7e00-8000-0000000000d1', 'GRANTED', '2026-09-02 10:30+00', '2026-09-02 10:30+00');
INSERT INTO "EmpathyValidation" (id, "attemptId", "sessionId", "userId", validated, feedback, "feedbackShared", "validatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e7c01', '00000000-0000-7e00-8000-00000000a7d1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1',
   true, 'You got it', true, '2026-09-03 08:00+00'),
  ('00000000-0000-7e00-8000-0000000e7d01', '00000000-0000-7e00-8000-00000000a7c1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1',
   true, 'mostly, but the money part', false, '2026-09-03 08:30+00');
INSERT INTO "ValidationFeedbackDraft" (id, "sessionId", "userId", content, "readyToShare", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000f0dc1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'draft feedback for Dev', false,
   '2026-09-03 07:00+00', '2026-09-03 07:30+00');
INSERT INTO "ReconcilerResult" (id, "sessionId", "guesserId", "guesserName", "subjectId", "subjectName", "alignmentScore", "alignmentSummary",
                                "correctlyIdentified", "gapSeverity", "gapSummary", "missedFeelings", misattributions, "recommendedAction", rationale,
                                "sharingWouldHelp", "areaHint", "guidanceType", "promptSeed", iteration, "createdAt") VALUES
  ('00000000-0000-7e00-8000-00000000e5e1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'Cara',
   '00000000-0000-7e00-8000-0000000000d1', 'Dev', 70, 'close', '{tired}', 'moderate', 'missed money worries', '{anxious}', NULL, 'OFFER_SHARING', 'gap',
   true, 'money', 'explore_deeper_feelings', 'what might be underneath', 1, '2026-09-02 11:00+00');
INSERT INTO "ReconcilerShareOffer" (id, "resultId", "userId", status, "suggestedContent", "refinedContent", "declinedAt", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000005f1', '00000000-0000-7e00-8000-00000000e5e1', '00000000-0000-7e00-8000-0000000000d1', 'DECLINED',
   'Money worries keep me up', 'Money worries keep me up at night', '2026-09-02 11:30+00', '2026-09-02 11:00+00', '2026-09-02 11:30+00');
INSERT INTO "RefinementAttemptCounter" (id, "sessionId", direction, attempts, "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000c7001', '00000000-0000-7e00-8000-0000000005e1',
   '00000000-0000-7e00-8000-0000000000c1->00000000-0000-7e00-8000-0000000000d1', 1, '2026-09-02 11:30+00');

-- Messages in X: a USER turn, the AI reply, a VALIDATION_FEEDBACK from D in
-- C's chat, a SHARED_CONTEXT, an AI row with neither forUserId nor senderId
-- (ownerless: not copied), a USER row whose sender was nulled.
INSERT INTO "Message" (id, "sessionId", "senderId", "forUserId", role, content, stage, "timestamp", "extractedNeeds", "extractedEmotions") VALUES
  ('00000000-0000-7e00-8000-00000000e5c1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', NULL, 'USER', 'I do all the dishes', 1, '2026-09-01 10:00+00', '{}', '{}'),
  ('00000000-0000-7e00-8000-00000000e5c2', '00000000-0000-7e00-8000-0000000005e1', NULL, '00000000-0000-7e00-8000-0000000000c1', 'AI', 'That sounds tiring', 1, '2026-09-01 10:01+00', '{}', '{}'),
  ('00000000-0000-7e00-8000-00000000e5c3', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', '00000000-0000-7e00-8000-0000000000c1', 'VALIDATION_FEEDBACK', 'You got most of it', 2, '2026-09-03 08:31+00', NULL, NULL),
  ('00000000-0000-7e00-8000-00000000e5c4', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', '00000000-0000-7e00-8000-0000000000c1', 'SHARED_CONTEXT', 'Money is tight', 2, '2026-09-02 11:20+00', NULL, NULL),
  ('00000000-0000-7e00-8000-00000000e5c5', '00000000-0000-7e00-8000-0000000005e1', NULL, NULL, 'AI', 'pre-2026 reply to Cara before Dev joined', 0, '2026-09-01 09:02+00', NULL, NULL),
  ('00000000-0000-7e00-8000-00000000e5c6', '00000000-0000-7e00-8000-0000000005e1', NULL, '00000000-0000-7e00-8000-0000000000d1', 'USER', 'my own turn', 1, '2026-09-01 10:03+00', NULL, NULL),
  ('00000000-0000-7e00-8000-00000000e5c7', '00000000-0000-7e00-8000-0000000005e1', NULL, '00000000-0000-7e00-8000-0000000000c1', 'SYSTEM', 'Stage 4 begins', 4, '2026-09-05 09:00+00', NULL, NULL);
-- Session Y: the vanished member E (forUserId with no User row).
INSERT INTO "Message" (id, "sessionId", "senderId", "forUserId", role, content, stage, "timestamp") VALUES
  ('00000000-0000-7e00-8000-00000000e5e8', '00000000-0000-7e00-8000-0000000005e2', NULL, '00000000-0000-7e00-8000-0000000000ee', 'AI', 'hello E', 1, '2026-09-01 10:00+00');

-- Proposals: P1 shared (needsAddressed matches N1 and an unknown label;
-- StrategyProposalNeed to N1 and to unshared N2), P2 C's individual commitment.
INSERT INTO "StrategyProposal" (id, "sessionId", "createdByUserId", description, "needsAddressed", kind, status, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000000f1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1',
   'Alternate dish nights', '{recognition,"Quality time"}', 'SHARED_PROPOSAL', 'ACTIVE', '2026-09-05 10:00+00', '2026-09-05 10:00+00'),
  ('00000000-0000-7e00-8000-0000000000f2', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1',
   'I will say thanks', '{}', 'INDIVIDUAL_COMMITMENT', 'ACTIVE', '2026-09-05 10:05+00', '2026-09-05 10:05+00');
INSERT INTO "StrategyProposalNeed" ("proposalId", "needId", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000000f1', '00000000-0000-7e00-8000-0000000000e1', '2026-09-05 10:00+00'),
  ('00000000-0000-7e00-8000-0000000000f1', '00000000-0000-7e00-8000-0000000000e2', '2026-09-05 10:00+00');
INSERT INTO "Stage4ProposalSelection" (id, "proposalId", "sessionId", "userId", decision, "selectedAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000005c1', '00000000-0000-7e00-8000-0000000000f1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'WILLING', '2026-09-06 09:00+00', '2026-09-06 09:00+00'),
  ('00000000-0000-7e00-8000-0000000005d1', '00000000-0000-7e00-8000-0000000000f1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 'WILLING', '2026-09-06 09:30+00', '2026-09-06 09:30+00'),
  ('00000000-0000-7e00-8000-0000000005c2', '00000000-0000-7e00-8000-0000000000f2', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'WILLING', '2026-09-06 09:00+00', '2026-09-06 09:00+00');
INSERT INTO "Stage4ProposalRevision" (id, "proposalId", "sessionId", "actorUserId", action, before, after, reason, "messageId", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000e0e01', '00000000-0000-7e00-8000-0000000000f1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1',
   'subchat_refined', '{"description": "Dish nights"}', '{"description": "Alternate dish nights"}', 'refined', 'm1', '2026-09-05 11:00+00');
INSERT INTO "Agreement" (id, "sharedVesselId", description, type, status, "agreedByA", "agreedByB", "agreedAt", "followUpDate", "proposalId") VALUES
  ('00000000-0000-7e00-8000-0000000a9e01', '00000000-0000-7e00-8000-00000000005a', 'Alternate dish nights', 'MICRO_EXPERIMENT', 'IN_PROGRESS',
   true, true, '2026-09-06 10:00+00', '2026-09-20 10:00+00', '00000000-0000-7e00-8000-0000000000f1');
INSERT INTO "Stage4Closure" (id, "sessionId", kind, reason, summary, "sharedAgreementIds", "individualProposalIds", "openNeedIds", "closedByUserId", "closedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000c105e', '00000000-0000-7e00-8000-0000000005e1', 'SHARED_AGREEMENT', 'MUTUAL_SELECTION', 'We agreed on dish nights',
   '{00000000-0000-7e00-8000-0000000a9e01}', '{00000000-0000-7e00-8000-0000000000f2}',
   '{00000000-0000-7e00-8000-0000000000e4,00000000-0000-7e00-8000-0000000000e2}', '00000000-0000-7e00-8000-0000000000c1',
   '2026-09-06 11:00+00', '2026-09-06 11:00+00');
INSERT INTO "Stage4SubChat" (id, "sessionId", "userId", "anchorKind", "anchorId", status, "createdAt") VALUES
  ('00000000-0000-7e00-8000-00000005c4a1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'PROPOSAL_REFINEMENT',
   '00000000-0000-7e00-8000-0000000000f1', 'RESOLVED', '2026-09-05 10:30+00');
UPDATE "Stage4SubChat" SET "resolvedAt" = '2026-09-05 10:50+00' WHERE id = '00000000-0000-7e00-8000-00000005c4a1';
INSERT INTO "Stage4SubChatMessage" (id, "subChatId", role, content, "createdAt") VALUES
  ('00000000-0000-7e00-8000-00000005c4b1', '00000000-0000-7e00-8000-00000005c4a1', 'USER', 'can we alternate?', '2026-09-05 10:31+00'),
  ('00000000-0000-7e00-8000-00000005c4b2', '00000000-0000-7e00-8000-00000005c4a1', 'AI', 'try alternate nights', '2026-09-05 10:32+00');
INSERT INTO "Stage4NeedDeclination" (id, "sessionId", "userId", "needId", "declinedAt") VALUES
  ('00000000-0000-7e00-8000-0000000dec01', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1',
   '00000000-0000-7e00-8000-0000000000e1', '2026-09-05 12:00+00');

-- Tending: E1 shared (agreement, in a cycle), E2 C's individual commitment, E3 a re-entry with D's orphan response.
INSERT INTO "TendingEntry" (id, "sessionId", "agreementId", type, scope, "ownerUserId", status, "scheduledFor", summary, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e0001', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000a9e01',
   'SCHEDULED_SHARED_AGREEMENT_CHECKIN', 'SHARED', NULL, 'OPEN', '2026-09-20 10:00+00', NULL, '2026-09-06 10:00+00', '2026-09-20 10:00+00'),
  ('00000000-0000-7e00-8000-0000000e0002', '00000000-0000-7e00-8000-0000000005e1', NULL,
   'SCHEDULED_INDIVIDUAL_COMMITMENT_CHECKIN', 'INDIVIDUAL', '00000000-0000-7e00-8000-0000000000c1', 'PARTIAL', '2026-09-20 10:00+00', 'going ok',
   '2026-09-06 10:00+00', '2026-09-20 10:00+00'),
  ('00000000-0000-7e00-8000-0000000e0003', '00000000-0000-7e00-8000-0000000005e1', NULL,
   'USER_INITIATED_REENTRY', 'SHARED', NULL, 'SCHEDULED', '2026-10-01 10:00+00', NULL, '2026-09-21 10:00+00', '2026-09-21 10:00+00');
INSERT INTO "TendingCoordinationCycle" (id, "sessionId", "createdByUserId", status, "entryIds", "participantUserIds", "submittedUserIds", "responseDeadlineAt", "resultSummary", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000c0c1e', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'WAITING_FOR_PARTNER',
   '{00000000-0000-7e00-8000-0000000e0001}', '{00000000-0000-7e00-8000-0000000000c1,00000000-0000-7e00-8000-0000000000d1}',
   '{00000000-0000-7e00-8000-0000000000c1}', '2099-01-01 00:00+00', NULL, '2026-09-20 10:00+00', '2026-09-20 11:00+00');
INSERT INTO "TendingCheckin" (id, "sessionId", "userId", "coordinationCycleId", "nextAction", "continueChoice", "reflectionSummary", "submittedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000c4ec1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000c0c1e',
   'EXTEND', 'PARTIAL_CLOSURE', 'mostly working', '2026-09-20 11:00+00', '2026-09-20 11:00+00');
INSERT INTO "TendingResponse" (id, "tendingEntryId", "userId", "checkinId", status, reflection, "continueChoice", "submittedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e5001', '00000000-0000-7e00-8000-0000000e0001', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000c4ec1', 'HAPPENED', 'good', 'EXTEND', '2026-09-20 11:00+00'),
  ('00000000-0000-7e00-8000-0000000e5002', '00000000-0000-7e00-8000-0000000e0002', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000c4ec1', 'PARTLY_HAPPENED', NULL, 'PARTIAL_CLOSURE', '2026-09-20 11:00+00'),
  ('00000000-0000-7e00-8000-0000000e5003', '00000000-0000-7e00-8000-0000000e0003', '00000000-0000-7e00-8000-0000000000d1', NULL, 'NOT_SURE', 'orphan', NULL, '2026-09-22 09:00+00');
INSERT INTO "TendingEntryOutcome" (id, "checkinId", "tendingEntryId", "responseId", "userId", "followThroughStatus", "helpfulnessStatus", "blockerCategories", "whatHappened", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000e0c01', '00000000-0000-7e00-8000-0000000c4ec1', '00000000-0000-7e00-8000-0000000e0001', '00000000-0000-7e00-8000-0000000e5001',
   '00000000-0000-7e00-8000-0000000000c1', 'HAPPENED', 'HELPED', '{FORGOT}', 'we alternated', '2026-09-20 11:00+00');
INSERT INTO "TendingNeedOutcome" (id, "checkinId", "sessionId", "needId", "needLabel", "sourceUserId", "resolutionStatus", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000e0d01', '00000000-0000-7e00-8000-0000000c4ec1', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000e1',
   'Recognition', '00000000-0000-7e00-8000-0000000000c1', 'IMPROVING', '2026-09-20 11:00+00'),
  ('00000000-0000-7e00-8000-0000000e0d02', '00000000-0000-7e00-8000-0000000c4ec1', '00000000-0000-7e00-8000-0000000005e1', 'label-only',
   'Quality time', NULL, 'STILL_OPEN', '2026-09-20 11:00+00');
INSERT INTO "TendingAdjustment" (id, "sessionId", "checkinId", "tendingEntryId", "userId", "revisedCadence", "blockerAddressed", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000ead01', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000c4ec1', '00000000-0000-7e00-8000-0000000e0002',
   '00000000-0000-7e00-8000-0000000000c1', 'weekly', '{TOO_FREQUENT}', '2026-09-20 11:00+00');
INSERT INTO "TendingResponsePartialClosure" (id, "tendingResponseId", "tendingEntryId", resolution, "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000e9c01', '00000000-0000-7e00-8000-0000000e5002', '00000000-0000-7e00-8000-0000000e0002', 'CONTINUING', '2026-09-20 11:00+00');
INSERT INTO "TendingBetweenPeriodNote" (id, "sessionId", "userId", content, "carryForwardSelected", "consentToShareWithPartner", "shareConsentAt", "selectedForCheckinId", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e0b01', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'Dev thanked me', true, true,
   '2026-09-19 10:00+00', '00000000-0000-7e00-8000-0000000c4ec1', '2026-09-10 10:00+00', '2026-09-19 10:00+00'),
  ('00000000-0000-7e00-8000-0000000e0b02', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000c1', 'private note', false, false,
   NULL, NULL, '2026-09-11 10:00+00', '2026-09-11 10:00+00');
INSERT INTO "TendingReminder" (id, "sessionId", "checkinId", "tendingEntryId", "userId", scope, "remindAt", status, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e7e01', '00000000-0000-7e00-8000-0000000005e1', NULL, '00000000-0000-7e00-8000-0000000e0001',
   '00000000-0000-7e00-8000-0000000000c1', 'PRIVATE', '2026-09-19 09:00+00', 'DELIVERED', '2026-09-06 10:00+00', '2026-09-19 09:00+00');

-- Mood, exercise, memory.
INSERT INTO "EmotionalReading" (id, "vesselId", intensity, context, stage, "timestamp") VALUES
  ('00000000-0000-7e00-8000-0000000e0e0d', '00000000-0000-7e00-8000-0000000007c1', 6, 'tired', 1, '2026-09-01 10:00+00');
INSERT INTO "EmotionalExerciseCompletion" (id, "sessionId", "userId", type, "intensityBefore", "intensityAfter", "completedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e0e0e', '00000000-0000-7e00-8000-0000000005e1', '00000000-0000-7e00-8000-0000000000d1', 'GROUNDING', 8, 4, '2026-09-01 11:00+00');
INSERT INTO "UserMemory" (id, "userId", "sessionId", content, category, status, source, "suggestedBy", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e3e01', '00000000-0000-7e00-8000-0000000000c1', NULL, 'Call me Car', 'PERSONAL_INFO', 'ACTIVE', 'USER_EDITED', 'Call me Cara',
   '2026-09-01 10:00+00', '2026-09-01 10:00+00');

-- Reflection.
INSERT INTO "InnerWorkSession" (id, "userId", title, theme, status, "conversationSummary", "linkedPartnerSessionId", "linkedAtStage", "linkedTrigger", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e1e01', '00000000-0000-7e00-8000-0000000000c1', 'Why the dishes', 'fairness', 'ACTIVE',
   '{"text": "fairness again", "messageCount": 2}', '00000000-0000-7e00-8000-0000000005e1', 2, 'empathy_wait', '2026-09-02 13:00+00', '2026-09-02 14:00+00');
INSERT INTO "InnerWorkMessage" (id, "sessionId", role, content, "timestamp") VALUES
  ('00000000-0000-7e00-8000-0000000e1e11', '00000000-0000-7e00-8000-0000000e1e01', 'USER', 'I keep score', '2026-09-02 13:01+00'),
  ('00000000-0000-7e00-8000-0000000e1e12', '00000000-0000-7e00-8000-0000000e1e01', 'AI', 'What would letting go look like?', '2026-09-02 13:02+00');
INSERT INTO "SessionTakeaway" (id, "sessionId", content, theme, source, type, position, resolved, "resolvedAt", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e1e21', '00000000-0000-7e00-8000-0000000e1e01', 'I keep score', 'fairness', 'AI', 'INSIGHT', 0, true, NULL, '2026-09-02 14:00+00', '2026-09-02 15:00+00'),
  ('00000000-0000-7e00-8000-0000000e1e22', '00000000-0000-7e00-8000-0000000e1e01', 'Say thanks daily', NULL, 'USER', 'ACTION_ITEM', 1, false, NULL, '2026-09-02 14:00+00', '2026-09-02 14:00+00');
INSERT INTO "TakeawayLink" (id, "sourceId", "targetId", "linkType", similarity, "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000e1e31', '00000000-0000-7e00-8000-0000000e1e21', '00000000-0000-7e00-8000-0000000e1e22', 'USER_MANUAL', NULL, '2026-09-02 14:30+00');

-- Wellbeing (all four features for C).
INSERT INTO "MeditationSession" (id, "userId", type, "durationMinutes", completed, "startedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e3d01', '00000000-0000-7e00-8000-0000000000c1', 'GUIDED', 10, true, '2026-09-03 07:00+00');
INSERT INTO "MeditationStats" (id, "userId", "totalSessions", "guidedCount") VALUES
  ('00000000-0000-7e00-8000-0000000e3d02', '00000000-0000-7e00-8000-0000000000c1', 1, 1);
INSERT INTO "MeditationFavorite" (id, "userId", name, "focusArea", "durationMinutes", "favoriteType") VALUES
  ('00000000-0000-7e00-8000-0000000e3d03', '00000000-0000-7e00-8000-0000000000c1', 'Morning', 'grounding', 10, 'THEME');
INSERT INTO "MeditationPreferences" (id, "userId") VALUES ('00000000-0000-7e00-8000-0000000e3d04', '00000000-0000-7e00-8000-0000000000c1');
INSERT INTO "SavedMeditation" (id, "userId", title, script, "durationSeconds", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e3d05', '00000000-0000-7e00-8000-0000000000c1', 'Calm', 'Breathe [PAUSE:5s]', 60, '2026-09-03 07:00+00');
INSERT INTO "GratitudeEntry" (id, "userId", content, "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000e3d06', '00000000-0000-7e00-8000-0000000000c1', 'Dev made coffee', '2026-09-04 07:00+00');
INSERT INTO "GratitudePreferences" (id, "userId") VALUES ('00000000-0000-7e00-8000-0000000e3d07', '00000000-0000-7e00-8000-0000000000c1');
INSERT INTO "NeedScore" (id, "userId", "needId", score, "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000e3d08', '00000000-0000-7e00-8000-0000000000c1', 1, 2, '2026-09-04 08:00+00');
INSERT INTO "NeedsAssessmentState" (id, "userId", "baselineCompleted") VALUES ('00000000-0000-7e00-8000-0000000e3d09', '00000000-0000-7e00-8000-0000000000c1', true);
INSERT INTO "Person" (id, "userId", name) VALUES ('00000000-0000-7e00-8000-0000000e3d0a', '00000000-0000-7e00-8000-0000000000c1', 'Dev');
INSERT INTO "PersonMention" (id, "personId", "userId", "sourceType", "sourceId") VALUES
  ('00000000-0000-7e00-8000-0000000e3d0b', '00000000-0000-7e00-8000-0000000e3d0a', '00000000-0000-7e00-8000-0000000000c1', 'GRATITUDE', '00000000-0000-7e00-8000-0000000e3d06');

-- Telemetry.
INSERT INTO "BrainActivity" (id, "sessionId", "innerWorkSessionId", "turnId", "activityType", model, input, output, "callType", cost, status, "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000eba01', '00000000-0000-7e00-8000-0000000005e1', NULL, 't1', 'LLM_CALL', 'sonnet', '{"prompt": "x"}', '[1, 2]',
   'ORCHESTRATED_RESPONSE', 0.0012345678, 'COMPLETED', '2026-09-01 10:01+00'),
  ('00000000-0000-7e00-8000-0000000eba02', NULL, '00000000-0000-7e00-8000-0000000e1e01', 't2', 'LLM_CALL', 'haiku', 'null', NULL,
   'DISTILLATION', 0, 'COMPLETED', '2026-09-02 14:00+00');

-- Session Y: the vanished member E's own typed message — senderId nulled by
-- the deletion, forUserId never set before 2026-01-02 (plan 4a: dropped).
INSERT INTO "Message" (id, "sessionId", "senderId", "forUserId", role, content, stage, "timestamp") VALUES
  ('00000000-0000-7e00-8000-00000000e5e9', '00000000-0000-7e00-8000-0000000005e2', NULL, NULL, 'USER', 'E typed this', 1, '2026-09-01 09:59+00');

-- Session V (relationship R5, RESOLVED): C and the vanished member E2
-- (…00ef, no "User" row: deleted, its RelationshipMember / EmpathyDraft /
-- Stage4ProposalSelection rows cascaded, its attempt's sourceUserId and its
-- review's userId nulled). C invited E2, E2 accepted; both agreed.
INSERT INTO "Relationship" (id, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000000a5', '2026-08-01 09:00+00', '2026-08-01 09:00+00');
INSERT INTO "RelationshipMember" ("relationshipId", "userId", "joinedAt", role) VALUES
  ('00000000-0000-7e00-8000-0000000000a5', '00000000-0000-7e00-8000-0000000000c1', '2026-08-01 09:00+00', 'member');
INSERT INTO "Session" (id, "relationshipId", status, "resolvedAt", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000005e5', '00000000-0000-7e00-8000-0000000000a5', 'RESOLVED', '2026-08-20 09:00+00', '2026-08-01 09:00+00', '2026-08-20 09:00+00');
INSERT INTO "SharedVessel" (id, "sessionId", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-00000000005b', '00000000-0000-7e00-8000-0000000005e5', '2026-08-01 09:00+00');
INSERT INTO "Invitation" (id, "sessionId", "invitedById", name, status, "expiresAt", "acceptedAt", "messageConfirmed", "messageConfirmedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000001a5', '00000000-0000-7e00-8000-0000000005e5', '00000000-0000-7e00-8000-0000000000c1', 'Eve', 'ACCEPTED',
   '2026-08-08 09:00+00', '2026-08-01 10:00+00', true, '2026-08-01 09:30+00', '2026-08-01 09:10+00');
INSERT INTO "UserVessel" (id, "userId", "sessionId", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000007c5', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000005e5', '2026-08-01 09:00+00', '2026-08-01 09:00+00');
INSERT INTO "StageProgress" ("sessionId", "userId", stage, status, "startedAt", "gatesSatisfied") VALUES
  ('00000000-0000-7e00-8000-0000000005e5', '00000000-0000-7e00-8000-0000000000c1', 0, 'COMPLETED', '2026-08-01 09:00+00', '{"compactSigned": true, "signedAt": "2026-08-01T09:20:00Z"}');
UPDATE "StageProgress" SET "completedAt" = '2026-08-01 09:20+00' WHERE "sessionId" = '00000000-0000-7e00-8000-0000000005e5';
INSERT INTO "Message" (id, "sessionId", "senderId", "forUserId", role, content, stage, "timestamp") VALUES
  ('00000000-0000-7e00-8000-00000000e5f1', '00000000-0000-7e00-8000-0000000005e5', NULL, '00000000-0000-7e00-8000-0000000000ef', 'AI', 'hello E2', 1, '2026-08-01 10:05+00'),
  ('00000000-0000-7e00-8000-00000000e5f2', '00000000-0000-7e00-8000-0000000005e5', NULL, NULL, 'USER', 'E2 typed this', 1, '2026-08-01 10:06+00');
INSERT INTO "EmpathyAttempt" (id, "sessionId", "sourceUserId", content, "sharedAt", status, "revealedAt", "deliveryStatus") VALUES
  ('00000000-0000-7e00-8000-00000000a7c5', '00000000-0000-7e00-8000-0000000005e5', '00000000-0000-7e00-8000-0000000000c1',
   'Eve feels rushed', '2026-08-05 09:00+00', 'VALIDATED', '2026-08-06 09:00+00', 'DELIVERED'),
  ('00000000-0000-7e00-8000-00000000a7e5', '00000000-0000-7e00-8000-0000000005e5', NULL,
   'Cara feels alone', '2026-08-05 10:00+00', 'VALIDATED', '2026-08-06 09:00+00', 'DELIVERED');
INSERT INTO "EmpathyValidation" (id, "attemptId", "sessionId", "userId", validated, "feedbackShared", "validatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000e7c05', '00000000-0000-7e00-8000-00000000a7e5', '00000000-0000-7e00-8000-0000000005e5', '00000000-0000-7e00-8000-0000000000c1', true, false, '2026-08-07 09:00+00'),
  ('00000000-0000-7e00-8000-0000000e7e05', '00000000-0000-7e00-8000-00000000a7c5', '00000000-0000-7e00-8000-0000000005e5', NULL, true, false, '2026-08-07 10:00+00');
INSERT INTO "ReconcilerResult" (id, "sessionId", "guesserId", "guesserName", "subjectId", "subjectName", "alignmentScore", "alignmentSummary",
                                "gapSeverity", "gapSummary", "recommendedAction", rationale, "sharingWouldHelp", "createdAt") VALUES
  ('00000000-0000-7e00-8000-00000000e5e5', '00000000-0000-7e00-8000-0000000005e5', '00000000-0000-7e00-8000-0000000000ef', 'Eve',
   '00000000-0000-7e00-8000-0000000000c1', 'Cara', 90, 'close', 'none', 'none', 'PROCEED', 'aligned', false, '2026-08-05 11:00+00');
INSERT INTO "StrategyProposal" (id, "sessionId", "createdByUserId", description, "needsAddressed", kind, status, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000000f5', '00000000-0000-7e00-8000-0000000005e5', '00000000-0000-7e00-8000-0000000000c1',
   'Slow mornings', '{}', 'SHARED_PROPOSAL', 'CONVERTED_TO_AGREEMENT', '2026-08-10 09:00+00', '2026-08-11 09:00+00');
INSERT INTO "Stage4ProposalSelection" (id, "proposalId", "sessionId", "userId", decision, "selectedAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000005c5', '00000000-0000-7e00-8000-0000000000f5', '00000000-0000-7e00-8000-0000000005e5', '00000000-0000-7e00-8000-0000000000c1', 'WILLING', '2026-08-10 10:00+00', '2026-08-10 10:00+00');
INSERT INTO "Agreement" (id, "sharedVesselId", description, type, status, "agreedByA", "agreedByB", "agreedAt", "proposalId") VALUES
  ('00000000-0000-7e00-8000-0000000a9e05', '00000000-0000-7e00-8000-00000000005b', 'Slow mornings', 'COMMITMENT', 'COMPLETED',
   true, true, '2026-08-11 09:00+00', '00000000-0000-7e00-8000-0000000000f5');

-- Session V, ruling R16: two pre-2026-style AI replies with no forUserId. The
-- first predates E2's acceptance (2026-08-01 10:00): only the inviter C could
-- have had the turn → attributed exactly to C (the survivor). The second
-- follows it: C or E2 → not attributable → dropped_content with both candidates.
INSERT INTO "Message" (id, "sessionId", "senderId", "forUserId", role, content, stage, "timestamp") VALUES
  ('00000000-0000-7e00-8000-00000000e5f3', '00000000-0000-7e00-8000-0000000005e5', NULL, NULL, 'AI', 'reply to Cara before Eve joined', 0, '2026-08-01 09:40+00'),
  ('00000000-0000-7e00-8000-00000000e5f4', '00000000-0000-7e00-8000-0000000005e5', NULL, NULL, 'AI', 'reply after both joined: whose?', 1, '2026-08-01 10:30+00');

-- Session S (relationship R6, RESOLVED by a NO_SHARED_AGREEMENT closure),
-- TS-7b: production's Stage 3 share-needs handler (stage3.ts ~750-780 on
-- phoenix/base) writes one GRANTED ConsentRecord(IDENTIFIED_NEED) per
-- confirmed live need and sets gatesSatisfied needsShared + sharedAt. It
-- writes NO ConsentedContent. Here both participants share that way:
--   C: 6e1 Appreciation (shared twice, a double-tap: R18 merge), 6e4 Weekend play time
--   D: 6e2 Downtime, 6e3 Quiet evenings (shared, then REVOKED)
-- Each share must land in need_share with the right owner (shared_text = the
-- need label, R19). Proposal P6 links D's need through StrategyProposalNeed
-- and C's label through needsAddressed, and must keep both proposal_need
-- rows. Coverage and closure follow the old rule, and the step-13 closure
-- comparison runs through them. A NULL-participant BrainActivity row in S
-- checks that anonymising a participant of X leaves S's history alone.
INSERT INTO "Relationship" (id, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000000a6', '2026-10-01 09:00+00', '2026-10-01 09:00+00');
INSERT INTO "RelationshipMember" ("relationshipId", "userId", "joinedAt", role) VALUES
  ('00000000-0000-7e00-8000-0000000000a6', '00000000-0000-7e00-8000-0000000000c1', '2026-10-01 09:00+00', 'owner'),
  ('00000000-0000-7e00-8000-0000000000a6', '00000000-0000-7e00-8000-0000000000d1', '2026-10-01 09:05+00', 'member');
INSERT INTO "Session" (id, "relationshipId", status, "resolvedAt", "topicFrame", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000a6', 'RESOLVED', '2026-10-06 09:00+00', 'Weekend plans', '2026-10-01 09:00+00', '2026-10-06 09:00+00');
INSERT INTO "Invitation" (id, "sessionId", "invitedById", name, status, "expiresAt", "acceptedAt", "messageConfirmed", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000001a6', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000c1', 'Dev', 'ACCEPTED',
   '2026-10-08 09:00+00', '2026-10-01 09:05+00', true, '2026-10-01 09:01+00');
INSERT INTO "UserVessel" (id, "userId", "sessionId", "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000007c6', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000005e6', '2026-10-01 09:00+00', '2026-10-01 09:00+00'),
  ('00000000-0000-7e00-8000-0000000007d6', '00000000-0000-7e00-8000-0000000000d1', '00000000-0000-7e00-8000-0000000005e6', '2026-10-01 09:05+00', '2026-10-01 09:05+00');
INSERT INTO "IdentifiedNeed" (id, "vesselId", need, category, evidence, confirmed, "aiConfidence", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000006e1', '00000000-0000-7e00-8000-0000000007c6', 'Appreciation', 'RECOGNITION', '{"nobody notices"}', true, 0.9, '2026-10-03 09:00+00'),
  ('00000000-0000-7e00-8000-0000000006e2', '00000000-0000-7e00-8000-0000000007d6', 'Downtime', 'AUTONOMY', '{}', true, 0.8, '2026-10-03 09:10+00'),
  ('00000000-0000-7e00-8000-0000000006e3', '00000000-0000-7e00-8000-0000000007d6', 'Quiet evenings', 'SAFETY', '{}', true, 0.7, '2026-10-03 09:20+00'),
  ('00000000-0000-7e00-8000-0000000006e4', '00000000-0000-7e00-8000-0000000007c6', 'Weekend play time', 'CONNECTION', '{}', true, 0.7, '2026-10-03 09:05+00');
INSERT INTO "ConsentRecord" (id, "userId", "sessionId", "targetType", "targetId", "requestedByUserId", decision, "decidedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-000000006cc1', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000005e6', 'IDENTIFIED_NEED',
   '00000000-0000-7e00-8000-0000000006e1', '00000000-0000-7e00-8000-0000000000c1', 'GRANTED', '2026-10-04 09:00+00', '2026-10-04 09:00+00'),
  ('00000000-0000-7e00-8000-000000006cc2', '00000000-0000-7e00-8000-0000000000d1', '00000000-0000-7e00-8000-0000000005e6', 'IDENTIFIED_NEED',
   '00000000-0000-7e00-8000-0000000006e2', '00000000-0000-7e00-8000-0000000000d1', 'GRANTED', '2026-10-04 09:30+00', '2026-10-04 09:30+00'),
  -- R18: C's double-tap — a second GRANTED record for the same need, 2 s later (merges; shared_at = the first grant)
  ('00000000-0000-7e00-8000-000000006cc5', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000005e6', 'IDENTIFIED_NEED',
   '00000000-0000-7e00-8000-0000000006e1', '00000000-0000-7e00-8000-0000000000c1', 'GRANTED', '2026-10-04 09:00:02+00', '2026-10-04 09:00:02+00'),
  -- C's second need, shared, only fuzzily matched by P6 (old coverage PARTIAL: "weekend")
  ('00000000-0000-7e00-8000-000000006cc4', '00000000-0000-7e00-8000-0000000000c1', '00000000-0000-7e00-8000-0000000005e6', 'IDENTIFIED_NEED',
   '00000000-0000-7e00-8000-0000000006e4', '00000000-0000-7e00-8000-0000000000c1', 'GRANTED', '2026-10-04 09:00+00', '2026-10-04 09:00+00');
-- D's third need: shared, then revoked — the REVOKED + revokedAt shape P19b produces.
INSERT INTO "ConsentRecord" (id, "userId", "sessionId", "targetType", "targetId", "requestedByUserId", decision, "decidedAt", "revokedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-000000006cc3', '00000000-0000-7e00-8000-0000000000d1', '00000000-0000-7e00-8000-0000000005e6', 'IDENTIFIED_NEED',
   '00000000-0000-7e00-8000-0000000006e3', '00000000-0000-7e00-8000-0000000000d1', 'REVOKED', '2026-10-04 09:30+00', '2026-10-05 09:00+00', '2026-10-04 09:30+00');
INSERT INTO "StageProgress" ("sessionId", "userId", stage, status, "startedAt", "completedAt", "gatesSatisfied") VALUES
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000c1', 0, 'COMPLETED', '2026-10-01 09:00+00', '2026-10-01 09:10+00',
   '{"compactSigned": true, "signedAt": "2026-10-01T09:10:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000c1', 1, 'COMPLETED', '2026-10-01 09:10+00', '2026-10-02 09:00+00',
   '{"feelHeardConfirmed": true, "feelHeardConfirmedAt": "2026-10-02T09:00:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000c1', 2, 'COMPLETED', '2026-10-02 09:00+00', '2026-10-03 08:00+00',
   '{"empathyValidated": true, "validatedAt": "2026-10-03T08:00:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000c1', 3, 'GATE_PENDING', '2026-10-03 08:00+00', NULL,
   '{"needsConfirmed": true, "confirmedAt": "2026-10-03T09:00:00Z", "needsShared": true, "sharedAt": "2026-10-04T09:00:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000d1', 0, 'COMPLETED', '2026-10-01 09:05+00', '2026-10-01 09:20+00',
   '{"compactSigned": true, "signedAt": "2026-10-01T09:20:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000d1', 1, 'COMPLETED', '2026-10-01 09:20+00', '2026-10-02 10:00+00',
   '{"feelHeardConfirmed": true, "confirmedAt": "2026-10-02T10:00:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000d1', 2, 'COMPLETED', '2026-10-02 10:00+00', '2026-10-03 08:30+00',
   '{"empathyValidated": true, "validatedAt": "2026-10-03T08:30:00Z"}'),
  ('00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000d1', 3, 'GATE_PENDING', '2026-10-03 08:30+00', NULL,
   '{"needsConfirmed": true, "confirmedAt": "2026-10-03T09:30:00Z", "needsShared": true, "sharedAt": "2026-10-04T09:30:00Z"}');
INSERT INTO "StrategyProposal" (id, "sessionId", "createdByUserId", description, "needsAddressed", kind, status, "createdAt", "updatedAt") VALUES
  ('00000000-0000-7e00-8000-0000000006f1', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000000c1',
   'Saturday mornings off for Dev, thanks out loud for Cara, weekend plans', '{appreciation}', 'SHARED_PROPOSAL', 'ACTIVE', '2026-10-04 10:00+00', '2026-10-04 10:00+00');
INSERT INTO "StrategyProposalNeed" ("proposalId", "needId", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000006f1', '00000000-0000-7e00-8000-0000000006e2', '2026-10-04 10:00+00');
-- Coverage and closure written by the OLD rule (stage4-coverage.service.ts
-- classifyCoverage over every confirmed need; stage4.ts ~1338 openNeedIds =
-- coverage rows OPEN or PARTIAL). P6 stays ACTIVE: the closure is
-- NO_SHARED_AGREEMENT / USER_STOPPED, so nothing is converted to an agreement.
--   6e1 Appreciation: needsAddressed label → COVERED
--   6e2 Downtime: StrategyProposalNeed → COVERED
--   6e3 Quiet evenings (revoked share): no match → OPEN, so it is in the old
--       openNeedIds; the view never names a revoked share (expected
--       difference, listed)
--   6e4 Weekend play time: "weekend" is 1 of 3 words → score 0.33 → PARTIAL,
--       so it is in the old openNeedIds; no proposal_need → open in the view too
INSERT INTO "Stage4NeedCoverage" (id, "sessionId", "needId", "needLabel", "sourceUserId", "coverageStatus", "coveringProposalIds", note, "updatedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000006a1', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000006e1', 'Appreciation',
   '00000000-0000-7e00-8000-0000000000c1', 'COVERED', '{00000000-0000-7e00-8000-0000000006f1}', 'Covered by at least one active proposal.', '2026-10-05 10:00+00', '2026-10-05 10:00+00'),
  ('00000000-0000-7e00-8000-0000000006a2', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000006e2', 'Downtime',
   '00000000-0000-7e00-8000-0000000000d1', 'COVERED', '{00000000-0000-7e00-8000-0000000006f1}', 'Covered by at least one active proposal.', '2026-10-05 10:00+00', '2026-10-05 10:00+00'),
  ('00000000-0000-7e00-8000-0000000006a3', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000006e3', 'Quiet evenings',
   '00000000-0000-7e00-8000-0000000000d1', 'OPEN', '{}', 'Not yet addressed by a proposal.', '2026-10-05 10:00+00', '2026-10-05 10:00+00'),
  ('00000000-0000-7e00-8000-0000000006a4', '00000000-0000-7e00-8000-0000000005e6', '00000000-0000-7e00-8000-0000000006e4', 'Weekend play time',
   '00000000-0000-7e00-8000-0000000000c1', 'PARTIAL', '{00000000-0000-7e00-8000-0000000006f1}', 'Partly addressed; may need more detail or adjustment.', '2026-10-05 10:00+00', '2026-10-05 10:00+00');
INSERT INTO "Stage4Closure" (id, "sessionId", kind, reason, summary, "sharedAgreementIds", "individualProposalIds", "openNeedIds", "closedByUserId", "closedAt", "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000c105f', '00000000-0000-7e00-8000-0000000005e6', 'NO_SHARED_AGREEMENT', 'USER_STOPPED', 'We stopped here for now',
   '{}', '{}', '{00000000-0000-7e00-8000-0000000006e3,00000000-0000-7e00-8000-0000000006e4}', '00000000-0000-7e00-8000-0000000000c1',
   '2026-10-06 09:00+00', '2026-10-06 09:00+00');
INSERT INTO "BrainActivity" (id, "sessionId", "innerWorkSessionId", "turnId", "activityType", model, input, output, "callType", cost, status, "createdAt") VALUES
  ('00000000-0000-7e00-8000-0000000eba03', '00000000-0000-7e00-8000-0000000005e6', NULL, 't3', 'LLM_CALL', 'sonnet', '{"prompt": "s"}', NULL,
   'ORCHESTRATED_RESPONSE', 0, 'COMPLETED', '2026-10-02 09:00+00');
