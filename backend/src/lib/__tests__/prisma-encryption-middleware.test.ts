/**
 * The field map and the encryption extension against the target schema (TS-13).
 * No database: the extension's body (`applyFieldEncryption`) runs over a fake
 * query, with the relations of the real generated client's data model. The
 * at-rest proof per column is services/__tests__/encryption-at-rest-*.target.test.ts.
 */

import crypto from 'crypto';
import { PrismaClient } from '../../generated/prisma/client';
import { createPrismaPgAdapter } from '../prisma-pg';
import {
  ENVELOPE_KEY,
  SENSITIVE_FIELD_MAP,
  applyFieldEncryption,
  decryptColumnValue,
  decryptRawRows,
  decryptRecordFields,
  encryptColumnValue,
  encryptDataFields,
  isEncryptedColumn,
  openFieldValue,
  relationIndexOf,
  sealFieldValue,
  withEncryption,
  type EncryptedField,
  type RelationIndex,
} from '../prisma-encryption-middleware';
import { encrypt, isEncrypted, FieldDecryptionError, _resetForTesting } from '../../utils/field-encryption';
import { contentHash } from '../../utils/content-hash';
import { COVERAGE } from '../../services/__tests__/encryption-at-rest';

const TEST_KEY = crypto.randomBytes(32).toString('base64');

beforeEach(() => {
  _resetForTesting();
  process.env.FIELD_ENCRYPTION_KEY = TEST_KEY;
});

afterEach(() => {
  _resetForTesting();
  delete process.env.FIELD_ENCRYPTION_KEY;
});

const noKey = () => {
  _resetForTesting();
  delete process.env.FIELD_ENCRYPTION_KEY;
};

interface RuntimeField {
  name: string;
  kind: string;
  type: string;
  dbName?: string | null;
}
const base = new PrismaClient({ adapter: createPrismaPgAdapter('postgresql://nobody@127.0.0.1:1/none') });
const dataModel = (base as unknown as {
  _runtimeDataModel: { models: Record<string, { dbName?: string | null; fields: RuntimeField[] }> };
})._runtimeDataModel;
const relations: RelationIndex = relationIndexOf(dataModel);

/**
 * Every column the target spec §1 (docs/backend/data-model/schema-target-2026-10.md)
 * marks "encrypted", with the key class its writer-principal rule assigns. The
 * test's oracle, read off the spec by hand; the map must equal it.
 */
const SPEC_ENCRYPTED: Record<string, string> = {
  'session.topic_frame': 'session',
  'message.content': 'per-row',
  'draft.content': 'participant',
  'ai_memory.doc': 'per-row',
  'mood_reading.context': 'participant',
  'invitation.name': 'session',
  'empathy_attempt.content': 'per-row',
  'empathy_review.feedback': 'session',
  'reconciler_result.alignment_summary': 'participant',
  'reconciler_result.gap_summary': 'participant',
  'reconciler_result.correctly_identified': 'participant',
  'reconciler_result.missed_feelings': 'participant',
  'reconciler_result.misattributions': 'participant',
  'context_share_offer.offer_message': 'participant',
  'context_share_offer.suggested_content': 'participant',
  'context_share_offer.suggested_reason': 'participant',
  'context_share_offer.shared_content': 'session',
  'need.label': 'participant',
  'need.evidence': 'participant',
  'need_share.shared_text': 'session',
  'need_disposition.note': 'participant',
  'proposal.description': 'session',
  'proposal_choice.note': 'session',
  'agreement.description': 'session',
  'session_closure.summary': 'session',
  'follow_up.summary': 'session',
  'follow_up_checkin.reflection_summary': 'session',
  'follow_up_checkin.payload': 'session',
  'follow_up_note.content': 'participant',
  'reflection.title': 'user',
  'reflection.summary': 'user',
  'reflection.summary_doc': 'user',
  'reflection.context_snapshot': 'user',
  'reflection_message.content': 'user',
  'takeaway.content': 'user',
  'user_memory.content': 'user',
  'feature_state.doc': 'user',
};

