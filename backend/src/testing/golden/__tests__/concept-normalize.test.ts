/**
 * Unit tests for the concept-view rename map (`buildConceptLabelMap`,
 * `conceptRowKey`).
 *
 * The rule carried over from the byte-level normaliser: an id becomes a label
 * derived from the row's natural key, never from order of appearance, and an
 * id-shaped token nobody labelled fails the run. The concept map adds the
 * target's new keys — participants, conversations, milestones — which have no
 * id at all in today's shape (the views derive one from the natural key), so
 * these tests pin that the label comes from the natural key and not the value.
 */

import { buildConceptLabelMap, conceptRowKey, normalize, ConceptLabelInput } from '../normalize';

const ADA = '0190f3a2-6c1e-7b4d-9a8e-00000000000a';
const BOB = '0190f3a2-6c1e-7b4d-9a8e-00000000000b';
const SESSION = '0190f3a2-6c1e-7b4d-9a8e-000000000051';
const P_ADA = '11111111-1111-1111-1111-11111111aaaa';
const P_BOB = '11111111-1111-1111-1111-11111111bbbb';
const C_ADA = '22222222-2222-2222-2222-22222222aaaa';
const C_BOB = '22222222-2222-2222-2222-22222222bbbb';

function msg(id: string, conversation: string, at: string, kind = 'CHAT', sender: string | null = null) {
  return { id, conversation_id: conversation, sender_participant_id: sender, kind, created_at: at };
}

function input(rows: ConceptLabelInput['rows'] = {}): ConceptLabelInput {
  return {
    manifest: {
      sessionId: SESSION,
      relationshipId: '0190f3a2-6c1e-7b4d-9a8e-0000000000e1',
      invitationId: '0190f3a2-6c1e-7b4d-9a8e-0000000000f1',
      users: [
        { id: ADA, email: 'ada@e2e.test' },
        { id: BOB, email: 'bob@e2e.test' },
      ],
    },
    seededClerkIds: [],
    rows: {
      participant: [
        { id: P_ADA, session_id: SESSION, user_id: ADA },
        { id: P_BOB, session_id: SESSION, user_id: BOB },
      ],
      conversation: [
        { id: C_ADA, participant_id: P_ADA, kind: 'MAIN' },
        { id: C_BOB, participant_id: P_BOB, kind: 'MAIN' },
      ],
      ...rows,
    },
  };
}

describe('concept labels — participants and conversations', () => {
  it('labels a participant from its (user, session) pair, not from its id', () => {
    const map = buildConceptLabelMap(input());
    expect(map.labels.get(P_ADA)).toBe('<participant:ada@main>');
    expect(map.labels.get(P_BOB)).toBe('<participant:bob@main>');
    expect(map.labels.get(C_ADA)).toBe('<conversation:ada@main/MAIN>');
  });

  it('leaves a participant of an unlabelled user unresolved, so the run fails', () => {
    // A participant the fixture does not know about is exactly what a routing
    // regression that invents an audience produces. It must not be quietly
    // given a name.
    const stranger = '0190f3a2-6c1e-7b4d-9a8e-00000000000c';
    const pX = '11111111-1111-1111-1111-11111111cccc';
    const i = input();
    i.rows.participant!.push({ id: pX, session_id: SESSION, user_id: stranger });
    const map = buildConceptLabelMap(i);
    expect(map.labels.has(pX)).toBe(false);
    const r = normalize({ author_participant_id: pX }, map);
    expect(r.unresolved).toEqual([pX]);
  });

  it('is independent of the order rows arrive in', () => {
    const a = buildConceptLabelMap(input({ message: [msg('m1', C_ADA, '2026-01-01 00:00:01'), msg('m2', C_ADA, '2026-01-01 00:00:02')] }));
    const b = buildConceptLabelMap(input({ message: [msg('m2', C_ADA, '2026-01-01 00:00:02'), msg('m1', C_ADA, '2026-01-01 00:00:01')] }));
    expect([...a.labels.entries()].sort()).toEqual([...b.labels.entries()].sort());
  });
});

