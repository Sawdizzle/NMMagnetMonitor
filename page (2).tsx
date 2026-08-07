import AssetPageClient from "./AssetPageClient";

export default async function AssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AssetPageClient assetId={id} />;
}
