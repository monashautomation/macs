import { type ReactNode, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { type Job, api, useAct, useClusters, useMe, useVM } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Modal, VMStatus, fmtDateTime, fmtGB, fmtSize, fmtUptime, inputCls } from "../ui";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-mute">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export function JobRow({ job }: { job: Job }) {
  const [open, setOpen] = useState(job.status === "running");
  return (
    <li className="border-b border-line py-2 last:border-0">
      <button className="flex w-full flex-wrap items-center gap-2 text-left text-sm" onClick={() => setOpen(!open)}>
        <Badge tone={job.status === "succeeded" ? "ok" : job.status === "failed" ? "bad" : "brand"}>{job.status}</Badge>
        <span className="font-medium">{job.kind}</span>
        {job.vm_name && <span className="text-mute">{job.vm_name}</span>}
        <span className="ml-auto text-xs text-mute">{job.user?.username ?? "scheduler"} · {fmtDateTime(job.created_at)}</span>
      </button>
      {open && <pre className="mt-2 overflow-x-auto rounded-md bg-sunken p-3 text-xs leading-relaxed">{job.log || "starting…"}</pre>}
    </li>
  );
}

export default function VMDetail() {
  const id = Number(useParams().id);
  const vmq = useVM(id);
  const me = useMe();
  const clusters = useClusters();
  const nav = useNavigate();
  const [dialog, setDialog] = useState<"gpu" | "backup" | null>(null);
  const [text, setText] = useState("");

  const act = useAct((a: { path: string; method?: string; body?: unknown }) => api(a.path, { method: a.method ?? "POST", body: a.body ?? {} }));
  const run = (path: string, body?: unknown, method?: string) => act.mutateAsync({ path, body, method }).catch(() => undefined);

  if (vmq.isError) return <p className="text-sm text-mute">VM not found. <Link className="text-brand underline" to="/">Back to my VMs</Link></p>;
  const vm = vmq.data;
  if (!vm) return null;
  const cluster = clusters.data?.find((c) => c.id === vm.cluster_id);
  const active = vm.status === "active";
  const idle = active && !vm.busy;
  const running = vm.power === "running";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{vm.name}</h1>
        <VMStatus vm={vm} />
        {vm.gpu && <Badge tone="gpu">{vm.gpu} attached</Badge>}
        <div className="ml-auto flex flex-wrap gap-2">
          {active && !running && <Button variant="primary" disabled={!idle} onClick={() => run(`/api/vms/${id}/power`, { action: "start" })}>Start</Button>}
          {active && running && (
            <>
              <Button disabled={!idle} onClick={() => run(`/api/vms/${id}/power`, { action: "reboot" })}>Reboot</Button>
              <Button disabled={!idle} onClick={() => run(`/api/vms/${id}/power`, { action: "shutdown" })}>Shut down</Button>
              <Button variant="danger" disabled={!idle} onClick={() => confirm("Force stop is like pulling the power cord. Continue?") && run(`/api/vms/${id}/power`, { action: "stop" })}>Force stop</Button>
            </>
          )}
        </div>
      </div>

      <ErrorNote error={act.error} />
      {vm.status === "pending" && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">Waiting for an admin to approve this request.</p>}
      {vm.status === "rejected" && <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">Request rejected{vm.review_note && `: ${vm.review_note}`}</p>}
      {vm.status === "error" && <p className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">Provisioning failed: {vm.error}</p>}
      {vm.status === "archived" && <p className="rounded-md bg-sunken px-3 py-2 text-sm text-mute">This VM is archived to the backup server and uses no cluster resources. Restore a backup below to bring it back.</p>}

      <Card title="Details">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label="Cluster">{cluster?.name ?? vm.cluster_id}</Fact>
          <Fact label="Node">{vm.node ?? "—"}</Fact>
          <Fact label="VMID">{vm.vmid ?? "—"}</Fact>
          <Fact label="Owner">{vm.owner.name}</Fact>
          <Fact label="Size">{vm.cores} vCPU · {fmtGB(vm.memory_mb)} · {vm.disk_gb} GB</Fact>
          <Fact label="Image">{cluster?.templates.find((t) => t.id === vm.template_id)?.name ?? (vm.template_id || "—")}</Fact>
          <Fact label="Uptime">{fmtUptime(vm.uptime)}</Fact>
          <Fact label="IP address">{vm.ips.length ? vm.ips.join(", ") : running ? "waiting for guest agent…" : "—"}</Fact>
        </dl>
        {vm.login_user && vm.ips[0] && (
          <pre className="mt-4 overflow-x-auto rounded-md bg-sunken px-3 py-2 text-xs">ssh {vm.login_user}@{vm.ips[0]}</pre>
        )}
      </Card>

      {cluster?.has_gpus && vm.status !== "archived" && (
        <Card title="GPU" actions={vm.gpu_access === "approved" && active && <Link to={`/gpus?vm=${vm.id}`} className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink">Book GPU time</Link>}>
          {vm.gpu_access === "none" && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-sm text-mute">This VM is not approved for GPU use.</p>
              <Button onClick={() => { setText(""); setDialog("gpu"); }}>Request GPU access</Button>
            </div>
          )}
          {vm.gpu_access === "requested" && <p className="text-sm text-warn">GPU access requested — waiting for an admin.</p>}
          {vm.gpu_access === "approved" && (
            vm.reservations.length ? (
              <ul className="text-sm">
                {vm.reservations.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-2 border-b border-line py-2 last:border-0">
                    <Badge tone={r.status === "active" ? "gpu" : r.status === "failed" ? "bad" : r.status === "scheduled" ? "brand" : "neutral"}>{r.status}</Badge>
                    <span>{fmtDateTime(r.start_at)} → {fmtDateTime(r.end_at)}</span>
                    {r.gpu_id && <span className="text-mute">{r.gpu_id}</span>}
                    {r.error && <span className="text-bad">{r.error}</span>}
                    {(r.status === "scheduled" || r.status === "active") && (
                      <Button variant="ghost" className="ml-auto" onClick={() => confirm(r.status === "active" ? "End this booking now? The VM restarts without the GPU." : "Cancel this booking?") && run(`/api/reservations/${r.id}`, undefined, "DELETE")}>
                        {r.status === "active" ? "End now" : "Cancel"}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-mute">Approved for GPU use. The GPU is attached for the duration of each booking; the VM restarts when a booking starts and ends.</p>
          )}
        </Card>
      )}

      {cluster?.has_backups && (active || vm.status === "archived") && (
        <Card title="Backups" actions={active && (
          <>
            <Button disabled={!idle} onClick={() => { setText(""); setDialog("backup"); }}>Back up now</Button>
            <Button disabled={!idle} onClick={() => confirm(`Archive ${vm.name}? It is shut down, backed up and removed from the cluster. You can restore it later.`) && run(`/api/vms/${id}/archive`)}>Archive</Button>
          </>
        )}>
          {vm.backups.length ? (
            <ul className="text-sm">
              {vm.backups.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-3 border-b border-line py-2 last:border-0">
                  <span>{fmtDateTime(b.created_at)}</span>
                  <span className="text-mute">{b.notes || "—"}</span>
                  <span className="text-xs text-mute tabular-nums">{fmtSize(b.size)}</span>
                  <Button variant="ghost" className="ml-auto" disabled={vm.busy}
                    onClick={() => confirm(active ? `Roll ${vm.name} back to this backup? Everything since then is lost.` : `Restore ${vm.name} from this backup?`) && run(`/api/vms/${id}/restore`, { backup_id: b.id })}>
                    {active ? "Roll back" : "Restore"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : <Empty>No backups yet.</Empty>}
        </Card>
      )}

      {vm.jobs.length > 0 && (
        <Card title="Recent activity">
          <ul>{vm.jobs.map((j) => <JobRow key={`${j.id}-${j.status}`} job={j} />)}</ul>
        </Card>
      )}

      {(vm.owner.id === me.data?.id || me.data?.is_admin) && vm.status !== "provisioning" && (
        <div className="flex justify-end">
          <Button variant="danger" disabled={vm.busy}
            onClick={async () => {
              const gone = active || vm.status === "error";
              if (!confirm(gone ? `Delete ${vm.name}? The VM and its disks are destroyed. This cannot be undone.` : `Remove ${vm.name} from your list?`)) return;
              await run(`/api/vms/${id}`, undefined, "DELETE");
              if (!gone) nav("/");
            }}>
            {active || vm.status === "error" ? "Delete VM" : "Remove"}
          </Button>
        </div>
      )}

      {dialog === "gpu" && (
        <Modal title="Request GPU access" onClose={() => setDialog(null)}>
          <Field label="What do you need the GPU for?">
            <textarea className={inputCls} rows={3} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" disabled={!text.trim()} onClick={() => { run(`/api/vms/${id}/gpu-access`, { justification: text }); setDialog(null); }}>Send request</Button>
          </div>
        </Modal>
      )}
      {dialog === "backup" && (
        <Modal title="Back up now" onClose={() => setDialog(null)}>
          <Field label="Note (optional)" hint="The VM keeps running during the backup.">
            <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder="before upgrading CUDA" autoFocus />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDialog(null)}>Cancel</Button>
            <Button variant="primary" onClick={() => { run(`/api/vms/${id}/backups`, { notes: text }); setDialog(null); }}>Start backup</Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
