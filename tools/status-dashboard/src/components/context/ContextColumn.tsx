import { ContextBundle } from '../../types';
import { RecentMessagesSection } from './RecentMessagesSection';
import { EmotionalThreadSection } from './EmotionalThreadSection';
import { InnerThoughtsSection } from './InnerThoughtsSection';
import { PriorThemesSection } from './PriorThemesSection';

interface ContextColumnProps {
  userId: string;
  userName: string;
  context: ContextBundle;
}

/**
 * ContextColumn displays all context sections for a single user.
 * Used in the side-by-side layout for partner sessions. No memory sections (notable facts, session summary,
 * things to remember, global facts): the backend no longer sends a participant's memory to the monitor
 * (owner decision, work-k5fk.9).
 */
export function ContextColumn({ userName, context }: ContextColumnProps) {
  return (
    <div className="context-column">
      <div className="context-column-header">
        <h3>{userName}</h3>
        <span className="stage-badge">Stage {context.stageContext.stage}</span>
        <span className="intent-badge" title={context.intent.reason}>
          {context.intent.intent.replace('_', ' ')}
        </span>
      </div>

      <div className="context-sections">
        <EmotionalThreadSection emotionalThread={context.emotionalThread} />

        <InnerThoughtsSection innerThoughtsContext={context.innerThoughtsContext} />

        <PriorThemesSection priorThemes={context.priorThemes} />

        <RecentMessagesSection
          recentTurns={context.conversationContext.recentTurns}
          turnCount={context.conversationContext.turnCount}
          sessionDurationMinutes={context.conversationContext.sessionDurationMinutes}
        />
      </div>
    </div>
  );
}
