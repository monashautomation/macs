import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { type Job, type UserRef, type VM, api, useAct, useApprovals, useClusters, useVMs } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Modal, cx, fmtDateTime, fmtGB, inputCls } from "../ui";
import { JobRow } from "./VMDetail";
import { VMTable } from "./VMs";

function Approvals() {
  const q = useApprovals(true);
  const clusters = useClusters();
  const [notes, setNotes] = useState<Record<number, string>>({});
  const review = useAct((a: { id: number; approve: boolean; grant_gpu: boolean }) =>
    api(`/api/admin/vms/${a.id}/review`, { method: "POST", body: { approve: a.approve, grant_gpu: a.grant_gpu, note: notes[a.id] ?? "" } }));
  if (!q.data?.length) return <Card><Empty>Nothing waiting for approval.</Empty></Card>;
  return (
    <div className="space-y-4">
      <ErrorNote error={review.error} />
      {q.data.map((vm: VM) => {
        const gpuOnly = vm.status === "active";
        const wantsGpu = vm.gpu_access === "requested";
        return (
          <Card key={vm.id}>
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/vms/${vm.id}`} className="font-semibold text-brand hover:underline">{vm.name}</Link>
              <Badge>{clusters.data?.find((c) => c.id === vm.cluster_id)?.name ?? vm.cluster_id}</Badge>
              <Badge tone={gpuOnly ? "gpu" : "brand"}>{gpuOnly ? "GPU access for existing VM" : "new VM"}</Badge>
              {!gpuOnly && wantsGpu && <Badge tone="gpu">wants GPU</Badge>}
              <span className="ml-auto text-xs text-mute">{vm.owner.name} ({vm.owner.username}) · {fmtDateTime(vm.created_at)}</span>
            </div>
            <p className="mt-2 text-sm text-mute tabular-nums">{vm.cores} vCPU · {fmtGB(vm.memory_mb)} · {vm.disk_gb} GB · image {vm.template_id || "—"}</p>
            <p className="mt-2 text-sm whitespace-pre-wrap">{vm.justification || <span className="text-mute">No justification given.</span>}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input className={cx(inputCls, "min-w-40 flex-1")} placeholder="Note to the requester (optional)" value={notes[vm.id] ?? ""} onChange={(e) => setNotes({ ...notes, [vm.id]: e.target.value })} />
              <Button variant="danger" disabled={review.isPending} onClick={() => review.mutate({ id: vm.id, approve: false, grant_gpu: false })}>Reject</Button>
              {!gpuOnly && wantsGpu && <Button disabled={review.isPending} onClick={() => review.mutate({ id: vm.id, approve: true, grant_gpu: false })}>Approve without GPU</Button>}
              <Button variant="primary" disabled={review.isPending} onClick={() => review.mutate({ id: vm.id, approve: true, grant_gpu: true })}>
                {gpuOnly ? "Grant GPU access" : wantsGpu ? "Approve with GPU" : "Approve"}
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function AllVMs() {
  const vms = useVMs("all");
  const clusters = useClusters();
  return <Card>{vms.data?.length ? <VMTable vms={vms.data} clusters={clusters.data ?? []} showOwner /> : <Empty>No VMs.</Empty>}</Card>;
}

interface Unmanaged { vmid: number; name: string; node: string; status: string }

function Adopt() {
  const clusters = useClusters();
  const [clusterId, setClusterId] = useState("");
  const cid = clusterId || clusters.data?.[0]?.id || "";
  const list = useQuery({ queryKey: ["unmanaged", cid], queryFn: () => api<Unmanaged[]>(`/api/admin/unmanaged?cluster_id=${cid}`), enabled: !!cid });
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<(UserRef & { email: string })[]>("/api/admin/users") });
  const [target, setTarget] = useState<Unmanaged | null>(null);
  const [owner, setOwner] = useState("");
  const [gpu, setGpu] = useState(false);
  const adopt = useAct(() => api("/api/admin/vms/adopt", { method: "POST", body: { cluster_id: cid, vmid: target!.vmid, owner, gpu_access: gpu } }).then(() => setTarget(null)));
  return (
    <Card title="VMs on the cluster that the portal does not manage" actions={
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
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={gpu} onChange={(e) => setGpu(e.target.checked)} /> Approved for GPU use</label>
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

function Jobs() {
  const q = useQuery({ queryKey: ["jobs", "all"], queryFn: () => api<Job[]>("/api/jobs?scope=all&limit=100"), refetchInterval: 5000 });
  return <Card>{q.data?.length ? <ul>{q.data.map((j) => <JobRow key={`${j.id}-${j.status}`} job={j} />)}</ul> : <Empty>No activity yet.</Empty>}</Card>;
}

interface AuditRow { id: number; at: string; user: UserRef | null; action: string; target: string; detail: string }

function AuditLog() {
  const q = useQuery({ queryKey: ["audit"], queryFn: () => api<AuditRow[]>("/api/admin/audit"), refetchInterval: 15_000 });
  return (
    <Card>
      <div className="-mx-4 overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <tbody>
            {q.data?.map((a) => (
              <tr key={a.id} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-xs whitespace-nowrap text-mute">{fmtDateTime(a.at)}</td>
                <td className="px-4 py-2">{a.user?.username ?? "system"}</td>
                <td className="px-4 py-2 font-medium">{a.action}</td>
                <td className="px-4 py-2 text-mute">{a.target}</td>
                <td className="px-4 py-2 text-xs text-mute">{a.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const tabs = { Approvals, "All VMs": AllVMs, Unmanaged: Adopt, Activity: Jobs, "Audit log": AuditLog } as const;

export default function Admin() {
  const [tab, setTab] = useState<keyof typeof tabs>("Approvals");
  const approvals = useApprovals(true);
  const Tab = tabs[tab];
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Admin</h1>
      <div className="flex flex-wrap gap-1 border-b border-line">
        {(Object.keys(tabs) as (keyof typeof tabs)[]).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", t === tab ? "border-brand text-brand" : "border-transparent text-mute hover:text-ink")}>
            {t}{t === "Approvals" && !!approvals.data?.length && ` (${approvals.data.length})`}
          </button>
        ))}
      </div>
      <Tab />
    </div>
  );
}
