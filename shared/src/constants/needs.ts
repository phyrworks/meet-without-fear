/**
 * The 19-need taxonomy of the Needs Assessment ("Am I OK?") — reference data.
 *
 * Target shape (TS-12, spec §1.7 feature_state Absorbs: "the `Need` taxonomy →
 * `shared/src/constants/needs.ts`"): the old `Need` table held exactly these
 * rows (seeded by migration 20260106083657_add_inner_work_features); nothing
 * wrote to it. Ids are stable: a user's scores in the `needs_assessment`
 * feature document name a need by this id.
 *
 * Order is the old read order — category in enum order, then `order`.
 */

import { NeedsCategory } from '../enums';
import type { NeedDTO } from '../dto/needs-assessment';

export const NEEDS: readonly NeedDTO[] = [
  // Foundation & Survival (4 needs)
  { id: 1, name: 'Physical Safety', slug: 'physical-safety', description: 'Do you feel physically safe in your body and environment?', category: NeedsCategory.FOUNDATION, order: 1 },
  { id: 2, name: 'Health & Physical Care', slug: 'health-physical-care', description: 'Are your basic health needs reasonably supported?', category: NeedsCategory.FOUNDATION, order: 2 },
  { id: 3, name: 'Rest & Restoration', slug: 'rest-restoration', description: 'Are you getting sufficient rest and recovery?', category: NeedsCategory.FOUNDATION, order: 3 },
  { id: 4, name: 'Material Security', slug: 'material-security', description: 'Are your basic material needs stable?', category: NeedsCategory.FOUNDATION, order: 4 },

  // Emotional & Psychological (4 needs)
  { id: 5, name: 'Emotional Safety', slug: 'emotional-safety', description: 'Can you feel emotions without fear of punishment or judgment?', category: NeedsCategory.EMOTIONAL, order: 1 },
  { id: 6, name: 'Self-Compassion', slug: 'self-compassion', description: 'Are you treating yourself with kindness?', category: NeedsCategory.EMOTIONAL, order: 2 },
  { id: 7, name: 'Regulation & Calm', slug: 'regulation-calm', description: 'Are you experiencing emotional steadiness?', category: NeedsCategory.EMOTIONAL, order: 3 },
  { id: 8, name: 'Agency / Autonomy', slug: 'agency-autonomy', description: 'Do you have meaningful choice in your life?', category: NeedsCategory.EMOTIONAL, order: 4 },

  // Relational (4 needs)
  { id: 9, name: 'Being Seen & Understood', slug: 'being-seen-understood', description: 'Do you feel genuinely understood by others?', category: NeedsCategory.RELATIONAL, order: 1 },
  { id: 10, name: 'Belonging', slug: 'belonging', description: 'Do you feel you fit somewhere?', category: NeedsCategory.RELATIONAL, order: 2 },
  { id: 11, name: 'Trust', slug: 'trust', description: 'Do you have relationships where you can rely on others?', category: NeedsCategory.RELATIONAL, order: 3 },
  { id: 12, name: 'Contribution', slug: 'contribution', description: 'Are you meaningfully contributing to others?', category: NeedsCategory.RELATIONAL, order: 4 },

  // Integration & Meaning (4 needs)
  { id: 13, name: 'Purpose / Meaning', slug: 'purpose-meaning', description: 'Does your life have direction or significance?', category: NeedsCategory.INTEGRATION, order: 1 },
  { id: 14, name: 'Learning & Growth', slug: 'learning-growth', description: 'Are you growing in ways that matter to you?', category: NeedsCategory.INTEGRATION, order: 2 },
  { id: 15, name: 'Integrity / Alignment', slug: 'integrity-alignment', description: 'Are you living aligned with your values?', category: NeedsCategory.INTEGRATION, order: 3 },
  { id: 16, name: 'Hope', slug: 'hope', description: 'Do you have a sense of possibility about the future?', category: NeedsCategory.INTEGRATION, order: 4 },

  // Transcendence (3 needs)
  { id: 17, name: 'Presence', slug: 'presence', description: 'Do you experience being fully here?', category: NeedsCategory.TRANSCENDENCE, order: 1 },
  { id: 18, name: 'Gratitude / Sufficiency', slug: 'gratitude-sufficiency', description: 'Do you feel "I have enough"?', category: NeedsCategory.TRANSCENDENCE, order: 2 },
  { id: 19, name: 'Connection to Something Larger', slug: 'connection-larger', description: 'Do you feel connected to nature, spirit, humanity, or a larger whole?', category: NeedsCategory.TRANSCENDENCE, order: 3 },
];

/** A need by its id (1–19), or undefined. */
export function needById(id: number): NeedDTO | undefined {
  return NEEDS.find(n => n.id === id);
}
