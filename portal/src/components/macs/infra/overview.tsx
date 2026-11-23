"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Meter } from "@/components/meter";
import { PageHeader } from "@/components/page-header";
import { SectionCard } from "@/components/section-card";
import { Badge } from "@/components/ui/badge";
import { type Overview, useOverview } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Note } from "../common";

function Stat({
  label,
  value,
  sub,
  warn,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  warn?: boolean;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn("mt-0.5 text-2xl font-bold tabular-nums", warn && "text-warning")}>{value}</dd>
      {sub ? <dd className="text-xs text-muted-foreground">{sub}</dd> : null}
    </div>
  );
}

function ClusterPanel({ c }: { c: Overview }) {
  const waiting = c.pending.vms + c.pending.gpu + c.pending.services;
  return (
    <SectionCard
      title={
        <>
          {c.name}
          <Badge variant="secondary">{c.kind}</Badge>
          {c.network.isolated ? <Badge variant="secondary">isolated network</Badge> : null}
        </>
      }
      actions={
        waiting > 0 ? (
          <Link
            href="/infra/approvals"
            className="rounded-md bg-warning-bg px-2.5 py-1 text-xs font-semibold text-warning no-underline"
          >
            {waiting} waiting for approval
          </Link>
        ) : null
      }
    >
      <div className="space-y-5">
        {c.error ? <Note tone="danger">Cluster unreachable: {c.error}</Note> : null}
        {c.network.firewallOk === false ? (
          <Note tone="danger">
            The datacenter firewall is switched off on this cluster, so VM isolation is{" "}
            <strong>not being enforced</strong>. Enable it under Datacenter → Firewall → Options.
          </Note>
        ) : null}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          <Stat
            label="Portal VMs"
            value={c.vms.managed}
            sub={`${c.vms.running} running · ${c.vms.owners} ${c.vms.owners === 1 ? "person" : "people"}`}
          />
          <Stat
            label="Not managed"
            value={c.vms.unmanaged}
            warn={c.vms.unmanaged > 0}
            sub={c.vms.unmanaged ? <Link href="/infra/machines">adopt them</Link> : "all VMs are tracked"}
          />
          {c.gpus ? (
            <Stat
              label="GPUs in use"
              value={`${c.gpus.inUse}/${c.gpus.total}`}
              sub={`${c.gpus.booked} booked now · ${c.gpus.upcoming} upcoming`}
            />
          ) : (
            <Stat
              label="Published services"
              value={c.network.published}
              sub={c.network.services ? "open ports" : "not offered"}
            />
          )}
          <Stat label="Images" value={c.images} sub={`${c.vms.archived} VMs archived`} />
        </dl>
        <div className="grid gap-4 sm:grid-cols-2">
          <Meter
            label="vCPUs allocated"
            detail={`${c.allocated.cores} / ${c.capacity.cores}`}
            value={c.allocated.cores}
            max={c.capacity.cores}
          />
          <Meter
            label="Memory allocated"
            detail={`${Math.round(c.allocated.memoryMb / 1024)} / ${Math.round(c.capacity.memoryMb / 1024)} GB`}
            value={c.allocated.memoryMb}
            max={c.capacity.memoryMb}
          />
        </div>
        {c.nodes.length > 0 ? (
          <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
            {c.nodes.map((n) => (
              <Meter
                key={n.node}
                tone="success"
                label={<span className="font-semibold text-foreground">{n.node}</span>}
                detail={
                  n.status === "online"
                    ? `CPU ${Math.round(n.cpu * 100)}% · RAM ${Math.round((n.mem / (n.maxmem || 1)) * 100)}%`
                    : n.status
                }
                value={n.mem}
                max={n.maxmem}
              />
            ))}
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}

export function InfraOverview() {
  const q = useOverview();
  return (
    <>
      <PageHeader title="Overview" description="Every cluster the portal manages." />
      <div className="space-y-5">
        {q.data?.map((c) => (
          <ClusterPanel key={c.id} c={c} />
        ))}
        {q.isError ? <Note tone="danger">Could not load the overview.</Note> : null}
      </div>
    </>
  );
}
