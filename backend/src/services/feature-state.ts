/**
 * Feature-state store (TS-12, spec §1.7 feature_state, assumption A-Q4).
 *
 * One document per (user, feature) — meditation, gratitude, needs_assessment,
 * people — with its zod contract in shared/src/dto/feature-state.ts. Reads
 * parse the stored document into its full shape (a user with no row reads the
 * defaults; nothing is written by a read). Writes are read-modify-write under a
 * ROW LOCK: the row is created empty if absent (INSERT … ON CONFLICT DO
 * NOTHING), locked (SELECT … FOR UPDATE), read, changed in memory, validated
 * and written back, all in one transaction — so two devices writing at once
 * serialise and neither loses the other's entry (the old tables appended rows;
 * a document must not turn that into last-write-wins).
 *
 * Every row is the caller's own (RLS shape: user_id = me); the store takes the
 * user id from the authenticated request and never another.
 *
 * TODO(TS-13): `doc` is encrypted under the user key (spec §1.7); the field map
 * is TS-13's. The document itself goes through the Prisma model API (so the
 * encryption middleware sees it); only the empty-row INSERT and the lock are raw.
 */

import { parseFeatureDoc, FEATURE_DOC_SCHEMAS, type Feature, type FeatureDocs } from '@meet-without-fear/shared';
import { prisma } from '../lib/prisma';
import { randomUUID } from 'crypto';
import type { Prisma } from '../generated/prisma/client';

/** The caller's document for a feature, in full shape (defaults when there is no row). */
export async function readFeature<F extends Feature>(userId: string, feature: F): Promise<FeatureDocs[F]> {
  const row = await prisma.featureState.findUnique({
    where: { userId_feature: { userId, feature } },
    select: { doc: true },
  });
  return parseFeatureDoc(feature, row?.doc ?? {});
}

/**
 * Read-modify-write the caller's document under a row lock. `mutate` changes
 * the document in place (or returns a replacement) and may return a result;
 * the document is validated against its contract before it is written.
 * Returns `mutate`'s result.
 */
export async function updateFeature<F extends Feature, R>(
  userId: string,
  feature: F,
  mutate: (doc: FeatureDocs[F]) => R | Promise<R>,
): Promise<R> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO feature_state (user_id, feature, doc) VALUES (${userId}::uuid, ${feature}, '{}'::jsonb) ON CONFLICT (user_id, feature) DO NOTHING`;
    await tx.$queryRaw`SELECT 1 FROM feature_state WHERE user_id = ${userId}::uuid AND feature = ${feature} FOR UPDATE`;
    const row = await tx.featureState.findUniqueOrThrow({
      where: { userId_feature: { userId, feature } },
      select: { doc: true },
    });
    const doc = parseFeatureDoc(feature, row.doc);
    const result = await mutate(doc);
    const next = FEATURE_DOC_SCHEMAS[feature].parse(doc) as Prisma.InputJsonObject;
    await tx.featureState.update({
      where: { userId_feature: { userId, feature } },
      data: { doc: next },
    });
    return result;
  });
}

/** A new document-entry id (the old rows' ids were uuidv7; ordering is by the entry's own instants). */
export function newEntryId(): string {
  return randomUUID();
}
