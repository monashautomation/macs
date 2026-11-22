import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { type GpuCluster, type GpuDevice, type Reservation, type VM, api, useAct, useClusters, useGpus, useMe, useReservations, useVMs } from "../api";
import { Badge, Button, Card, Empty, ErrorNote, Field, Modal, cx, fmtDateTime, fmtTime, inputCls } from "../ui";

const DAY = 86_400_000;
const DAYS = 7;

const toInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
function nextHour() {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
}

function DeviceCard({ gpu, cluster, vms, isAdmin }: { gpu: GpuDevice; cluster: GpuCluster; vms: VM[]; isAdmin: boolean }) {
  const [assigning, setAssigning] = useState(false);
  const [vmId, setVmId] = useState("");
  const act = useAct((a: { path: string; body: unknown }) => api(a.path, { method: "POST", body: a.body }));
  const h = gpu.holder;
  const candidates = vms.filter((v) => v.cluster_id === cluster.cluster_id && v.status === "active" && v.vmid !== h?.vmid);
  return (
    <div className={cx("rounded-xl border bg-panel p-4", h ? "border-gpu/40" : "border-line")}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{gpu.id}</span>
        {h ? <Badge tone="gpu">in use</Badge> : <Badge tone="ok">free</Badge>}
      </div>
      <p className="text-xs text-mute">{gpu.model} · {gpu.node}</p>
      <div className="mt-3 min-h-12 text-sm">
        {h ? (
          <>
            {h.vm_id ? <Link to={`/vms/${h.vm_id}`} className="font-medium text-brand hover:underline">{h.name}</Link> : <span className="font-medium">{h.name}</span>}
            <span className="text-mute"> · {h.owner?.username ?? "not managed by the portal"}</span>
            <p className="text-xs text-mute">
              {h.power !== "running" && "VM is stopped · "}
              {h.booked_until ? `booked until ${fmtDateTime(h.booked_until)}` : h.vm_id ? "no booking — the next booking may take it" : "never taken automatically"}
            </p>
          </>
        ) : <span className="text-mute">Available</span>}
      </div>
      {isAdmin && (
        <div className="mt-3 flex gap-2">
          <Button onClick={() => { setVmId(""); setAssigning(true); }}>{h ? "Swap to…" : "Assign…"}</Button>
          {h && <Button variant="ghost" disabled={act.isPending} onClick={() => confirm(`Detach ${gpu.id} from ${h.name}? The VM is shut down and restarted without it.`) && act.mutate({ path: "/api/admin/gpus/release", body: { cluster_id: cluster.cluster_id, vmid: h.vmid } })}>Release</Button>}
        </div>
      )}
      <ErrorNote error={act.error} />
      {assigning && (
        <Modal title={`${h ? "Swap" : "Assign"} ${gpu.id}`} onClose={() => setAssigning(false)}>
          {h && <p className="rounded-md bg-warn-soft px-3 py-2 text-sm text-warn">{h.name} is shut down, loses the GPU and is restarted without it.</p>}
          <Field label="Give this GPU to" hint={`The VM is shut down, moved to ${gpu.node} if needed and started with the GPU attached.`}>
            <select className={inputCls} value={vmId} onChange={(e) => setVmId(e.target.value)}>
              <option value="">Choose a VM…</option>
              {candidates.map((v) => <option key={v.id} value={v.id}>{v.name} ({v.owner.username}){v.gpu ? ` — has ${v.gpu}` : ""}</option>)}
            </select>
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setAssigning(false)}>Cancel</Button>
            <Button variant="primary" disabled={!vmId} onClick={() => { act.mutate({ path: "/api/admin/gpus/assign", body: { vm_id: +vmId, gpu_id: gpu.id } }); setAssigning(false); }}>
              {h ? "Swap" : "Assign"}
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}

/** Pack bookings into as few rows as possible; rows are capacity slots, not physical GPUs. */
function pack(reservations: Reservation[], lanes: number): Reservation[][] {
  const rows: Reservation[][] = Array.from({ length: lanes }, () => []);
  for (const r of [...reservations].sort((a, b) => a.start_at.localeCompare(b.start_at))) {
    let row = rows.find((row) => !row.length || row[row.length - 1].end_at <= r.start_at);
    if (!row) rows.push((row = []));
    row.push(r);
  }
  return rows;
}

function Timeline({ clusterId, lanes, from, meId, isAdmin }: { clusterId: string; lanes: number; from: Date; meId: number; isAdmin: boolean }) {
  const to = new Date(from.getTime() + DAYS * DAY);
  const q = useReservations(clusterId, from, to);
  const cancel = useAct((id: number) => api(`/api/reservations/${id}`, { method: "DELETE" }));
  const shown = (q.data ?? []).filter((r) => r.status !== "failed");
  const rows = useMemo(() => pack(shown, lanes), [shown, lanes]);
  const span = to.getTime() - from.getTime();
  const pct = (t: number) => ((Math.min(Math.max(t, from.getTime()), to.getTime()) - from.getTime()) / span) * 100;
  const now = Date.now();

  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <div className="min-w-[720px]">
        <div className="grid grid-cols-7 text-xs text-mute">
          {Array.from({ length: DAYS }, (_, i) => new Date(from.getTime() + i * DAY)).map((d) => (
            <div key={d.getTime()} className="border-l border-line px-2 pb-1">
              {d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}
            </div>
          ))}
        </div>
        <div className="relative">
          {rows.map((row, i) => (
            <div key={i} className="relative h-10 border-t border-line bg-[repeating-linear-gradient(to_right,var(--color-line)_0_1px,transparent_1px_calc(100%/7))]">
              {row.map((r) => {
                const mine = r.user.id === meId;
                const canCancel = (mine || isAdmin) && (r.status === "scheduled" || r.status === "active");
                const left = pct(new Date(r.start_at).getTime());
                const width = Math.max(pct(new Date(r.end_at).getTime()) - left, 0.6);
                return (
                  <button key={r.id} disabled={!canCancel}
                    title={`${r.vm_name} · ${r.user.name}\n${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)}\n${r.status}${r.gpu_id ? ` on ${r.gpu_id}` : ""}${r.note ? `\n${r.note}` : ""}${canCancel ? "\nClick to cancel" : ""}`}
                    onClick={() => confirm(r.status === "active" ? `End the booking for ${r.vm_name} now?` : `Cancel the booking for ${r.vm_name} (${fmtDateTime(r.start_at)})?`) && cancel.mutate(r.id)}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    className={cx("absolute inset-y-1 overflow-hidden rounded-md px-2 text-left text-xs leading-8 whitespace-nowrap",
                      r.status === "active" ? "bg-gpu text-panel" : r.status === "completed" ? "bg-sunken text-mute" : mine ? "bg-brand text-brand-ink" : "bg-brand-soft text-brand",
                      canCancel && "cursor-pointer hover:opacity-85")}>
                    <span className="font-medium">{r.vm_name}</span> <span className="opacity-75">{fmtTime(r.start_at)}–{fmtTime(r.end_at)}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {now > from.getTime() && now < to.getTime() && (
            <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-bad" style={{ left: `${pct(now)}%` }} title="Now" />
          )}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 border-t border-line pt-2 text-xs text-mute">
          <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-brand" />yours</span>
          <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-brand-soft" />others</span>
          <span><i className="mr-1 inline-block h-2.5 w-2.5 rounded-sm bg-gpu" />GPU attached now</span>
          <span>Each row is one of the {lanes} GPUs' worth of capacity; the actual card is picked when the booking starts.</span>
        </div>
        <ErrorNote error={cancel.error} />
      </div>
    </div>
  );
}

function BookingForm({ eligible, maxHours, preselect }: { eligible: VM[]; maxHours: number; preselect: string | null }) {
  const [vmId, setVmId] = useState(preselect && eligible.some((v) => String(v.id) === preselect) ? preselect : "");
  const [start, setStart] = useState(toInput(nextHour()));
  const [hours, setHours] = useState(4);
  const [note, setNote] = useState("");
  const [done, setDone] = useState("");
  const chosen = vmId || (eligible.length === 1 ? String(eligible[0].id) : "");
  const book = useAct(() => {
    const s = new Date(start);
    return api<Reservation>("/api/reservations", {
      method: "POST",
      body: { vm_id: +chosen, start_at: s.toISOString(), end_at: new Date(s.getTime() + hours * 3_600_000).toISOString(), note },
    }).then((r) => setDone(`Booked ${r.vm_name}: ${fmtDateTime(r.start_at)} → ${fmtDateTime(r.end_at)}`));
  });

  if (!eligible.length) {
    return <Empty>None of your VMs on this cluster are approved for GPU use yet. Request GPU access from a VM's page.</Empty>;
  }
  return (
    <form className="grid items-end gap-4 sm:grid-cols-2 lg:grid-cols-[1.2fr_1.2fr_0.6fr_1.4fr_auto]" onSubmit={(e) => { e.preventDefault(); setDone(""); book.mutate(); }}>
      <Field label="VM">
        <select className={inputCls} value={chosen} onChange={(e) => setVmId(e.target.value)} required>
          <option value="">Choose a VM…</option>
          {eligible.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </Field>
      <Field label="Start">
        <input type="datetime-local" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} required />
      </Field>
      <Field label="Hours">
        <input type="number" min={1} max={maxHours} className={inputCls} value={hours} onChange={(e) => setHours(+e.target.value)} required />
      </Field>
      <Field label="Note (optional)">
        <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} placeholder="training run" />
      </Field>
      <Button type="submit" variant="primary" disabled={book.isPending || !chosen} className="h-[38px]">Book</Button>
      <div className="sm:col-span-2 lg:col-span-5">
        <ErrorNote error={book.error} />
        {done && !book.error && <p className="rounded-md bg-ok-soft px-3 py-2 text-sm text-ok">{done}</p>}
        <p className="mt-2 text-xs text-mute">Your VM is shut down and restarted with a GPU when the booking starts, and restarted without it when it ends. Save your work before both. Up to {maxHours} hours per booking.</p>
      </div>
    </form>
  );
}

export default function Gpus() {
  const me = useMe();
  const gpus = useGpus();
  const clusters = useClusters();
  const isAdmin = !!me.data?.is_admin;
  const vms = useVMs(isAdmin ? "all" : "mine");
  const [params] = useSearchParams();
  const [picked, setPicked] = useState("");
  const [offset, setOffset] = useState(0);

  const from = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return new Date(d.getTime() + offset * DAYS * DAY);
  }, [offset]);

  if (!gpus.data || !me.data) return null;
  if (!gpus.data.length) return <Empty>No GPU cluster is available to your account.</Empty>;
  const preselect = params.get("vm");
  const preCluster = vms.data?.find((v) => String(v.id) === preselect)?.cluster_id;
  const cluster = gpus.data.find((c) => c.cluster_id === (picked || preCluster)) ?? gpus.data[0];
  const rules = clusters.data?.find((c) => c.id === cluster.cluster_id)?.gpu_rules;
  const eligible = (vms.data ?? []).filter((v) => v.cluster_id === cluster.cluster_id && v.status === "active" && v.gpu_access === "approved" && (v.owner.id === me.data!.id || isAdmin));
  const free = cluster.devices.filter((d) => !d.holder).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">GPUs</h1>
        {gpus.data.length > 1 && (
          <select className={cx(inputCls, "w-auto")} value={cluster.cluster_id} onChange={(e) => setPicked(e.target.value)}>
            {gpus.data.map((c) => <option key={c.cluster_id} value={c.cluster_id}>{c.cluster_name}</option>)}
          </select>
        )}
        <span className="text-sm text-mute">{cluster.cluster_name} · {free} of {cluster.devices.length} free right now</span>
      </div>
      {cluster.error && <ErrorNote error={`Cluster unreachable: ${cluster.error}`} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        {cluster.devices.map((g) => <DeviceCard key={g.id} gpu={g} cluster={cluster} vms={vms.data ?? []} isAdmin={isAdmin} />)}
      </div>

      <Card title="Book GPU time">
        <BookingForm key={cluster.cluster_id} eligible={eligible} maxHours={rules?.max_reservation_hours ?? 72} preselect={preselect} />
      </Card>

      <Card title="Schedule" actions={
        <>
          <Button variant="ghost" onClick={() => setOffset(offset - 1)} aria-label="Previous week">←</Button>
          <Button variant="ghost" onClick={() => setOffset(0)} disabled={offset === 0}>Today</Button>
          <Button variant="ghost" onClick={() => setOffset(offset + 1)} aria-label="Next week">→</Button>
        </>
      }>
        <Timeline clusterId={cluster.cluster_id} lanes={cluster.devices.length} from={from} meId={me.data.id} isAdmin={isAdmin} />
      </Card>
    </div>
  );
}
