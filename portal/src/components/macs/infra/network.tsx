"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { useConfirm } from "@/components/providers";
import { SectionCard } from "@/components/section-card";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { api, type Overview, type Service, useAct, useOverview } from "@/lib/client";
import { Muted, Note, ServiceAddress } from "../common";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3 border-b border-border py-2 text-sm last:border-0">
      <dt className="w-44 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

const list = (items: (string | number)[], none: string) => (items.length ? items.join(", ") : none);

function Policy({ c }: { c: Overview }) {
  const n = c.network;
  const confirm = useConfirm();
  const sync = useAct(() =>
    api(`/admin/clusters/${c.id}/network-sync`, { method: "POST", body: {} }).then(() =>
      toast.success("Started — follow it under Activity."),
    ),
  );
  return (
    <SectionCard
      title={
        <>
          {c.name}
          <StatusBadge tone={n.isolated ? "info" : "neutral"}>
            {n.isolated ? "isolated" : "open LAN"}
          </StatusBadge>
        </>
      }
      actions={
        n.isolated ? (
          <Button
            variant="outline"
            disabled={sync.isPending}
            onClick={async () => {
              if (
                await confirm({
                  title: `Re-apply the firewall on every VM in ${c.name}?`,
                  description: "Only the portal's own rules are rewritten.",
                  confirm: "Re-apply",
                })
              )
                sync.mutate();
            }}
          >
            Re-apply to all VMs
          </Button>
        ) : null
      }
    >
      {n.firewallOk === false ? (
        <Note tone="danger">The datacenter firewall is off: none of this is being enforced.</Note>
      ) : null}
      <dl>
        <Row label="Network">
          {n.label || "—"}{" "}
          <span className="text-muted-foreground">
            ({n.bridge || "template default bridge"}
            {n.vlan ? `, VLAN ${n.vlan}` : ""})
          </span>
        </Row>
        {n.isolated ? (
          <>
            <Row label="Between VMs">Blocked. Each VM's firewall drops inbound traffic by default.</Row>
            <Row label="Owner access">
              Ports {list(n.accessPorts, "none")} from {list(n.accessSources, "anywhere")}
            </Row>
            <Row label="Published services">
              {n.services
                ? `Reachable from ${list(n.publicSources, "anywhere")} · ${n.serviceApproval === "required" ? "each needs approval" : "self-service"} · ${n.published} open`
                : "Not offered"}
            </Row>
          </>
        ) : (
          <Row label="Between VMs">Not filtered by the portal. VMs sit directly on this network.</Row>
        )}
      </dl>
      {n.isolated ? (
        <p className="mt-3 text-xs text-muted-foreground">
          Policy is set in the config file under this cluster's network section. After changing sources or
          ports, re-apply.
        </p>
      ) : null}
    </SectionCard>
  );
}

export function InfraNetwork() {
  const overview = useOverview();
  const confirm = useConfirm();
  const services = useQuery({
    queryKey: ["admin-services"],
    queryFn: () => api<Service[]>("/admin/services"),
    refetchInterval: 15_000,
  });
  const remove = useAct((id: string) => api(`/services/${id}`, { method: "DELETE" }));
  return (
    <>
      <PageHeader
        title="Network & services"
        description="How each cluster's VMs sit on the network, and every published port."
      />
      <div className="space-y-5">
        {overview.data?.map((c) => (
          <Policy key={c.id} c={c} />
        ))}
        <SectionCard title="All published services">
          {services.data?.length ? (
            <ul className="text-sm">
              {services.data.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2 last:border-0"
                >
                  <StatusBadge
                    tone={
                      s.status === "published" ? "success" : s.status === "pending" ? "warning" : "neutral"
                    }
                  >
                    {s.status}
                  </StatusBadge>
                  <span className="font-semibold">{s.name}</span>
                  <ServiceAddress s={s} />
                  <span className="text-xs text-muted-foreground">
                    <Link href={`/vms/${s.vmId}`}>{s.vmName}</Link> · {s.owner.name}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Close ${s.protocol}/${s.port} on ${s.vmName}?`,
                          confirm: "Close port",
                        })
                      )
                        remove.mutate(s.id);
                    }}
                  >
                    {s.status === "published" ? "Close port" : "Remove"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>No services.</Muted>
          )}
        </SectionCard>
      </div>
    </>
  );
}
