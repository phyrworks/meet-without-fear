"use client";

import { Suspense, useEffect, useState, useRef } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth, useUser, useClerk, SignIn } from "@clerk/nextjs";
import Link from "next/link";
import {
  Loader2,
  Clock,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Download,
} from "lucide-react";
import { getInvitation, acceptInvitation, InvitationDetails, InvitationClaimedError } from "@/lib/api";
import {
  trackInvitationViewed,
  trackInvitationAccepted,
  trackAppDownload,
} from "@/lib/mixpanel";

const PENDING_INVITATION_KEY = "pending_invitation_id";

type InvitationState =
  | "loading"
  | "not_found"
  | "expired"
  | "accepted"
  | "declined"
  | "signing_out"
  | "needs_auth"
  | "accepting"
  | "success"
  | "error";

export default function InvitationPage() {
  return (
    <Suspense fallback={<LoadingState />}>
      <InvitationPageInner />
    </Suspense>
  );
}

function InvitationPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const invitationId = params.id as string;

  // Detect if user just returned from OAuth redirect (query param survives cross-domain redirects on mobile)
  const isReturningFromOAuth = searchParams.get("returning") === "1";

  const { isSignedIn, isLoaded: isAuthLoaded, getToken } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();

  const [state, setState] = useState<InvitationState>("loading");
  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasSignedOut, setHasSignedOut] = useState(false);
  const hasTrackedView = useRef(false);

  // Sign out any existing session when visiting invitation page
  // This ensures invitees start with a fresh auth state
  // BUT: skip sign-out if user just returned from OAuth (detected via sessionStorage)
  useEffect(() => {
    async function ensureSignedOut() {
      console.log("[Invitation] ensureSignedOut check:", { isAuthLoaded, isSignedIn, hasSignedOut });

      if (!isAuthLoaded) {
        console.log("[Invitation] Waiting for Clerk to load...");
        return;
      }
      if (hasSignedOut) {
        console.log("[Invitation] Already handled sign-out, skipping");
        return;
      }

      // Check if user just returned from OAuth - if so, don't sign them out.
      // Use URL query param (survives mobile cross-domain redirects) with sessionStorage as fallback.
      const pendingInvitation = sessionStorage.getItem(PENDING_INVITATION_KEY);
      if ((isReturningFromOAuth || pendingInvitation === invitationId) && isSignedIn) {
        console.log("[Invitation] User returned from OAuth, keeping signed in to accept");
        setHasSignedOut(true);
        return;
      }

      if (isSignedIn) {
        // work-k5fk.10.41: the visitor who already claimed this invitation (opened it in the app, signed in
        // as this account) keeps their session: signed out, the preview is a stranger's — the claim notice.
        const token = await getToken().catch(() => null);
        const mine = token ? await getInvitation(invitationId, token).catch(() => null) : null;
        if (mine?.claimedByYou) {
          console.log("[Invitation] Signed in as the claimer, keeping the session");
          setHasSignedOut(true);
          return;
        }
        console.log("[Invitation] User is signed in, signing out for fresh auth...");
        setState("signing_out");
        try {
          // Pass redirectUrl to stay on the invitation page after sign-out
          // Without this, Clerk redirects to home page by default
          await signOut({ redirectUrl: `/invitation/${invitationId}` });
          console.log("[Invitation] Sign out successful");
        } catch (err) {
          console.error("[Invitation] Error signing out:", err);
        }
      } else {
        console.log("[Invitation] No existing session, proceeding");
      }
      setHasSignedOut(true);
    }

    ensureSignedOut();
  }, [isAuthLoaded, isSignedIn, signOut, hasSignedOut, invitationId, isReturningFromOAuth, getToken]);

  // Fetch invitation details (only after we've handled sign-out)
  useEffect(() => {
    async function fetchInvitation() {
      console.log("[Invitation] fetchInvitation check:", { invitationId, hasSignedOut });

      if (!invitationId) {
        console.log("[Invitation] No invitation ID, marking not_found");
        setState("not_found");
        if (!hasTrackedView.current) {
          trackInvitationViewed("unknown", "not_found");
          hasTrackedView.current = true;
        }
        return;
      }

      // Wait for sign-out logic to complete
      if (!hasSignedOut) {
        console.log("[Invitation] Waiting for sign-out to complete before fetching...");
        return;
      }

      console.log("[Invitation] Fetching invitation details...");
      try {
        // Signed in (the claimer, or back from OAuth): the caller's own preview (work-k5fk.10.41).
        const token = isSignedIn ? await getToken().catch(() => null) : null;
        const data = await getInvitation(invitationId, token);
        console.log("[Invitation] API response:", data);

        if (!data) {
          console.log("[Invitation] No invitation data, marking not_found");
          setState("not_found");
          if (!hasTrackedView.current) {
            trackInvitationViewed(invitationId, "not_found");
            hasTrackedView.current = true;
          }
          return;
        }

        setInvitation(data);

        // Check invitation status and track view
        if (data.status === "EXPIRED") {
          console.log("[Invitation] Status: EXPIRED");
          setState("expired");
          if (!hasTrackedView.current) {
            trackInvitationViewed(invitationId, "expired");
            hasTrackedView.current = true;
          }
        } else if (data.status === "ACCEPTED") {
          console.log("[Invitation] Status: ACCEPTED");
          setState("accepted");
          if (!hasTrackedView.current) {
            trackInvitationViewed(invitationId, "accepted");
            hasTrackedView.current = true;
          }
        } else if (data.status === "DECLINED") {
          console.log("[Invitation] Status: DECLINED");
          setState("declined");
          if (!hasTrackedView.current) {
            trackInvitationViewed(invitationId, "declined");
            hasTrackedView.current = true;
          }
        } else {
          console.log("[Invitation] Status: PENDING, needs auth");
          setState("needs_auth");
          if (!hasTrackedView.current) {
            trackInvitationViewed(invitationId, "pending");
            hasTrackedView.current = true;
          }
        }
      } catch (err) {
        console.error("[Invitation] Error fetching invitation:", err);
        setError(
          err instanceof InvitationClaimedError ? err.message : "Failed to load invitation. Please try again."
        );
        setState("error");
      }
    }

    fetchInvitation();
  }, [invitationId, hasSignedOut, isSignedIn, getToken]);

  // Handle accepting invitation after auth
  useEffect(() => {
    async function handleAcceptInvitation() {
      console.log("[Invitation] handleAcceptInvitation check:", {
        isAuthLoaded,
        isSignedIn,
        hasInvitation: !!invitation,
        state,
      });

      if (!isAuthLoaded || !isSignedIn || !invitation) {
        console.log("[Invitation] Not ready to accept - missing:", {
          needsAuthLoaded: !isAuthLoaded,
          needsSignIn: !isSignedIn,
          needsInvitation: !invitation,
        });
        return;
      }
      if (state !== "needs_auth") {
        console.log("[Invitation] State is not needs_auth, skipping accept");
        return;
      }

      console.log("[Invitation] User signed in, accepting invitation...");
      setState("accepting");

      try {
        const token = await getToken();
        console.log("[Invitation] Got token:", token ? "yes" : "no");

        if (!token) {
          console.error("[Invitation] No token received");
          setError("Authentication failed. Please try again.");
          setState("error");
          return;
        }

        console.log("[Invitation] Calling accept API...");
        const result = await acceptInvitation(invitationId, token);
        console.log("[Invitation] Accept result:", result);

        if (result.success) {
          console.log("[Invitation] Accept successful!");
          // Clear pending invitation from sessionStorage to prevent redirect loops
          sessionStorage.removeItem(PENDING_INVITATION_KEY);
          setState("success");
          trackInvitationAccepted(invitationId, invitation?.invitedBy?.id);
        } else {
          console.error("[Invitation] Accept failed:", result.error);
          setError(result.error || "Failed to accept invitation");
          setState("error");
        }
      } catch (err) {
        console.error("[Invitation] Error accepting invitation:", err);
        setError("Failed to accept invitation. Please try again.");
        setState("error");
      }
    }

    handleAcceptInvitation();
  }, [isAuthLoaded, isSignedIn, invitation, state, invitationId, getToken]);

  // Render based on state
  console.log("[Invitation] Rendering with state:", state, { isSignedIn, isAuthLoaded });

  if (state === "loading" || state === "signing_out") {
    return <LoadingState />;
  }

  if (state === "not_found") {
    return <NotFoundState />;
  }

  if (state === "expired") {
    return <ExpiredState inviterName={invitation?.invitedBy.name || null} />;
  }

  if (state === "accepted") {
    return <AlreadyAcceptedState inviterName={invitation?.invitedBy.name || null} />;
  }

  if (state === "declined") {
    return <DeclinedState inviterName={invitation?.invitedBy.name || null} />;
  }

  // Show auth UI when invitation needs auth - don't require isAuthLoaded
  // because Clerk's SignIn component handles its own loading state
  if (state === "needs_auth" && !isSignedIn) {
    return (
      <AuthRequiredState
        invitation={invitation}
        invitationId={invitationId}
      />
    );
  }

  if (state === "accepting") {
    return <AcceptingState />;
  }

  if (state === "success") {
    return <SuccessState />;
  }

  if (state === "error") {
    return <ErrorState message={error} onRetry={() => router.refresh()} />;
  }

  // Default loading
  return <LoadingState />;
}

