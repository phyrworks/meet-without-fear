import React from 'react';
import { PriorThemes } from '../../types';

interface PriorThemesSectionProps {
  priorThemes?: PriorThemes;
}

/**
 * PriorThemesSection displays how many themes previous sessions carried, the last session date and the session
 * count. The themes are never sent to the monitor (owner decision, work-k5fk.9: "close all").
 */
export function PriorThemesSection({ priorThemes }: PriorThemesSectionProps) {
  const hasThemes = !!priorThemes && priorThemes.themeCount > 0;
  const hasPriorSessions = priorThemes?.sessionCount && priorThemes.sessionCount > 0;

  return (
    <div className="context-section prior-themes">
      <div className="section-header">
        <h4>Prior Themes</h4>
        {hasPriorSessions && (
          <span className="session-count">{priorThemes.sessionCount} prior sessions</span>
        )}
      </div>

      <div className="section-content">
        {!hasThemes && !hasPriorSessions ? (
          <div className="empty-section">No prior session data</div>
        ) : (
          <div className="prior-themes-content">
            {priorThemes?.lastSessionDate && (
              <div className="last-session">
                <span className="label">Last session:</span>
                <span className="date">
                  {new Date(priorThemes.lastSessionDate).toLocaleDateString()}
                </span>
              </div>
            )}

            {hasThemes && (
              <div className="themes-list">
                <span className="theme-chip prior">{priorThemes!.themeCount} themes</span>
              </div>
            )}

            {hasPriorSessions && !hasThemes && (
              <div className="no-themes-note">
                Themes not yet extracted from prior sessions
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