describe('SENSITIVE_FIELD_MAP — the target columns', () => {
  const entries = Object.entries(SENSITIVE_FIELD_MAP).flatMap(([model, c]) =>
    Object.entries(c.fields).map(([field, f]) => ({ model, table: c.table, field, f })),
  );

  it('is exactly the columns the spec marks encrypted, each with its key class', () => {
    const map = Object.fromEntries(entries.map(e => [`${e.table}.${e.f.column}`, e.f.key]));
    expect(map).toEqual(SPEC_ENCRYPTED);
  });

  it('names target Prisma models, fields and columns that exist in the generated client', () => {
    for (const { model, table, field, f } of entries) {
      const m = dataModel.models[model];
      expect({ model, exists: Boolean(m) }).toEqual({ model, exists: true });
      expect({ model, table: m.dbName ?? model }).toEqual({ model, table });
      const rf = m.fields.find(x => x.name === field);
      expect({ field: `${model}.${field}`, scalar: rf?.kind }).toEqual({ field: `${model}.${field}`, scalar: 'scalar' });
      expect({ field: `${model}.${field}`, column: rf?.dbName ?? field }).toEqual({
        field: `${model}.${field}`,
        column: f.column,
      });
      const wantType = f.kind === 'jsonb-envelope' || f.kind === 'jsonb-leaves' ? 'Json' : 'String';
      expect({ field: `${model}.${field}`, type: rf?.type }).toEqual({ field: `${model}.${field}`, type: wantType });
    }
    // none of the pre-rebuild models survives
    for (const old of ['InnerWorkMessage', 'UserVessel', 'Boundary', 'UserDocument', 'EmpathyDraft', 'GratitudeEntry']) {
      expect(SENSITIVE_FIELD_MAP[old]).toBeUndefined();
    }
    expect(SENSITIVE_FIELD_MAP.User).toBeUndefined();
  });

  it('every per-row key class states its rule; message.content keeps its content_hash', () => {
    for (const { f } of entries) if (f.key === 'per-row') expect(f.rule).toEqual(expect.any(String));
    expect(SENSITIVE_FIELD_MAP.Message.hashedFields).toEqual([{ from: 'content', to: 'contentHash' }]);
    expect(dataModel.models.Message.fields.find(x => x.name === 'contentHash')?.dbName).toBe('content_hash');
  });

  it('the at-rest suites (encryption-at-rest-*.target.test.ts) together prove every column of the map', () => {
    const proven = Object.values(COVERAGE).flat();
    expect(new Set(proven).size).toBe(proven.length);
    expect([...proven].sort()).toEqual(Object.keys(SPEC_ENCRYPTED).sort());
  });

  it('jsonb modes (R43): envelope wherever the CHECK allows, leaves only for ai_memory.doc', () => {
    const json = entries.filter(e => e.f.kind.startsWith('jsonb'));
    expect(Object.fromEntries(json.map(e => [`${e.table}.${e.f.column}`, e.f.kind]))).toEqual({
      'ai_memory.doc': 'jsonb-leaves',
      'follow_up_checkin.payload': 'jsonb-envelope',
      'reflection.summary_doc': 'jsonb-envelope',
      'feature_state.doc': 'jsonb-envelope',
    });
  });
});

