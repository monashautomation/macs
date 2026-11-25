"use client";

import { Button } from "@monashautomation/ui/button";
import { Checkbox } from "@monashautomation/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@monashautomation/ui/dialog";
import { Input } from "@monashautomation/ui/input";
import { SectionCard } from "@monashautomation/ui/section-card";
import { Textarea } from "@monashautomation/ui/textarea";
import { Camera, Clock, KeyRound, ListChecks, Scaling, TriangleAlert, Users } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useConfirm } from "@/components/providers";
import {
  api,
  type VmDetail as Detail,
  type Login,
  rememberLogin,
  useAct,
  usePeople,
  useSession,
  useSnapshots,
} from "@/lib/client";
import { Field, fmtDateTime, Muted, Note, Pick } from "./common";
import { HelpTip } from "./help";

type Run = (path: string, body?: unknown, method?: string) => Promise<unknown>;
const DAY = 86_400_000;

/** When the VM will be shut down, and the button that puts that off. */
export function Expiry({ vm, run }: { vm: Detail; run: Run }) {
  if (!vm.expiresAt || vm.status !== "active") return null;
  const days = Math.ceil((new Date(vm.expiresAt).getTime() - Date.now()) / DAY);
  if (!vm.expired && days > 7) return null;
  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-md px-3 py-2 text-sm ${
        vm.expired ? "bg-danger-bg text-destructive" : "bg-warning-bg text-warning"
      }`}
    >
      <span className="flex-1">
        {vm.expired
          ? "This VM expired and was shut down. Nothing was deleted: extend it to start it again."
          : `This VM will be shut down ${days <= 1 ? "within a day" : `in ${days} days`} unless it is extended. Nothing is deleted when that happens.`}
      </span>
      <Button variant="outline" size="sm" onClick={() => run(`/vms/${vm.id}/extend`)}>
        Extend {vm.lifetimeDays} days
      </Button>
    </div>
  );
}

/** Shown while the VM is flagged idle: what will happen, and how to stop it. */
export function IdleNotice({ vm, run }: { vm: Detail; run: Run }) {
  if (!vm.idleSince || vm.power !== "running") return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-md bg-warning-bg px-3 py-2 text-sm text-warning">
      <span className="flex-1">
        This VM looks idle: it has used almost no CPU or network for days. It will be shut down soon to free
        the resources (nothing is deleted, and you can start it again). Still need it running?{" "}
        <HelpTip topic="idle" label="idle" />
      </span>
      <Button variant="outline" size="sm" onClick={() => run(`/vms/${vm.id}/keep`)}>
        Keep running
      </Button>
    </div>
  );
}

const DAY_SETS = [
  { value: "", label: "Every day" },
  { value: "12345", label: "Weekdays (Mon to Fri)" },
  { value: "67", label: "Weekends" },
];

/** A short checklist for a new VM. Ticks are kept in this browser. */
export function FirstSteps({ vm }: { vm: Detail }) {
  const key = `macs-steps-${vm.id}`;
  const [done, setDone] = useState<string[] | "hidden" | null>(null);
  useEffect(() => {
    try {
      setDone(JSON.parse(localStorage.getItem(key) ?? "[]"));
    } catch {
      setDone([]);
    }
  }, [key]);
  const save = (next: string[] | "hidden") => {
    setDone(next);
    localStorage.setItem(key, JSON.stringify(next));
  };
  if (vm.status !== "active" || vm.access === "admin" || done === null || done === "hidden") return null;
  const specific = [...(vm.lab?.steps ?? []), ...(vm.setup?.steps ?? [])];
  const steps = [
    ...(specific.length
      ? specific
      : vm.image?.kind === "iso"
        ? [
            "Open the console and run the installer",
            "Install the QEMU guest agent so the portal can see its address",
          ]
        : [
            "Open the terminal and sign in with the login above",
            "Add your SSH key under Settings, then connect over SSH",
          ]),
    ...(vm.maxSnapshots ? ["Take a snapshot once it is set up the way you like"] : []),
  ];
  const all = steps.every((s) => done.includes(s));
  return (
    <SectionCard
      title={
        <>
          <ListChecks className="size-4 text-muted-foreground" aria-hidden /> First steps{" "}
          <HelpTip topic="firstSteps" label="First steps" />
        </>
      }
      actions={
        <Button variant="ghost" size="sm" onClick={() => save("hidden")}>
          {all ? "Done" : "Hide"}
        </Button>
      }
    >
      <ul className="space-y-2 text-sm">
        {steps.map((step, i) => {
          const id = `step-${i}`;
          const ticked = done.includes(step);
          return (
            <li key={step} className="flex items-start gap-2">
              <Checkbox
                id={id}
                className="mt-0.5"
                checked={ticked}
                onCheckedChange={(v) => save(v === true ? [...done, step] : done.filter((d) => d !== step))}
              />
              <label htmlFor={id} className={ticked ? "text-muted-foreground line-through" : ""}>
                {step}
              </label>
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}

export function SnapshotsPanel({ vm, run, own }: { vm: Detail; run: Run; own: boolean }) {
  const confirm = useConfirm();
  const q = useSnapshots(vm.id, vm.status === "active");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const add = useAct(
    () =>
      api(`/vms/${vm.id}/snapshots`, { method: "POST", body: { name, description: note } }).then(() =>
        setOpen(false),
      ),
    { quiet: true },
  );
  const rows = q.data?.snapshots ?? [];
  const max = q.data?.max ?? vm.maxSnapshots;
  if (!max || vm.status !== "active") return null;
  return (
    <SectionCard
      title={
        <>
          <Camera className="size-4 text-muted-foreground" aria-hidden /> Snapshots{" "}
          <HelpTip topic="snapshots" label="Snapshots" />
        </>
      }
      actions={
        own ? (
          <Button
            variant="outline"
            disabled={vm.busy || rows.length >= max}
            onClick={() => {
              add.reset();
              setName("");
              setNote("");
              setOpen(true);
            }}
          >
            Take a snapshot
          </Button>
        ) : null
      }
    >
      <p className="text-sm text-muted-foreground">
        A snapshot is a save point for the disk: take one before trying something risky, and roll back if it
        goes wrong. A VM keeps up to {max}.
      </p>
      {rows.length ? (
        <ul className="mt-3 text-sm">
          {rows.map((s) => (
            <li
              key={s.name}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border py-2"
            >
              <span className="font-semibold">{s.name}</span>
              <span className="text-muted-foreground">{fmtDateTime(s.createdAt)}</span>
              {s.description ? <span className="text-muted-foreground">{s.description}</span> : null}
              {own ? (
                <span className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={vm.busy}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Roll ${vm.name} back to “${s.name}”?`,
                          description:
                            "Everything on its disk since then is lost. The VM restarts if it is running.",
                          confirm: "Roll back",
                          destructive: true,
                        })
                      )
                        run(`/vms/${vm.id}/snapshots/${s.name}`);
                    }}
                  >
                    Roll back
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={vm.busy}
                    onClick={async () => {
                      if (await confirm({ title: `Delete snapshot “${s.name}”?`, confirm: "Delete" }))
                        run(`/vms/${vm.id}/snapshots/${s.name}`, undefined, "DELETE");
                    }}
                  >
                    Delete
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <Muted>{q.isLoading ? "Loading…" : "No snapshots yet."}</Muted>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Take a snapshot</DialogTitle>
            <DialogDescription>The VM keeps running. It takes a few seconds.</DialogDescription>
          </DialogHeader>
          <Field label="Name" htmlFor="snap-name" hint="Letters, digits and dashes, starting with a letter.">
            <Input
              id="snap-name"
              value={name}
              onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_-]/g, "-"))}
              placeholder="before-upgrade"
              maxLength={40}
            />
          </Field>
          <Field label="Note (optional)" htmlFor="snap-note">
            <Input id="snap-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
          </Field>
          {add.error ? <Note tone="danger">{add.error.message}</Note> : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={name.length < 2 || add.isPending} onClick={() => add.mutate()}>
              Take snapshot
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SectionCard>
  );
}

