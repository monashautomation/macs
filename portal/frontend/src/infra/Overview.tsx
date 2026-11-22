import { Link } from "react-router-dom";
import { type Overview, useOverview } from "../api";
import { Badge, Card, cx } from "../ui";

function Stat({ label, value, sub, tone }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "warn" }) {
  return (
    <div>
      <dt className="text-xs text-mute">{label}</dt>
      <dd className={cx("mt-0.5 text-2xl font-semibold tabular-nums", tone === "warn" && "text-warn")}>{value}</dd>
      {sub && <dd className="text-xs text-mute">{sub}</dd>}
    </div>
  );
}

function Bar({ value, max, tone = "bg-brand" }: { value: number; max: number; tone?: string }) {
  const pct = max ? Math.min(100, (value / max) * 100) : 0;
  return <div className="h-1.5 rounded-full bg-sunken"><div className={cx("h-full rounded-full", pct > 90 ? "bg-bad" : tone)} style={{ width: `${pct}%` }} /></div>;
}

function ClusterPanel({ c }: { c: Overview }) {
  const waiting = c.pending.vms + c.pending.gpu + c.pending.services;
  return (
    <Card title={<span className="flex flex-wrap items-center gap-2">{c.name}<Badge>{c.kind}</Badge>{c.network.isolated && <Badge>isolated network</Badge>}</span>}
      actions={waiting > 0 && <Link to="/infra/approvals" className="rounded-md bg-warn-soft px-2.5 py-1 text-xs font-medium text-warn">{waiting} waiting for approval →</Link>}>
      {c.error && <p className="mb-4 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">Cluster unreachable: {c.error}</p>}
      {c.network.firewall_ok === false && (
        <p className="mb-4 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">
          The datacenter firewall is switched off on this cluster, so VM isolation is <strong>not being enforced</strong>. Enable it under Datacenter → Firewall → Options.
        </p>
      )}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
        <Stat label="Portal VMs" value={c.vms.managed} sub={`${c.vms.running} running · ${c.vms.owners} ${c.vms.owners === 1 ? "person" : "people"}`} />
        <Stat label="Not managed" value={c.vms.unmanaged} sub={c.vms.unmanaged ? <Link to="/infra/machines" className="text-brand hover:underline">adopt them</Link> : "all VMs are tracked"} tone={c.vms.unmanaged ? "warn" : undefined} />
        {c.gpus
          ? <Stat label="GPUs in use" value={`${c.gpus.in_use}/${c.gpus.total}`} sub={`${c.gpus.booked} booked now · ${c.gpus.upcoming} upcoming`} />
          : <Stat label="Published services" value={c.network.published} sub={c.network.services ? "open ports" : "not offered"} />}
        <Stat label="Images" value={c.images} sub={`${c.vms.archived} VMs archived`} />
      </dl>
      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <div className="mb-1 flex justify-between text-xs text-mute"><span>vCPUs allocated</span><span className="tabular-nums">{c.allocated.cores} / {c.capacity.cores}</span></div>
          <Bar value={c.allocated.cores} max={c.capacity.cores} />
        </div>
        <div>
          <div className="mb-1 flex justify-between text-xs text-mute"><span>Memory allocated</span><span className="tabular-nums">{Math.round(c.allocated.memory_mb / 1024)} / {Math.round(c.capacity.memory_mb / 1024)} GB</span></div>
          <Bar value={c.allocated.memory_mb} max={c.capacity.memory_mb} />
        </div>
      </div>
      {c.nodes.length > 0 && (
        <div className="mt-5 grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
          {c.nodes.map((n) => (
            <div key={n.node}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium">{n.node}</span>
                <span className={n.status === "online" ? "text-mute" : "text-bad"}>
                  {n.status === "online" ? `CPU ${Math.round(n.cpu * 100)}% · RAM ${Math.round((n.mem / (n.maxmem || 1)) * 100)}%` : n.status}
                </span>
              </div>
              <Bar value={n.mem} max={n.maxmem} tone="bg-ok" />
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

export default function OverviewPage() {
  const q = useOverview();
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Overview</h1>
      {q.data?.map((c) => <ClusterPanel key={c.id} c={c} />)}
      {q.isError && <p className="text-sm text-bad">Could not load the overview.</p>}
    </div>
  );
}
