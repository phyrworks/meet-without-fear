import { MonitorContext } from '../../types';

interface ContextColumnProps {
  userId: string;
  userName: string;
  context: MonitorContext;
}

/**
 * ContextColumn shows one participant's context structure: stage, memory intent, turn count, latest mood intensity
 * and the milestones reached. The monitor never receives the AI's context bundle, its text or its memory (review r1
 * F3, work-k5fk.9).
 */
export function ContextColumn({ userName, context }: ContextColumnProps) {
  const milestones = Object.entries(context.milestones).sort(([, a], [, b]) => a.localeCompare(b));
  return (
    <div className="context-column">
      <div className="context-column-header">
        <h3>{userName}</h3>
        <span className="stage-badge">Stage {context.stage}</span>
        <span className="intent-badge" title={context.intent.reason}>
          {context.intent.intent.replace('_', ' ')}
        </span>
      </div>

      <div className="context-sections">
        <div className="context-section">
          <div className="section-header">
            <h4>Structure</h4>
            <span className="turn-count">{context.turnCount} turns</span>
          </div>
          <div className="section-content">
            <div>Latest intensity: {context.latestIntensity ?? <span className="text-muted">none</span>}</div>
            <div>
              Retrieval: {context.intent.depth} · surface {context.intent.surfaceStyle}
            </div>
          </div>
        </div>

        <div className="context-section">
          <div className="section-header">
            <h4>Milestones</h4>
            <span className="turn-count">{milestones.length}</span>
          </div>
          <div className="section-content">
            {milestones.length === 0 ? (
              <div className="empty-section">None reached</div>
            ) : (
              <ul className="message-list">
                {milestones.map(([key, at]) => (
                  <li key={key} className="message-item">
                    <span className="message-role">{key}</span>{' '}
                    <span className="text-muted">{new Date(at).toLocaleString()}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
