import { z } from "zod";
import { db } from "@/lib/db";
import { toPublicUser } from "@/lib/public-user";
import { canUse } from "@/server/config";
import { Busy, core } from "@/server/core";
import { HttpError, isAdmin, type Who } from "@/server/http";
import { ProxmoxError } from "@/server/proxmox/types";
import { localClock, validTimeZone } from "@/server/services/housekeeping";
import { getImage } from "@/server/services/images";
import { BLUEPRINTS, deployLab } from "@/server/services/labs";
import {
  rebuildVm,
  removeSnapshot,
  resizeVm,
  rollbackSnapshot,
  SNAPSHOT_NAME,
  takeSnapshot,
} from "@/server/services/lifecycle";
import { notify } from "@/server/services/notify";
import { defaultImage, generatePassword } from "@/server/services/setups";
import { expiryFrom, locate, quotaError, usage, VM_LIVE } from "@/server/services/vms";
import { liveView, vmOut } from "@/server/views";
import { deleteVm, getVm, NAME, startJob } from "./vms";

/** Things people do to a VM they already have, and what surrounds it: sharing, labs, notifications. */

type VmRow = Awaited<ReturnType<typeof getVm>>;

function active(vm: VmRow) {
  if (vm.status !== "active" || vm.vmid === null) throw new HttpError(409, "the VM is not active");
  return vm.vmid;
}

/** The running VM on its cluster, or 409 with what to do about it. */
async function running(vm: VmRow, why: string) {
  const vmid = active(vm);
  const live = await locate(core(), vm);
  if (live?.status !== "running") throw new HttpError(409, `start the VM to ${why}`);
  return { vmid, node: live.node, drv: core().driver(vm.clusterId) };
}

/** A Linux VM deployed from a prepared image: the kind the portal can log in to and manage inside. */
async function linuxLogin(vm: VmRow): Promise<string> {
  const image = await getImage(vm.clusterId, vm.imageSlug);
  const user = image?.defaultUser ?? "";
  if (image?.kind !== "template" || image.os !== "linux" || !/^[a-z_][a-z0-9_-]{0,31}$/.test(user)) {
    throw new HttpError(409, "this only works on Linux VMs deployed from a prepared image");
  }
  return user;
}

// -- snapshots -----------------------------------------------------------

export async function listSnapshots(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id, "use");
  const max = c.findCluster(vm.clusterId)?.max_snapshots ?? 0;
  if (vm.status !== "active" || vm.vmid === null) return { max, snapshots: [] };
  const vmid = vm.vmid;
  const live = await locate(c, vm);
  if (!live) return { max, snapshots: [] };
  const rows = await c.driver(vm.clusterId).snapshots(live.node, vmid);
  return {
    max,
    snapshots: rows
      .map((s) => ({
        name: s.name,
        description: s.description,
        createdAt: new Date(s.time * 1000).toISOString(),
      }))
      .reverse(),
  };
}

export const SnapshotCreate = z.object({
  name: z.string().trim().regex(SNAPSHOT_NAME, "use letters, digits and dashes, starting with a letter"),
  description: z.string().trim().max(200).default(""),
});

export async function createSnapshot(who: Who, id: string, body: z.infer<typeof SnapshotCreate>) {
  const c = core();
  const vm = await getVm(who, id);
  active(vm);
  const { max, snapshots } = await listSnapshots(who, id);
  if (!max) throw new HttpError(409, "snapshots are not offered on this cluster");
  if (snapshots.some((s) => s.name === body.name))
    throw new HttpError(409, `this VM already has a snapshot called ${body.name}`);
  if (snapshots.length >= max)
    throw new HttpError(422, `a VM can keep ${max} snapshots; delete one to take another`);
  return {
    jobId: await startJob("snapshot", vm, who, (log) =>
      takeSnapshot(c, vm.id, body.name, body.description, log),
    ),
  };
}

