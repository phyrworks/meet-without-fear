/**
 * Field-level encryption for the target schema (TS-13; spec
 * docs/backend/data-model/schema-target-2026-10.md, Conventions "Encryption keys").
 *
 * `SENSITIVE_FIELD_MAP` is the ONE list of encrypted columns. Two paths read it:
 *
 *   - the Prisma extension (`withEncryption`): it encrypts on write and decrypts
 *     on read for every model operation, including nested writes
 *     (`create`/`createMany`/`connectOrCreate`/`upsert`/`update`/`updateMany`
 *     under a relation) and nested results (`include`/`select` of a relation).
 *     The relations come from the client's own runtime data model.
 *   - the raw-SQL helper (`encryptColumnValue` / `decryptColumnValue` /
 *     `decryptRawRows`), by `table.column`, for `$executeRaw`/`$queryRaw`
 *     writers and readers. The extension never sees raw SQL, so every raw
 *     INSERT/UPDATE of an encrypted column passes its value through
 *     `encryptColumnValue`, and every raw SELECT of one through
 *     `decryptRawRows`/`decryptColumnValue`.
 *
 * Encryption is the single `FIELD_ENCRYPTION_KEY` (AES-256-GCM, `enc:v1:`;
 * utils/field-encryption.ts). With no key set every value passes through
 * unchanged (graceful degradation for dev/test), except `content_hash`, which is
 * written either way.
 *
 * ## Key class per column (writer-principal rule; the W13 prerequisite, ruling R41)
 *
 * Each entry carries the key class the rule assigns. Today every class resolves
 * to the one key; W13 (Phase 3: per-user/session/participant DEKs, `enc:v2:<keyId>`)
 * changes `sealText`/`openText` below to look up the key of `field.key` (a
 * `per-row` class by its `rule`), and the share-moment hook in
 * `lib/share-moments.ts` to re-encrypt. Nothing else needs to change.
 *
 * | table.column                                  | kind           | key class   |
 * |-----------------------------------------------|----------------|-------------|
 * | session.topic_frame                           | text           | session     |
 * | message.content (+ content_hash)              | text           | per-row: own USER/CHAT turns and AI/SYSTEM replies to the owner → participant; every delivered kind (EMPATHY_STATEMENT in the subject's conversation, SHARED_CONTEXT, VALIDATION_FEEDBACK, SHARE_SUGGESTION, EMPATHY_REVEAL_INTRO, EMPATHY_VALIDATION_PROMPT) → session |
 * | draft.content                                 | text           | participant |
 * | ai_memory.doc                                 | jsonb (leaves) | per-row: participant_id set → participant; user_id set (GLOBAL_FACTS) → user |
 * | mood_reading.context                          | text           | participant |
 * | invitation.name                               | text           | session     |
 * | empathy_attempt.content                       | text           | per-row: participant (author) until revealed; re-encrypted under session by the reveal job |
 * | empathy_review.feedback                       | text           | session     |
 * | reconciler_result.alignment_summary, gap_summary | text        | participant (subject) |
 * | reconciler_result.correctly_identified, missed_feelings, misattributions | text[] | participant (subject) |
 * | context_share_offer.offer_message, suggested_content, suggested_reason | text | participant (subject) |
 * | context_share_offer.shared_content            | text           | session     |
 * | need.label                                    | text           | participant |
 * | need.evidence                                 | text[]         | participant |
 * | need_share.shared_text                        | text           | session     |
 * | need_disposition.note                         | text           | participant |
 * | proposal.description                          | text           | session     |
 * | proposal_choice.note                          | text           | session     |
 * | agreement.description                         | text           | session     |
 * | session_closure.summary                       | text           | session     |
 * | follow_up.summary                             | text           | session     |
 * | follow_up_checkin.reflection_summary          | text           | session     |
 * | follow_up_checkin.payload                     | jsonb (envelope) | session   |
 * | follow_up_note.content                        | text           | participant |
 * | reflection.title, summary, context_snapshot   | text           | user        |
 * | reflection.summary_doc                        | jsonb (envelope) | user      |
 * | reflection_message.content                    | text           | user        |
 * | takeaway.content                              | text           | user        |
 * | user_memory.content                           | text           | user        |
 * | feature_state.doc                             | jsonb (envelope) | user      |
 *
 * ## Value shapes (rulings R43, R44)
 *
 *   - `text`: the column holds `enc:v1:…`.
 *   - `text[]`: each element is encrypted; the column stays `text[]`.
 *   - `jsonb-envelope`: the whole document becomes `{"$enc":"enc:v1:…"}` — fully
 *     opaque and still an object, so `CHECK (jsonb_typeof(col) = 'object')` holds.
 *   - `jsonb-leaves` (ai_memory.doc only): every string leaf is encrypted; keys,
 *     numbers, booleans, nulls and array shape stay. Its CHECK requires the
 *     SUMMARY keys `text, messageCount, generatedAt` and a `facts` array, so an
 *     envelope would be refused. BY DESIGN this leaks the document's key set,
 *     counts, numeric values and array lengths (generatedAt is a string leaf and
 *     is encrypted); W13 may revisit it together with that CHECK.
 *
 * ## Columns that must never be filtered by SQL
 *
 * A random-IV cipher cannot be matched by WHERE/ON CONFLICT/unique keys. No
 * unique key or ON CONFLICT target on the target schema includes an encrypted
 * column. Equality probes use `message.content_hash` (written here, SHA-256 of
 * the plaintext); `user_memory.content`'s duplicate probe compares plaintext in
 * the app (ruling R45, controllers/memories.ts); the ops dashboard's
 * `reflection.title` search arm is skipped when a key is set (routes/brain.ts).
 *
 * A value that cannot be decrypted raises FieldDecryptionError, which
 * propagates to the caller. It is never converted into empty content.
 */

