/**
 * Analytics tracking helpers for Meet Without Fear mobile app
 *
 * MVP Events tracked:
 * - Session: Created, Person Selected, Invitation Sent, Compact Signed, Resolved
 * - Flow: Stage Started/Completed, Message Sent, Felt Heard, Common Ground
 * - Inner Thoughts: Created, Linked
 * - Errors: API/Critical errors
 */

import { track } from './mixpanel';

// ============================================================================
// Session Events
// ============================================================================

export function trackSessionCreated(sessionId: string, personId?: string): void {
  track('Session Created', {
    session_id: sessionId,
    person_id: personId,
  });
}

export function trackPersonSelected(personId: string | undefined, isNewPerson: boolean): void {
  // A new person invited by link has no user id until they accept: omit person_id rather than send ''.
  track('Person Selected', {
    ...(personId ? { person_id: personId } : {}),
    is_new_person: isNewPerson,
  });
}

export function trackInvitationSent(
  sessionId: string,
  shareMethod: 'copy' | 'share_sheet'
): void {
  track('Invitation Sent', {
    session_id: sessionId,
    share_method: shareMethod,
  });
}

export function trackInvitationAccepted(sessionId: string): void {
  track('Invitation Accepted', {
    session_id: sessionId,
  });
}

export function trackInvitationDeclined(invitationId: string): void {
  track('Invitation Declined', {
    invitation_id: invitationId,
  });
}

export function trackCompactSigned(sessionId: string, isInviter: boolean): void {
  track('Compact Signed', {
    session_id: sessionId,
    is_inviter: isInviter,
  });
}

export function trackSessionResolved(
  sessionId: string,
  resolutionType?: string
): void {
  track('Session Resolved', {
    session_id: sessionId,
    resolution_type: resolutionType,
  });
}

// ============================================================================
// Flow Events
// ============================================================================

export function trackStageStarted(
  sessionId: string,
  stageName: string,
  previousStage?: string
): void {
  track('Stage Started', {
    session_id: sessionId,
    stage_name: stageName,
    previous_stage: previousStage,
  });
}

export function trackStageCompleted(
  sessionId: string,
  stageName: string,
  durationSeconds: number
): void {
  track('Stage Completed', {
    session_id: sessionId,
    stage_name: stageName,
    duration_seconds: durationSeconds,
  });
}

export function trackMessageSent(sessionId: string, messageLength: number): void {
  track('Message Sent', {
    session_id: sessionId,
    message_length: messageLength,
  });
}

export function trackFeltHeardResponse(
  sessionId: string,
  response: 'yes' | 'no'
): void {
  track('Felt Heard Response', {
    session_id: sessionId,
    response,
  });
}

export function trackCommonGroundFound(
  sessionId: string,
  overlappingNeeds: number
): void {
  track('Common Ground Found', {
    session_id: sessionId,
    overlapping_needs: overlappingNeeds,
  });
}

export function trackEmpathyValidated(
  sessionId: string,
  accuracy: 'accurate' | 'partial' | 'inaccurate'
): void {
  track('Empathy Validated', {
    session_id: sessionId,
    accuracy,
  });
}

// ============================================================================
// Inner Thoughts Events
// ============================================================================

export function trackInnerThoughtsCreated(sessionId: string): void {
  track('Inner Thoughts Created', {
    session_id: sessionId,
  });
}

export function trackInnerThoughtsLinked(
  sessionId: string,
  partnerSessionId: string
): void {
  track('Inner Thoughts Linked', {
    session_id: sessionId,
    partner_session_id: partnerSessionId,
  });
}

// ============================================================================
// Share Topic Events (OFFER_OPTIONAL / OFFER_SHARING flow)
// ============================================================================

export function trackShareTopicShown(
  sessionId: string,
  action: 'OFFER_SHARING' | 'OFFER_OPTIONAL'
): void {
  track('Share Topic Shown', {
    session_id: sessionId,
    action,
  });
}

export function trackShareTopicAccepted(
  sessionId: string,
  action: 'OFFER_SHARING' | 'OFFER_OPTIONAL'
): void {
  track('Share Topic Accepted', {
    session_id: sessionId,
    action,
  });
}

export function trackShareTopicDeclined(
  sessionId: string,
  action: 'OFFER_SHARING' | 'OFFER_OPTIONAL'
): void {
  track('Share Topic Declined', {
    session_id: sessionId,
    action,
  });
}

export function trackShareTopicDismissed(
  sessionId: string,
  action: 'OFFER_SHARING' | 'OFFER_OPTIONAL'
): void {
  track('Share Topic Dismissed', {
    session_id: sessionId,
    action,
  });
}

export function trackShareDraftSent(
  sessionId: string,
  action: 'OFFER_SHARING' | 'OFFER_OPTIONAL',
  wasEdited: boolean
): void {
  track('Share Draft Sent', {
    session_id: sessionId,
    action,
    was_edited: wasEdited,
  });
}

// ============================================================================
// Inner Work Events
// ============================================================================

export function trackInnerWorkHubOpened(source: string): void {
  track('Inner Work Hub Opened', {
    source,
  });
}

export function trackMeditationStarted(durationSeconds: number): void {
  track('Meditation Started', {
    duration_seconds: durationSeconds,
  });
}

export function trackMeditationCompleted(durationSeconds: number): void {
  track('Meditation Completed', {
    duration_seconds: durationSeconds,
  });
}

export function trackGratitudeStarted(): void {
  track('Gratitude Started');
}

export function trackGratitudeCompleted(entryLength: number): void {
  track('Gratitude Completed', {
    entry_length: entryLength,
  });
}

export function trackNeedsAssessmentStarted(): void {
  track('Needs Assessment Started');
}

export function trackNeedsAssessmentCompleted(): void {
  track('Needs Assessment Completed');
}

export function trackStrategicRepairStarted(sessionId: string): void {
  track('Strategic Repair Started', {
    session_id: sessionId,
  });
}

export function trackStrategicRepairCompleted(sessionId: string): void {
  track('Strategic Repair Completed', {
    session_id: sessionId,
  });
}

// ============================================================================
// Error Events
// ============================================================================

export function trackError(
  errorType: 'api' | 'network' | 'auth' | 'session' | 'validation',
  errorCode: string,
  context?: string
): void {
  track('Error', {
    error_type: errorType,
    error_code: errorCode,
    context,
  });
}
