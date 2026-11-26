/**
 * Whether the Stage 1 "Do you feel heard?" card shows (useUnifiedSession).
 *
 * The AI's offer is a persisted fact of the caller's own progress (`feelHeardCheckOffered`,
 * conversation_read_state.feel_heard_offered_at; owner decision 2026-11-25, work-k5fk.34), so the
 * card survives a reload or another device; the stream trigger shows it before the cache has it.
 * It hides once the caller reached `feel_heard`, confirmed in this view, or dismissed it here.
 */
export function shouldShowFeelHeardCard(args: {
  isWitnessStage: boolean;
  offeredPersisted: boolean;
  offeredByStream: boolean;
  feelHeardReached: boolean;
  dismissed: boolean;
  confirmedHere: boolean;
}): boolean {
  return (
    args.isWitnessStage &&
    (args.offeredPersisted || args.offeredByStream) &&
    !args.feelHeardReached &&
    !args.dismissed &&
    !args.confirmedHere
  );
}
