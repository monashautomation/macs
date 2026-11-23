"use client";

import { Button } from "@monashautomation/ui/button";
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
import { PageHeader } from "@monashautomation/ui/page-header";
import { SectionCard } from "@monashautomation/ui/section-card";
import { StatusBadge } from "@monashautomation/ui/status-badge";
import { cn } from "@monashautomation/ui/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { useConfirm } from "@/components/providers";
import {
  api,
  type GpuCluster,
  type GpuDevice,
  type Reservation,
  useAct,
  useClusters,
  useGpus,
  useReservations,
  useSession,
  useVms,
  type Vm,
} from "@/lib/client";
import { Field, fmtDateTime, fmtTime, Note, Pick } from "./common";

const DAY = 86_400_000;
const DAYS = 7;

const toInput = (d: Date) =>
  new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
function nextHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function DeviceCard({
  gpu,
  cluster,
  vms,
  admin,
}: {
  gpu: GpuDevice;
  cluster: GpuCluster;
  vms: Vm[];
  admin: boolean;
}) {
  const confirm = useConfirm();
  const [assigning, setAssigning] = useState(false);
  const [vmId, setVmId] = useState("");
  const act = useAct((a: { path: string; body: unknown }) => api(a.path, { method: "POST", body: a.body }));
  const h = gpu.holder;
  const candidates = vms.filter(
    (v) => v.clusterId === cluster.clusterId && v.status === "active" && v.vmid !== h?.vmid,
  );
  return (
    <SectionCard
      title={gpu.id}
      actions={<StatusBadge tone={h ? "info" : "success"}>{h ? "in use" : "free"}</StatusBadge>}
    >
      <p className="-mt-3 text-xs text-muted-foreground">
        {gpu.model} · {gpu.node}
      </p>
      <div className="mt-3 min-h-12 text-sm">
        {h ? (
          <>
            {h.vmId ? (
              <Link href={`/vms/${h.vmId}`}>{h.name}</Link>
            ) : (
              <span className="font-semibold">{h.name}</span>
            )}
            <span className="text-muted-foreground"> · {h.owner?.name ?? "not managed by the portal"}</span>
            <p className="text-xs text-muted-foreground">
              {h.power !== "running" ? "VM is stopped · " : ""}
              {h.bookedUntil
                ? `booked until ${fmtDateTime(h.bookedUntil)}`
                : h.vmId
                  ? "no booking — the next booking may take it"
                  : "never taken automatically"}
            </p>
          </>
        ) : (
          <span className="text-muted-foreground">Available</span>
        )}
      </div>
      {admin ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setVmId("");
              setAssigning(true);
            }}
          >
            {h ? "Swap to…" : "Assign…"}
          </Button>
          {h ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={act.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Detach ${gpu.id} from ${h.name}?`,
                    description: "The VM is shut down and restarted without it.",
                    confirm: "Release",
                  })
                ) {
                  act.mutate({
                    path: "/admin/gpus/release",
                    body: { clusterId: cluster.clusterId, vmid: h.vmid },
                  });
                }
              }}
            >
              Release
            </Button>
          ) : null}
        </div>
      ) : null}
      <Dialog open={assigning} onOpenChange={setAssigning}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {h ? "Swap" : "Assign"} {gpu.id}
            </DialogTitle>
            <DialogDescription>
              The VM is shut down, moved to {gpu.node} if needed and started with the GPU attached.
              {h ? ` ${h.name} is shut down, loses the GPU and is restarted without it.` : ""}
            </DialogDescription>
          </DialogHeader>
          <Field label="Give this GPU to">
            <Pick
              value={vmId}
              onChange={setVmId}
              placeholder="Choose a VM…"
              options={candidates.map((v) => ({
                value: v.id,
                label: `${v.name} (${v.owner.name})${v.gpu ? ` — has ${v.gpu}` : ""}`,
              }))}
            />
          </Field>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setAssigning(false)}>
              Cancel
            </Button>
            <Button
              disabled={!vmId}
              onClick={() => {
                act.mutate({ path: "/admin/gpus/assign", body: { vmId, gpuId: gpu.id } });
                setAssigning(false);
              }}
            >
              {h ? "Swap" : "Assign"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

/** Pack bookings into as few rows as possible; rows are capacity slots, not physical GPUs. */
function pack(reservations: Reservation[], lanes: number): Reservation[][] {
  const rows: Reservation[][] = Array.from({ length: lanes }, () => []);
  for (const r of [...reservations].sort((a, b) => a.startAt.localeCompare(b.startAt))) {
    let row = rows.find((x) => (x.at(-1)?.endAt ?? "") <= r.startAt);
    if (!row) {
      row = [];
      rows.push(row);
    }
    row.push(r);
  }
  return rows;
}

function Timeline({
  clusterId,
  lanes,
  from,
  meId,
  admin,
}: {
  clusterId: string;
  lanes: number;
  from: Date;
  meId: string;
  admin: boolean;
}) {
  const confirm = useConfirm();
  const to = new Date(from.getTime() + DAYS * DAY);
  const q = useReservations(clusterId, from, to);
  const cancel = useAct((id: string) => api(`/reservations/${id}`, { method: "DELETE" }));
  const rows = useMemo(
    () =>
      pack(
        (q.data ?? []).filter((r) => r.status !== "failed"),
        lanes,
      ),
    [q.data, lanes],
  );
  const span = to.getTime() - from.getTime();
  const pct = (t: number) =>
    ((Math.min(Math.max(t, from.getTime()), to.getTime()) - from.getTime()) / span) * 100;
  const now = Date.now();
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[720px]">
        <div className="grid grid-cols-7 text-xs text-muted-foreground">
          {Array.from({ length: DAYS }, (_, i) => new Date(from.getTime() + i * DAY)).map((d) => (
            <div key={d.getTime()} className="border-l border-border px-2 pb-1">
              {d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
            </div>
          ))}
        </div>
        <div className="relative">
          {rows.map((row, i) => (
            <div key={i} className="relative grid h-10 grid-cols-7 border-t border-border">
              {Array.from({ length: DAYS }, (_, d) => (
                <div key={d} className="border-l border-border" />
              ))}
              {row.map((r) => {
                const mine = r.user.id === meId;
                const canCancel = (mine || admin) && (r.status === "scheduled" || r.status === "active");
                const left = pct(new Date(r.startAt).getTime());
                const width = Math.max(pct(new Date(r.endAt).getTime()) - left, 0.6);
                return (
                  <button
                    type="button"
                    key={r.id}
                    disabled={!canCancel}
                    title={`${r.vmName} · ${r.user.name}\n${fmtDateTime(r.startAt)} → ${fmtDateTime(r.endAt)}\n${r.status}${r.gpuId ? ` on ${r.gpuId}` : ""}${r.note ? `\n${r.note}` : ""}${canCancel ? "\nClick to cancel" : ""}`}
                    onClick={async () => {
                      const live = r.status === "active";
                      if (
                        await confirm({
                          title: live
                            ? `End the booking for ${r.vmName} now?`
                            : `Cancel the booking for ${r.vmName}?`,
                          description: fmtDateTime(r.startAt),
                          confirm: live ? "End now" : "Cancel booking",
                        })
                      ) {
                        cancel.mutate(r.id);
                      }
                    }}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    className={cn(
                      "absolute inset-y-1 overflow-hidden rounded-md px-2 text-left text-xs leading-8 whitespace-nowrap",
                      r.status === "active"
                        ? "bg-success-bg text-success"
                        : r.status === "completed"
                          ? "bg-muted text-muted-foreground"
                          : mine
                            ? "bg-primary text-primary-foreground"
                            : "bg-info-bg text-info",
                      canCancel && "cursor-pointer hover:opacity-85",
                    )}
                  >
                    <span className="font-semibold">{r.vmName}</span>{" "}
                    <span className="opacity-75">
                      {fmtTime(r.startAt)}–{fmtTime(r.endAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
          {now > from.getTime() && now < to.getTime() ? (
            <div
              className="pointer-events-none absolute inset-y-0 w-0.5 bg-destructive"
              style={{ left: `${pct(now)}%` }}
              title="Now"
            />
          ) : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 border-t border-border pt-2 text-xs text-muted-foreground">
          <span>
            <i className="mr-1 inline-block size-2.5 rounded-sm bg-primary" />
            yours
          </span>
          <span>
            <i className="mr-1 inline-block size-2.5 rounded-sm bg-info-bg" />
            others
          </span>
          <span>
            <i className="mr-1 inline-block size-2.5 rounded-sm bg-success-bg" />
            GPU attached now
          </span>
          <span>
            Each row is one GPU's worth of capacity; the actual card is picked when the booking starts.
          </span>
        </div>
      </div>
    </div>
  );
}

function BookingForm({
  eligible,
  maxHours,
  preselect,
  primary,
}: {
  eligible: Vm[];
  maxHours: number;
  preselect: string | null;
  primary: boolean;
}) {
  const [vmId, setVmId] = useState(preselect && eligible.some((v) => v.id === preselect) ? preselect : "");
  const [start, setStart] = useState(toInput(nextHour()));
  const [hours, setHours] = useState(4);
  const [note, setNote] = useState("");
  const [done, setDone] = useState("");
  const chosen = vmId || (eligible.length === 1 ? (eligible[0]?.id ?? "") : "");
  const book = useAct(
    () => {
      const s = new Date(start);
      return api<Reservation>("/reservations", {
        method: "POST",
        body: {
          vmId: chosen,
          startAt: s.toISOString(),
          endAt: new Date(s.getTime() + hours * 3_600_000).toISOString(),
          note,
        },
      }).then((r) => setDone(`Booked ${r.vmName}: ${fmtDateTime(r.startAt)} → ${fmtDateTime(r.endAt)}`));
    },
    { quiet: true },
  );
  if (!eligible.length) {
    return (
      <p className="text-sm text-muted-foreground">
        None of your VMs on this cluster are approved for GPU use yet. Request GPU access from a VM's page.
      </p>
    );
  }
  return (
    <form
      className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-[1.2fr_1.2fr_0.6fr_1.4fr_auto]"
      onSubmit={(e) => {
        e.preventDefault();
        setDone("");
        book.mutate();
      }}
    >
      <Field label="VM">
        <Pick
          value={chosen}
          onChange={setVmId}
          placeholder="Choose a VM…"
          options={eligible.map((v) => ({ value: v.id, label: v.name }))}
        />
      </Field>
      <Field label="Start" htmlFor="book-start">
        <Input
          id="book-start"
          type="datetime-local"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          required
        />
      </Field>
      <Field label="Hours" htmlFor="book-hours">
        <Input
          id="book-hours"
          type="number"
          min={1}
          max={maxHours}
          value={hours}
          onChange={(e) => setHours(+e.target.value)}
          required
        />
      </Field>
      <Field label="Note (optional)" htmlFor="book-note">
        <Input
          id="book-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={200}
          placeholder="training run"
        />
      </Field>
      <Button type="submit" variant={primary ? "default" : "outline"} disabled={book.isPending || !chosen}>
        Book
      </Button>
      <div className="space-y-2 sm:col-span-2 lg:col-span-5">
        {book.error ? <Note tone="danger">{book.error.message}</Note> : null}
        {done && !book.error ? <Note tone="success">{done}</Note> : null}
        <p className="text-xs text-muted-foreground">
          Your VM is shut down and restarted with a GPU when the booking starts, and restarted without it when
          it ends. Save your work before both. Up to {maxHours} hours per booking.
        </p>
      </div>
    </form>
  );
}

/** `admin` is the infrastructure view: every VM, plus swap and release controls. */
export function Gpus({ admin = false }: { admin?: boolean }) {
  const me = useSession();
  const gpus = useGpus();
  const clusters = useClusters();
  const vms = useVms(admin ? "all" : "mine");
  const params = useSearchParams();
  const [picked, setPicked] = useState("");
  const [offset, setOffset] = useState(0);
  const from = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return new Date(d.getTime() + offset * DAYS * DAY);
  }, [offset]);

  if (!gpus.data || !me.data) return null;
  const preselect = params.get("vm");
  const preCluster = vms.data?.find((v) => v.id === preselect)?.clusterId;
  const cluster = gpus.data.find((c) => c.clusterId === (picked || preCluster)) ?? gpus.data[0];
  if (!cluster)
    return (
      <EmptyState title="No GPU cluster" description="No cluster with GPUs is available to your account." />
    );
  const rules = clusters.data?.find((c) => c.id === cluster.clusterId)?.gpuRules;
  const meId = me.data.id;
  const eligible = (vms.data ?? []).filter(
    (v) =>
      v.clusterId === cluster.clusterId &&
      v.status === "active" &&
      v.gpuAccess === "approved" &&
      (admin || v.owner.id === meId),
  );
  const free = cluster.devices.filter((d) => !d.holder).length;

  return (
    <>
      <PageHeader
        title="GPUs"
        description={`${cluster.clusterName} · ${free} of ${cluster.devices.length} free right now`}
        actions={
          gpus.data.length > 1 ? (
            <Pick
              className="w-56"
              value={cluster.clusterId}
              onChange={setPicked}
              options={gpus.data.map((c) => ({ value: c.clusterId, label: c.clusterName }))}
            />
          ) : null
        }
      />
      <div className="space-y-6">
        {cluster.error ? <Note tone="danger">Cluster unreachable: {cluster.error}</Note> : null}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          {cluster.devices.map((g) => (
            <DeviceCard key={g.id} gpu={g} cluster={cluster} vms={vms.data ?? []} admin={admin} />
          ))}
        </div>
        <SectionCard title="Book GPU time">
          <BookingForm
            key={cluster.clusterId}
            eligible={eligible}
            maxHours={rules?.maxReservationHours ?? 72}
            preselect={preselect}
            primary={!admin}
          />
        </SectionCard>
        <SectionCard
          title="Schedule"
          actions={
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOffset(offset - 1)}
                aria-label="Previous week"
              >
                <ChevronLeft />
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setOffset(0)} disabled={offset === 0}>
                Today
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setOffset(offset + 1)}
                aria-label="Next week"
              >
                <ChevronRight />
              </Button>
            </>
          }
        >
          <Timeline
            clusterId={cluster.clusterId}
            lanes={cluster.devices.length}
            from={from}
            meId={meId}
            admin={admin}
          />
        </SectionCard>
      </div>
    </>
  );
}
