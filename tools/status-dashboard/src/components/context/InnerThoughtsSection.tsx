import React from 'react';
import { InnerThoughtsContext } from '../../types';

interface InnerThoughtsSectionProps {
  innerThoughtsContext?: InnerThoughtsContext;
}

/**
 * InnerThoughtsSection displays the relevant inner thoughts' similarity scores and linked-session indicators. The
 * reflections' text is never sent to the monitor (owner decision, work-k5fk.9: "close all").
 */
export function InnerThoughtsSection({ innerThoughtsContext }: InnerThoughtsSectionProps) {
  const hasReflections = innerThoughtsContext?.relevantReflections &&
    innerThoughtsContext.relevantReflections.length > 0;

  return (
    <div className="context-section inner-thoughts">
      <div className="section-header">
        <h4>Inner Thoughts Context</h4>
        {innerThoughtsContext?.hasLinkedSession && (
          <span className="linked-badge">Has Linked Session</span>
        )}
      </div>

      <div className="section-content">
        {!hasReflections ? (
          <div className="empty-section">No relevant inner thoughts</div>
        ) : (
          <div className="reflections-list">
            {innerThoughtsContext!.relevantReflections.map((reflection, idx) => (
              <blockquote key={idx} className="reflection-quote">
                <footer className="reflection-meta">
                  <span className="similarity-badge">
                    {Math.round(reflection.similarity * 100)}% match
                  </span>
                  {reflection.isFromLinkedSession && (
                    <span className="linked-indicator">Linked</span>
                  )}
                </footer>
              </blockquote>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
