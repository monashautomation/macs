import { useState } from "react";
import { Link } from "react-router-dom";
import { api, useAct, useApprovals, useClusters } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, cx, fmtDateTime, fmtGB, inputCls } from "../ui";

export default function Approvals() {
  const q = useApprovals(true);
  const clusters = useClusters();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const review = useAct((a: { kind: "vms" | "services"; id: number; approve: boolean; grant_gpu?: boolean }) =>
    api(`/api/admin/${a.kind}/${a.id}/review`, { method: "POST", body: { approve: a.approve, grant_gpu: !!a.grant_gpu, note: notes[`${a.kind}${a.id}`] ?? "" } }));
  const cname = (id: string) => clusters.data?.find((c) => c.id === id)?.name ?? id;
  const note = (key: string) => (
    <input className={cx(inputCls, "min-w-40 flex-1")} placeholder="Note to the requester (optional)" value={notes[key] ?? ""} onChange={(e) => setNotes({ ...notes, [key]: e.target.value })} />
  );
  const empty = q.data && !q.data.vms.length && !q.data.services.length;
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Approvals</h1>
      <ErrorNote error={review.error} />
      {empty && <Card><Empty>Nothing waiting for approval.</Empty></Card>}
      {q.data?.vms.map((vm) => {
        const gpuOnly = vm.status === "active";
        const wantsGpu = vm.gpu_access === "requested";
        return (
          <Card key={`vm${vm.id}`}>
            <div className="flex flex-wrap items-center gap-2">
              <Link to={`/vms/${vm.id}`} className="font-semibold text-brand hover:underline">{vm.name}</Link>
              <Badge>{cname(vm.cluster_id)}</Badge>
              <Badge tone={gpuOnly ? "gpu" : "brand"}>{gpuOnly ? "GPU access for existing VM" : "new VM"}</Badge>
              {!gpuOnly && wantsGpu && <Badge tone="gpu">wants GPU</Badge>}
              <span className="ml-auto text-xs text-mute">{vm.owner.name} ({vm.owner.username}) · {fmtDateTime(vm.created_at)}</span>
            </div>
            <p className="mt-2 text-sm text-mute tabular-nums">{vm.cores} vCPU · {fmtGB(vm.memory_mb)} · {vm.disk_gb} GB · image {vm.template_id || "—"}</p>
            <p className="mt-2 text-sm whitespace-pre-wrap">{vm.justification || <span className="text-mute">No justification given.</span>}</p>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {note(`vms${vm.id}`)}
              <Button variant="danger" disabled={review.isPending} onClick={() => review.mutate({ kind: "vms", id: vm.id, approve: false })}>Reject</Button>
              {!gpuOnly && wantsGpu && <Button disabled={review.isPending} onClick={() => review.mutate({ kind: "vms", id: vm.id, approve: true })}>Approve without GPU</Button>}
              <Button variant="primary" disabled={review.isPending} onClick={() => review.mutate({ kind: "vms", id: vm.id, approve: true, grant_gpu: true })}>
                {gpuOnly ? "Grant GPU access" : wantsGpu ? "Approve with GPU" : "Approve"}
              </Button>
            </div>
          </Card>
        );
      })}
      {q.data?.services.map((s) => (
        <Card key={`svc${s.id}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{s.name}</span>
            <Badge>{cname(s.cluster_id)}</Badge>
            <Badge tone="brand">publish a service</Badge>
            <span className="ml-auto text-xs text-mute">{s.owner.name} ({s.owner.username}) · {fmtDateTime(s.created_at)}</span>
          </div>
          <p className="mt-2 text-sm text-mute">
            Open <span className="font-medium text-ink">{s.protocol}/{s.port}</span>{s.scheme && ` (${s.scheme})`} on{" "}
            <Link to={`/vms/${s.vm_id}`} className="text-brand hover:underline">{s.vm_name}</Link> to NetBird.
          </p>
          {s.description && <p className="mt-2 text-sm">{s.description}</p>}
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {note(`services${s.id}`)}
            <Button variant="danger" disabled={review.isPending} onClick={() => review.mutate({ kind: "services", id: s.id, approve: false })}>Reject</Button>
            <Button variant="primary" disabled={review.isPending} onClick={() => review.mutate({ kind: "services", id: s.id, approve: true })}>Open the port</Button>
          </div>
        </Card>
      ))}
    </div>
  );
}
