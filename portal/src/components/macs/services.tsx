"use client";

import { Badge } from "@monashautomation/ui/badge";
import { EmptyState } from "@monashautomation/ui/empty-state";
import { PageHeader } from "@monashautomation/ui/page-header";
import { SectionCard } from "@monashautomation/ui/section-card";
import { Globe } from "lucide-react";
import Link from "next/link";
import { useClusters, useServices, useSession } from "@/lib/client";
import { ServiceAddress } from "./common";
import { HelpTip } from "./help";

export function Services() {
  const services = useServices();
  const clusters = useClusters();
  const me = useSession();
  const hosts = clusters.data?.filter((c) => c.network.services).map((c) => c.name) ?? [];
  return (
    <>
      <PageHeader
        title="Public services"
        description={
          <>
            {`VMs on ${hosts.join(" and ") || "the homelab"} cannot reach each other. A VM's owner can publish individual ports, which makes them reachable over NetBird. To add your own, open one of your VMs.`}{" "}
            <HelpTip topic="serviceList" label="published services" />
          </>
        }
      />
      {services.data?.length ? (
        <SectionCard>
          <ul>
            {services.data.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border py-2.5 text-sm last:border-0"
              >
                <span className="font-semibold">{s.name}</span>
                <ServiceAddress s={s} />
                {s.description ? <span className="text-muted-foreground">{s.description}</span> : null}
                <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
                  {s.owner.id === me.data?.id ? <Link href={`/vms/${s.vmId}`}>{s.vmName}</Link> : s.vmName} ·{" "}
                  {s.owner.name}
                  {clusters.data && clusters.data.length > 1 ? (
                    <Badge variant="secondary">{clusters.data.find((c) => c.id === s.clusterId)?.name}</Badge>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </SectionCard>
      ) : services.isLoading ? null : (
        <EmptyState
          icon={<Globe />}
          title="Nothing is published yet"
          description="Publish a port from one of your VMs and it will be listed here."
        />
      )}
    </>
  );
}