async function snapshotNamed(who: Who, id: string, name: string) {
  const vm = await getVm(who, id);
  active(vm);
  // Only names Proxmox really has for this VM: never pass a client string through.
  if (!(await listSnapshots(who, id)).snapshots.some((s) => s.name === name))
    throw new HttpError(404, "snapshot not found");
  return vm;
}

export async function rollback(who: Who, id: string, name: string) {
  const vm = await snapshotNamed(who, id, name);
  return { jobId: await startJob("rollback", vm, who, (log) => rollbackSnapshot(core(), vm.id, name, log)) };
}

export async function deleteSnapshot(who: Who, id: string, name: string) {
  const vm = await snapshotNamed(who, id, name);
  return {
    jobId: await startJob("delete-snapshot", vm, who, (log) => removeSnapshot(core(), vm.id, name, log)),
  };
}

// -- rebuild and resize --------------------------------------------------

export async function rebuild(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id);
  active(vm);
  const image = await getImage(vm.clusterId, vm.imageSlug);
  if (!image?.enabled)
    throw new HttpError(409, "the image this VM was made from is no longer in the library");
  if (await db.reservation.count({ where: { vmId: vm.id, status: "active" } }))
    throw new HttpError(409, "this VM has a GPU right now; rebuild it after the booking ends");
  // Same rule as first login: generated here, handed to the job in memory, shown once.
  const password = image.kind === "template" && image.os === "linux" ? generatePassword() : undefined;
  c.setIntent(vm.id, { password, publish: false });
  let jobId: string;
  try {
    jobId = await startJob("rebuild", vm, who, (log) => rebuildVm(c, vm.id, log));
  } catch (e) {
    c.takeIntent(vm.id);
    throw e;
  }
  return { jobId, login: password ? { user: image.defaultUser, password } : null };
}

export const Resize = z.object({
  cores: z.number().int().min(1),
  memoryMb: z.number().int().min(512),
  diskGb: z.number().int().min(8),
});

export async function resize(who: Who, id: string, body: z.infer<typeof Resize>) {
  const c = core();
  const vm = await getVm(who, id);
  active(vm);
  const cluster = c.cluster(vm.clusterId);
  if (cluster.approval !== "none" && !isAdmin(who)) {
    throw new HttpError(
      403,
      `VMs on ${cluster.name} were sized by approval; ask Systems & Infra to resize it`,
    );
  }
  if (body.cores === vm.cores && body.memoryMb === vm.memoryMb && body.diskGb === vm.diskGb)
    throw new HttpError(422, "that is the size it already has");
  if (body.diskGb < vm.diskGb) throw new HttpError(422, "a disk can grow but not shrink");
  const lim = cluster.limits;
  if (body.cores > lim.max_cores || body.memoryMb > lim.max_memory_mb || body.diskGb > lim.max_disk_gb) {
    throw new HttpError(
      422,
      `over the per-VM limit (${lim.max_cores} cores, ${lim.max_memory_mb} MB, ${lim.max_disk_gb} GB)`,
    );
  }
  if (!isAdmin(who)) {
    const used = await usage(vm.ownerId, cluster.id);
    const without = {
      ...used,
      cores: used.cores - vm.cores,
      memoryMb: used.memoryMb - vm.memoryMb,
      diskGb: used.diskGb - vm.diskGb,
    };
    const over = quotaError(cluster, without, body, 0);
    if (over) throw new HttpError(422, over);
  }
  await c.audit(
    who.id,
    "resize-request",
    `${vm.clusterId}/${vm.name}`,
    `${vm.cores}c/${vm.memoryMb}MB/${vm.diskGb}GB -> ${body.cores}c/${body.memoryMb}MB/${body.diskGb}GB`,
  );
  return { jobId: await startJob("resize", vm, who, (log) => resizeVm(c, vm.id, body, log)) };
}

// -- expiry and power schedule -------------------------------------------

