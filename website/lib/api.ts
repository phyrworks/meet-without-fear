const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3000";

export interface InvitationDetails {
  id: string;
  invitedBy: {
    id: string;
    name: string;
  };
  name: string | null;
  status: "PENDING" | "ACCEPTED" | "DECLINED" | "EXPIRED";
  createdAt: string;
  expiresAt: string;
  session: {
    id: string;
    status: string;
  };
  /** The signed-in caller is the one who claimed it (work-k5fk.10.41); false signed out or unclaimed. */
  claimedByYou?: boolean;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string | { code?: string; message?: string; details?: unknown };
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object") {
    const message = "message" in error ? error.message : null;
    if (typeof message === "string" && message.trim()) {
      return message;
    }
  }

  return fallback;
}

/** Someone else opened the invitation first and so is its invitee (backend 403, work-k5fk.10.8). */
export class InvitationClaimedError extends Error {}

/**
 * Fetch invitation details from the backend. With `token` (a signed-in visitor) the preview is the
 * caller's: its claimer reads past the claim notice (work-k5fk.10.41); without it, a stranger's.
 */
export async function getInvitation(invitationId: string, token?: string | null): Promise<InvitationDetails | null> {
  try {
    const response = await fetch(`${API_URL}/api/invitations/${invitationId}`, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      if (response.status === 403) {
        const body: ApiResponse<never> = await response.json().catch(() => ({ success: false }));
        throw new InvitationClaimedError(
          getErrorMessage(body.error, "This invitation has already been opened by someone else")
        );
      }
      throw new Error("Failed to fetch invitation");
    }

    const data: ApiResponse<{ invitation: InvitationDetails }> = await response.json();
    return data.data?.invitation || null;
  } catch (error) {
    if (error instanceof InvitationClaimedError) throw error;
    console.error("Error fetching invitation:", error);
    return null;
  }
}

/**
 * Accept an invitation (requires authentication)
 */
export async function acceptInvitation(
  invitationId: string,
  token: string
): Promise<{ success: boolean; sessionId?: string; error?: string }> {
  try {
    const response = await fetch(`${API_URL}/api/invitations/${invitationId}/accept`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const data = await response.json();

    if (!response.ok) {
      return {
        success: false,
        error: getErrorMessage(data.error, "Failed to accept invitation"),
      };
    }

    return { success: true, sessionId: data.data?.session?.id };
  } catch (error) {
    console.error("Error accepting invitation:", error);
    return { success: false, error: "Network error. Please try again." };
  }
}