import type { PrismaClient } from '../generated/prisma/client';
import { encrypt, decrypt, isEncrypted, FieldDecryptionError } from '../utils/field-encryption';
import { contentHash } from '../utils/content-hash';

/** The key a column's values are written under (spec Conventions "Encryption keys"). */
export type KeyClass = 'participant' | 'session' | 'user' | 'per-row';

/** How a column's value is encrypted. See the header ("Value shapes"). */
export type EncryptedKind = 'text' | 'text[]' | 'jsonb-envelope' | 'jsonb-leaves';

export interface EncryptedField {
  /** The database column (snake_case), the raw-SQL helper's key. */
  column: string;
  kind: EncryptedKind;
  key: KeyClass;
  /** For `per-row`: the rule that decides the key of a row. */
  rule?: string;
}

export interface SensitiveFieldConfig {
  /** The database table, the raw-SQL helper's key. */
  table: string;
  /** Prisma field name → its encrypted column. */
  fields: Record<string, EncryptedField>;
  /**
   * Deterministic digests written alongside the ciphertext, so equality/dedupe
   * probes have something to match on. `from` is a plaintext string field,
   * `to` is the field that receives its SHA-256. See utils/content-hash.ts.
   */
  hashedFields?: Array<{ from: string; to: string }>;
}

const text = (column: string, key: KeyClass, rule?: string): EncryptedField => ({
  column,
  kind: 'text',
  key,
  ...(rule ? { rule } : {}),
});
const textArray = (column: string, key: KeyClass): EncryptedField => ({ column, kind: 'text[]', key });

const MESSAGE_KEY_RULE =
  "role = 'USER' AND kind = 'CHAT' (the owner's turn) or role IN ('AI','SYSTEM') replying to the owner → participant; " +
  'every delivered kind (written by mwf_job) → session';
const AI_MEMORY_KEY_RULE = 'participant_id IS NOT NULL → participant; user_id IS NOT NULL (GLOBAL_FACTS) → user';
const EMPATHY_ATTEMPT_KEY_RULE =
  "revealed_at IS NULL → participant (author); re-encrypted under session at the reveal (lib/share-moments.ts 'empathy-reveal')";

/**
 * Prisma model name → its encrypted columns, for every column the target spec
 * (§1) marks "encrypted". The table in the header comment is this map.
 */
