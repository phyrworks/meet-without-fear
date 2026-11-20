import { useParams, Link } from 'react-router-dom';
import { usePromptDetail } from '../hooks/usePromptDetail';
import { ModelBadge } from '../components/metrics/ModelBadge';
import { RequestPanel } from '../components/prompt/RequestPanel';
import { ResponsePanel } from '../components/prompt/ResponsePanel';
import { MetadataPanel } from '../components/prompt/MetadataPanel';
import { FormattedPrice } from '../components/session/FormattedPrice';

/**
 * One LLM call: its request and response structure (sizes, roles, cache flags, tags) and its cost and timing.
 * No prompt diff or parsing view: the monitor never receives the text a user or the AI wrote (owner decision,
 * work-k5fk.9: "close all").
 */
export function PromptInspectorPage() {
  const { sessionId, activityId } = useParams<{ sessionId: string; activityId: string }>();
  const { data, loading, error } = usePromptDetail(activityId);

  if (loading) {
    return (
      <div className="loading" style={{ padding: '2rem' }}>
        Loading prompt detail...
      </div>
    );
  }

  if (error) {
    return (
      <div className="error" style={{ padding: '2rem' }}>
        Error: {error}
      </div>
    );
  }

  if (!data) {
    return (
      <div className="error" style={{ padding: '2rem' }}>
        Prompt not found
      </div>
    );
  }

  return (
    <div className="prompt-inspector">
      {/* Header */}
      <div className="prompt-inspector-header">
        <div className="prompt-inspector-nav">
          <Link to={`/sessions/${sessionId}`} className="prompt-back-link">
            &larr; Session Detail
          </Link>
        </div>
        <div className="prompt-inspector-meta">
          <span className="prompt-call-type">{data.timing.callType.replace(/_/g, ' ')}</span>
          <ModelBadge model={data.timing.model} />
          <span className="prompt-header-cost">
            <FormattedPrice value={data.cost.total} />
          </span>
        </div>
      </div>

      {/* Inspector Panels */}
      <div className="prompt-inspector-panels">
        <RequestPanel systemPrompt={data.systemPrompt.blocks} messages={data.messages} tokens={data.tokens} />
        <ResponsePanel response={data.response} />
        <MetadataPanel
          model={data.timing.model}
          callType={data.timing.callType}
          tokens={data.tokens}
          cost={data.cost}
          durationMs={data.timing.durationMs}
          contextWindow={data.contextWindow}
        />
      </div>
    </div>
  );
}
