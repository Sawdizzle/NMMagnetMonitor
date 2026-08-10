"use client";

import LoginScreen from "./LoginScreen";
import AppNav from "./AppNav";
import { useAuth } from "@/lib/auth";
import type { Session } from "@/lib/auth";

export default function Protected({
  requireAdmin = false,
  children,
}: {
  requireAdmin?: boolean;
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

  const denied = requireAdmin && session.role !== "admin";
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
