import { Link } from "react-router-dom";
import { type Cluster, type VM, useClusters, useVMs } from "../api";
import { Badge, Card, Empty, VMStatus, fmtGB } from "../ui";

function Meter({ label, used, max, unit = "" }: { label: string; used: number; max: number; unit?: string }) {
  if (!max) return null;
  const pct = Math.min(100, (used / max) * 100);
  return (
    <div className="min-w-24 flex-1">
      <div className="flex justify-between text-xs text-mute">
        <span>{label}</span>
        <span className="tabular-nums">{used}/{max}{unit}</span>
      </div>
      <div className="mt-1 h-1.5 rounded-full bg-sunken">
        <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function ClusterCard({ c }: { c: Cluster }) {
  const q = c.quota;
  const hasQuota = q.max_vms || q.max_cores || q.max_memory_mb || q.max_disk_gb;
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-semibold">{c.name}</h3>
        <Badge tone={c.approval === "none" ? "ok" : "warn"}>{c.approval === "none" ? "self-service" : "needs approval"}</Badge>
        {c.has_gpus && <Badge tone="gpu">{c.gpu_count} GPUs</Badge>}
        {c.has_backups && <Badge>backups</Badge>}
      </div>
      {c.description && <p className="mt-1 text-sm text-mute">{c.description}</p>}
      {c.error ? (
        <p className="mt-3 text-sm text-bad">Cluster unreachable: {c.error}</p>
      ) : (
        <p className="mt-3 text-xs text-mute">
          {c.nodes.filter((n) => n.status === "online").length}/{c.nodes.length} nodes online
        </p>
      )}
      {hasQuota ? (
        <div className="mt-3 flex flex-wrap gap-4">
          <Meter label="VMs" used={c.usage.vms} max={q.max_vms} />
          <Meter label="Cores" used={c.usage.cores} max={q.max_cores} />
          <Meter label="Memory" used={c.usage.memory_mb / 1024} max={q.max_memory_mb / 1024} unit=" GB" />
          <Meter label="Disk" used={c.usage.disk_gb} max={q.max_disk_gb} unit=" GB" />
        </div>
      ) : null}
    </div>
  );
}

export function VMTable({ vms, clusters, showOwner = false }: { vms: VM[]; clusters: Cluster[]; showOwner?: boolean }) {
  const name = (id: string) => clusters.find((c) => c.id === id)?.name ?? id;
  return (
    <div className="-mx-4 overflow-x-auto">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-mute">
            <th className="px-4 py-2 font-medium">Name</th>
            {showOwner && <th className="px-4 py-2 font-medium">Owner</th>}
            <th className="px-4 py-2 font-medium">Cluster</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">Size</th>
            <th className="px-4 py-2 font-medium">GPU</th>
          </tr>
        </thead>
        <tbody>
          {vms.map((vm) => (
            <tr key={vm.id} className="border-b border-line last:border-0 hover:bg-sunken/60">
              <td className="px-4 py-2.5">
                <Link to={`/vms/${vm.id}`} className="font-medium text-brand hover:underline">{vm.name}</Link>
                {vm.vmid != null && <span className="ml-2 text-xs text-mute tabular-nums">#{vm.vmid}</span>}
              </td>
              {showOwner && <td className="px-4 py-2.5 text-mute">{vm.owner.username}</td>}
              <td className="px-4 py-2.5 text-mute">{name(vm.cluster_id)}{vm.node && <span className="text-xs"> · {vm.node}</span>}</td>
              <td className="px-4 py-2.5"><VMStatus vm={vm} /></td>
              <td className="px-4 py-2.5 text-mute tabular-nums">{vm.cores} vCPU · {fmtGB(vm.memory_mb)} · {vm.disk_gb} GB</td>
              <td className="px-4 py-2.5">
                {vm.gpu ? <Badge tone="gpu">{vm.gpu} attached</Badge>
                  : vm.gpu_access === "approved" ? <Badge>eligible</Badge>
                  : vm.gpu_access === "requested" ? <Badge tone="warn">requested</Badge>
                  : <span className="text-mute">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function VMs() {
  const vms = useVMs();
  const clusters = useClusters();
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">My VMs</h1>
        <Link to="/new" className="rounded-md bg-brand px-3 py-1.5 text-sm font-medium text-brand-ink hover:opacity-90">New VM</Link>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {clusters.data?.map((c) => <ClusterCard key={c.id} c={c} />)}
        {clusters.data?.length === 0 && (
          <p className="text-sm text-mute">Your account is not in a group with access to any cluster yet. Ask an admin to add you in Authentik.</p>
        )}
      </div>
      <Card>
        {vms.data?.length ? (
          <VMTable vms={vms.data} clusters={clusters.data ?? []} />
        ) : (
          <Empty>{vms.isLoading ? "Loading…" : "No VMs yet. Create one to get started."}</Empty>
        )}
      </Card>
    </div>
  );
}
