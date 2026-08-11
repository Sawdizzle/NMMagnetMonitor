import DocsContent from "@/components/DocsContent";
import { demoInfra } from "@/lib/docsInfra";

// Full knowledge base with every Numed-specific identifier swapped for neutral
// placeholders (see lib/docsInfra.ts).
export default function DemoDocsPage() {
  return <DocsContent infra={demoInfra} />;
}
