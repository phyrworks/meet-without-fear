/**
 * Partner Session Classifier: the pure fact bookkeeping (short-ID mapping,
 * ensureFactIds, applyFactUpdates).
 *
 * TS-12: the Prisma-mock half of this suite moved to
 * services/__tests__/partner-session-classifier.target.test.ts, where the
 * classifier runs against a real session and the NOTABLE_FACTS document is
 * read back from ai_memory (written by mwf_job).
 */

import {
  applyFactUpdates,
  ensureFactIds,
  generateRandomShortId,
  createIdMapping,
  resolveShortIds,
  normalizeResult,
  CategorizedFactWithId,
  FactUpdatePayload,
  IdMapping,
} from '../partner-session-classifier';

// ============================================================================
// Short ID Mapping Tests
// ============================================================================

describe('Short ID Mapping', () => {
  describe('generateRandomShortId', () => {
    it('generates 5-character alphanumeric IDs', () => {
      const id = generateRandomShortId();
      expect(id).toHaveLength(5);
      expect(id).toMatch(/^[a-z0-9]+$/);
    });

    it('generates different IDs on each call', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateRandomShortId());
      }
      // With random generation, we expect high uniqueness
      expect(ids.size).toBeGreaterThan(95);
    });
  });

  describe('createIdMapping', () => {
    it('creates bidirectional mapping from facts to random short IDs', () => {
      const facts: CategorizedFactWithId[] = [
        { id: 'uuid-111-aaa', category: 'People', fact: 'Fact 1' },
        { id: 'uuid-222-bbb', category: 'Logistics', fact: 'Fact 2' },
      ];

      const mapping = createIdMapping(facts);

      // Verify mapping size
      expect(mapping.shortToFull.size).toBe(2);
      expect(mapping.fullToShort.size).toBe(2);

      // Verify bidirectional consistency
      const shortId1 = mapping.fullToShort.get('uuid-111-aaa')!;
      const shortId2 = mapping.fullToShort.get('uuid-222-bbb')!;
      expect(mapping.shortToFull.get(shortId1)).toBe('uuid-111-aaa');
      expect(mapping.shortToFull.get(shortId2)).toBe('uuid-222-bbb');

      // Verify short IDs are 5 chars
      expect(shortId1).toHaveLength(5);
      expect(shortId2).toHaveLength(5);

      // Verify short IDs are unique
      expect(shortId1).not.toBe(shortId2);
    });

    it('handles empty facts array', () => {
      const mapping = createIdMapping([]);
      expect(mapping.shortToFull.size).toBe(0);
      expect(mapping.fullToShort.size).toBe(0);
    });

    it('generates unique IDs even with many facts', () => {
      const facts: CategorizedFactWithId[] = Array.from({ length: 20 }, (_, i) => ({
        id: `uuid-${i}`,
        category: 'People',
        fact: `Fact ${i}`,
      }));

      const mapping = createIdMapping(facts);

      // All 20 should have unique short IDs
      expect(mapping.shortToFull.size).toBe(20);
      expect(mapping.fullToShort.size).toBe(20);
    });
  });

  describe('resolveShortIds', () => {
    it('resolves short IDs back to full UUIDs in upsert array', () => {
      const mapping: IdMapping = {
        shortToFull: new Map([
          ['aa0000', 'full-uuid-1'],
          ['ab0001', 'full-uuid-2'],
        ]),
        fullToShort: new Map([
          ['full-uuid-1', 'aa0000'],
          ['full-uuid-2', 'ab0001'],
        ]),
      };

      const factUpdates: FactUpdatePayload = {
        upsert: [
          { id: 'aa0000', category: 'People', fact: 'Updated fact' },
          { category: 'Emotional', fact: 'New fact without ID' },
        ],
        delete: [],
      };

      const resolved = resolveShortIds(factUpdates, mapping);

      expect(resolved.upsert[0].id).toBe('full-uuid-1');
      expect(resolved.upsert[1].id).toBeUndefined();
    });

    it('resolves short IDs in delete array', () => {
      const mapping: IdMapping = {
        shortToFull: new Map([
          ['aa0000', 'full-uuid-1'],
          ['ab0001', 'full-uuid-2'],
          ['ac0002', 'full-uuid-3'],
        ]),
        fullToShort: new Map(),
      };

      const factUpdates: FactUpdatePayload = {
        upsert: [],
        delete: ['ab0001', 'ac0002'],
      };

      const resolved = resolveShortIds(factUpdates, mapping);

      expect(resolved.delete).toEqual(['full-uuid-2', 'full-uuid-3']);
    });

    it('an id not in the mapping is a new fact with a fresh uuidv7; deleting one is dropped (work-k5fk.19)', () => {
      const mapping: IdMapping = {
        shortToFull: new Map([['aa0000', 'full-uuid-1']]),
        fullToShort: new Map([['full-uuid-1', 'aa0000']]),
      };

      const factUpdates: FactUpdatePayload = {
        upsert: [
          { id: 'unknown-id', category: 'People', fact: 'Some fact' },
          { id: 'full-uuid-1', category: 'People', fact: 'An existing fact by its full id' },
        ],
        delete: ['unknown-delete-id', 'full-uuid-1'],
      };

      const resolved = resolveShortIds(factUpdates, mapping);

      expect(resolved.upsert[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(resolved.upsert[1].id).toBe('full-uuid-1');
      expect(resolved.delete).toEqual(['full-uuid-1']);
    });
  });
});

