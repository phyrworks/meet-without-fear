/**
 * Named fixture scenarios. Each value is a declarative scenario in
 * `scenarios.ts`; `state-factory.ts` re-exports this enum as its public surface.
 */
export enum TargetStage {
  /** Session just created, compact not signed */
  CREATED = 'CREATED',

  /** Topic has been confirmed and the invitation-ready modal can be opened */
  INVITATION_READY = 'INVITATION_READY',

  /** User A completed Stage 1 (witnessed, felt heard) and shared empathy */
  EMPATHY_SHARED_A = 'EMPATHY_SHARED_A',

  /** User B has completed Stage 1 (felt heard), reconciler has run. Ready for reconciler tests. */
  FEEL_HEARD_B = 'FEEL_HEARD_B',

  /** User B has felt heard, reconciler has run with significant gaps, share offer is OFFERED. Ready for share modal UI tests. */
  RECONCILER_SHOWN_B = 'RECONCILER_SHOWN_B',

  /** Both users active: User B has felt heard, received share suggestion, and shared context */
  CONTEXT_SHARED_B = 'CONTEXT_SHARED_B',

  /** Both users active: Both have shared empathy and validated each other's empathy (empathy reveal complete) */
  EMPATHY_REVEALED = 'EMPATHY_REVEALED',

  /** Stage 3: Both users have identified needs and confirmed common ground */
  NEED_MAPPING_COMPLETE = 'NEED_MAPPING_COMPLETE',

  /** Stage 4: Strategies collected, ranked, and agreement created */
  STRATEGIC_REPAIR_COMPLETE = 'STRATEGIC_REPAIR_COMPLETE',

  /** Redesigned Stage 4: Active proposal inventory with one removed proposal */
  STAGE4_REDESIGN_INVENTORY = 'STAGE4_REDESIGN_INVENTORY',

  /** Redesigned Stage 4: Both partners selected one shared proposal as willing */
  STAGE4_REDESIGN_SHARED_SELECTIONS = 'STAGE4_REDESIGN_SHARED_SELECTIONS',

  /** Redesigned Stage 4: Both partners selected, but no shared proposal overlaps */
  STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS = 'STAGE4_REDESIGN_NO_OVERLAP_SELECTIONS',

  /** Redesigned Stage 4: One partner selected while the other is inactive */
  STAGE4_REDESIGN_PARTNER_INACTIVE = 'STAGE4_REDESIGN_PARTNER_INACTIVE',
}