/** Push the VM's expiry out to a full lifetime from now. Anyone who uses the VM can. */
export async function extend(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id, "use");
  active(vm);
  const expiresAt = expiryFrom(c.cluster(vm.clusterId));
  if (!expiresAt) throw new HttpError(409, "VMs on this cluster do not expire");
  await db.vm.update({ where: { id: vm.id }, data: { expiresAt, expiryWarnedAt: null, expired: false } });
  await c.audit(who.id, "extend", `${vm.clusterId}/${vm.name}`, expiresAt.toISOString().slice(0, 10));
  return { expiresAt: expiresAt.toISOString() };
}

/** "Keep running": the owner says an idle-looking VM is in use. Idle checks leave it alone for two weeks. */
export async function keepRunning(who: Who, id: string) {
  const vm = await getVm(who, id, "use");
  active(vm);
  const idleCheckAfter = new Date(Date.now() + 14 * 86_400_000);
  await db.vm.update({ where: { id: vm.id }, data: { idleWarnedAt: null, idleCheckAfter } });
  await core().audit(who.id, "keep-running", `${vm.clusterId}/${vm.name}`);
}

const clock = z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM")]);
export const Schedule = z.object({
  start: clock.default(""),
  stop: clock.default(""),
  timeZone: z.string().max(64).default("UTC"),
  /** ISO weekdays the schedule applies on, 1 (Mon) to 7 (Sun). Empty = every day. */
  days: z.array(z.number().int().min(1).max(7)).max(7).default([]),
});

export async function setSchedule(who: Who, id: string, input: z.input<typeof Schedule>) {
  const body = Schedule.parse(input);
  const vm = await getVm(who, id);
  active(vm);
  if (!validTimeZone(body.timeZone)) throw new HttpError(422, "unknown time zone");
  if (body.start && body.start === body.stop)
    throw new HttpError(422, "start and stop cannot be the same time");
  const days = [...new Set(body.days)].sort();
  // A time that has already passed today first fires tomorrow.
  const { date, time } = localClock(new Date(), body.timeZone);
  await db.vm.update({
    where: { id: vm.id },
    data: {
      autoStart: body.start,
      autoStop: body.stop,
      scheduleTz: body.timeZone,
      scheduleDays: days.length === 7 ? "" : days.join(""),
      lastAutoStart: body.start && time >= body.start ? date : "",
      lastAutoStop: body.stop && time >= body.stop ? date : "",
    },
  });
  await core().audit(
    who.id,
    "set-schedule",
    `${vm.clusterId}/${vm.name}`,
    `start=${body.start || "-"} stop=${body.stop || "-"} ${body.timeZone} days=${days.join("") || "all"}`,
  );
}

// -- logging in: keys, password, terminal --------------------------------

const KEY_TYPE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com)$/;

/**
 * SSH public keys, one per line, rebuilt from their parts so that what reaches
 * a shell or a file is only ever "type base64 comment" in safe characters.
 */
export function normalizeKeys(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const [type = "", blob = "", ...rest] = line.trim().split(/\s+/);
    if (!type) continue;
    if (!KEY_TYPE.test(type) || !/^[A-Za-z0-9+/]{32,2000}={0,3}$/.test(blob)) {
      throw new HttpError(422, "that does not look like an SSH public key");
    }
    const comment = rest
      .join("-")
      .replace(/[^A-Za-z0-9@._+-]/g, "")
      .slice(0, 64);
    out.push(comment ? `${type} ${blob} ${comment}` : `${type} ${blob}`);
  }
  if (out.length > 10) throw new HttpError(422, "at most 10 keys");
  return [...new Set(out)];
}

export const Keys = z.object({ sshPublicKey: z.string().max(8000) });

/** The keys offered by default on new VMs. */
export async function saveProfile(who: Who, body: z.infer<typeof Keys>) {
  const sshPublicKey = normalizeKeys(body.sshPublicKey).join("\n");
  await db.profile.upsert({
    where: { userId: who.id },
    create: { userId: who.id, sshPublicKey },
    update: { sshPublicKey },
  });
  return { sshPublicKey };
}