// ============================================================================
// State Components
// ============================================================================

function LoadingState() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center">
        <Loader2 className="w-12 h-12 text-accent animate-spin mx-auto mb-4" />
        <p className="text-muted-foreground">Loading invitation...</p>
      </div>
    </main>
  );
}

function NotFoundState() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-full bg-card flex items-center justify-center mx-auto mb-6">
          <AlertTriangle className="w-10 h-10 text-warning" />
        </div>
        <h1 className="text-2xl font-bold mb-3">Invitation Not Found</h1>
        <p className="text-muted-foreground mb-6">
          We could not find this invitation. It may have been deleted or the link may be incorrect.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-accent hover:text-accent/80"
        >
          <ArrowLeft className="w-4 h-4" />
          Return Home
        </Link>
      </div>
    </main>
  );
}

function ExpiredState({ inviterName }: { inviterName: string | null }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-full bg-card flex items-center justify-center mx-auto mb-6">
          <Clock className="w-10 h-10 text-warning" />
        </div>
        <h1 className="text-2xl font-bold mb-3">Invitation Expired</h1>
        <p className="text-muted-foreground mb-2">
          {inviterName
            ? `The invitation from ${inviterName} has expired.`
            : "This invitation has expired."}
        </p>
        <p className="text-muted-foreground text-sm mb-6">
          Invitations are valid for 7 days. Please ask {inviterName || "the sender"} to send you a new invitation.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-accent hover:text-accent/80"
        >
          <ArrowLeft className="w-4 h-4" />
          Return Home
        </Link>
      </div>
    </main>
  );
}

