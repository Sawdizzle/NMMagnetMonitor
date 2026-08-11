import { Suspense } from "react";
import TvWall from "@/components/TvWall";

// Same TV/Display component as the live app; the /demo layout's DemoProvider
// routes it to fixtures + neutral branding. The full-screen TV overlay covers
// the demo nav/banner, and TvWall keeps its own small DEMO marker so a demo
// screenshot stays unmistakable.
export default function DemoTvPage() {
  return (
    <Suspense fallback={null}>
      <TvWall />
    </Suspense>
  );
}
