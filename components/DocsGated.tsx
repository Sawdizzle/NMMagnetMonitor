"use client";

import Protected from "@/components/Protected";
import DocsContent from "@/components/DocsContent";
import type { DocsInfra } from "@/lib/docsInfra";

/**
 * Client wrapper for the live runbook.
 *
 * Exists because app/docs/page.tsx had to become a server component to keep
 * realInfra out of the browser bundle, while the surrounding chrome — the nav,
 * the login screen, the "no access" message — is all client-side in Protected.
 *
 * `infra` is null whenever the server decided this caller may not read the
 * runbook. Protected renders the same denial for them, so the null branch is
 * belt-and-braces: if the two checks ever disagree, this fails CLOSED rather
 * than rendering a page with blank identifiers.
 */
export default function DocsGated({ infra }: { infra: DocsInfra | null }) {
  return (
    <Protected requireDocs>
      {() =>
        infra ? (
          <DocsContent infra={infra} />
        ) : (
          <div
            className="min-h-screen flex items-center justify-center text-[var(--text-muted)] text-sm"
            role="alert"
          >
            You don&apos;t have access to this page.
          </div>
        )
      }
    </Protected>
  );
}