function AlreadyAcceptedState({ inviterName }: { inviterName: string | null }) {
  const handleDownloadClick = () => {
    // Detect platform for tracking
    const userAgent = navigator.userAgent || navigator.vendor;
    const platform = /android/i.test(userAgent) ? "android" : "ios";
    trackAppDownload(platform, "invitation_already_accepted");
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-full bg-card flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 className="w-10 h-10 text-success" />
        </div>
        <h1 className="text-2xl font-bold mb-3">Invitation Already Accepted</h1>
        <p className="text-muted-foreground mb-6">
          You have already accepted this invitation
          {inviterName ? ` from ${inviterName}` : ""}.
        </p>
        <Link
          href="/app"
          onClick={handleDownloadClick}
          className="inline-flex items-center justify-center gap-2 bg-accent text-accent-foreground px-6 py-3 rounded-xl font-semibold hover:bg-accent/90 transition-all"
        >
          Open Meet Without Fear
          <ArrowRight className="w-5 h-5" />
        </Link>
      </div>
    </main>
  );
}

function DeclinedState({ inviterName }: { inviterName: string | null }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-full bg-card flex items-center justify-center mx-auto mb-6">
          <XCircle className="w-10 h-10 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-bold mb-3">Invitation Declined</h1>
        <p className="text-muted-foreground mb-6">
          This invitation{inviterName ? ` from ${inviterName}` : ""} was declined.
        </p>
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-accent hover:text-accent/80"
        >
          <ArrowLeft className="w-4 h-4" />
          Return Home
        </Link>
      </div>
    </main>
  );
}

