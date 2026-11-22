import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type AdminImage, api, useAct, useClusters } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Modal, cx, fmtSize, inputCls } from "../ui";

interface Listing {
  images: AdminImage[];
  unlisted: { templates: { vmid: number; name: string; node: string }[]; isos: { volid: string; size: number }[] };
  iso_storage: string; error: string | null;
}
type Draft = Partial<AdminImage> & { name: string; kind: "template" | "iso"; tagText: string; connectText: string };

const blank = (over: Partial<Draft>): Draft => ({
  name: "", kind: "template", os: "linux", description: "", default_user: "", cicustom: "", gpu_ready: false, enabled: true, tagText: "", connectText: "", ...over,
});

function Editor({ draft, clusterId, hasGpus, onClose }: { draft: Draft; clusterId: string; hasGpus: boolean; onClose: () => void }) {
  const [d, setD] = useState(draft);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const save = useAct(() => {
    const connect = d.connectText.split(",").map((s) => s.trim()).filter(Boolean);
    const body = {
      name: d.name, description: d.description, os: d.os, default_user: d.default_user, cicustom: d.cicustom, gpu_ready: d.gpu_ready, enabled: d.enabled,
      tags: d.tagText.split(",").map((s) => s.trim()).filter(Boolean), connect: connect.length ? connect : null,
    };
    return (d.db_id
      ? api(`/api/admin/images/${d.db_id}`, { method: "PUT", body })
      : api("/api/admin/images", { method: "POST", body: { ...body, cluster_id: clusterId, kind: d.kind, vmid: d.vmid, volid: d.volid } })
    ).then(onClose);
  });
  const prepared = d.kind === "template";
  return (
    <Modal title={d.db_id ? `Edit ${draft.name}` : "Add to the library"} onClose={onClose}>
      <p className="text-xs text-mute">{prepared ? `Proxmox template #${d.vmid}` : d.volid}</p>
      <Field label="Name shown to users"><input className={inputCls} value={d.name} onChange={(e) => set({ name: e.target.value })} autoFocus /></Field>
      <Field label="Description" hint="What is installed, who it is for."><textarea className={inputCls} rows={3} value={d.description} onChange={(e) => set({ description: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Operating system">
          <select className={inputCls} value={d.os} onChange={(e) => set({ os: e.target.value as AdminImage["os"] })}>
            <option value="linux">Linux</option><option value="windows">Windows</option><option value="other">Other</option>
          </select>
        </Field>
        {prepared && <Field label="Login user" hint="Set by cloud-init on Linux."><input className={inputCls} value={d.default_user} onChange={(e) => set({ default_user: e.target.value })} placeholder="ubuntu" /></Field>}
      </div>
      <Field label="Tags" hint="Comma separated, e.g. desktop, cuda, ros2"><input className={inputCls} value={d.tagText} onChange={(e) => set({ tagText: e.target.value })} /></Field>
      {prepared && (
        <>
          <Field label="Connection methods" hint="Comma separated from ssh, rdp, sunshine. Blank = ssh for Linux, rdp for Windows.">
            <input className={inputCls} value={d.connectText} onChange={(e) => set({ connectText: e.target.value })} placeholder="ssh, sunshine" />
          </Field>
          <Field label="cloud-init vendor snippet (optional)" hint="Proxmox cicustom value, e.g. for NetBird enrolment.">
            <input className={cx(inputCls, "font-mono text-xs")} value={d.cicustom} onChange={(e) => set({ cicustom: e.target.value })} placeholder="vendor=cephfs:snippets/macs-vendor.yaml" />
          </Field>
        </>
      )}
      {hasGpus && (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={!!d.gpu_ready} onChange={(e) => set({ gpu_ready: e.target.checked })} />
          <span>GPU-ready<span className="block text-xs text-mute">NVIDIA drivers are installed, so it works with the passthrough 4090s out of the box.</span></span>
        </label>
      )}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!d.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Visible to users</label>
      <ErrorNote error={save.error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" disabled={!d.name.trim() || save.isPending} onClick={() => save.mutate()}>{d.db_id ? "Save" : "Add"}</Button>
      </div>
    </Modal>
  );
}

export default function ImagesAdmin() {
  const clusters = useClusters();
  const [clusterId, setClusterId] = useState("");
  const cid = clusterId || clusters.data?.[0]?.id || "";
  const cluster = clusters.data?.find((c) => c.id === cid);
  const q = useQuery({ queryKey: ["admin-images", cid], queryFn: () => api<Listing>(`/api/admin/images?cluster_id=${cid}`), enabled: !!cid, refetchInterval: 30_000 });
  const [draft, setDraft] = useState<Draft | null>(null);
  const remove = useAct((id: number) => api(`/api/admin/images/${id}`, { method: "DELETE" }));
  const edit = (i: AdminImage) => setDraft({ ...i, tagText: i.tags.join(", "), connectText: (i.connect ?? []).join(", ") });
  const guessOs = (name: string) => (/win/i.test(name) ? "windows" : /nix|bsd/i.test(name) && !/linux/i.test(name) ? "other" : "linux");
  const data = q.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Image library</h1>
          <p className="mt-1 text-sm text-mute">What users can deploy from. Build templates with Packer (<code>img-builds/</code>) or upload ISOs in Proxmox, then list them here.</p>
        </div>
        <select className={cx(inputCls, "w-auto")} value={cid} onChange={(e) => setClusterId(e.target.value)}>
          {clusters.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {data?.error && <ErrorNote error={`Cluster unreachable, so discovery is unavailable: ${data.error}`} />}
      <ErrorNote error={remove.error} />

      <Card title="In the library">
        {data?.images.length ? (
          <ul className="text-sm">
            {data.images.map((i) => (
              <li key={i.db_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-0">
                <span className={cx("font-medium", !i.enabled && "text-mute line-through")}>{i.name}</span>
                {i.gpu_ready && <Badge tone="gpu">GPU-ready</Badge>}
                <Badge>{i.kind === "iso" ? "ISO" : `template #${i.vmid}`}</Badge>
                {!i.enabled && <Badge>hidden</Badge>}
                {i.missing && <Badge tone="bad">missing on cluster</Badge>}
                {i.tags.map((t) => <Badge key={t}>{t}</Badge>)}
                <span className="text-xs text-mute">{i.vm_count} VM{i.vm_count === 1 ? "" : "s"}</span>
                <span className="ml-auto flex gap-1">
                  <Button variant="ghost" onClick={() => edit(i)}>Edit</Button>
                  <Button variant="ghost" onClick={() => confirm(`Remove ${i.name} from the library? The ${i.kind === "iso" ? "ISO" : "template"} itself stays on the cluster.`) && remove.mutate(i.db_id)}>Remove</Button>
                </span>
              </li>
            ))}
          </ul>
        ) : <Empty>{q.isLoading ? "Loading…" : "The library is empty for this cluster."}</Empty>}
      </Card>

      <Card title="Templates on the cluster not yet listed">
        {data?.unlisted.templates.length ? (
          <ul className="text-sm">
            {data.unlisted.templates.map((t) => (
              <li key={t.vmid} className="flex flex-wrap items-center gap-3 border-b border-line py-2 last:border-0">
                <span className="font-medium">{t.name}</span>
                <span className="text-xs text-mute tabular-nums">#{t.vmid} · {t.node}</span>
                <Button className="ml-auto" onClick={() => setDraft(blank({ kind: "template", vmid: t.vmid, name: t.name, os: guessOs(t.name) }))}>Add to library…</Button>
              </li>
            ))}
          </ul>
        ) : <Empty>Every template on the cluster is listed.</Empty>}
      </Card>

      <Card title={`ISO installers${data?.iso_storage ? ` on ${data.iso_storage}` : ""}`}>
        {!data?.iso_storage ? (
          <Empty>Set <code>iso_storage</code> for this cluster in config.yaml to offer ISO installs.</Empty>
        ) : data.unlisted.isos.length ? (
          <ul className="text-sm">
            {data.unlisted.isos.map((i) => {
              const file = i.volid.split("/").pop()!;
              return (
                <li key={i.volid} className="flex flex-wrap items-center gap-3 border-b border-line py-2 last:border-0">
                  <span className="font-mono text-xs">{file}</span>
                  <span className="text-xs text-mute tabular-nums">{fmtSize(i.size)}</span>
                  <Button className="ml-auto" onClick={() => setDraft(blank({ kind: "iso", volid: i.volid, name: file.replace(/\.iso$/i, ""), os: guessOs(file) }))}>Add to library…</Button>
                </li>
              );
            })}
          </ul>
        ) : <Empty>Every ISO on the storage is listed.</Empty>}
      </Card>

      {draft && <Editor key={draft.db_id ?? draft.vmid ?? draft.volid} draft={draft} clusterId={cid} hasGpus={!!cluster?.has_gpus} onClose={() => setDraft(null)} />}
    </div>
  );
}
