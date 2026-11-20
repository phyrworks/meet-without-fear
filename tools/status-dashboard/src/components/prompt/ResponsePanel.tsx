import { useState } from 'react';
import type { ParsedResponse } from '../../types/prompt';

interface ResponsePanelProps {
  response: ParsedResponse;
}

/**
 * The response's structure: its size, stop reason and which tags it carried. The monitor never receives the
 * text the AI wrote (owner decision, work-k5fk.9: "close all").
 */
export function ResponsePanel({ response }: ResponsePanelProps) {
  const [showRaw, setShowRaw] = useState(false);
  const tags = [
    response.hasThinking && 'thinking',
    response.hasDraft && 'draft',
    response.hasDispatch && 'dispatch',
  ].filter(Boolean) as string[];

  return (
    <div className="prompt-panel response-panel">
      <h3 className="panel-title">Response</h3>

      <div className="response-text-section">
        <div className="response-text-label">Response</div>
        <div className="response-text-content">
          {response.chars > 0 ? (
            <span>
              {response.chars.toLocaleString()} chars
              {response.stopReason && <> · stop: {response.stopReason}</>}
              {response.streaming && <> · streamed</>}
            </span>
          ) : (
            <span className="text-muted">(empty response)</span>
          )}
        </div>
        {tags.length > 0 && (
          <div className="thinking-badges">
            {tags.map(t => (
              <span key={t} className="thinking-badge">
                {t}
              </span>
            ))}
          </div>
        )}
      </div>

      <button className="prompt-expand-btn raw-toggle" onClick={() => setShowRaw(!showRaw)}>
        {showRaw ? 'Hide Raw JSON' : 'Show Raw JSON'}
      </button>
      {showRaw && <pre className="raw-json">{JSON.stringify(response, null, 2)}</pre>}
    </div>
  );
}
