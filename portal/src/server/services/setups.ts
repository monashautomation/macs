import { randomInt } from "node:crypto";
import type { Image, Setup } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import type { ClusterConfig } from "@/server/config";
import type { Core, Log } from "@/server/core";
import { ProxmoxError } from "@/server/proxmox/types";
import { applyNetworkPolicy } from "./network";
import { locate } from "./vms";

/**
 * Ready-made setups: scripts the portal runs as root inside a freshly deployed
 * Debian/Ubuntu VM, through the QEMU guest agent, to install something.
 */

export const SetupPort = z.object({
  name: z.string().trim().min(1).max(64),
  port: z.number().int().min(1).max(65535),
  protocol: z.enum(["tcp", "udp"]).default("tcp"),
  scheme: z.enum(["", "http", "https"]).default(""),
});
export type SetupPort = z.infer<typeof SetupPort>;

export const setupPorts = (s: Pick<Setup, "ports">): SetupPort[] =>
  z.array(SetupPort).catch([]).parse(s.ports);

const DOCKER = `apt-get update -qq
apt-get install -y -qq docker.io
systemctl enable --now docker
[ -n "\${MACS_USER:-}" ] && usermod -aG docker "$MACS_USER" || true`;

const container = (run: string) => `${DOCKER}\n${run}`;

type Builtin = Omit<Setup, "id" | "createdAt" | "enabled" | "ports"> & { ports: SetupPort[] };
const port = (
  name: string,
  p: number,
  scheme: SetupPort["scheme"] = "",
  protocol: SetupPort["protocol"] = "tcp",
): SetupPort => ({ name, port: p, scheme, protocol });

/** Starter library, added on first start. Systems & Infra edit, hide or add to it in the app. */
export const BUILTIN: Builtin[] = [
  {
    slug: "docker",
    name: "Docker host",
    category: "Containers",
    cores: 2,
    memoryMb: 2048,
    diskGb: 20,
    ports: [],
    description: "Docker Engine, ready for your own containers. Your login can run docker without sudo.",
    script: DOCKER,
    afterInstall: "Sign in and try: docker run hello-world",
  },
  {
    slug: "portainer",
    name: "Portainer",
    category: "Containers",
    cores: 2,
    memoryMb: 2048,
    diskGb: 20,
    ports: [port("Portainer", 9443, "https")],
    description: "A web interface for managing Docker containers, on a Docker host.",
    script: container(
      "docker run -d --name portainer --restart unless-stopped -p 9443:9443 -v /var/run/docker.sock:/var/run/docker.sock -v portainer_data:/data portainer/portainer-ce:latest",
    ),
    afterInstall:
      "Open the Portainer address within a few minutes and create the admin account (it locks itself if left unclaimed).",
  },
  {
    slug: "nginx",
    name: "Web server (nginx)",
    category: "Web",
    cores: 1,
    memoryMb: 1024,
    diskGb: 20,
    ports: [port("Website", 80, "http")],
    description: "nginx serving a starter page from /var/www/html. A first place to put a site.",
    script: `apt-get update -qq
apt-get install -y -qq nginx
cat > /var/www/html/index.html <<HTML
<!doctype html><title>\${MACS_HOSTNAME:-It works}</title><h1>\${MACS_HOSTNAME:-It works}</h1><p>Edit /var/www/html/index.html</p>
HTML
systemctl enable --now nginx`,
    afterInstall: "Your site is in /var/www/html.",
  },
  {
    slug: "uptime-kuma",
    name: "Uptime Kuma",
    category: "Monitoring",
    cores: 1,
    memoryMb: 1024,
    diskGb: 20,
    ports: [port("Uptime Kuma", 3001, "http")],
    description: "Self-hosted uptime monitoring with a status page.",
    script: container(
      "docker run -d --name uptime-kuma --restart unless-stopped -p 3001:3001 -v uptime-kuma:/app/data louislam/uptime-kuma:1",
    ),
    afterInstall: "Open it and create the admin account.",
  },
  {
    slug: "gitea",
    name: "Gitea",
    category: "Development",
    cores: 2,
    memoryMb: 2048,
    diskGb: 40,
    ports: [port("Gitea", 3000, "http"), port("Gitea SSH", 2222)],
    description: "A lightweight self-hosted Git service.",
    script: container(
      "docker run -d --name gitea --restart unless-stopped -p 3000:3000 -p 2222:22 -v gitea:/data gitea/gitea:latest",
    ),
    afterInstall: "Open it to finish the first-run setup. Git over SSH is on port 2222.",
  },
  {
    slug: "jellyfin",
    name: "Jellyfin",
    category: "Media",
    cores: 2,
    memoryMb: 4096,
    diskGb: 40,
    ports: [port("Jellyfin", 8096, "http")],
    description: "A media server. Put files in /srv/media.",
    script: container(
      "mkdir -p /srv/media\ndocker run -d --name jellyfin --restart unless-stopped -p 8096:8096 -v jellyfin-config:/config -v jellyfin-cache:/cache -v /srv/media:/media jellyfin/jellyfin:latest",
    ),
    afterInstall: "Open it to run the setup wizard; add /media as a library.",
  },
  {
    slug: "home-assistant",
    name: "Home Assistant",
    category: "Automation",
    cores: 2,
    memoryMb: 2048,
    diskGb: 40,
    ports: [port("Home Assistant", 8123, "http")],
    description: "Home automation hub (container install).",
    script: container(
      "docker run -d --name homeassistant --restart unless-stopped -p 8123:8123 -v homeassistant:/config ghcr.io/home-assistant/home-assistant:stable",
    ),
    afterInstall: "Open it and create your account. First start takes a few minutes.",
  },
  {
    slug: "k3s",
    name: "Kubernetes (k3s)",
    category: "Containers",
    cores: 2,
    memoryMb: 4096,
    diskGb: 40,
    ports: [],
    description: "A single-node Kubernetes cluster to learn on.",
    script: `apt-get update -qq
apt-get install -y -qq curl
curl -sfL https://get.k3s.io | sh -`,
    afterInstall: "Sign in and try: sudo kubectl get nodes",
  },
  {
    slug: "minecraft",
    name: "Minecraft server",
    category: "Games",
    cores: 2,
    memoryMb: 4096,
    diskGb: 20,
    ports: [port("Minecraft", 25565)],
    description: "A Java Edition server. Installing it accepts the Minecraft EULA on your behalf.",
    script: container(
      "docker run -d --name minecraft --restart unless-stopped -p 25565:25565 -e EULA=TRUE -v minecraft:/data itzg/minecraft-server:latest",
    ),
    afterInstall:
      "World data is in the minecraft Docker volume. The first start downloads the server and takes a few minutes.",
  },
];