// ============================================================================
// Diff-Based Fact Reconciliation Tests
// ============================================================================

describe('ensureFactIds', () => {
  it('assigns UUIDs to facts without IDs', () => {
    const legacyFacts = [
      { category: 'People', fact: 'User has a daughter' },
      { category: 'Logistics', fact: 'Lives in NYC' },
    ];

    const result = ensureFactIds(legacyFacts);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBeDefined();
    expect(result[0].id).toMatch(/^[a-f0-9-]{36}$/); // UUID format
    expect(result[0].category).toBe('People');
    expect(result[0].fact).toBe('User has a daughter');
    expect(result[1].id).toBeDefined();
    expect(result[1].id).not.toBe(result[0].id); // Each gets unique ID
  });

  it('preserves existing IDs on facts that already have them', () => {
    const factsWithIds: CategorizedFactWithId[] = [
      { id: 'existing-id-1', category: 'People', fact: 'User has a daughter' },
      { id: 'existing-id-2', category: 'Logistics', fact: 'Lives in NYC' },
    ];

    const result = ensureFactIds(factsWithIds);

    expect(result[0].id).toBe('existing-id-1');
    expect(result[1].id).toBe('existing-id-2');
  });

  it('handles mixed facts (some with IDs, some without)', () => {
    const mixedFacts = [
      { id: 'existing-id', category: 'People', fact: 'User has a daughter' },
      { category: 'Logistics', fact: 'Lives in NYC' }, // No ID
    ];

    const result = ensureFactIds(mixedFacts as CategorizedFactWithId[]);

    expect(result[0].id).toBe('existing-id');
    expect(result[1].id).toBeDefined();
    expect(result[1].id).not.toBe('existing-id');
  });

  it('returns empty array for null/undefined input', () => {
    expect(ensureFactIds(null as unknown as CategorizedFactWithId[])).toEqual([]);
    expect(ensureFactIds(undefined as unknown as CategorizedFactWithId[])).toEqual([]);
  });
});

