import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { type Overview, type Service, api, useAct, useOverview } from "../api";
import { ServiceAddress } from "../pages/Services";
import { Badge, Button, Card, Empty, ErrorNote } from "../ui";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="flex flex-wrap gap-x-3 border-b border-line py-2 text-sm last:border-0"><dt className="w-44 shrink-0 text-mute">{label}</dt><dd className="min-w-0 flex-1">{children}</dd></div>;
}

const list = (items: (string | number)[], none: string) => (items.length ? items.join(", ") : none);

function Policy({ c }: { c: Overview }) {
  const n = c.network;
  const sync = useAct(() => api(`/api/admin/clusters/${c.id}/network/sync`, { method: "POST", body: {} }));
  return (
    <Card title={<span className="flex items-center gap-2">{c.name}{n.isolated ? <Badge tone="brand">isolated</Badge> : <Badge>open LAN</Badge>}</span>}
      actions={n.isolated && <Button disabled={sync.isPending} onClick={() => confirm(`Rewrite the portal's firewall rules on every VM in ${c.name}?`) && sync.mutate()}>Re-apply to all VMs</Button>}>
      {n.firewall_ok === false && <p className="mb-3 rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">The datacenter firewall is off: none of this is being enforced.</p>}
      <dl>
        <Row label="Network">{n.label || "—"} <span className="text-mute">({n.bridge || "template default bridge"}{n.vlan ? `, VLAN ${n.vlan}` : ""})</span></Row>
        {n.isolated ? (
          <>
            <Row label="Between VMs">Blocked. Each VM's firewall drops inbound traffic by default.</Row>
            <Row label="Owner access">Ports {list(n.access_ports, "none")} from {list(n.access_sources, "anywhere")}</Row>
            <Row label="Published services">{n.services ? <>Reachable from {list(n.public_sources, "anywhere")} · {n.service_approval === "required" ? "each needs approval" : "self-service"} · {n.published} open</> : "Not offered"}</Row>
          </>
        ) : <Row label="Between VMs">Not filtered by the portal. VMs sit directly on this network.</Row>}
      </dl>
      <ErrorNote error={sync.error} />
      {sync.isSuccess && <p className="mt-3 text-sm text-ok">Started — follow it under <Link to="/infra/activity" className="underline">Activity</Link>.</p>}
      {n.isolated && <p className="mt-3 text-xs text-mute">Policy is set in <code>config.yaml</code> under this cluster's <code>network</code>. After changing sources or ports, re-apply.</p>}
    </Card>
  );
}

export default function Network() {
  const overview = useOverview();
  const services = useQuery({ queryKey: ["admin-services"], queryFn: () => api<Service[]>("/api/admin/services"), refetchInterval: 15_000 });
  const remove = useAct((id: number) => api(`/api/services/${id}`, { method: "DELETE" }));
  return (
    <div className="space-y-5">
      <h1 className="text-xl font-semibold">Network &amp; services</h1>
      {overview.data?.map((c) => <Policy key={c.id} c={c} />)}
      <Card title="All published services">
        <ErrorNote error={remove.error} />
        {services.data?.length ? (
          <ul className="text-sm">
            {services.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2 last:border-0">
                <Badge tone={s.status === "published" ? "ok" : s.status === "pending" ? "warn" : "bad"}>{s.status}</Badge>
                <span className="font-medium">{s.name}</span>
                <ServiceAddress s={s} />
                <span className="text-xs text-mute"><Link to={`/vms/${s.vm_id}`} className="text-brand hover:underline">{s.vm_name}</Link> · {s.owner.username}</span>
                <Button variant="ghost" className="ml-auto" onClick={() => confirm(`Close ${s.protocol}/${s.port} on ${s.vm_name}?`) && remove.mutate(s.id)}>{s.status === "published" ? "Close port" : "Remove"}</Button>
              </li>
            ))}
          </ul>
        ) : <Empty>No services.</Empty>}
      </Card>
    </div>
  );
}