describe('values by kind', () => {
  const field = (kind: EncryptedField['kind']): EncryptedField => ({ column: 'c', kind, key: 'user' });

  it('text: enc:v1 at rest, plaintext back; already-encrypted values are not sealed twice', () => {
    const sealed = sealFieldValue(field('text'), 'secret') as string;
    expect(isEncrypted(sealed)).toBe(true);
    expect(sealFieldValue(field('text'), sealed)).toBe(sealed);
    expect(openFieldValue(field('text'), sealed)).toBe('secret');
    expect(openFieldValue(field('text'), 'legacy plaintext')).toBe('legacy plaintext');
  });

  it('text[] (R44): each element sealed, the array stays an array', () => {
    const sealed = sealFieldValue(field('text[]'), ['a', 'b']) as string[];
    expect(sealed).toHaveLength(2);
    expect(sealed.every(isEncrypted)).toBe(true);
    expect(openFieldValue(field('text[]'), sealed)).toEqual(['a', 'b']);
    expect(sealFieldValue(field('text[]'), [])).toEqual([]);
  });

  it('jsonb envelope (R43): one opaque object; legacy plain documents read as they are', () => {
    const doc = { entries: [{ content: 'thanks', n: 3 }], preferences: { enabled: true } };
    const sealed = sealFieldValue(field('jsonb-envelope'), doc) as Record<string, string>;
    expect(Object.keys(sealed)).toEqual([ENVELOPE_KEY]);
    expect(isEncrypted(sealed[ENVELOPE_KEY])).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('thanks');
    expect(openFieldValue(field('jsonb-envelope'), sealed)).toEqual(doc);
    expect(sealFieldValue(field('jsonb-envelope'), sealed)).toBe(sealed);
    expect(openFieldValue(field('jsonb-envelope'), doc)).toBe(doc);
    expect(sealFieldValue(field('jsonb-envelope'), null)).toBeNull();
  });

  it('jsonb leaves (R43): keys, numbers and array shape stay (the ai_memory CHECKs), every string leaf is sealed', () => {
    const doc = { text: 'summary', messageCount: 12, generatedAt: '2026-10-27T00:00:00Z', facts: [{ category: 'People', fact: 'x' }] };
    const sealed = sealFieldValue(field('jsonb-leaves'), doc) as Record<string, unknown>;
    expect(Object.keys(sealed)).toEqual(['text', 'messageCount', 'generatedAt', 'facts']);
    expect(sealed.messageCount).toBe(12);
    expect(Array.isArray(sealed.facts)).toBe(true);
    expect(isEncrypted(sealed.text as string)).toBe(true);
    expect(isEncrypted(sealed.generatedAt as string)).toBe(true);
    expect(isEncrypted((sealed.facts as Array<Record<string, string>>)[0].fact)).toBe(true);
    expect(openFieldValue(field('jsonb-leaves'), sealed)).toEqual(doc);
  });

  it('keyless: every kind passes through unchanged (the goldens run keyless)', () => {
    noKey();
    const doc = { a: 'b' };
    expect(sealFieldValue(field('text'), 'x')).toBe('x');
    expect(sealFieldValue(field('text[]'), ['x'])).toEqual(['x']);
    expect(sealFieldValue(field('jsonb-envelope'), doc)).toBe(doc);
    expect(sealFieldValue(field('jsonb-leaves'), doc)).toEqual(doc);
  });

  it('an undecryptable value propagates FieldDecryptionError, never empty content', () => {
    const sealedText = sealFieldValue(field('text'), 'secret');
    const sealedDoc = sealFieldValue(field('jsonb-envelope'), { a: 1 });
    _resetForTesting();
    process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    expect(() => openFieldValue(field('text'), sealedText)).toThrow(FieldDecryptionError);
    expect(() => openFieldValue(field('jsonb-envelope'), sealedDoc)).toThrow(FieldDecryptionError);
  });
});

describe('the raw-SQL helper reads the same map', () => {
  it('encrypts and decrypts by table.column, and refuses a column that is not encrypted', () => {
    const v = encryptColumnValue('draft', 'content', 'my draft');
    expect(isEncrypted(v)).toBe(true);
    expect(decryptColumnValue('draft', 'content', v)).toBe('my draft');
    expect(() => encryptColumnValue('draft', 'version', 'x')).toThrow(/not an encrypted column/);
    expect(() => encryptColumnValue('user_preferences', 'doc', {})).toThrow(/not an encrypted column/);
    expect(isEncryptedColumn('need', 'evidence')).toBe(true);
    expect(isEncryptedColumn('need', 'category')).toBe(false);
  });

  it('decryptRawRows maps row keys (aliases) to table.column', () => {
    const rows = [
      { id: '1', note: encryptColumnValue('proposal_choice', 'note', 'n1'), decision: 'WILLING' },
      { id: '2', note: null, decision: 'NOT_WILLING' },
    ];
    expect(decryptRawRows(rows, { note: 'proposal_choice.note' })).toEqual([
      { id: '1', note: 'n1', decision: 'WILLING' },
      { id: '2', note: null, decision: 'NOT_WILLING' },
    ]);
    expect(() => decryptRawRows(rows, { note: 'proposal_choice.decision' })).toThrow(/not an encrypted column/);
  });
});