describe('applyFactUpdates', () => {
  const existingFacts: CategorizedFactWithId[] = [
    { id: 'fact-1', category: 'People', fact: 'User has a daughter named Emma' },
    { id: 'fact-2', category: 'Logistics', fact: 'Lives in NYC' },
    { id: 'fact-3', category: 'Emotional', fact: 'Feeling stressed' },
  ];

  it('adds new facts (upsert without ID assigns UUID)', () => {
    const llmOutput: FactUpdatePayload = {
      upsert: [
        { category: 'History', fact: 'Married for 10 years' }, // New fact, no ID
      ],
      delete: [],
    };

    const result = applyFactUpdates(existingFacts, llmOutput);

    expect(result).toHaveLength(4);
    // Original facts preserved
    expect(result.find(f => f.id === 'fact-1')).toBeDefined();
    expect(result.find(f => f.id === 'fact-2')).toBeDefined();
    expect(result.find(f => f.id === 'fact-3')).toBeDefined();
    // New fact added with generated ID
    const newFact = result.find(f => f.fact === 'Married for 10 years');
    expect(newFact).toBeDefined();
    expect(newFact?.id).toBeDefined();
    expect(newFact?.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it('updates existing facts (upsert with matching ID)', () => {
    const llmOutput: FactUpdatePayload = {
      upsert: [{ id: 'fact-1', category: 'People', fact: 'User has a daughter named Emma who is 14' }],
      delete: [],
    };

    const result = applyFactUpdates(existingFacts, llmOutput);

    expect(result).toHaveLength(3);
    const updatedFact = result.find(f => f.id === 'fact-1');
    expect(updatedFact?.fact).toBe('User has a daughter named Emma who is 14');
    expect(updatedFact?.category).toBe('People');
  });

  it('deletes facts by ID', () => {
    const llmOutput: FactUpdatePayload = {
      upsert: [],
      delete: ['fact-2', 'fact-3'],
    };

    const result = applyFactUpdates(existingFacts, llmOutput);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('fact-1');
  });

  it('handles combined add, update, and delete in single operation', () => {
    const llmOutput: FactUpdatePayload = {
      upsert: [
        { id: 'fact-1', category: 'People', fact: 'UPDATED: User has a daughter' },
        { category: 'History', fact: 'NEW: Married for 10 years' },
      ],
      delete: ['fact-2'],
    };

    const result = applyFactUpdates(existingFacts, llmOutput);

    expect(result).toHaveLength(3); // 3 original - 1 deleted + 1 new = 3
    // Updated fact
    expect(result.find(f => f.id === 'fact-1')?.fact).toBe('UPDATED: User has a daughter');
    // Deleted fact gone
    expect(result.find(f => f.id === 'fact-2')).toBeUndefined();
    // Preserved fact
    expect(result.find(f => f.id === 'fact-3')).toBeDefined();
    // New fact added
    expect(result.find(f => f.fact === 'NEW: Married for 10 years')).toBeDefined();
  });

  it('preserves all facts when LLM returns empty upsert/delete', () => {
    const llmOutput: FactUpdatePayload = {
      upsert: [],
      delete: [],
    };

    const result = applyFactUpdates(existingFacts, llmOutput);

    expect(result).toHaveLength(3);
    expect(result).toEqual(existingFacts);
  });

  it('handles empty existing facts with new additions', () => {
    const llmOutput: FactUpdatePayload = {
      upsert: [{ category: 'People', fact: 'First fact ever' }],
      delete: [],
    };

    const result = applyFactUpdates([], llmOutput);

    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe('First fact ever');
    expect(result[0].id).toBeDefined();
  });

  it('ignores delete requests for non-existent IDs', () => {
    const llmOutput: FactUpdatePayload = {
      upsert: [],
      delete: ['non-existent-id', 'another-fake-id'],
    };

    const result = applyFactUpdates(existingFacts, llmOutput);

    expect(result).toHaveLength(3); // All preserved
  });

  it('enforces soft limit of 20 facts after reconciliation', () => {
    const manyExistingFacts: CategorizedFactWithId[] = Array.from({ length: 18 }, (_, i) => ({
      id: `fact-${i}`,
      category: 'People',
      fact: `Existing fact ${i}`,
    }));

    const llmOutput: FactUpdatePayload = {
      upsert: [
        { category: 'New', fact: 'New fact 1' },
        { category: 'New', fact: 'New fact 2' },
        { category: 'New', fact: 'New fact 3' },
        { category: 'New', fact: 'New fact 4' },
      ],
      delete: [],
    };

    const result = applyFactUpdates(manyExistingFacts, llmOutput);

    expect(result).toHaveLength(20); // Capped at 20
  });

  it('filters invalid upsert entries (empty fact or category)', () => {
    const llmOutput: FactUpdatePayload = {
      upsert: [
        { category: 'People', fact: 'Valid fact' },
        { category: '', fact: 'Empty category' },
        { category: 'Emotional', fact: '' },
        { category: 'History', fact: 'Another valid fact' },
      ],
      delete: [],
    };

    const result = applyFactUpdates([], llmOutput);

    expect(result).toHaveLength(2);
    expect(result.map(f => f.fact)).toEqual(['Valid fact', 'Another valid fact']);
  });

  it('handles null/undefined llmOutput gracefully (preserves existing)', () => {
    const result1 = applyFactUpdates(existingFacts, null as unknown as FactUpdatePayload);
    const result2 = applyFactUpdates(existingFacts, undefined as unknown as FactUpdatePayload);

    expect(result1).toEqual(existingFacts);
    expect(result2).toEqual(existingFacts);
  });
});

// ============================================================================
// normalizeResult: the model's ids (work-k5fk.8 review M1)
// ============================================================================

describe('normalizeResult fact ids', () => {
  it('turns a numeric id into a string, so the NOTABLE_FACTS schema (id: string) accepts the document', () => {
    const out = normalizeResult({
      upsert: [
        { id: 12345, category: 'people', fact: ' Alex is a sibling ' },
        { id: 'ab3x9', category: 'Conflict', fact: 'f' },
      ],
      delete: [67890, ' k2p0q ', '', null],
    });
    expect(out.factUpdates?.upsert).toEqual([
      { id: '12345', category: 'People', fact: 'Alex is a sibling' },
      { id: 'ab3x9', category: 'Conflict', fact: 'f' },
    ]);
    expect(out.factUpdates?.delete).toEqual(['67890', 'k2p0q']);
  });

  it('drops an id that is neither a string nor a finite number (the fact becomes a new one)', () => {
    const out = normalizeResult({
      upsert: [
        { id: { x: 1 }, category: 'People', fact: 'a' },
        { id: true, category: 'People', fact: 'b' },
        { id: Number.NaN, category: 'People', fact: 'c' },
        { id: '  ', category: 'People', fact: 'd' },
      ],
    });
    expect(out.factUpdates?.upsert).toHaveLength(4);
    for (const f of out.factUpdates!.upsert) expect(f).not.toHaveProperty('id');
  });

  it('an all-digit short id the model returns as a number still resolves to its full id', () => {
    const full = '01900000-0000-7000-8000-000000000001';
    const mapping: IdMapping = { shortToFull: new Map([['12345', full]]), fullToShort: new Map([[full, '12345']]) };
    const out = normalizeResult({ upsert: [{ id: 12345, category: 'People', fact: 'f' }], delete: [12345] });
    const resolved = resolveShortIds(out.factUpdates!, mapping);
    expect(resolved.upsert[0].id).toBe(full);
    expect(resolved.delete).toEqual([full]);
  });
});
