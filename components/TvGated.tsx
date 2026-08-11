"use client";

import { Suspense } from "react";
import Protected from "@/components/Protected";
import TvWall from "@/components/TvWall";

// Client wrapper so the render-prop child can be passed to Protected (a client
// component). The /tv route itself is a server component that owns the page
// metadata, so it can't pass a function child directly — it renders this.
export default function TvGated() {
  return (
    <Protected requireTv>
      {() => (
        <Suspense fallback={null}>
          <TvWall />
        </Suspense>
      )}
    </Protected>
  );
}