export const SENSITIVE_FIELD_MAP: Record<string, SensitiveFieldConfig> = {
  Session: { table: 'session', fields: { topicFrame: text('topic_frame', 'session') } },
  Message: {
    table: 'message',
    fields: { content: text('content', 'per-row', MESSAGE_KEY_RULE) },
    hashedFields: [{ from: 'content', to: 'contentHash' }],
  },
  Draft: { table: 'draft', fields: { content: text('content', 'participant') } },
  AiMemory: {
    table: 'ai_memory',
    fields: { doc: { column: 'doc', kind: 'jsonb-leaves', key: 'per-row', rule: AI_MEMORY_KEY_RULE } },
  },
  MoodReading: { table: 'mood_reading', fields: { context: text('context', 'participant') } },
  Invitation: { table: 'invitation', fields: { name: text('name', 'session') } },
  EmpathyAttempt: {
    table: 'empathy_attempt',
    fields: { content: text('content', 'per-row', EMPATHY_ATTEMPT_KEY_RULE) },
  },
  EmpathyReview: { table: 'empathy_review', fields: { feedback: text('feedback', 'session') } },
  ReconcilerResult: {
    table: 'reconciler_result',
    fields: {
      alignmentSummary: text('alignment_summary', 'participant'),
      gapSummary: text('gap_summary', 'participant'),
      correctlyIdentified: textArray('correctly_identified', 'participant'),
      missedFeelings: textArray('missed_feelings', 'participant'),
      misattributions: textArray('misattributions', 'participant'),
    },
  },
  ContextShareOffer: {
    table: 'context_share_offer',
    fields: {
      offerMessage: text('offer_message', 'participant'),
      suggestedContent: text('suggested_content', 'participant'),
      suggestedReason: text('suggested_reason', 'participant'),
      sharedContent: text('shared_content', 'session'),
    },
  },
  Need: {
    table: 'need',
    fields: { label: text('label', 'participant'), evidence: textArray('evidence', 'participant') },
  },
  NeedShare: { table: 'need_share', fields: { sharedText: text('shared_text', 'session') } },
  NeedDisposition: { table: 'need_disposition', fields: { note: text('note', 'participant') } },
  Proposal: { table: 'proposal', fields: { description: text('description', 'session') } },
  ProposalChoice: { table: 'proposal_choice', fields: { note: text('note', 'session') } },
  Agreement: { table: 'agreement', fields: { description: text('description', 'session') } },
  SessionClosure: { table: 'session_closure', fields: { summary: text('summary', 'session') } },
  FollowUp: { table: 'follow_up', fields: { summary: text('summary', 'session') } },
  FollowUpCheckin: {
    table: 'follow_up_checkin',
    fields: {
      reflectionSummary: text('reflection_summary', 'session'),
      payload: { column: 'payload', kind: 'jsonb-envelope', key: 'session' },
    },
  },
  FollowUpNote: { table: 'follow_up_note', fields: { content: text('content', 'participant') } },
  Reflection: {
    table: 'reflection',
    fields: {
      title: text('title', 'user'),
      summary: text('summary', 'user'),
      summaryDoc: { column: 'summary_doc', kind: 'jsonb-envelope', key: 'user' },
      contextSnapshot: text('context_snapshot', 'user'),
    },
  },
  ReflectionMessage: { table: 'reflection_message', fields: { content: text('content', 'user') } },
  Takeaway: { table: 'takeaway', fields: { content: text('content', 'user') } },
  UserMemory: { table: 'user_memory', fields: { content: text('content', 'user') } },
  FeatureState: { table: 'feature_state', fields: { doc: { column: 'doc', kind: 'jsonb-envelope', key: 'user' } } },
};

// ============================================================================
// Values
// ============================================================================

/** The key of an envelope document (`jsonb-envelope`). */
export const ENVELOPE_KEY = '$enc';

/**
 * Encrypt one string under `field`'s key. The single place W13 resolves a key
 * per class. A value already in the encrypted format is left alone, so a raw
 * path that copies ciphertext (or re-saves a row it read raw) never
 * double-encrypts.
 */
