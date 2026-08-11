"use client";

import Protected from "@/components/Protected";
import DocsContent from "@/components/DocsContent";
import { realInfra } from "@/lib/docsInfra";

export default function DocsPage() {
  return <Protected>{() => <DocsContent infra={realInfra} />}</Protected>;
}