/** Add SSH keys to a running VM's login account, through the guest agent. */
export async function installKeys(who: Who, id: string, body: z.infer<typeof Keys>) {
  const vm = await getVm(who, id, "use");
  const keys = normalizeKeys(body.sshPublicKey);
  if (!keys.length) throw new HttpError(422, "paste at least one SSH public key");
  const user = await linuxLogin(vm);
  const { vmid, node, drv } = await running(vm, "add keys to it");
  const script = `set -eu
U='${user}'
H=$(getent passwd "$U" | cut -d: -f6)
[ -n "$H" ] || { echo "no account called $U in this VM" >&2; exit 2; }
G=$(id -gn "$U")
install -d -m 700 -o "$U" -g "$G" "$H/.ssh"
touch "$H/.ssh/authorized_keys"
while IFS= read -r key; do
  [ -n "$key" ] || continue
  grep -qxF "$key" "$H/.ssh/authorized_keys" || printf '%s\\n' "$key" >> "$H/.ssh/authorized_keys"
done <<'MACS_KEYS'
${keys.join("\n")}
MACS_KEYS
chown "$U:$G" "$H/.ssh/authorized_keys"
chmod 600 "$H/.ssh/authorized_keys"`;
  const jobId = await startJob("add-keys", vm, who, async (log) => {
    log(`adding ${keys.length} SSH key${keys.length === 1 ? "" : "s"} for ${user}`);
    const result = await drv.runInGuest(node, vmid, script, { agentWaitMs: 60_000, timeoutMs: 60_000 });
    if (result.exitCode !== 0) throw new ProxmoxError(result.output.trim() || "could not add the keys");
    // Remember them so a rebuild puts them back.
    const fresh = await db.vm.findUniqueOrThrow({ where: { id: vm.id }, select: { sshPublicKey: true } });
    const all = new Set([...fresh.sshPublicKey.split("\n").map((k) => k.trim()), ...keys].filter(Boolean));
    await db.vm.update({ where: { id: vm.id }, data: { sshPublicKey: [...all].join("\n") } });
    log("done");
  });
  return { jobId };
}

/**
 * Set a new generated password on the VM's login account (the console and
 * terminal ask for it). The owner sees it once, in this response; it is not
 * stored, logged or put in the audit trail, and it travels to the VM through
 * Proxmox's guest-agent password call rather than a shell command.
 */
export async function resetPassword(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id);
  const user = await linuxLogin(vm);
  const { vmid, node, drv } = await running(vm, "reset its password");
  const password = generatePassword();
  await drv.setGuestPassword(node, vmid, user, password);
  await c.audit(who.id, "reset-password", `${vm.clusterId}/${vm.name}`, `account ${user}`);
  return { login: { user, password } };
}

/** Open the VM's serial terminal. Returns a one-time token for the console websocket. */
export async function openTerminal(who: Who, id: string) {
  const c = core();
  const vm = await getVm(who, id, "use");
  const image = await getImage(vm.clusterId, vm.imageSlug);
  if (image && image.os !== "linux")
    throw new HttpError(409, "the terminal is for Linux VMs; use the console");
  const { vmid, node, drv } = await running(vm, "open its terminal");
  if (!("serial0" in (await drv.vmConfig(node, vmid)))) {
    // VMs from before the terminal existed: give them the port; it appears at the next cold start.
    await drv.setConfig(node, vmid, { serial0: "socket" });
    throw new HttpError(
      409,
      "The terminal has just been switched on for this VM. Shut it down and start it once, then open the terminal again.",
    );
  }
  const stream = await drv.openTerminal(node, vmid);
  await c.audit(who.id, "terminal", `${vm.clusterId}/${vm.name}`);
  return { token: c.holdConsole(who.id, stream), name: vm.name };
}

// -- sharing -------------------------------------------------------------

