"use client";

import { Badge } from "@monashautomation/ui/badge";
import { Meter } from "@monashautomation/ui/meter";
import { PageHeader } from "@monashautomation/ui/page-header";
import { SectionCard } from "@monashautomation/ui/section-card";
import { StatTile } from "@monashautomation/ui/stat-tile";
import { CircleHelp, Cpu, Disc3, Globe, Server } from "lucide-react";
import Link from "next/link";
import { type ClusterMetrics, type Overview, useClusterMetrics, useOverview } from "@/lib/client";
import { ChartFigure, GpuHoursChart, TimeChart } from "../charts";
import { Note } from "../common";

function ClusterPanel({ c, m }: { c: Overview; m?: ClusterMetrics }) {
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
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile
            icon={<Server aria-hidden />}
            label="Portal VMs"
            value={c.vms.managed}
            detail={`${c.vms.running} running · ${c.vms.owners} ${c.vms.owners === 1 ? "person" : "people"}`}
          />
          <StatTile
            icon={<CircleHelp aria-hidden />}
            label="Not managed"
            value={c.vms.unmanaged}
            tone={c.vms.unmanaged > 0 ? "warning" : "default"}
            detail={c.vms.unmanaged ? <Link href="/infra/machines">adopt them</Link> : "all VMs are tracked"}
          />
          {c.gpus ? (
            <StatTile
              icon={<Cpu aria-hidden />}
              label="GPUs in use"
              value={`${c.gpus.inUse}/${c.gpus.total}`}
              detail={`${c.gpus.booked} booked now · ${c.gpus.upcoming} upcoming`}
            />
          ) : (
            <StatTile
              icon={<Globe aria-hidden />}
              label="Published services"
              value={c.network.published}
              detail={c.network.services ? "open ports" : "not offered"}
            />
          )}
          <StatTile
            icon={<Disc3 aria-hidden />}
            label="Images"
            value={c.images}
            detail={`${c.vms.archived} VMs archived`}
          />
        </div>
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
        {m && (m.load.length > 1 || m.gpu) ? (
          <div className="grid gap-6 lg:grid-cols-2">
            {m.load.length > 1 ? (
              <ChartFigure
                title="Cluster load, last day"
                summary={`now CPU ${m.load.at(-1)?.cpu}% · memory ${m.load.at(-1)?.mem}%`}
              >
                <TimeChart
                  data={m.load}
                  series={[
                    { key: "cpu", label: "CPU" },
                    { key: "mem", label: "Memory" },
                  ]}
                  unit="%"
                  max={100}
                  span="day"
                />
              </ChartFigure>
            ) : null}
            {m.gpu ? (
              <ChartFigure
                title="GPU-hours booked per day"
                summary={`${Math.round(m.gpu.days.slice(7).reduce((n, d) => n + d.booked, 0))} h booked in the next 7 days`}
              >
                <GpuHoursChart days={m.gpu.days} capacity={m.gpu.capacityPerDay} />
              </ChartFigure>
            ) : null}
          </div>
        ) : null}
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
  const metrics = useClusterMetrics();
  return (
    <>
      <PageHeader title="Overview" description="Every cluster the portal manages." />
      <div className="space-y-5">
        {q.data?.map((c) => (
          <ClusterPanel key={c.id} c={c} m={metrics.data?.find((x) => x.id === c.id)} />
        ))}
        {q.isError ? <Note tone="danger">Could not load the overview.</Note> : null}
      </div>
    </>
  );
}
