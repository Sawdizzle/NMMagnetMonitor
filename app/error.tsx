"use client";

// Catches uncaught render/runtime errors within a route segment and shows a
// recoverable message instead of a blank screen. Must be a client component.
import { useEffect } from "react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface the error in the console for debugging; the digest ties a client
    // report back to the server-side log entry when this runs in production.
    console.error(error);
  }, [error]);

  return (
    <div
      id="main-content"
      className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center"
      role="alert"
    >
      <p className="eyebrow">Something went wrong</p>
      <h1 className="text-2xl font-semibold tracking-tight">This page hit an error</h1>
      <p className="text-sm text-[var(--text-muted)] max-w-sm">
        The dashboard ran into an unexpected problem. You can retry, or head back to the fleet view.
      </p>
      <div className="flex items-center gap-3 mt-2">
        <button onClick={reset} className="btn-primary">
          Try again
        </button>
        <a href="/" className="btn-secondary inline-flex items-center">
          Back to fleet
        </a>
      </div>
    </div>
  );
}
