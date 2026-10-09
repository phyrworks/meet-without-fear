import { getHaikuJson } from '../lib/bedrock';
import { BrainActivityCallType } from '../generated/prisma/client';

export interface SendableRewriteResult {
  needsRewrite: boolean;
  severity: 'low' | 'medium' | 'high';
  note: string;
  variants: string[];
}

export async function suggestSendableRewrite(params: {
  text: string;
  sessionId: string;
  turnId: string;
  requesterName: string;
  targetName: string;
}): Promise<SendableRewriteResult | null> {
  const { text, sessionId, turnId, requesterName, targetName } = params;
  if (!text.trim()) {
    return null;
  }

  const systemPrompt = `You check whether a message contains attacking or blame-heavy language before it is shared.

TASKS:
1) Decide if a gentler rewrite is needed to prevent escalation.
2) If needed, produce 1-3 rewrites that preserve the speaker's intent and accountability without sanitizing their voice.

Rules:
- Keep the speaker's intent and specifics.
- Do NOT remove accountability or soften away real harm.
- Avoid lecturing or therapy jargon.
- If no rewrite is needed, return needsRewrite=false and empty variants.

Output JSON:
{
  "needsRewrite": true|false,
  "severity": "low"|"medium"|"high",
  "note": "1 sentence describing what changed or why",
  "variants": ["rewrite 1", "rewrite 2"]
}`;

  const userPrompt = `Speaker: ${requesterName}
Recipient: ${targetName}
Message:
"""
${text}
"""`;

  return getHaikuJson<SendableRewriteResult>({
    systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    maxTokens: 400,
    sessionId,
    turnId,
    operation: 'sendable-rewrite',
    callType: BrainActivityCallType.BACKGROUND_CLASSIFICATION,
  });
}