describe('concept labels — messages', () => {
  it('ranks CHAT messages within their conversation by time, then id', () => {
    const map = buildConceptLabelMap(
      input({
        message: [
          msg('m3', C_ADA, '2026-01-01 00:00:03'),
          msg('m1', C_ADA, '2026-01-01 00:00:01'),
          msg('m2', C_BOB, '2026-01-01 00:00:02'),
          // Same instant as m3: id breaks the tie.
          msg('m0', C_ADA, '2026-01-01 00:00:03'),
        ],
      }),
    );
    expect(map.labels.get('m1')).toBe('<message:ada@main#1>');
    expect(map.labels.get('m0')).toBe('<message:ada@main#2>');
    expect(map.labels.get('m3')).toBe('<message:ada@main#3>');
    expect(map.labels.get('m2')).toBe('<message:bob@main#1>');
  });

  it('puts the audience in the label, so a message routed to the partner changes its label', () => {
    // The byte-level `<message:N>` is a global rank; a message moved from Ada's
    // inbox to Bob's kept its number whenever the rank happened not to move.
    const right = buildConceptLabelMap(input({ message: [msg('m1', C_ADA, '2026-01-01 00:00:01')] }));
    const wrong = buildConceptLabelMap(input({ message: [msg('m1', C_BOB, '2026-01-01 00:00:01')] }));
    expect(right.labels.get('m1')).not.toBe(wrong.labels.get('m1'));
  });

  it('ranks delivered kinds per (kind, sender), so an inserted copy renumbers nothing else', () => {
    // The target inserts a delivered EMPATHY_STATEMENT copy into the subject's
    // conversation (plan §3 step 9). It must not shift the subject's CHAT ranks
    // or their own statement's label.
    const before = buildConceptLabelMap(
      input({
        message: [
          msg('chat1', C_BOB, '2026-01-01 00:00:01'),
          msg('own', C_BOB, '2026-01-01 00:00:02', 'EMPATHY_STATEMENT', P_BOB),
          msg('chat2', C_BOB, '2026-01-01 00:00:04'),
        ],
      }),
    );
    const after = buildConceptLabelMap(
      input({
        message: [
          msg('chat1', C_BOB, '2026-01-01 00:00:01'),
          msg('own', C_BOB, '2026-01-01 00:00:02', 'EMPATHY_STATEMENT', P_BOB),
          msg('copy', C_BOB, '2026-01-01 00:00:03', 'EMPATHY_STATEMENT', P_ADA),
          msg('chat2', C_BOB, '2026-01-01 00:00:04'),
        ],
      }),
    );
    for (const id of ['chat1', 'own', 'chat2']) expect(after.labels.get(id)).toBe(before.labels.get(id));
    expect(after.labels.get('own')).toBe('<message:bob@main/EMPATHY_STATEMENT:bob#1>');
    expect(after.labels.get('copy')).toBe('<message:bob@main/EMPATHY_STATEMENT:ada#1>');
  });

  it('leaves a message with no conversation unresolved', () => {
    const map = buildConceptLabelMap(input({ message: [msg('orphan', null as unknown as string, '2026-01-01 00:00:01')] }));
    expect(map.labels.has('orphan')).toBe(false);
  });
});

describe('concept labels — content rows', () => {
  it('labels attempts by direction and round, and consents by what they consent to', () => {
    const attempt = '33333333-3333-3333-3333-33333333aaaa';
    const consent = '44444444-4444-4444-4444-44444444aaaa';
    const draft = '55555555-5555-5555-5555-55555555aaaa';
    const map = buildConceptLabelMap(
      input({
        empathy_attempt: [{ id: attempt, author_participant_id: P_ADA, subject_participant_id: P_BOB, round: 1 }],
        draft: [{ id: draft, participant_id: P_ADA, kind: 'EMPATHY' }],
        consent: [
          {
            id: consent,
            participant_id: P_ADA,
            target_kind: 'EMPATHY_ATTEMPT',
            empathy_attempt_id: attempt,
            created_at: '2026-01-01 00:00:01',
          },
        ],
      }),
    );
    expect(map.labels.get(attempt)).toBe('<empathyAttempt:ada→bob@main#1>');
    expect(map.labels.get(draft)).toBe('<draft:ada@main/EMPATHY>');
    expect(map.labels.get(consent)).toBe('<consent:ada@main/EMPATHY_ATTEMPT/empathyAttempt:ada→bob@main#1>');
  });

  it('labels the manifest ids and seeded clerkIds as the byte-level map does', () => {
    const i = input();
    i.seededClerkIds = [{ userId: BOB, clerkId: 'e2e_1787097373886_xa944v' }];
    const map = buildConceptLabelMap(i);
    expect(map.labels.get(ADA)).toBe('<user:ada>');
    expect(map.labels.get(SESSION)).toBe('<session:main>');
    expect(map.labels.get('e2e_1787097373886_xa944v')).toBe('<clerkId:bob>');
  });
});

describe('conceptRowKey — structural row keys', () => {
  it('renders an id-bearing row by its label', () => {
    expect(conceptRowKey('participant', { id: '<participant:ada@main>' })).toBe('<participant:ada@main>');
  });

  it('renders a milestone row as <milestone:who@session/key>', () => {
    expect(conceptRowKey('participant_milestone', { participant_id: '<participant:ada@main>', milestone_key: 'feel_heard' })).toBe(
      '<milestone:ada@main/feel_heard>',
    );
  });

  it('renders other junctions from their labelled parts', () => {
    expect(
      conceptRowKey('proposal_choice', { proposal_id: '<proposal:main#1>', participant_id: '<participant:bob@main>' }),
    ).toBe('<proposalChoice:proposal:main#1/participant:bob@main>');
  });
});