function SizePanel({ vm, run }: { vm: Detail; run: Run }) {
  const confirm = useConfirm();
  const [cores, setCores] = useState(String(vm.cores));
  const [memGb, setMemGb] = useState(String(vm.memoryMb / 1024));
  const [disk, setDisk] = useState(String(vm.diskGb));
  const want = { cores: Number(cores), memoryMb: Math.round(Number(memGb) * 1024), diskGb: Number(disk) };
  const changed = want.cores !== vm.cores || want.memoryMb !== vm.memoryMb || want.diskGb !== vm.diskGb;
  const restarts = vm.power === "running" && (want.cores !== vm.cores || want.memoryMb !== vm.memoryMb);
  const lim = vm.limits;
  return (
    <SectionCard
      title={
        <>
          <Scaling className="size-4 text-muted-foreground" aria-hidden /> Size{" "}
          <HelpTip topic="size" label="Size" />
        </>
      }
    >
      {vm.canResize ? (
        <>
          <div className="grid max-w-xl grid-cols-3 gap-3">
            <Field label="vCPUs" htmlFor="size-cores">
              <Input
                id="size-cores"
                type="number"
                min={1}
                max={lim?.maxCores}
                value={cores}
                onChange={(e) => setCores(e.target.value)}
              />
            </Field>
            <Field label="Memory (GB)" htmlFor="size-mem">
              <Input
                id="size-mem"
                type="number"
                min={0.5}
                step={0.5}
                max={lim ? lim.maxMemoryMb / 1024 : undefined}
                value={memGb}
                onChange={(e) => setMemGb(e.target.value)}
              />
            </Field>
            <Field label="Disk (GB)" htmlFor="size-disk">
              <Input
                id="size-disk"
                type="number"
                min={vm.diskGb}
                max={lim?.maxDiskGb}
                value={disk}
                onChange={(e) => setDisk(e.target.value)}
              />
            </Field>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              disabled={!changed || vm.busy || !want.cores || !want.memoryMb || !want.diskGb}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Resize ${vm.name}?`,
                    description: restarts
                      ? "The VM is shut down and started again to change CPU and memory."
                      : "This does not interrupt the VM.",
                    confirm: "Resize",
                  })
                )
                  run(`/vms/${vm.id}/resize`, want);
              }}
            >
              Apply
            </Button>
            <p className="flex-1 text-xs text-muted-foreground">
              A disk can grow but not shrink. Most Linux images use the new space after a restart.
              {lim
                ? ` Up to ${lim.maxCores} vCPUs, ${lim.maxMemoryMb / 1024} GB memory and ${lim.maxDiskGb} GB disk per VM.`
                : ""}
            </p>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          This VM's size was set when the request was approved. Ask Systems & Infra if it needs more.
        </p>
      )}
    </SectionCard>
  );
}

function SchedulePanel({ vm, run }: { vm: Detail; run: Run }) {
  const [start, setStart] = useState(vm.schedule.start);
  const [stop, setStop] = useState(vm.schedule.stop);
  const savedDays = vm.schedule.days.join("");
  const [days, setDays] = useState(savedDays);
  const preset = DAY_SETS.some((d) => d.value === days);
  const body = (s: string, e: string) => ({ start: s, stop: e, timeZone: here, days: [...days].map(Number) });
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const on = vm.schedule.start || vm.schedule.stop;
  const changed = start !== vm.schedule.start || stop !== vm.schedule.stop || days !== savedDays;
  return (
    <SectionCard
      title={
        <>
          <Clock className="size-4 text-muted-foreground" aria-hidden /> Power schedule{" "}
          <HelpTip topic="schedule" label="Power schedule" />
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        Shut the VM down and start it again at set times, for example overnight or only on weekdays. Leave a
        time empty to skip it.
      </p>
      <div className="mt-3 grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Shut down at" htmlFor="sched-stop">
          <Input id="sched-stop" type="time" value={stop} onChange={(e) => setStop(e.target.value)} />
        </Field>
        <Field label="Start at" htmlFor="sched-start">
          <Input id="sched-start" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="On">
          <Pick
            value={preset ? days || "all" : "custom"}
            onChange={(v) => v !== "custom" && setDays(v === "all" ? "" : v)}
            options={[
              ...DAY_SETS.map((d) => ({ value: d.value || "all", label: d.label })),
              ...(preset ? [] : [{ value: "custom", label: "Custom days" }]),
            ]}
          />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          disabled={!changed || (!start && !stop)}
          onClick={() => run(`/vms/${vm.id}/schedule`, body(start, stop), "PUT")}
        >
          Save schedule
        </Button>
        {on ? (
          <Button
            variant="ghost"
            onClick={() => {
              setStart("");
              setStop("");
              run(`/vms/${vm.id}/schedule`, body("", ""), "PUT");
            }}
          >
            Turn off
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Times are in {on ? vm.schedule.timeZone : here}. A VM with a GPU booking is not shut down until the
          booking ends.
        </p>
      </div>
    </SectionCard>
  );
}

function LoginPanel({ vm, run, own, onLogin }: { vm: Detail; run: Run; own: boolean; onLogin: () => void }) {
  const confirm = useConfirm();
  const session = useSession();
  const [keys, setKeys] = useState<string | null>(null);
  const value = keys ?? session.data?.sshPublicKey ?? "";
  const reset = useAct(() =>
    api<{ login: Login }>(`/vms/${vm.id}/password`, { method: "POST", body: {} }).then((out) => {
      rememberLogin({ id: vm.id, login: out.login });
      onLogin();
    }),
  );
  const linux = vm.image?.kind === "template" && vm.image.os === "linux";
  const running = vm.power === "running";
  return (
    <SectionCard
      title={
        <>
          <KeyRound className="size-4 text-muted-foreground" aria-hidden /> Login{" "}
          <HelpTip topic="keys" label="Login" />
        </>
      }
    >
      {!linux ? (
        <p className="text-sm text-muted-foreground">
          The portal can manage logins only on Linux VMs deployed from a prepared image. On this one, manage
          users from inside the VM.
        </p>
      ) : (
        <div className="space-y-5">
          <div>
            <Field
              label="SSH keys"
              htmlFor="vm-keys"
              hint="Public keys, one per line. They are added to the VM's login account; keys already there are kept."
            >
              <Textarea
                id="vm-keys"
                rows={3}
                className="font-mono text-xs"
                value={value}
                onChange={(e) => setKeys(e.target.value)}
                placeholder="ssh-ed25519 AAAA… you@laptop"
              />
            </Field>
            <Button
              variant="outline"
              className="mt-2"
              disabled={!value.trim() || !running || vm.busy}
              onClick={() => run(`/vms/${vm.id}/keys`, { sshPublicKey: value })}
            >
              Add to this VM
            </Button>
          </div>
          {own ? (
            <div className="border-t border-border pt-4">
              <p className="text-sm font-semibold">Password</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Forgot it? Set a new generated password for the console, terminal and sudo. It is shown once
                and is not stored by the portal.
              </p>
              <Button
                variant="outline"
                className="mt-2"
                disabled={!running || reset.isPending}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Reset the password on ${vm.name}?`,
                      description: "The current password stops working straight away.",
                      confirm: "Reset password",
                    })
                  )
                    reset.mutate();
                }}
              >
                Reset password
              </Button>
            </div>
          ) : null}
          {!running ? (
            <p className="text-xs text-muted-foreground">Start the VM to change its login.</p>
          ) : null}
        </div>
      )}
    </SectionCard>
  );
}

