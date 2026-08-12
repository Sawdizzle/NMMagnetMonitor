import Link from "next/link";
import BrandMark from "@/components/BrandMark";

export default function NotFound() {
  return (
    <div
      id="main-content"
      className="min-h-screen flex flex-col items-center justify-center gap-4 p-6 text-center"
      role="main"
    >
      <span className="dash-mark" aria-hidden="true">
        <BrandMark size="100%" bleed />
      </span>
      <p className="eyebrow">Error 404</p>
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="text-sm text-[var(--text-muted)] max-w-sm">
        This page doesn&apos;t exist or may have moved. The asset you&apos;re looking for might have been
        renamed or removed.
      </p>
      <Link href="/" className="btn-primary inline-flex items-center mt-2">
        Back to fleet
      </Link>
    </div>
  );
}
