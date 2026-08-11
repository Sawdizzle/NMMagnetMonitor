// Route-level fallback shown while a segment's code/data streams in. Matches
// the muted "Loading…" treatment used by the auth gate and asset detail so
// navigation feels instant rather than blank.
export default function Loading() {
  return (
    <div
      className="min-h-screen flex items-center justify-center text-[var(--text-muted)]"
      role="status"
      aria-live="polite"
    >
      Loading&hellip;
    </div>
  );
}
