"use client";

import Link from "next/link";
import Protected from "@/components/Protected";
import Dashboard from "./Dashboard";
import type { Session } from "@/lib/auth";

export default function DashboardGated() {
  return (
    <Protected>
      {(session) => (
        <>
          <TopNav session={session} />
          <Dashboard />
        </>
      )}
    </Protected>
  );
}

function TopNav({ session }: { session: Session }) {
  return (
    <nav
      aria-label="User menu"
      className="flex items-center justify-end gap-4 px-6 md:px-10 pt-4 text-xs text-[var(--text-dim)]"
    >
      {session.role === "admin" && (
        <Link href="/admin" className="hover:text-[var(--accent)]">
          Admin
        </Link>
      )}
      <Link href="/account" className="hover:text-[var(--accent)]">
        {session.username}
      </Link>
    </nav>
  );
}
