import { logger } from '../lib/logger';
import { Resend } from 'resend';

// Initialize Resend client - required
const resend = new Resend(process.env.RESEND_API_KEY);

// Default sender email
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';

/**
 * Result of an email send operation
 */
export interface EmailResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Send an invitation email to a partner
 *
 * @param to - Recipient email address
 * @param inviterName - Name of the person sending the invitation
 * @param invitationUrl - Deep link URL for accepting the invitation
 * @returns EmailResult indicating success or failure
 */
export async function sendInvitationEmail(
  to: string,
  inviterName: string,
  invitationUrl: string,
): Promise<EmailResult> {
  if (!process.env.RESEND_API_KEY) {
    logger.error('[Email] RESEND_API_KEY not configured');
    return {
      success: false,
      error: 'Email service not configured: set RESEND_API_KEY',
    };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `${inviterName} invited you to Meet Without Fear`,
      html: buildInvitationEmailHtml(inviterName, invitationUrl),
      text: buildInvitationEmailText(inviterName, invitationUrl),
    });

    if (error) {
      logger.error('[Email] Failed to send invitation:', error);
      return {
        success: false,
        error: error.message,
      };
    }

    logger.info('[Email] Invitation sent successfully:', data?.id);
    return {
      success: true,
      messageId: data?.id,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    logger.error('[Email] Exception sending invitation:', errorMessage);
    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Build the HTML content for an invitation email
 */
function buildInvitationEmailHtml(inviterName: string, invitationUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Meet Without Fear Invitation</title>
</head>
<body style="
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.6;
  color: #333;
  max-width: 600px;
  margin: 0 auto;
  padding: 20px;
">
  <div style="text-align: center; margin-bottom: 30px;">
    <h1 style="color: #4F46E5; margin-bottom: 10px;">Meet Without Fear</h1>
  </div>

  <div style="background: #F9FAFB; border-radius: 12px; padding: 30px; margin-bottom: 30px;">
    <h2 style="margin-top: 0; color: #111827;">You've been invited</h2>
    <p style="font-size: 16px; color: #4B5563;">
      <strong>${escapeHtml(inviterName)}</strong> wants to work through something together using Meet Without Fear.
    </p>
    <p style="font-size: 14px; color: #6B7280;">
      Meet Without Fear is a guided process that helps two people understand each other better and find common ground.
    </p>
  </div>

  <div style="text-align: center; margin-bottom: 30px;">
    <a href="${escapeHtml(invitationUrl)}" style="
      display: inline-block;
      background: #4F46E5;
      color: white;
      padding: 14px 32px;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      font-size: 16px;
    ">Accept Invitation</a>
  </div>

  <div style="text-align: center; color: #9CA3AF; font-size: 12px;">
    <p>This invitation expires in 7 days.</p>
    <p>If you didn't expect this invitation, you can safely ignore this email.</p>
  </div>
</body>
</html>
  `.trim();
}

/**
 * Build the plain text content for an invitation email
 */
function buildInvitationEmailText(inviterName: string, invitationUrl: string): string {
  return `
You've been invited to Meet Without Fear

${inviterName} wants to work through something together using Meet Without Fear.

Meet Without Fear is a guided process that helps two people understand each other better and find common ground.

Accept the invitation here:
${invitationUrl}

This invitation expires in 7 days.

If you didn't expect this invitation, you can safely ignore this email.
  `.trim();
}

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(text: string): string {
  const htmlEscapes: Record<string, string> = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#x27;',
  };
  return text.replace(/[&<>"']/g, char => htmlEscapes[char] || char);
}
