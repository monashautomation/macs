"use client";

import { Button } from "@monashautomation/ui/button";
import { CopyField } from "@monashautomation/ui/copy-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@monashautomation/ui/dialog";
import { EmptyState } from "@monashautomation/ui/empty-state";
import { Input } from "@monashautomation/ui/input";
import { SectionCard } from "@monashautomation/ui/section-card";
import { StatusBadge } from "@monashautomation/ui/status-badge";
import { Textarea } from "@monashautomation/ui/textarea";
import { ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { useConfirm } from "@/components/providers";
import { api, type Connection, type VmDetail as Detail, useAct, useClusters, useVm } from "@/lib/client";
import {
  Field,
  fmtDateTime,
  fmtGB,
  fmtSize,
  fmtUptime,
  JobRow,
  Muted,
  Note,
  Pick,
  ServiceAddress,
  VmStatus,
} from "./common";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function ConnectionRow({ c, name }: { c: Connection; name: string }) {
  const rdpFile = `full address:s:${c.host}:${c.port}\r\n${c.user ? `username:s:${c.user}\r\n` : ""}prompt for credentials:i:1\r\n`;
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-sm">
        <span className="font-semibold">{c.label}</span>
        <span className="text-xs text-muted-foreground">
          port {c.port}
          {c.user ? ` · user ${c.user}` : ""}
          {c.kind === "ssh" ? " · with the SSH key you provided" : ""}
        </span>
        {c.kind === "rdp" ? (
          <a
            className="ml-auto text-xs"
            download={`${name}.rdp`}
            href={`data:application/x-rdp;charset=utf-8,${encodeURIComponent(rdpFile)}`}
          >
            Download .rdp file
          </a>
        ) : null}
        {c.kind === "sunshine" && c.url ? (
          <a className="ml-auto text-xs" href={c.url} target="_blank" rel="noopener noreferrer">
            Sunshine web UI (pairing)
          </a>
        ) : null}
      </div>
      <CopyField value={c.command} label={`Copy ${c.label} address`} />
      {c.kind === "sunshine" ? (
        <p className="mt-1 text-xs text-muted-foreground">
          In Moonlight choose “Add host” and enter this address.
        </p>
      ) : null}
      {c.hosts.length > 1 ? (
        <p className="mt-1 text-xs text-muted-foreground">Also reachable at {c.hosts.slice(1).join(", ")}</p>
      ) : null}
    </div>
  );
}

