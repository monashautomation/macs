"use client";

import { Plus, Server } from "lucide-react";
import Link from "next/link";
import { EmptyState } from "@/components/empty-state";
import { Meter } from "@/components/meter";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { type Cluster, useClusters, useVms } from "@/lib/client";
import { VmTable } from "./common";

function Quota({ label, used, max, unit = "" }: { label: string; used: number; max: number; unit?: string }) {
  if (!max) return null;
  return (
    <Meter
      className="min-w-24 flex-1"
      label={label}
      detail={`${used}/${max}${unit}`}
      value={used}
      max={max}
    />
  );
}

function ClusterCard({ c }: { c: Cluster }) {
  const q = c.quota;
  return (
    <SectionCard
      title={
        <>
          {c.name}
          <StatusBadge tone={c.approval === "none" ? "success" : "info"}>
            {c.approval === "none" ? "self-service" : "needs approval"}
          </StatusBadge>
          {c.hasGpus ? <Badge variant="secondary">{c.gpuCount} GPUs</Badge> : null}
          {c.network.isolated ? <Badge variant="secondary">isolated network</Badge> : null}
        </>
      }
    >
      {c.description ? <p className="text-sm text-muted-foreground">{c.description}</p> : null}
      {c.network.description ? (
        <p className="mt-2 text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{c.network.label || "Network"}:</span>{" "}
          {c.network.description}
        </p>
      ) : null}
      {c.error ? (
        <p className="mt-3 text-sm text-destructive">Cluster unreachable: {c.error}</p>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          {c.nodes.filter((n) => n.status === "online").length}/{c.nodes.length} nodes online
        </p>
      )}
      {q.maxVms || q.maxCores || q.maxMemoryMb || q.maxDiskGb ? (
        <div className="mt-3 flex flex-wrap gap-4">
          <Quota label="VMs" used={c.usage.vms} max={q.maxVms} />
          <Quota label="Cores" used={c.usage.cores} max={q.maxCores} />
          <Quota label="Memory" used={c.usage.memoryMb / 1024} max={q.maxMemoryMb / 1024} unit=" GB" />
          <Quota label="Disk" used={c.usage.diskGb} max={q.maxDiskGb} unit=" GB" />
        </div>
      ) : null}
    </SectionCard>
  );
}

export function MyVms() {
  const vms = useVms();
  const clusters = useClusters();
  const none = clusters.data?.length === 0;
  return (
    <>
      <PageHeader
        title="My VMs"
        description="Deploy and manage your virtual machines."
        actions={
          none ? null : (
            <Button asChild>
              <Link href="/new" className="text-primary-foreground no-underline">
                <Plus aria-hidden /> New VM
              </Link>
            </Button>
          )
        }
      />
      {none ? (
        <EmptyState
          title="No cluster access yet"
          description="Your account is not in a group with access to any cluster. Ask Systems & Infra to add you in Authentik."
        />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-2">
            {clusters.data?.map((c) => <ClusterCard key={c.id} c={c} />) ?? <Skeleton className="h-32" />}
          </div>
          {vms.isLoading ? (
            <Skeleton className="h-40" />
          ) : vms.data?.length ? (
            <SectionCard>
              <VmTable vms={vms.data} clusters={clusters.data ?? []} />
            </SectionCard>
          ) : (
            <EmptyState
              icon={<Server />}
              title="No VMs yet"
              description="Pick an image and a size, and your VM is ready in a minute or two."
            />
          )}
        </div>
      )}
    </>
  );
}