function SharingPanel({ vm, run }: { vm: Detail; run: Run }) {
  const [q, setQ] = useState("");
  const found = usePeople(q);
  const have = new Set(vm.sharedWith.map((u) => u.id));
  const results = (found.data ?? []).filter((u) => !have.has(u.id) && u.id !== vm.owner.id);
  return (
    <SectionCard
      title={
        <>
          <Users className="size-4 text-muted-foreground" aria-hidden /> Sharing{" "}
          <HelpTip topic="sharing" label="Sharing" />
        </>
      }
    >
      <p className="text-sm text-muted-foreground">
        People you share with can see this VM, start and stop it, open its console and terminal, and add their
        own SSH key. They cannot delete, rebuild, resize or share it.
      </p>
      {vm.sharedWith.length ? (
        <ul className="mt-3 text-sm">
          {vm.sharedWith.map((u) => (
            <li key={u.id} className="flex items-center gap-3 border-t border-border py-2">
              <span className="font-semibold">{u.name}</span>
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                onClick={() => run(`/vms/${vm.id}/shares/${u.id}`, undefined, "DELETE")}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 max-w-md">
        <Field label="Add someone" htmlFor="share-q">
          <Input
            id="share-q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by name"
            autoComplete="off"
          />
        </Field>
        {q.trim().length >= 2 ? (
          results.length ? (
            <ul className="mt-2 text-sm">
              {results.map((u) => (
                <li key={u.id} className="flex items-center gap-3 border-t border-border py-1.5">
                  <span>{u.name}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() => run(`/vms/${vm.id}/shares`, { userId: u.id }).then(() => setQ(""))}
                  >
                    Share
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">
              {found.isLoading ? "Searching…" : "Nobody by that name has signed in to MACS yet."}
            </p>
          )
        ) : null}
      </div>
    </SectionCard>
  );
}

function DangerPanel({ vm, run, onLogin }: { vm: Detail; run: Run; onLogin: () => void }) {
  const confirm = useConfirm();
  const router = useRouter();
  const exists = vm.status === "active" || vm.status === "error";
  const rebuild = useAct(() =>
    api<{ login: Login | null }>(`/vms/${vm.id}/rebuild`, { method: "POST", body: {} }).then((out) => {
      rememberLogin({ id: vm.id, login: out.login });
      onLogin();
    }),
  );
  return (
    <SectionCard
      title={
        <>
          <TriangleAlert className="size-4 text-muted-foreground" aria-hidden /> Start over{" "}
          <HelpTip topic="startOver" label="Start over" />
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {vm.status === "active" ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="min-w-48 flex-1 text-muted-foreground">
              <span className="font-semibold text-foreground">Rebuild.</span> Wipe the disk and install{" "}
              {vm.setup?.name ?? vm.image?.name ?? "the same image"} again. The name, size, sharing and
              published ports are kept; snapshots are not.
            </p>
            <Button
              variant="outline"
              disabled={vm.busy || rebuild.isPending}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Rebuild ${vm.name}?`,
                    description:
                      "Everything on its disk is erased, including snapshots. This cannot be undone.",
                    confirm: "Erase and rebuild",
                    destructive: true,
                  })
                )
                  rebuild.mutate();
              }}
            >
              Rebuild
            </Button>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <p className="min-w-48 flex-1 text-muted-foreground">
            <span className="font-semibold text-foreground">{exists ? "Delete." : "Remove."}</span>{" "}
            {exists
              ? "Destroy the VM and its disks for good."
              : "Take this entry off your list. Nothing exists on the cluster."}
          </p>
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
              await run(`/vms/${vm.id}`, undefined, "DELETE");
              if (!exists) router.push("/");
            }}
          >
            {exists ? "Delete VM" : "Remove"}
          </Button>
        </div>
      </div>
    </SectionCard>
  );
}

/** Everything under the Settings tab. People a VM is shared with only get the login card. */
export function VmSettings({ vm, run, onLogin }: { vm: Detail; run: Run; onLogin: () => void }) {
  const router = useRouter();
  const session = useSession();
  const own = vm.access !== "shared";
  const active = vm.status === "active";
  return (
    <div className="space-y-4">
      {active ? <LoginPanel vm={vm} run={run} own={own} onLogin={onLogin} /> : null}
      {own && active ? <SizePanel key={`${vm.cores}-${vm.memoryMb}-${vm.diskGb}`} vm={vm} run={run} /> : null}
      {own && active ? (
        <SchedulePanel
          key={`${vm.schedule.start}-${vm.schedule.stop}-${vm.schedule.days.join("")}`}
          vm={vm}
          run={run}
        />
      ) : null}
      {own && vm.status !== "archived" ? <SharingPanel vm={vm} run={run} /> : null}
      {own && vm.status !== "provisioning" ? <DangerPanel vm={vm} run={run} onLogin={onLogin} /> : null}
      {!own ? (
        <SectionCard title="Shared with you">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <p className="min-w-48 flex-1 text-muted-foreground">
              {vm.owner.name} owns this VM. Leaving takes it off your list.
            </p>
            <Button
              variant="outline"
              onClick={async () => {
                if (!session.data) return;
                await run(`/vms/${vm.id}/shares/${session.data.id}`, undefined, "DELETE");
                router.push("/");
              }}
            >
              Leave
            </Button>
          </div>
        </SectionCard>
      ) : null}
    </div>
  );
}