function ServicesPanel({ vm, approval, max }: { vm: Detail; approval: boolean; max: number }) {
  const confirm = useConfirm();
  const blank = { name: "", port: "", kind: "http", description: "" };
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(blank);
  const add = useAct(
    () =>
      api(`/vms/${vm.id}/services`, {
        method: "POST",
        body: {
          name: form.name,
          description: form.description,
          port: Number(form.port),
          protocol: form.kind === "udp" ? "udp" : "tcp",
          scheme: form.kind === "http" || form.kind === "https" ? form.kind : "",
        },
      }).then(() => {
        setOpen(false);
        setForm(blank);
      }),
    { quiet: true },
  );
  const remove = useAct((id: string) => api(`/services/${id}`, { method: "DELETE" }));
  return (
    <SectionCard
      title="Public services"
      actions={
        <Button
          variant="outline"
          disabled={vm.services.length >= max}
          onClick={() => {
            add.reset();
            setOpen(true);
          }}
        >
          Publish a port
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">
        This VM is isolated: other VMs cannot connect to it, and only you can reach its login port. Publish a
        port to make a service on it reachable over NetBird.
      </p>
      {vm.services.length > 0 ? (
        <ul className="mt-3 text-sm">
          {vm.services.map((s) => (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2"
            >
              <StatusBadge
                tone={s.status === "published" ? "success" : s.status === "pending" ? "warning" : "neutral"}
              >
                {s.status === "pending" ? "awaiting approval" : s.status}
              </StatusBadge>
              <span className="font-semibold">{s.name}</span>
              {s.status === "published" ? (
                <ServiceAddress s={s} />
              ) : (
                <span className="text-muted-foreground">
                  {s.protocol}/{s.port}
                </span>
              )}
              {s.reviewNote ? <span className="text-xs text-muted-foreground">“{s.reviewNote}”</span> : null}
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                disabled={remove.isPending}
                onClick={async () => {
                  const live = s.status === "published";
                  if (
                    await confirm({
                      title: live ? `Stop publishing ${s.name}?` : `Remove ${s.name}?`,
                      description: live ? `Port ${s.port} is closed again.` : undefined,
                      confirm: live ? "Unpublish" : "Remove",
                    })
                  ) {
                    remove.mutate(s.id);
                  }
                }}
              >
                {s.status === "published" ? "Unpublish" : "Remove"}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish a port</DialogTitle>
            <DialogDescription>
              {approval
                ? "Systems & Infra approve each service before the port is opened."
                : "The port is opened straight away and listed on the Services page."}
            </DialogDescription>
          </DialogHeader>
          <Field label="Name" htmlFor="svc-name">
            <Input
              id="svc-name"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Team wiki"
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Port" htmlFor="svc-port">
              <Input
                id="svc-port"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => setForm({ ...form, port: e.target.value })}
                placeholder="8080"
              />
            </Field>
            <Field label="Type">
              <Pick
                value={form.kind}
                onChange={(kind) => setForm({ ...form, kind })}
                options={[
                  { value: "http", label: "Website (http)" },
                  { value: "https", label: "Website (https)" },
                  { value: "tcp", label: "Other TCP" },
                  { value: "udp", label: "UDP" },
                ]}
              />
            </Field>
          </div>
          <Field label="Description (optional)" htmlFor="svc-desc">
            <Input
              id="svc-desc"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={500}
            />
          </Field>
          {add.error ? <Note tone="danger">{add.error.message}</Note> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!form.name.trim() || !form.port || add.isPending} onClick={() => add.mutate()}>
              {approval ? "Request" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

export function VmDetail({ id }: { id: string }) {
  const vmq = useVm(id);
  const clusters = useClusters();
  const router = useRouter();
  const confirm = useConfirm();
  const [dialog, setDialog] = useState<"gpu" | "backup" | null>(null);
  const [text, setText] = useState("");
  const act = useAct((a: { path: string; method?: string; body?: unknown }) =>
    api(a.path, { method: a.method ?? "POST", body: a.body ?? {} }),
  );
  const run = (path: string, body?: unknown, method?: string) =>
    act.mutateAsync({ path, body, method }).catch(() => undefined);

  if (vmq.isError) {
    return (
      <EmptyState
        title="VM not found"
        description="It may have been deleted, or it belongs to someone else."
        action={
          <Button asChild variant="outline">
            <Link href="/" className="text-foreground no-underline">
              Back to my VMs
            </Link>
          </Button>
        }
      />
    );
  }
  const vm = vmq.data;
  if (!vm) return null;
  const cluster = clusters.data?.find((c) => c.id === vm.clusterId);
  const active = vm.status === "active";
  const idle = active && !vm.busy;
  const running = vm.power === "running";
  const exists = active || vm.status === "error";
  const power = (action: string) => run(`/vms/${id}/power`, { action });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold tracking-tight">{vm.name}</h1>
        <VmStatus vm={vm} />
        {vm.gpu ? <StatusBadge tone="success">{vm.gpu} attached</StatusBadge> : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {active && !running ? (
            <Button variant="outline" disabled={!idle} onClick={() => power("start")}>
              Start
            </Button>
          ) : null}
          {active && running ? (
            <>
              <Button variant="outline" disabled={!idle} onClick={() => power("reboot")}>
                Reboot
              </Button>
              <Button variant="outline" disabled={!idle} onClick={() => power("shutdown")}>
                Shut down
              </Button>
              <Button
                variant="danger"
                disabled={!idle}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Force stop ${vm.name}?`,
                      description: "This is like pulling the power cord. Unsaved work is lost.",
                      confirm: "Force stop",
                      destructive: true,
                    })
                  )
                    power("stop");
                }}
              >
                Force stop
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {vm.status === "pending" ? (
        <Note tone="warning">Waiting for Systems & Infra to approve this request.</Note>
      ) : null}
      {vm.status === "rejected" ? (
        <Note>Request rejected{vm.reviewNote ? `: ${vm.reviewNote}` : ""}</Note>
      ) : null}
      {vm.status === "error" ? <Note tone="danger">Provisioning failed: {vm.error}</Note> : null}
      {vm.status === "archived" ? (
        <Note>
          This VM is archived to the backup server and uses no cluster resources. Restore a backup below to
          bring it back.
        </Note>
      ) : null}

      <SectionCard title="Details">
        <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label="Cluster">{cluster?.name ?? vm.clusterId}</Fact>
          <Fact label="Node">{vm.node ?? "—"}</Fact>
          <Fact label="VMID">{vm.vmid ?? "—"}</Fact>
          <Fact label="Owner">{vm.owner.name}</Fact>
          <Fact label="Size">
            {vm.cores} vCPU · {fmtGB(vm.memoryMb)} · {vm.diskGb} GB
          </Fact>
          <Fact label="Image">{vm.image?.name ?? (vm.imageSlug || "—")}</Fact>
          <Fact label="Uptime">{fmtUptime(vm.uptime)}</Fact>
          <Fact label="IP address">
            {vm.ips.length ? vm.ips.join(", ") : running ? "waiting for guest agent…" : "—"}
          </Fact>
        </dl>
      </SectionCard>

      {active ? (
        <SectionCard
          title="Connect"
          actions={
            running ? (
              <Button asChild>
                <a
                  href={`/vms/${vm.id}/console`}
                  target="_blank"
                  rel="noopener"
                  className="text-primary-foreground no-underline"
                >
                  Open console <ExternalLink aria-hidden />
                </a>
              </Button>
            ) : null
          }
        >
          {!running ? (
            <p className="text-sm text-muted-foreground">
              Start the VM to open its console or connect over the network.
            </p>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {vm.image?.kind === "iso"
                  ? "This VM booted an installer. Open the console to install the operating system; network details appear once the guest agent is running."
                  : "The console is the VM's own screen and keyboard in your browser. It works even before the network is up, so use it to fix a broken SSH or network setup."}
              </p>
              {vm.connections.map((c) => (
                <ConnectionRow key={c.kind} c={c} name={vm.name} />
              ))}
              {!vm.connections.length ? (
                <p className="text-sm text-muted-foreground">
                  Waiting for the guest agent to report an address for SSH / remote desktop…
                </p>
              ) : null}
            </div>
          )}
        </SectionCard>
      ) : null}

      {cluster?.network.services && active ? (
        <ServicesPanel
          vm={vm}
          approval={cluster.network.serviceApproval === "required"}
          max={cluster.network.maxServicesPerVm}
        />
      ) : null}

      {cluster?.hasGpus && vm.status !== "archived" ? (
        <SectionCard
          title="GPU"
          actions={
            vm.gpuAccess === "approved" && active ? (
              <Button asChild variant="outline">
                <Link href={`/gpus?vm=${vm.id}`} className="text-foreground no-underline">
                  Book GPU time
                </Link>
              </Button>
            ) : vm.gpuAccess === "none" ? (
              <Button
                variant="outline"
                onClick={() => {
                  setText("");
                  setDialog("gpu");
                }}
              >
                Request GPU access
              </Button>
            ) : null
          }
        >
          {vm.gpuAccess === "none" ? (
            <p className="text-sm text-muted-foreground">This VM is not approved for GPU use.</p>
          ) : null}
          {vm.gpuAccess === "requested" ? (
            <p className="text-sm text-warning">GPU access requested — waiting for Systems & Infra.</p>
          ) : null}
          {vm.gpuAccess === "approved" ? (
            vm.reservations.length ? (
              <ul className="text-sm">
                {vm.reservations.map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center gap-2 border-b border-border py-2 last:border-0"
                  >
                    <StatusBadge
                      tone={
                        r.status === "active"
                          ? "success"
                          : r.status === "failed"
                            ? "danger"
                            : r.status === "scheduled"
                              ? "info"
                              : "neutral"
                      }
                    >
                      {r.status}
                    </StatusBadge>
                    <span>
                      {fmtDateTime(r.startAt)} → {fmtDateTime(r.endAt)}
                    </span>
                    {r.gpuId ? <span className="text-muted-foreground">{r.gpuId}</span> : null}
                    {r.error ? <span className="text-destructive">{r.error}</span> : null}
                    {r.status === "scheduled" || r.status === "active" ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="ml-auto"
                        onClick={async () => {
                          const now = r.status === "active";
                          if (
                            await confirm({
                              title: now ? "End this booking now?" : "Cancel this booking?",
                              description: now ? "The VM restarts without the GPU." : undefined,
                              confirm: now ? "End now" : "Cancel booking",
                            })
                          ) {
                            run(`/reservations/${r.id}`, undefined, "DELETE");
                          }
                        }}
                      >
                        {r.status === "active" ? "End now" : "Cancel"}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Approved for GPU use. The GPU is attached for the duration of each booking; the VM restarts
                when a booking starts and ends.
              </p>
            )
          ) : null}
        </SectionCard>
      ) : null}

      {cluster?.hasBackups && (active || vm.status === "archived") ? (
        <SectionCard
          title="Backups"
          actions={
            active ? (
              <>
                <Button
                  variant="outline"
                  disabled={!idle}
                  onClick={() => {
                    setText("");
                    setDialog("backup");
                  }}
                >
                  Back up now
                </Button>
                <Button
                  variant="outline"
                  disabled={!idle}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Archive ${vm.name}?`,
                        description:
                          "It is shut down, backed up and removed from the cluster. You can restore it later.",
                        confirm: "Archive",
                      })
                    )
                      run(`/vms/${id}/archive`);
                  }}
                >
                  Archive
                </Button>
              </>
            ) : null
          }
        >
          {vm.backups.length ? (
            <ul className="text-sm">
              {vm.backups.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center gap-3 border-b border-border py-2 last:border-0"
                >
                  <span>{fmtDateTime(b.createdAt)}</span>
                  <span className="text-muted-foreground">{b.notes || "—"}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{fmtSize(b.sizeBytes)}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="ml-auto"
                    disabled={vm.busy}
                    onClick={async () => {
                      const ok = await confirm(
                        active
                          ? {
                              title: `Roll ${vm.name} back to this backup?`,
                              description: "Everything since then is lost.",
                              confirm: "Roll back",
                              destructive: true,
                            }
                          : { title: `Restore ${vm.name} from this backup?`, confirm: "Restore" },
                      );
                      if (ok) run(`/vms/${id}/restore`, { backupId: b.id });
                    }}
                  >
                    {active ? "Roll back" : "Restore"}
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>No backups yet.</Muted>
          )}
        </SectionCard>
      ) : null}

      {vm.jobs.length > 0 ? (
        <SectionCard title="Recent activity">
          <ul>
            {vm.jobs.map((j) => (
              <JobRow key={`${j.id}-${j.status}`} job={j} />
            ))}
          </ul>
        </SectionCard>
      ) : null}

      {vm.status !== "provisioning" ? (
        <div className="flex justify-end">
          <Button
            variant="danger"
            disabled={vm.busy}
            onClick={async () => {
              const ok = await confirm(
                exists
                  ? {
                      title: `Delete ${vm.name}?`,
                      description: "The VM and its disks are destroyed. This cannot be undone.",
                      confirm: "Delete VM",
                      destructive: true,
                    }
                  : { title: `Remove ${vm.name} from your list?`, confirm: "Remove" },
              );
              if (!ok) return;
              await run(`/vms/${id}`, undefined, "DELETE");
              if (!exists) router.push("/");
            }}
          >
            {exists ? "Delete VM" : "Remove"}
          </Button>
        </div>
      ) : null}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialog === "gpu" ? "Request GPU access" : "Back up now"}</DialogTitle>
            <DialogDescription>
              {dialog === "gpu"
                ? "Systems & Infra review GPU requests."
                : "The VM keeps running during the backup."}
            </DialogDescription>
          </DialogHeader>
          {dialog === "gpu" ? (
            <Field label="What do you need the GPU for?" htmlFor="gpu-why">
              <Textarea id="gpu-why" rows={3} value={text} onChange={(e) => setText(e.target.value)} />
            </Field>
          ) : (
            <Field label="Note (optional)" htmlFor="backup-note">
              <Input
                id="backup-note"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="before upgrading CUDA"
              />
            </Field>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              Cancel
            </Button>
            <Button
              disabled={dialog === "gpu" && !text.trim()}
              onClick={() => {
                if (dialog === "gpu") run(`/vms/${id}/gpu-access`, { justification: text });
                else run(`/vms/${id}/backups`, { notes: text });
                setDialog(null);
              }}
            >
              {dialog === "gpu" ? "Send request" : "Start backup"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
