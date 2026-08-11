"use client";

import Protected from "@/components/Protected";
import AssetDetail from "@/components/AssetDetail";

export default function AssetPageClient({ assetId }: { assetId: string }) {
  return <Protected>{() => <AssetDetail assetId={assetId} />}</Protected>;
}
