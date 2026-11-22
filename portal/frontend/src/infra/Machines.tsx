import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { type UserRef, api, useAct, useClusters, useVMs } from "../api";
import { VMTable } from "../pages/VMs";
import { Button, Card, Empty, ErrorNote, Field, Modal, cx, inputCls } from "../ui";

interface Unmanaged { vmid: number; name: string; node: string; status: string }

function Adopt() {
  const clusters = useClusters();
  const [clusterId, setClusterId] = useState("");
  const cid = clusterId || clusters.data?.[0]?.id || "";
  const cluster = clusters.data?.find((c) => c.id === cid);
  const list = useQuery({ queryKey: ["unmanaged", cid], queryFn: () => api<Unmanaged[]>(`/api/admin/unmanaged?cluster_id=${cid}`), enabled: !!cid });
  const users = useQuery({ queryKey: ["people"], queryFn: () => api<UserRef[]>("/api/admin/people") });
  const [target, setTarget] = useState<Unmanaged | null>(null);
  const [owner, setOwner] = useState("");
  const [gpu, setGpu] = useState(false);
  const adopt = useAct(() => api("/api/admin/vms/adopt", { method: "POST", body: { cluster_id: cid, vmid: target!.vmid, owner, gpu_access: gpu } }).then(() => setTarget(null)));
  return (
    <Card title="On the cluster but not managed by the portal" actions={
      <select className={cx(inputCls, "w-auto py-1")} value={cid} onChange={(e) => setClusterId(e.target.value)}>
        {clusters.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    }>
      <ErrorNote error={list.error} />
      {list.data?.length ? (
        <ul className="text-sm">
          {list.data.map((v) => (
            <li key={v.vmid} className="flex flex-wrap items-center gap-3 border-b border-line py-2 last:border-0">
              <span className="font-medium">{v.name || "(unnamed)"}</span>
              <span className="text-xs text-mute tabular-nums">#{v.vmid} · {v.node} · {v.status}</span>
              <Button className="ml-auto" onClick={() => { setTarget(v); setOwner(""); setGpu(false); adopt.reset(); }}>Assign to a user…</Button>
            </li>
          ))}
        </ul>
      ) : <Empty>{list.isLoading ? "Loading…" : "Every VM on this cluster is managed by the portal."}</Empty>}
      {target && (
        <Modal title={`Adopt ${target.name || target.vmid}`} onClose={() => setTarget(null)}>
          <Field label="Owner" hint="Only people who have signed in to the portal are listed.">
            <select className={inputCls} value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Choose a user…</option>
              {users.data?.map((u) => <option key={u.id} value={u.username}>{u.name} ({u.username})</option>)}
            </select>
          </Field>
          {cluster?.has_gpus && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={gpu} onChange={(e) => setGpu(e.target.checked)} /> Approved for GPU use</label>}
          {cluster?.network.isolated && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">This cluster isolates VMs: adopting turns on the VM's firewall and blocks inbound traffic except the owner's access ports.</p>}
          <ErrorNote error={adopt.error} />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setTarget(null)}>Cancel</Button>
            <Button variant="primary" disabled={!owner || adopt.isPending} onClick={() => adopt.mutate()}>Adopt</Button>
          </div>
        </Modal>
      )}
    </Card>
  );
}

export default function Machines() {
  const vms = useVMs("all");
  const clusters = useClusters();
  const [q, setQ] = useState("");
  const rows = (vms.data ?? []).filter((v) => !q || `${v.name} ${v.owner.username} ${v.owner.name} ${v.vmid}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Virtual machines</h1>
        <input className={cx(inputCls, "w-64")} placeholder="Filter by name, owner or VMID" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <Card>{rows.length ? <VMTable vms={rows} clusters={clusters.data ?? []} showOwner /> : <Empty>{vms.isLoading ? "Loading…" : "No VMs."}</Empty>}</Card>
      <Adopt />
    </div>
  );
}
