import { VmDetail } from "@/components/macs/vm-detail";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <VmDetail id={(await params).id} />;
}
