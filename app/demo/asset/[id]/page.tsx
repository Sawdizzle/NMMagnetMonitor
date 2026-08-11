import AssetDetail from "@/components/AssetDetail";

export default async function DemoAssetPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AssetDetail assetId={id} />;
}
