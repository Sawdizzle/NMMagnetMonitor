"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getDataSource } from "@/lib/dataSource";
import { useDemo } from "@/lib/demoContext";

// The dashboard's way into the morning debrief, with an overnight count on it.
//
// It carries its own fetch rather than riding the dashboard's 30s fleet poll:
// the debrief window only moves once a day, so re-reading it every 30 seconds
// alongside telemetry would be pure noise. Failures render the plain link — a
// missing badge is a much better outcome here than a broken header.
const POLL_MS = 5 * 60_000;

export default function DebriefLink() {
  const { demo, basePath } = useDemo();
  const [opened, setOpened] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { counts, error } = await getDataSource(demo).loadDebrief();
      if (alive && !error) setOpened(counts.opened);
    };
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      alive = false;
      clearInterval(interval);
    };
  }, [demo]);

  return (
    <Link
      href={`${basePath}/debrief`}
      className="btn-secondary inline-flex items-center gap-1.5 shrink-0"
      title="What the monitor opened and resolved since 9am yesterday"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="M6 3.5h9l4 4v13H6z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
        <path d="M9 11h7M9 15h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
      Debrief
      {opened !== null && opened > 0 && (
        <span className="debrief-badge" aria-label={`${opened} alerts opened in the last debrief window`}>
          {opened}
        </span>
      )}
    </Link>
  );
}