function sealText(plaintext: string, _field: EncryptedField): string {
  return isEncrypted(plaintext) ? plaintext : encrypt(plaintext);
}

/** Decrypt one string (plaintext passes through — rows written keyless). The W13 read-side key lookup. */
function openText(value: string, _field: EncryptedField): string {
  return decrypt(value);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Is this a JSON document value (not a Prisma null sentinel, a Date, …)? */
function isJsonDocument(v: unknown): v is Record<string, unknown> | unknown[] {
  return Array.isArray(v) || isPlainObject(v);
}

function isEnvelope(v: unknown): v is { [ENVELOPE_KEY]: string } {
  return (
    isPlainObject(v) &&
    Object.keys(v).length === 1 &&
    typeof v[ENVELOPE_KEY] === 'string' &&
    isEncrypted(v[ENVELOPE_KEY] as string)
  );
}

function mapLeaves(v: unknown, f: (s: string) => string): unknown {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map(x => mapLeaves(x, f));
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = mapLeaves(x, f);
    return out;
  }
  return v;
}

/** Encrypt a value of `field` (the plain JS value of the column). Anything not of the column's shape is returned as is. */
export function sealFieldValue(field: EncryptedField, value: unknown): unknown {
  switch (field.kind) {
    case 'text':
      return typeof value === 'string' ? sealText(value, field) : value;
    case 'text[]':
      return Array.isArray(value) ? value.map(v => (typeof v === 'string' ? sealText(v, field) : v)) : value;
    case 'jsonb-envelope': {
      if (!isJsonDocument(value) || isEnvelope(value)) return value;
      const json = JSON.stringify(value);
      const sealed = sealText(json, field);
      // No key configured: encrypt() returned the plaintext — store the document as it is.
      return sealed === json ? value : { [ENVELOPE_KEY]: sealed };
    }
    case 'jsonb-leaves':
      return isJsonDocument(value) ? mapLeaves(value, s => sealText(s, field)) : value;
  }
}

/** Decrypt a value of `field`. Plaintext (rows written keyless) passes through. */
export function openFieldValue(field: EncryptedField, value: unknown): unknown {
  switch (field.kind) {
    case 'text':
      return typeof value === 'string' ? openText(value, field) : value;
    case 'text[]':
      return Array.isArray(value) ? value.map(v => (typeof v === 'string' ? openText(v, field) : v)) : value;
    case 'jsonb-envelope': {
      if (!isEnvelope(value)) return value;
      // decrypt() throws FieldDecryptionError on an undecryptable value; that
      // propagates deliberately — see utils/field-encryption.ts.
      const json = openText(value[ENVELOPE_KEY], field);
      try {
        return JSON.parse(json);
      } catch (err) {
        throw new FieldDecryptionError('[FieldEncryption] An envelope decrypted to something that is not JSON', err);
      }
    }
    case 'jsonb-leaves':
      return mapLeaves(value, s => openText(s, field));
  }
}

// ============================================================================
// Raw-SQL helper (the extension never sees $queryRaw / $executeRaw)
// ============================================================================

const BY_COLUMN = new Map<string, EncryptedField>();
for (const config of Object.values(SENSITIVE_FIELD_MAP)) {
  for (const field of Object.values(config.fields)) BY_COLUMN.set(`${config.table}.${field.column}`, field);
}

function columnField(table: string, column: string): EncryptedField {
  const field = BY_COLUMN.get(`${table}.${column}`);
  if (!field) throw new Error(`[FieldEncryption] ${table}.${column} is not an encrypted column (SENSITIVE_FIELD_MAP)`);
  return field;
}

/** Is `table.column` an encrypted column? */
export function isEncryptedColumn(table: string, column: string): boolean {
  return BY_COLUMN.has(`${table}.${column}`);
}

/**
 * The value a raw writer binds for `table.column` (a jsonb column: the JS value
 * to `JSON.stringify(…)::jsonb`). Throws for a column that is not encrypted, so
 * a typo cannot silently write plaintext.
 */
export function encryptColumnValue<T>(table: string, column: string, value: T): T {
  return sealFieldValue(columnField(table, column), value) as T;
}

