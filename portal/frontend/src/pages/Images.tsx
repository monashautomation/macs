import { useState } from "react";
import { Link } from "react-router-dom";
import { type Cluster, type Image, useClusters } from "../api";
import { Badge, Empty, cx } from "../ui";

const osLabel = { linux: "Linux", windows: "Windows", other: "Other" } as const;

export function ImageBadges({ image }: { image: Image }) {
  return (
    <>
      {image.gpu_ready && <Badge tone="gpu">GPU-ready</Badge>}
      <Badge>{image.kind === "iso" ? "ISO installer" : "ready to boot"}</Badge>
      <Badge>{osLabel[image.os]}</Badge>
      {image.tags.map((t) => <Badge key={t}>{t}</Badge>)}
    </>
  );
}

function ImageCard({ image, cluster }: { image: Image; cluster: Cluster }) {
  return (
    <div className={cx("flex flex-col rounded-xl border bg-panel p-4", image.gpu_ready ? "border-gpu/40" : "border-line")}>
      <h3 className="font-semibold">{image.name}</h3>
      <p className="text-xs text-mute">{cluster.name}</p>
      <div className="mt-2 flex flex-wrap gap-1.5"><ImageBadges image={image} /></div>
      <p className="mt-3 flex-1 text-sm text-mute">
        {image.description || (image.kind === "iso" ? "Boots the installer on an empty disk; you install the OS from the console." : "Cloned from a prepared template.")}
      </p>
      <Link to={`/new?cluster=${cluster.id}&image=${image.id}`} className="mt-4 self-start rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink hover:opacity-90">
        Deploy
      </Link>
    </div>
  );
}

export default function Images() {
  const clusters = useClusters();
  const [clusterId, setClusterId] = useState("all");
  const [filter, setFilter] = useState<"all" | "gpu" | "template" | "iso">("all");
  if (!clusters.data) return null;
  const rows = clusters.data
    .filter((c) => clusterId === "all" || c.id === clusterId)
    .flatMap((c) => c.images.map((image) => ({ image, cluster: c })))
    .filter(({ image }) => filter === "all" || (filter === "gpu" ? image.gpu_ready : image.kind === filter));
  const chip = (active: boolean) => cx("rounded-full border px-3 py-1 text-sm", active ? "border-brand bg-brand-soft text-brand" : "border-line text-mute hover:text-ink");
  const anyGpu = clusters.data.some((c) => c.images.some((i) => i.gpu_ready));
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Image library</h1>
        <p className="mt-1 text-sm text-mute">Prepared images boot ready to use with your SSH key. ISO installers give you an empty machine to set up yourself from the console.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className={chip(clusterId === "all")} onClick={() => setClusterId("all")}>All clusters</button>
        {clusters.data.map((c) => <button key={c.id} className={chip(clusterId === c.id)} onClick={() => setClusterId(c.id)}>{c.name}</button>)}
        <span className="mx-1 w-px bg-line" />
        <button className={chip(filter === "all")} onClick={() => setFilter("all")}>Everything</button>
        {anyGpu && <button className={chip(filter === "gpu")} onClick={() => setFilter("gpu")}>GPU-ready</button>}
        <button className={chip(filter === "template")} onClick={() => setFilter("template")}>Ready to boot</button>
        <button className={chip(filter === "iso")} onClick={() => setFilter("iso")}>ISO installers</button>
      </div>
      {rows.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ image, cluster }) => <ImageCard key={`${cluster.id}/${image.id}`} image={image} cluster={cluster} />)}
        </div>
      ) : <Empty>No images match.</Empty>}
    </div>
  );
}
