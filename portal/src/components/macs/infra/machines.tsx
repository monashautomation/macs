"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, type Person, type Unmanaged, useAct, useClusters, useVms } from "@/lib/client";
import { Field, Muted, Note, Panel, Pick, VmTable } from "../common";

function Adopt() {
  const clusters = useClusters();
  const [clusterId, setClusterId] = useState("");
  const cid = clusterId || clusters.data?.[0]?.id || "";
  const cluster = clusters.data?.find((c) => c.id === cid);
  const list = useQuery({
    queryKey: ["unmanaged", cid],
    queryFn: () => api<Unmanaged[]>(`/admin/unmanaged?clusterId=${cid}`),
    enabled: !!cid,
  });
  const people = useQuery({ queryKey: ["people"], queryFn: () => api<Person[]>("/admin/people") });
  const [target, setTarget] = useState<Unmanaged | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [gpu, setGpu] = useState(false);
  const adopt = useAct(
    () =>
      api("/admin/vms/adopt", {
        method: "POST",
        body: { clusterId: cid, vmid: target?.vmid, ownerId, gpuAccess: gpu },
      }).then(() => setTarget(null)),
    { quiet: true },
  );
  return (
    <Panel
      title="On the cluster but not managed by the portal"
      actions={
        <Pick
          className="w-48"
          value={cid}
          onChange={setClusterId}
          options={(clusters.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
        />
      }
    >
      {list.error ? <Note tone="danger">{list.error.message}</Note> : null}
      {list.data?.length ? (
        <ul className="text-sm">
          {list.data.map((v) => (
            <li
              key={v.vmid}
              className="flex flex-wrap items-center gap-3 border-b border-border py-2 last:border-0"
            >
              <span className="font-semibold">{v.name || "(unnamed)"}</span>
              <span className="text-xs text-muted-foreground tabular-nums">
                #{v.vmid} · {v.node} · {v.status}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="ml-auto"
                onClick={() => {
                  setTarget(v);
                  setOwnerId("");
                  setGpu(false);
                  adopt.reset();
                }}
              >
                Assign to a person…
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Muted>{list.isLoading ? "Loading…" : "Every VM on this cluster is managed by the portal."}</Muted>
      )}
      <Dialog open={!!target} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Adopt {target?.name || target?.vmid}</DialogTitle>
            <DialogDescription>
              The VM appears in its owner's workspace and follows this cluster's policies.
            </DialogDescription>
          </DialogHeader>
          <Field label="Owner" hint="Only people who have signed in to the portal are listed.">
            <Pick
              value={ownerId}
              onChange={setOwnerId}
              placeholder="Choose a person…"
              options={(people.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.email})` }))}
            />
          </Field>
          {cluster?.hasGpus ? (
            <div className="flex items-center gap-2 text-sm">
              <Checkbox id="adopt-gpu" checked={gpu} onCheckedChange={(v) => setGpu(v === true)} />
              <label htmlFor="adopt-gpu">Approved for GPU use</label>
            </div>
          ) : null}
          {cluster?.network.isolated ? (
            <Note tone="warning">
              This cluster isolates VMs: adopting turns on the VM's firewall and blocks inbound traffic except
              the owner's access ports.
            </Note>
          ) : null}
          {adopt.error ? <Note tone="danger">{adopt.error.message}</Note> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button disabled={!ownerId || adopt.isPending} onClick={() => adopt.mutate()}>
              Adopt
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Panel>
  );
}

export function InfraMachines() {
  const vms = useVms("all");
  const clusters = useClusters();
  const [q, setQ] = useState("");
  const rows = (vms.data ?? []).filter(
    (v) => !q || `${v.name} ${v.owner.name} ${v.vmid}`.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        title="Virtual machines"
        description="Every VM the portal manages, across all people."
        actions={
          <Input
            className="w-64"
            aria-label="Filter"
            placeholder="Filter by name, owner or VMID"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        }
      />
      <div className="space-y-5">
        <Panel>
          {rows.length ? (
            <VmTable vms={rows} clusters={clusters.data ?? []} showOwner />
          ) : (
            <Muted>{vms.isLoading ? "Loading…" : "No VMs."}</Muted>
          )}
        </Panel>
        <Adopt />
      </div>
    </>
  );
}