/** Decrypt one value a raw reader got back for `table.column`. */
export function decryptColumnValue<T>(table: string, column: string, value: T): T {
  return openFieldValue(columnField(table, column), value) as T;
}

/**
 * Decrypt the encrypted columns of raw rows in place. `columns` maps each row
 * key (the SELECT's column name or alias) to the `table.column` it holds.
 */
export function decryptRawRows<T extends object>(rows: T[], columns: Record<string, string>): T[] {
  const fields = Object.entries(columns).map(([key, ref]) => {
    const dot = ref.indexOf('.');
    return [key, columnField(ref.slice(0, dot), ref.slice(dot + 1))] as const;
  });
  for (const row of rows) {
    const r = row as Record<string, unknown>;
    for (const [key, field] of fields) if (key in r) r[key] = openFieldValue(field, r[key]);
  }
  return rows;
}

// ============================================================================
// Prisma model operations
// ============================================================================

/** The relations of each model: model → relation field → related model. From the client's runtime data model. */
export type RelationIndex = Record<string, Record<string, string>>;

interface RuntimeDataModelLike {
  models: Record<string, { fields: ReadonlyArray<{ name: string; kind: string; type: string }> }>;
}

export function relationIndexOf(dataModel: RuntimeDataModelLike): RelationIndex {
  const index: RelationIndex = {};
  for (const [model, { fields }] of Object.entries(dataModel.models)) {
    index[model] = {};
    for (const f of fields) if (f.kind === 'object') index[model][f.name] = f.type;
  }
  return index;
}

/** Unwrap Prisma's `{ set: v }` update form. */
function sealUpdateValue(field: EncryptedField, value: unknown): unknown {
  if (isPlainObject(value) && field.kind !== 'jsonb-envelope' && field.kind !== 'jsonb-leaves') {
    const out = { ...value };
    if ('set' in out) out.set = sealFieldValue(field, out.set);
    if ('push' in out) {
      out.push = Array.isArray(out.push)
        ? sealFieldValue(field, out.push)
        : sealFieldValue({ ...field, kind: 'text' }, out.push);
    }
    return out;
  }
  return sealFieldValue(field, value);
}

/** Encrypt a single data object's sensitive fields in place (and, with `relations`, its nested writes). */
export function encryptDataFields(
  data: Record<string, unknown>,
  config: SensitiveFieldConfig | undefined,
  model?: string,
  relations?: RelationIndex,
): void {
  if (config) {
    // Hash BEFORE encrypting — the digest must cover the plaintext. Written on
    // every write that supplies the source field, including when no encryption
    // key is configured, so probes behave identically in both modes.
    for (const { from, to } of config.hashedFields ?? []) {
      const v = data[from];
      const plain = typeof v === 'string' ? v : isPlainObject(v) && typeof v.set === 'string' ? v.set : undefined;
      if (plain !== undefined) data[to] = contentHash(plain);
    }
    for (const [name, field] of Object.entries(config.fields)) {
      if (name in data && data[name] != null) data[name] = sealUpdateValue(field, data[name]);
    }
  }
  if (!model || !relations) return;
  for (const [name, target] of Object.entries(relations[model] ?? {})) {
    const nested = data[name];
    if (isPlainObject(nested)) sealNestedWrite(nested, target, relations);
  }
}

const each = (v: unknown, f: (o: Record<string, unknown>) => void): void => {
  for (const x of Array.isArray(v) ? v : [v]) if (isPlainObject(x)) f(x);
};

/** A relation field's nested write (`{ create, createMany, connectOrCreate, upsert, update, updateMany }`). */
function sealNestedWrite(op: Record<string, unknown>, model: string, relations: RelationIndex): void {
  const config = SENSITIVE_FIELD_MAP[model];
  const seal = (d: unknown) => {
    if (isPlainObject(d)) encryptDataFields(d, config, model, relations);
  };
  each(op.create, seal);
  if (isPlainObject(op.createMany)) each(op.createMany.data, seal);
  each(op.connectOrCreate, o => seal(o.create));
  each(op.upsert, o => {
    seal(o.create);
    seal(o.update);
  });
  // to-many `update: { where, data }`; to-one `update: { data }` or the data itself
  each(op.update, o => seal('data' in o && isPlainObject(o.data) ? o.data : o));
  each(op.updateMany, o => seal(o.data));
}

