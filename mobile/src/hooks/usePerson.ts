/**
 * Person Hooks for Meet Without Fear Mobile
 *
 * React Query hooks for person/relationship-related API operations.
 */

import {
  useQuery,
  UseQueryOptions,
} from '@tanstack/react-query';
import { get, ApiClientError } from '../lib/api';
import { Stage, PersonSummaryDTO, ListPeopleResponse } from '@meet-without-fear/shared';

// ============================================================================
// Query Keys
// ============================================================================

export const personKeys = {
  all: ['people'] as const,
  lists: () => [...personKeys.all, 'list'] as const,
  details: () => [...personKeys.all, 'detail'] as const,
  detail: (id: string) => [...personKeys.details(), id] as const,
  sessions: (id: string) => [...personKeys.detail(id), 'sessions'] as const,
  pastSessions: (id: string) => [...personKeys.sessions(id), 'past'] as const,
};

// ============================================================================
// Types
// ============================================================================

export type SessionStatus = 'waiting_on_you' | 'your_turn' | 'waiting_on_partner' | 'both_active';

export interface ActiveSessionInfo {
  id: string;
  stage: Stage;
  status: SessionStatus;
  lastUpdate: string;
}

export interface PendingInvitationInfo {
  id: string;
  sessionId: string;
  sentAt: string;
  expiresAt: string;
}

export interface PersonDTO {
  id: string;
  name: string;
  initials: string;
  connectedSince: string;
  activeSession: ActiveSessionInfo | null;
  pendingInvitation: PendingInvitationInfo | null;
}

export interface PastSessionDTO {
  id: string;
  date: string;
  topic: string;
}

export interface GetPersonResponse {
  person: PersonDTO;
}

export interface GetPastSessionsResponse {
  sessions: PastSessionDTO[];
}

function isAfter(left?: string, right?: string) {
  if (!left) return false;
  if (!right) return true;
  return new Date(left).getTime() > new Date(right).getTime();
}

export function dedupePeople(people: PersonSummaryDTO[]) {
  const byId = new Map<string, PersonSummaryDTO>();

  for (const person of people) {
    const existing = byId.get(person.id);
    if (!existing) {
      byId.set(person.id, person);
      continue;
    }

    byId.set(person.id, {
      ...existing,
      ...person,
      lastSession: isAfter(person.lastSession?.updatedAt, existing.lastSession?.updatedAt)
        ? person.lastSession
        : existing.lastSession,
      activeSessionCount: Math.max(existing.activeSessionCount, person.activeSessionCount),
    });
  }

  return Array.from(byId.values());
}

// ============================================================================
// Get Person Hook
// ============================================================================

/**
 * Fetch person details by ID, including active session info.
 *
 * @param personId - The person ID to fetch
 * @param options - React Query options
 */
export function usePerson(
  personId: string | undefined,
  options?: Omit<
    UseQueryOptions<PersonDTO, ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: personKeys.detail(personId || ''),
    queryFn: async () => {
      if (!personId) throw new Error('Person ID is required');
      const response = await get<GetPersonResponse>(`/people/${personId}`);
      return response.person;
    },
    enabled: !!personId,
    staleTime: 30_000, // 30 seconds
    ...options,
  });
}

// ============================================================================
// Get Past Sessions Hook
// ============================================================================

/**
 * Fetch past (completed) sessions for a specific person.
 *
 * @param personId - The person ID to fetch sessions for
 * @param options - React Query options
 */
export function usePastSessions(
  personId: string | undefined,
  options?: Omit<
    UseQueryOptions<PastSessionDTO[], ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: personKeys.pastSessions(personId || ''),
    queryFn: async () => {
      if (!personId) throw new Error('Person ID is required');
      const response = await get<GetPastSessionsResponse>(
        `/people/${personId}/sessions?status=completed`
      );
      return response.sessions;
    },
    enabled: !!personId,
    staleTime: 60_000, // 1 minute
    ...options,
  });
}

// ============================================================================
// List People Hook
// ============================================================================

/**
 * Fetch all people the user shares a session with.
 *
 * @param options - React Query options
 */
export function usePeople(
  options?: Omit<
    UseQueryOptions<PersonSummaryDTO[], ApiClientError>,
    'queryKey' | 'queryFn'
  >
) {
  return useQuery({
    queryKey: personKeys.lists(),
    queryFn: async () => {
      const response = await get<ListPeopleResponse>('/people');
      return dedupePeople(response.people);
    },
    staleTime: 30_000, // 30 seconds
    ...options,
  });
}