/** Add built-in setups the library does not have yet; never overwrite edits. */
export async function seedSetups() {
  const have = new Set((await db.setup.findMany({ select: { slug: true } })).map((s) => s.slug));
  for (const b of BUILTIN) if (!have.has(b.slug)) await db.setup.create({ data: b });
}

export function setupOut(s: Setup) {
  return {
    id: s.slug,
    name: s.name,
    description: s.description,
    category: s.category,
    cores: s.cores,
    memoryMb: s.memoryMb,
    diskGb: s.diskGb,
    ports: setupPorts(s),
    afterInstall: s.afterInstall,
  };
}

/** The image one-click setups go on: the configured one, else the first Ubuntu/Debian template. */
export function defaultImage(cluster: ClusterConfig, images: Image[]): Image | undefined {
  const usable = images.filter((i) => i.enabled && i.kind === "template" && i.os === "linux");
  return (
    usable.find((i) => i.slug === cluster.default_image) ??
    usable.find((i) => /ubuntu/i.test(`${i.slug} ${i.name}`)) ??
    usable.find((i) => /debian/i.test(`${i.slug} ${i.name}`)) ??
    usable[0]
  );
}

/** A password someone can read off a screen and type into a console. */
export function generatePassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes
  const group = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return `${group()}-${group()}-${group()}-${group()}`;
}

const shq = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;

/** Run a VM's setup inside it and record the outcome. Throws if it fails. */
export async function installSetup(core: Core, vmId: string, log: Log, publish = false): Promise<void> {
  const vm = await db.vm.findUniqueOrThrow({ where: { id: vmId } });
  const setup = await db.setup.findUnique({ where: { slug: vm.setupSlug } });
  const fail = async (message: string): Promise<never> => {
    await db.vm.update({ where: { id: vmId }, data: { setupStatus: "failed" } });
    throw new ProxmoxError(message);
  };
  if (!setup) return fail(`setup ${vm.setupSlug} is no longer in the library`);
  const live = await locate(core, vm);
  if (!live || vm.vmid === null || live.status !== "running")
    return fail("the VM must be running to install its setup");
  const image = await db.image.findUnique({
    where: { clusterId_slug: { clusterId: vm.clusterId, slug: vm.imageSlug } },
  });
  await db.vm.update({ where: { id: vmId }, data: { setupStatus: "installing" } });
  log(`installing ${setup.name} (waiting for the VM to finish booting)`);
  const script = [
    "set -euo pipefail",
    "export DEBIAN_FRONTEND=noninteractive",
    `MACS_USER=${shq(image?.defaultUser ?? "")}`,
    `MACS_HOSTNAME=${shq(vm.name)}`,
    'command -v apt-get >/dev/null || { echo "This setup needs a Debian or Ubuntu image." >&2; exit 2; }',
    // cloud-init may still be holding apt on first boot.
    "command -v cloud-init >/dev/null && cloud-init status --wait >/dev/null 2>&1 || true",
    setup.script,
  ].join("\n");
  let result: { exitCode: number; output: string };
  try {
    result = await core.driver(vm.clusterId).runInGuest(live.node, vm.vmid, script);
  } catch (e) {
    return fail((e as Error).message);
  }
  const tail = result.output.trim().split("\n").slice(-25).join("\n");
  if (tail) log(tail);
  if (result.exitCode !== 0)
    return fail(`${setup.name} did not install (exit code ${result.exitCode}); see the log above`);
  await db.vm.update({ where: { id: vmId }, data: { setupStatus: "done" } });
  log(`${setup.name} installed`);

  if (publish) {
    const net = core.cluster(vm.clusterId).network;
    const ports = setupPorts(setup).filter(
      (p) => !(p.protocol === "tcp" && net.access_ports.includes(p.port)),
    );
    if (net.services && ports.length) {
      const status = net.service_approval === "none" ? "published" : "pending";
      for (const p of ports.slice(0, net.max_services_per_vm)) {
        await db.service.create({
          data: { vmId, name: p.name, port: p.port, protocol: p.protocol, scheme: p.scheme, status },
        });
      }
      await applyNetworkPolicy(core, vmId, log);
      log(
        status === "published"
          ? `published ${ports.map((p) => p.port).join(", ")}`
          : "asked Systems & Infra to publish its ports",
      );
    }
  }
}
