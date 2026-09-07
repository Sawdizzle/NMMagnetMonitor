"use client";

import { useEffect, useRef } from "react";

// One polling loop, used by every surface that re-reads the fleet.
//
// There were ten hand-rolled setInterval effects — the dashboard, the wall
// display, the asset page and its forecast, the debrief and its badge, weather,
// ambient, fleet helium — and each had the same two gaps.
//
// PAUSING. Only the wall display listened for visibilitychange, and only to
// re-arm its wake lock. So a dashboard buried behind twelve other tabs kept
// pulling /api/fleet every thirty seconds and the whole-fleet helium query
// every ten minutes, indefinitely, for nobody. That last one was the slowest
// query in the system before it was indexed.
//
// ABORTING. Nothing carried an AbortSignal, so when a request outlived its own
// interval two were in flight at once and whichever resolved LAST won — which
// could be the older one. The visible symptom is a card flicking back to a
// stale reading, which on this app reads as a magnet changing state.
//
// Both are fixed here rather than ten times over.

export type PollFn = (signal: AbortSignal) => void | Promise<void>;

/**
 * Run `fn` now, then every `intervalMs` — but only while the page is visible.
 *
 * `fn` receives an AbortSignal that fires when the next tick starts, when the
 * page is hidden, or on unmount. It is aborted, not merely ignored, so a slow
 * request stops occupying a connection the moment nobody wants its answer.
 * Callers must still check `signal.aborted` before calling setState: an aborted
 * fetch rejects rather than resolving, and the guard is what keeps a superseded
 * response from overwriting a newer one.
 *
 * Returning to a visible tab runs `fn` IMMEDIATELY rather than waiting out the
 * remaining interval. Coming back to a dashboard that shows what the fleet was
 * doing twenty minutes ago, with a live-looking timestamp, is the failure this
 * avoids.
 */
export function usePolling(fn: PollFn, intervalMs: number, enabled = true): void {
  // The callback is rebuilt on most renders, and depending on its identity
  // would tear down and restart the interval each time — resetting the clock so
  // a fast-rendering page could poll far more often than asked, or never.
  // Kept in a ref so the effect below depends only on the cadence.
  const latest = useRef(fn);
  useEffect(() => {
    latest.current = fn;
  });

  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    let inFlight: AbortController | null = null;
    let stopped = false;

    const run = () => {
      // Abort whatever the previous tick started. Two overlapping requests are
      // exactly the case where the older answer can land last.
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      // Errors are the caller's business — every loadX returns { error } rather
      // than throwing — but a genuine rejection here must not become an
      // unhandled rejection that takes out the page.
      void Promise.resolve(latest.current(controller.signal)).catch(() => {});
    };

    const startInterval = () => {
      if (stopped || timer) return;
      timer = setInterval(run, intervalMs);
    };

    const stopInterval = () => {
      if (timer) clearInterval(timer);
      timer = null;
      inFlight?.abort();
      inFlight = null;
    };

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        // Straight away, not after the remaining interval. Coming back to a
        // dashboard showing what the fleet was doing twenty minutes ago, under
        // a live-looking timestamp, is the failure this avoids.
        run();
        startInterval();
      } else {
        stopInterval();
      }
    };

    // The first read always happens, even into a hidden tab. Only the REPEAT is
    // gated on visibility: gating both is the obvious reading of "don't poll
    // for nobody" and it is wrong — a page opened in a background tab would
    // render empty and stay empty until focused, so middle-clicking three
    // assets to look at in a moment would get you three blank pages.
    run();
    if (document.visibilityState === "visible") startInterval();
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", onVisibility);
      stopInterval();
    };
  }, [intervalMs, enabled]);
}