describe('applyFieldEncryption — model operations', () => {
  const captured: Array<Record<string, unknown>> = [];
  const query = async (args: Record<string, unknown>) => {
    captured.push(JSON.parse(JSON.stringify(args)));
    return null;
  };
  beforeEach(() => {
    captured.length = 0;
  });
  const run = (model: string, operation: string, args: Record<string, unknown>) =>
    applyFieldEncryption({ model, operation, args, query, relations });

  it('create / update / upsert / createMany / updateMany seal the mapped fields', async () => {
    await run('Draft', 'create', { data: { content: 'd', version: 1 } });
    await run('Need', 'update', { where: { id: 'n' }, data: { label: 'Safety', evidence: ['quote'] } });
    await run('NeedDisposition', 'upsert', { where: {}, create: { note: 'c' }, update: { note: 'u' } });
    await run('FollowUpNote', 'createMany', { data: [{ content: 'a' }, { content: 'b' }] });
    await run('ContextShareOffer', 'updateMany', { where: {}, data: { sharedContent: 's' } });
    const [draft, need, disp, notes, offer] = captured;
    expect(isEncrypted((draft.data as { content: string }).content)).toBe(true);
    expect((draft.data as { version: number }).version).toBe(1);
    expect(isEncrypted((need.data as { label: string }).label)).toBe(true);
    expect((need.data as { evidence: string[] }).evidence.every(isEncrypted)).toBe(true);
    expect(isEncrypted((disp.create as { note: string }).note)).toBe(true);
    expect(isEncrypted((disp.update as { note: string }).note)).toBe(true);
    expect((notes.data as Array<{ content: string }>).every(n => isEncrypted(n.content))).toBe(true);
    expect(isEncrypted((offer.data as { sharedContent: string }).sharedContent)).toBe(true);
  });

  it('the { set } and { push } update forms are sealed', async () => {
    await run('Need', 'update', { where: {}, data: { label: { set: 'L' }, evidence: { push: 'q' } } });
    const data = captured[0].data as { label: { set: string }; evidence: { push: string } };
    expect(isEncrypted(data.label.set)).toBe(true);
    expect(isEncrypted(data.evidence.push)).toBe(true);
  });

  it('nested writes under a relation are sealed (create, createMany, connectOrCreate, upsert, update)', async () => {
    await run('Reflection', 'create', {
      data: {
        title: 't',
        messages: { create: [{ role: 'USER', content: 'm1' }], createMany: { data: [{ role: 'AI', content: 'm2' }] } },
        takeaways: { connectOrCreate: { where: { id: 'x' }, create: { content: 'tk' } } },
      },
    });
    await run('Proposal', 'update', {
      where: { id: 'p' },
      data: {
        choices: {
          upsert: { where: {}, create: { note: 'c' }, update: { note: 'u' } },
          update: { where: {}, data: { note: 'v' } },
          updateMany: { where: {}, data: { note: 'w' } },
        },
      },
    });
    const text = JSON.stringify(captured);
    for (const plain of ['"t"', '"m1"', '"m2"', '"tk"', '"c"', '"u"', '"v"', '"w"']) expect(text).not.toContain(plain);
    const r = captured[0].data as { messages: { create: Array<{ content: string; role: string }> } };
    expect(r.messages.create[0].role).toBe('USER');
    expect(isEncrypted(r.messages.create[0].content)).toBe(true);
  });

  it('reads decrypt the model and its included relations; results of writes too', async () => {
    const result = await applyFieldEncryption({
      model: 'Conversation',
      operation: 'findMany',
      args: {},
      relations,
      query: async () => [
        {
          id: 'c',
          messages: [{ id: 'm', content: encrypt('hello'), senderParticipant: null }],
          participant: { id: 'p', drafts: [{ content: encrypt('draft') }], needs: [{ label: encrypt('Safety'), evidence: [encrypt('q')] }] },
        },
      ],
    });
    expect(result).toEqual([
      {
        id: 'c',
        messages: [{ id: 'm', content: 'hello', senderParticipant: null }],
        participant: { id: 'p', drafts: [{ content: 'draft' }], needs: [{ label: 'Safety', evidence: ['q'] }] },
      },
    ]);
    const created = await applyFieldEncryption({
      model: 'Draft',
      operation: 'create',
      args: { data: { content: 'd' } },
      relations,
      query: async a => ({ id: 'd', ...(a.data as object) }),
    });
    expect(created).toEqual({ id: 'd', content: 'd' });
  });

  it('leaves unmapped scalars and models without encrypted fields alone', async () => {
    const row = { id: 's1', status: 'ACTIVE' };
    await expect(
      applyFieldEncryption({ model: 'Milestone', operation: 'findFirst', args: {}, query: async () => row, relations }),
    ).resolves.toEqual(row);
    await run('ParticipantMilestone', 'create', { data: { participantId: 'p', milestoneKey: 'feel_heard' } });
    expect(captured[0]).toEqual({ data: { participantId: 'p', milestoneKey: 'feel_heard' } });
  });

  it('propagates a decryption failure inside a findMany batch', async () => {
    const rows = [{ content: encrypt('first') }, { content: encrypt('second') }];
    _resetForTesting();
    process.env.FIELD_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
    await expect(
      applyFieldEncryption({ model: 'Message', operation: 'findMany', args: {}, query: async () => rows, relations }),
    ).rejects.toThrow(FieldDecryptionError);
  });
});