function AuthRequiredState({
  invitation,
  invitationId,
}: {
  invitation: InvitationDetails | null;
  invitationId: string;
}) {
  const inviterName = invitation?.invitedBy.name;

  // Store invitation ID before sign-in so we can redirect back after OAuth
  useEffect(() => {
    sessionStorage.setItem(PENDING_INVITATION_KEY, invitationId);
  }, [invitationId]);

  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-background p-6">
      <div className="text-center max-w-md mb-8">
        <h1 className="font-bold mb-3">
          <span className="text-xl block mb-1">
            {inviterName ? `${inviterName} has invited you to` : "You've been invited to"}
          </span>
          <span className="text-3xl block whitespace-nowrap">Meet Without Fear</span>
        </h1>
        <p className="text-muted-foreground">
          A safe space for real conversations.
        </p>
        <p className="text-muted-foreground text-sm mt-2">
          Sign in to begin.
        </p>
      </div>

      <SignIn
        routing="hash"
        appearance={{
          variables: {
            colorPrimary: "#10b981",
          },
          elements: {
            card: "bg-card border border-border shadow-xl py-6",
            // Hide Clerk's header (we have our own above)
            header: "hidden",
            socialButtonsBlockButton: "border-border hover:bg-card text-foreground",
            // Hide email form and divider (social-only login)
            form: "hidden",
            dividerRow: "hidden",
            // Hide sign up link and footer
            footerAction: "hidden",
            footer: "hidden",
          },
          layout: {
            socialButtonsPlacement: "top",
            socialButtonsVariant: "blockButton",
          },
        }}
        forceRedirectUrl={`/invitation/${invitationId}?returning=1`}
      />
    </main>
  );
}

function AcceptingState() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center">
        <Loader2 className="w-12 h-12 text-accent animate-spin mx-auto mb-4" />
        <p className="text-muted-foreground">Accepting invitation...</p>
      </div>
    </main>
  );
}

function SuccessState() {
  const handleDownloadClick = () => {
    // Detect platform for tracking
    const userAgent = navigator.userAgent || navigator.vendor;
    const platform = /android/i.test(userAgent) ? "android" : "ios";
    trackAppDownload(platform, "invitation_success");
  };

  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-full bg-success/20 flex items-center justify-center mx-auto mb-6">
          <CheckCircle2 className="w-10 h-10 text-success" />
        </div>
        <h1 className="text-2xl font-bold mb-3">You&apos;re In!</h1>
        <p className="text-muted-foreground mb-6">
          Your account has been created and linked to this session. Open the app to get started.
        </p>
        <a
          href={process.env.NEXT_PUBLIC_APP_URL || "https://app.meetwithoutfear.com/"}
          className="inline-flex items-center justify-center gap-2 bg-accent text-accent-foreground px-8 py-4 rounded-xl font-semibold text-lg hover:bg-accent/90 transition-all"
        >
          Open Meet Without Fear
        </a>
        <div className="mt-4">
          <Link
            href="/download"
            onClick={handleDownloadClick}
            className="inline-flex items-center justify-center gap-2 text-muted-foreground hover:text-foreground text-sm"
          >
            <Download className="w-4 h-4" />
            Or download the mobile app
          </Link>
        </div>
      </div>
    </main>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="text-center max-w-md">
        <div className="w-20 h-20 rounded-full bg-error/20 flex items-center justify-center mx-auto mb-6">
          <AlertTriangle className="w-10 h-10 text-error" />
        </div>
        <h1 className="text-2xl font-bold mb-3">Something Went Wrong</h1>
        <p className="text-muted-foreground mb-6">
          {message || "An error occurred. Please try again."}
        </p>
        <button
          onClick={onRetry}
          className="inline-flex items-center justify-center gap-2 bg-accent text-accent-foreground px-6 py-3 rounded-xl font-semibold hover:bg-accent/90 transition-all"
        >
          Try Again
        </button>
      </div>
    </main>
  );
}
