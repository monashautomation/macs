import { Link } from "react-router-dom";
import { type Service, useClusters, useMe, useServices } from "../api";
import { Badge, Card, Empty } from "../ui";

export function ServiceAddress({ s }: { s: Service }) {
  if (!s.address) return <span className="text-mute">{s.protocol}/{s.port}</span>;
  return s.url
    ? <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-brand hover:underline">{s.url}</a>
    : <code className="text-xs">{s.address} ({s.protocol})</code>;
}

export default function Services() {
  const services = useServices();
  const clusters = useClusters();
  const me = useMe();
  const hosts = clusters.data?.filter((c) => c.network.services) ?? [];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold">Public services</h1>
        <p className="mt-1 max-w-3xl text-sm text-mute">
          VMs on {hosts.map((c) => c.name).join(" and ") || "the homelab"} cannot reach each other. A VM's owner can publish individual ports,
          which makes them reachable over NetBird. This is everything currently published. To add your own, open one of your VMs.
        </p>
      </div>
      <Card>
        {services.data?.length ? (
          <ul>
            {services.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-2.5 text-sm last:border-0">
                <span className="font-medium">{s.name}</span>
                <ServiceAddress s={s} />
                {s.description && <span className="text-mute">{s.description}</span>}
                <span className="ml-auto text-xs text-mute">
                  {s.owner.id === me.data?.id ? <Link to={`/vms/${s.vm_id}`} className="text-brand hover:underline">{s.vm_name}</Link> : s.vm_name}
                  {" · "}{s.owner.name}
                  {clusters.data && clusters.data.length > 1 && <> · <Badge>{clusters.data.find((c) => c.id === s.cluster_id)?.name}</Badge></>}
                </span>
              </li>
            ))}
          </ul>
        ) : <Empty>{services.isLoading ? "Loading…" : "Nothing is published yet."}</Empty>}
      </Card>
    </div>
  );
}