describe('contentHash on write (message.content → content_hash)', () => {
  const captured: Array<Record<string, unknown>> = [];
  const query = async (args: Record<string, unknown>) => {
    captured.push(args);
    return null;
  };
  beforeEach(() => {
    captured.length = 0;
  });

  it('is the digest of the plaintext, next to the ciphertext', async () => {
    await applyFieldEncryption({ model: 'Message', operation: 'create', args: { data: { content: 'hi' } }, query });
    const data = captured[0].data as { content: string; contentHash: string };
    expect(data.contentHash).toBe(contentHash('hi'));
    expect(isEncrypted(data.content)).toBe(true);
  });

  it('is written keyless too, on every row of a createMany, on both upsert branches, and on { set }', async () => {
    noKey();
    await applyFieldEncryption({ model: 'Message', operation: 'create', args: { data: { content: 'a' } }, query });
    expect((captured[0].data as { contentHash: string }).contentHash).toBe(contentHash('a'));
    expect((captured[0].data as { content: string }).content).toBe('a');
    await applyFieldEncryption({
      model: 'Message',
      operation: 'createMany',
      args: { data: [{ content: 'x' }, { content: 'y' }] },
      query,
    });
    expect((captured[1].data as Array<{ contentHash: string }>).map(r => r.contentHash)).toEqual([
      contentHash('x'),
      contentHash('y'),
    ]);
    await applyFieldEncryption({
      model: 'Message',
      operation: 'upsert',
      args: { where: {}, create: { content: 'c' }, update: { content: { set: 'u' } } },
      query,
    });
    expect((captured[2].create as { contentHash: string }).contentHash).toBe(contentHash('c'));
    expect((captured[2].update as { contentHash: string }).contentHash).toBe(contentHash('u'));
  });

  it('is left alone by an update that does not touch content, and never added to other models', async () => {
    await applyFieldEncryption({ model: 'Message', operation: 'update', args: { where: {}, data: {} }, query });
    expect(captured[0].data).not.toHaveProperty('contentHash');
    await applyFieldEncryption({ model: 'Draft', operation: 'create', args: { data: { content: 'd' } }, query });
    expect(captured[1].data).not.toHaveProperty('contentHash');
  });
});

describe('encryptDataFields / decryptRecordFields (exported for manual paths)', () => {
  it('round-trips a record of every mapped model', () => {
    for (const [model, config] of Object.entries(SENSITIVE_FIELD_MAP)) {
      const record: Record<string, unknown> = {};
      for (const [name, f] of Object.entries(config.fields)) {
        record[name] = f.kind === 'text' ? `${model}.${name}` : f.kind === 'text[]' ? [`${model}.${name}`] : { v: `${model}.${name}` };
      }
      const copy = JSON.parse(JSON.stringify(record));
      encryptDataFields(record, config);
      expect(JSON.stringify(record)).not.toContain(`${model}.`);
      decryptRecordFields(record, config);
      for (const { to } of config.hashedFields ?? []) delete record[to];
      expect(record).toEqual(copy);
    }
  });
});

describe('withEncryption', () => {
  it('reads the relations from the client it extends (fails closed without them)', () => {
    expect(() => withEncryption(base)).not.toThrow();
    expect(() => withEncryption({} as never)).toThrow(/no runtime data model/);
  });
});