export const PeopleQuery = z.object({ q: z.string().trim().min(2).max(64) });

/** Find people to share with, by name. Never by email, and only what PublicUser shows. */
export async function findPeople(who: Who, q: string) {
  const rows = await db.user.findMany({
    where: { name: { contains: q, mode: "insensitive" }, id: { not: who.id } },
    orderBy: { name: "asc" },
    take: 8,
  });
  return rows.map(toPublicUser);
}

export const Share = z.object({ userId: z.string().min(1) });

export async function addShare(who: Who, id: string, body: z.infer<typeof Share>) {
  const vm = await getVm(who, id);
  if (!VM_LIVE.includes(vm.status)) throw new HttpError(409, `cannot share a VM that is ${vm.status}`);
  if (body.userId === vm.ownerId) throw new HttpError(422, "that is the VM's owner");
  const user = await db.user.findUnique({ where: { id: body.userId } });
  if (!user) throw new HttpError(404, "person not found");
  if ((await db.vmShare.count({ where: { vmId: vm.id } })) >= 10)
    throw new HttpError(422, "a VM can be shared with at most 10 people");
  await db.vmShare.upsert({
    where: { vmId_userId: { vmId: vm.id, userId: user.id } },
    create: { vmId: vm.id, userId: user.id },
    update: {},
  });
  await core().audit(who.id, "share", `${vm.clusterId}/${vm.name}`, `with ${user.id}`);
  await notify(user.id, {
    kind: "vm.shared",
    title: `${who.name} shared ${vm.name} with you`,
    body: "You can start and stop it and open its console and terminal.",
    link: `/vms/${vm.id}`,
  });
  return toPublicUser(user);
}

/** The owner takes access away, or someone removes themselves. */
export async function removeShare(who: Who, id: string, userId: string) {
  const vm = await getVm(who, id, userId === who.id ? "use" : "own");
  const { count } = await db.vmShare.deleteMany({ where: { vmId: vm.id, userId } });
  if (!count) throw new HttpError(404, "that person does not have access");
  await core().audit(who.id, "unshare", `${vm.clusterId}/${vm.name}`, `with ${userId}`);
}

// -- labs ----------------------------------------------------------------

export const LabCreate = z.object({
  clusterId: z.string(),
  blueprint: z.string(),
  name: z.string().trim().toLowerCase(),
});

