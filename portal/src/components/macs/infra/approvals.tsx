"use client";

import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, useAct, useApprovals, useClusters } from "@/lib/client";
import { fmtDateTime, fmtGB, Panel } from "../common";

export function InfraApprovals() {
  const q = useApprovals();
  const clusters = useClusters();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const review = useAct((a: { kind: "vms" | "services"; id: string; approve: boolean; grantGpu?: boolean }) =>
    api(`/admin/${a.kind}/${a.id}/review`, {
      method: "POST",
      body: { approve: a.approve, grantGpu: !!a.grantGpu, note: notes[a.id] ?? "" },
    }),
  );
  const cname = (id: string) => clusters.data?.find((c) => c.id === id)?.name ?? id;
  const note = (id: string) => (
    <Input
      className="min-w-40 flex-1"
      aria-label="Note to the requester"
      placeholder="Note to the requester (optional)"
      value={notes[id] ?? ""}
      onChange={(e) => setNotes({ ...notes, [id]: e.target.value })}
    />
  );
  const empty = q.data && !q.data.vms.length && !q.data.services.length;
  // Each request is its own decision, so approve buttons are outline: no single primary action on this page.
  return (
    <>
      <PageHeader
        title="Approvals"
        description="VM requests, GPU access and published services waiting on Systems & Infra."
      />
      <div className="space-y-4">
        {empty ? (
          <EmptyState
            icon={<CheckCircle2 />}
            title="Nothing waiting"
            description="New requests appear here as people make them."
          />
        ) : null}
        {q.data?.vms.map((vm) => {
          const gpuOnly = vm.status === "active";
          const wantsGpu = vm.gpuAccess === "requested";
          return (
            <Panel
              key={vm.id}
              title={
                <>
                  <Link href={`/vms/${vm.id}`}>{vm.name}</Link>
                  <Badge variant="secondary">{cname(vm.clusterId)}</Badge>
                  <StatusBadge tone="info">{gpuOnly ? "GPU access for existing VM" : "new VM"}</StatusBadge>
                  {!gpuOnly && wantsGpu ? <StatusBadge tone="warning">wants GPU</StatusBadge> : null}
                </>
              }
            >
              <p className="-mt-2 text-xs text-muted-foreground">
                {vm.owner.name} · {fmtDateTime(vm.createdAt)}
              </p>
              <p className="mt-2 text-sm text-muted-foreground tabular-nums">
                {vm.cores} vCPU · {fmtGB(vm.memoryMb)} · {vm.diskGb} GB · image {vm.imageSlug || "—"}
              </p>
              <p className="mt-2 text-sm whitespace-pre-wrap">
                {vm.justification || <span className="text-muted-foreground">No justification given.</span>}
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {note(vm.id)}
                <Button
                  variant="danger"
                  disabled={review.isPending}
                  onClick={() => review.mutate({ kind: "vms", id: vm.id, approve: false })}
                >
                  Reject
                </Button>
                {!gpuOnly && wantsGpu ? (
                  <Button
                    variant="ghost"
                    disabled={review.isPending}
                    onClick={() => review.mutate({ kind: "vms", id: vm.id, approve: true })}
                  >
                    Approve without GPU
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  disabled={review.isPending}
                  onClick={() => review.mutate({ kind: "vms", id: vm.id, approve: true, grantGpu: true })}
                >
                  {gpuOnly ? "Grant GPU access" : wantsGpu ? "Approve with GPU" : "Approve"}
                </Button>
              </div>
            </Panel>
          );
        })}
        {q.data?.services.map((s) => (
          <Panel
            key={s.id}
            title={
              <>
                {s.name}
                <Badge variant="secondary">{cname(s.clusterId)}</Badge>
                <StatusBadge tone="info">publish a service</StatusBadge>
              </>
            }
          >
            <p className="-mt-2 text-xs text-muted-foreground">
              {s.owner.name} · {fmtDateTime(s.createdAt)}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Open{" "}
              <span className="font-semibold text-foreground">
                {s.protocol}/{s.port}
              </span>
              {s.scheme ? ` (${s.scheme})` : ""} on <Link href={`/vms/${s.vmId}`}>{s.vmName}</Link> to
              NetBird.
            </p>
            {s.description ? <p className="mt-2 text-sm">{s.description}</p> : null}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {note(s.id)}
              <Button
                variant="danger"
                disabled={review.isPending}
                onClick={() => review.mutate({ kind: "services", id: s.id, approve: false })}
              >
                Reject
              </Button>
              <Button
                variant="outline"
                disabled={review.isPending}
                onClick={() => review.mutate({ kind: "services", id: s.id, approve: true })}
              >
                Open the port
              </Button>
            </div>
          </Panel>
        ))}
      </div>
    </>
  );
}
