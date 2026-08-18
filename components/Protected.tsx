"use client";

import LoginScreen from "./LoginScreen";
import AppNav from "./AppNav";
import { useAuth } from "@/lib/auth";
import type { Session } from "@/lib/auth";

export default function Protected({
  requireAdmin = false,
  requireTv = false,
  requireDocs = false,
  children,
}: {
  requireAdmin?: boolean;
  requireTv?: boolean;
  requireDocs?: boolean;
  children: (session: Session) => React.ReactNode;
}) {
  const { session, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[var(--text-muted)]" role="status" aria-live="polite">
        Loading&hellip;
      </div>
    );
  }
  if (!session) {
    return <LoginScreen />;
  }

  // Admins always pass. TV access is a separate per-user grant for viewers.
  const isAdmin = session.role === "admin";
  // requireDocs mirrors requireTv. It hides the page and its nav entry; the
  // values themselves are withheld server-side (app/docs/page.tsx), because a
  // check here runs only after the bundle has reached the browser.
  const denied =
    (requireAdmin && !isAdmin) ||
    (requireTv && !isAdmin && !session.tvAccess) ||
    (requireDocs && !isAdmin && !session.docsAccess);
  return (
    <>
      <AppNav session={session} />
      {denied ? (
        <div className="min-h-screen flex items-center justify-center text-[var(--text-muted)] text-sm" role="alert">
          You don&apos;t have access to this page.
        </div>
      ) : (
        children(session)
      )}
    </>
  );
}