export async function createLab(who: Who, body: z.infer<typeof LabCreate>) {
  const c = core();
  const cluster = c.findCluster(body.clusterId);
  if (!cluster || !canUse(cluster, who)) throw new HttpError(404, "cluster not found");
  const blueprint = BLUEPRINTS.find((b) => b.id === body.blueprint);
  if (!cluster.labs || cluster.approval !== "none" || !blueprint)
    throw new HttpError(422, "that lab is not available on this cluster");
  if (!NAME.test(body.name) || body.name.length > 24) {
    throw new HttpError(422, "name the lab with lowercase letters, digits and dashes, up to 24 characters");
  }
  const images = await db.image.findMany({ where: { clusterId: cluster.id, enabled: true } });
  const image = defaultImage(cluster, images);
  if (!image) throw new HttpError(422, "no suitable image is in the library for this cluster");
  const members = blueprint.members.map((m) => ({ ...m, name: `${body.name}-${m.role}` }));
  for (const m of members) {
    if (m.setupSlug && !(await db.setup.findFirst({ where: { slug: m.setupSlug, enabled: true } })))
      throw new HttpError(422, `the ${m.setupSlug} setup this lab needs is switched off`);
  }
  const lim = cluster.limits;
  if (
    members.some(
      (m) => m.cores > lim.max_cores || m.memoryMb > lim.max_memory_mb || m.diskGb > lim.max_disk_gb,
    )
  ) {
    throw new HttpError(422, `${blueprint.name} needs more than ${cluster.name} allows per VM`);
  }
  const clash = await db.vm.findFirst({
    where: { clusterId: cluster.id, status: { in: VM_LIVE }, name: { in: members.map((m) => m.name) } },
  });
  if (clash) throw new HttpError(409, `a VM named ${clash.name} already exists on ${cluster.name}`);
  const total = {
    cores: members.reduce((n, m) => n + m.cores, 0),
    memoryMb: members.reduce((n, m) => n + m.memoryMb, 0),
    diskGb: members.reduce((n, m) => n + m.diskGb, 0),
  };
  const over = quotaError(cluster, await usage(who.id, cluster.id), total, members.length);
  if (over) throw new HttpError(422, over);

  const profile = await db.profile.findUnique({ where: { userId: who.id } });
  const lab = await db.lab.create({
    data: { clusterId: cluster.id, name: body.name, blueprint: blueprint.id, ownerId: who.id },
  });
  // One password for the whole lab, under the same rule as any first login.
  const password = generatePassword();
  const jobs: { vmId: string; jobId: string }[] = [];
  const vms = [];
  for (const m of members) {
    const vm = await db.vm.create({
      data: {
        clusterId: cluster.id,
        name: m.name,
        ownerId: who.id,
        imageSlug: image.slug,
        cores: m.cores,
        memoryMb: m.memoryMb,
        diskGb: m.diskGb,
        sshPublicKey: profile?.sshPublicKey ?? "",
        status: "provisioning",
        setupSlug: m.setupSlug ?? "",
        setupStatus: m.setupSlug ? "pending" : "none",
        labId: lab.id,
        labRole: m.role,
      },
      include: { owner: true, reviewedBy: true },
    });
    c.setIntent(vm.id, { password });
    jobs.push({ vmId: vm.id, jobId: await c.createJob("provision", vm, who.id) });
    vms.push(vm);
  }
  await c.audit(who.id, "deploy-lab", `${cluster.id}/${lab.name}`, blueprint.id);
  c.background(() => deployLab(c, lab.id, jobs));
  const live = await liveView(c, cluster.id);
  return {
    id: lab.id,
    name: lab.name,
    vms: vms.map((v) => vmOut(v, live, true)),
    login: { user: image.defaultUser, password },
  };
}

export async function listLabs(who: Who) {
  const rows = await db.lab.findMany({
    where: { ownerId: who.id, vms: { some: { status: { not: "deleted" } } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((l) => ({
    id: l.id,
    name: l.name,
    clusterId: l.clusterId,
    blueprint: BLUEPRINTS.find((b) => b.id === l.blueprint)?.name ?? l.blueprint,
  }));
}

/** Delete every VM in a lab. Members that are busy are left for another go. */
export async function deleteLab(who: Who, id: string) {
  const lab = await db.lab.findFirst({ where: isAdmin(who) ? { id } : { id, ownerId: who.id } });
  if (!lab) throw new HttpError(404, "lab not found");
  const members = await db.vm.findMany({ where: { labId: lab.id, status: { not: "deleted" } } });
  const skipped: string[] = [];
  for (const m of members) {
    try {
      await deleteVm(who, m.id);
    } catch (e) {
      if (!(e instanceof Busy) && !(e instanceof HttpError)) throw e;
      skipped.push(m.name);
    }
  }
  if (skipped.length)
    throw new HttpError(409, `${skipped.join(", ")} could not be deleted right now; try again shortly`);
}

// -- notifications -------------------------------------------------------

export async function listNotifications(who: Who) {
  const [rows, unread] = await Promise.all([
    db.notification.findMany({ where: { userId: who.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    db.notification.count({ where: { userId: who.id, readAt: null } }),
  ]);
  return {
    unread,
    items: rows.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      body: n.body,
      link: n.link,
      read: !!n.readAt,
      createdAt: n.createdAt.toISOString(),
    })),
  };
}

export async function markNotificationsRead(who: Who) {
  await db.notification.updateMany({ where: { userId: who.id, readAt: null }, data: { readAt: new Date() } });
}