/** Decrypt a single record's sensitive fields in place (and, with `relations`, its included relations). */
export function decryptRecordFields(
  record: Record<string, unknown>,
  config: SensitiveFieldConfig | undefined,
  model?: string,
  relations?: RelationIndex,
): void {
  if (config) {
    for (const [name, field] of Object.entries(config.fields)) {
      if (name in record && record[name] != null) record[name] = openFieldValue(field, record[name]);
    }
  }
  if (!model || !relations) return;
  for (const [name, target] of Object.entries(relations[model] ?? {})) {
    if (record[name] != null) decryptResult(record[name], target, relations);
  }
}

const WRITE_OPERATIONS = new Set([
  'create',
  'update',
  'upsert',
  'createMany',
  'createManyAndReturn',
  'updateMany',
  'updateManyAndReturn',
]);

const RESULT_BEARING_OPERATIONS = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'findMany',
  'create',
  'update',
  'upsert',
  'delete',
  'createManyAndReturn',
  'updateManyAndReturn',
]);

function encryptWriteArgs(
  operation: string,
  args: Record<string, unknown>,
  model: string,
  relations?: RelationIndex,
): void {
  const config = SENSITIVE_FIELD_MAP[model];
  const seal = (d: unknown) => {
    if (isPlainObject(d)) encryptDataFields(d, config, model, relations);
  };
  if (operation === 'upsert') {
    seal(args.create);
    seal(args.update);
  } else if (operation === 'createMany' || operation === 'createManyAndReturn') {
    each(args.data, seal);
  } else {
    seal(args.data);
  }
}

function decryptResult(result: unknown, model: string, relations?: RelationIndex): void {
  const config = SENSITIVE_FIELD_MAP[model];
  each(result, r => decryptRecordFields(r, config, model, relations));
}

/**
 * The body of the `$allOperations` interceptor, extracted so it can be exercised
 * directly in unit tests without a live PrismaClient. `relations` (the client's
 * data model) enables nested writes and included relations.
 *
 * Decryption failures (FieldDecryptionError) propagate to the caller: an
 * undecryptable row is missing data, not empty data.
 */
export async function applyFieldEncryption({
  model,
  operation,
  args,
  query,
  relations,
}: {
  model: string;
  operation: string;
  args: Record<string, unknown>;
  query: (args: Record<string, unknown>) => Promise<unknown>;
  relations?: RelationIndex;
}): Promise<unknown> {
  const name = model ?? '';
  // Without the data model, only mapped models can need anything.
  if (!relations && !SENSITIVE_FIELD_MAP[name]) return query(args);

  if (WRITE_OPERATIONS.has(operation) && args) encryptWriteArgs(operation, args, name, relations);

  const result = await query(args);

  // Decrypt on read (including results returned from write operations)
  if (RESULT_BEARING_OPERATIONS.has(operation) && result != null) decryptResult(result, name, relations);

  return result;
}

/**
 * Apply field-level encryption to a PrismaClient via $extends.
 * Returns a new extended client with transparent encrypt-on-write / decrypt-on-read.
 */
export function withEncryption(prisma: PrismaClient) {
  const dataModel = (prisma as unknown as { _runtimeDataModel?: RuntimeDataModelLike })._runtimeDataModel;
  if (!dataModel?.models) {
    // Fail closed: without the relations a nested write would store plaintext.
    throw new Error(
      '[FieldEncryption] the Prisma client exposes no runtime data model; nested writes cannot be encrypted',
    );
  }
  const relations = relationIndexOf(dataModel);
  return prisma.$extends({
    name: 'field-level-encryption',
    query: {
      $allModels: {
        $allOperations: ({ model, operation, args, query }) =>
          applyFieldEncryption({
            model,
            operation,
            args: args as Record<string, unknown>,
            query: query as (a: Record<string, unknown>) => Promise<unknown>,
            relations,
          }),
      },
    },
  });
}
