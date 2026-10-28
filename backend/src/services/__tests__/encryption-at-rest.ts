/**
 * TS-13 support for the encryption-at-rest suites (`encryption-at-rest-*.target.test.ts`):
 * with FIELD_ENCRYPTION_KEY set, every encrypted column (SENSITIVE_FIELD_MAP)
 * written through its real writer is ciphertext at rest, and the app reads the
 * plaintext back.
 *
 * Import this module FIRST in a suite: it sets the key before lib/prisma or
 * utils/field-encryption are loaded.
 */

import crypto from 'crypto';

export const TEST_KEY = crypto.randomBytes(32).toString('base64');
process.env.FIELD_ENCRYPTION_KEY = TEST_KEY;

import { ENVELOPE_KEY, SENSITIVE_FIELD_MAP, type EncryptedKind } from '../../lib/prisma-encryption-middleware';
import { isEncrypted } from '../../utils/field-encryption';
import type { TargetRun } from './target-roles';

/** Every `table.column` of the map, with its kind. */
export const ENCRYPTED_COLUMNS: Array<{ table: string; column: string; kind: EncryptedKind }> = Object.values(
  SENSITIVE_FIELD_MAP,
).flatMap(c => Object.values(c.fields).map(f => ({ table: c.table, column: f.column, kind: f.kind })));

function kindOf(table: string, column: string): EncryptedKind {
  const hit = ENCRYPTED_COLUMNS.find(c => c.table === table && c.column === column);
  if (!hit) throw new Error(`${table}.${column} is not in SENSITIVE_FIELD_MAP`);
  return hit.kind;
}

function stringLeaves(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach(x => stringLeaves(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach(x => stringLeaves(x, out));
  return out;
}

/** Why a stored value is not ciphertext of its kind, or null when it is. */
export function notSealed(kind: EncryptedKind, value: unknown): string | null {
  switch (kind) {
    case 'text':
      return typeof value === 'string' && isEncrypted(value) ? null : `not enc:v1 text: ${JSON.stringify(value)}`;
    case 'text[]':
      return Array.isArray(value) && value.length > 0 && value.every(v => typeof v === 'string' && isEncrypted(v))
        ? null
        : `not an array of enc:v1 elements: ${JSON.stringify(value)}`;
    case 'jsonb-envelope': {
      const o = value as Record<string, unknown> | null;
      return o &&
        typeof o === 'object' &&
        !Array.isArray(o) &&
        Object.keys(o).length === 1 &&
        typeof o[ENVELOPE_KEY] === 'string' &&
        isEncrypted(o[ENVELOPE_KEY] as string)
        ? null
        : `not a {"${ENVELOPE_KEY}": enc:v1} envelope: ${JSON.stringify(value)}`;
    }
    case 'jsonb-leaves': {
      const leaves = stringLeaves(value);
      return leaves.length > 0 && leaves.every(isEncrypted)
        ? null
        : `a plaintext string leaf: ${JSON.stringify(leaves.filter(l => !isEncrypted(l)))}`;
    }
  }
}

/**
 * The stored values of `table.column` in the rows `where` selects (superuser
 * SQL), each checked to be ciphertext of the column's kind. Returns the raw
 * values so a test can also show they hold no plaintext probe.
 */
export async function expectSealed(
  run: TargetRun,
  table: string,
  column: string,
  where: string,
  params: unknown[] = [],
): Promise<unknown[]> {
  const kind = kindOf(table, column);
  const rows = await run.sql<{ v: unknown }>(`SELECT ${column} AS v FROM ${table} WHERE ${where}`, params);
  expect({ table, column, rows: rows.length }).toEqual({ table, column, rows: expect.any(Number) });
  if (rows.length === 0) throw new Error(`${table}.${column}: no row matched ${where}`);
  const problems = rows.map(r => notSealed(kind, r.v)).filter(Boolean);
  expect({ column: `${table}.${column}`, problems }).toEqual({ column: `${table}.${column}`, problems: [] });
  return rows.map(r => r.v);
}

/** The columns a suite proved; each suite asserts its list, and the union is checked to be the whole map. */
export const COVERAGE: Record<string, string[]> = {
  user: [
    'ai_memory.doc',
    'reflection.title',
    'reflection.summary',
    'reflection.summary_doc',
    'reflection.context_snapshot',
    'reflection_message.content',
    'takeaway.content',
    'user_memory.content',
    'user_memory.suggested_text',
    'feature_state.doc',
  ],
  empathy: [
    'session.topic_frame',
    'message.content',
    'draft.content',
    'mood_reading.context',
    'invitation.name',
    'empathy_attempt.content',
    'empathy_review.feedback',
    'reconciler_result.alignment_summary',
    'reconciler_result.gap_summary',
    'reconciler_result.correctly_identified',
    'reconciler_result.missed_feelings',
    'reconciler_result.misattributions',
    'context_share_offer.offer_message',
    'context_share_offer.suggested_content',
    'context_share_offer.suggested_reason',
    'context_share_offer.shared_content',
    // R46
    'invitation.decline_reason',
    'reconciler_result.most_important_gap',
    'reconciler_result.rationale',
    'reconciler_result.suggested_share_focus',
    'reconciler_result.suggested_share_content',
    'reconciler_result.suggested_share_reason',
    'reconciler_guidance.area_hint',
    'reconciler_guidance.prompt_seed',
  ],
  repair: [
    'need.label',
    'need.evidence',
    'need_share.shared_text',
    'need_disposition.note',
    'proposal.description',
    'proposal_choice.note',
    'agreement.description',
    'session_closure.summary',
    'follow_up.summary',
    'follow_up_checkin.reflection_summary',
    'follow_up_checkin.payload',
    'follow_up_note.content',
    // R46
    'proposal.duration',
    'proposal.measure_of_success',
    'proposal.removal_reason',
    'proposal.unresolved_need_labels',
    'proposal_revision.before',
    'proposal_revision.after',
    'agreement.duration',
    'agreement.measure_of_success',
    'reminder.note',
  ],
};
