# MACS portal

Self-service virtual machines and GPU time on Monash Automation's Proxmox
clusters. Built from [MA-App-Template](https://github.com/monashautomation/MA-App-Template)
with the [`@monashautomation/ui`](https://github.com/monashautomation/MA-App-UI) package, so it
follows the platform app standard (central-platform-argocd `docs/standards/app-standard.md`).

**Stack:** Next.js 16 (App Router) · TypeScript · better-auth with Authentik (OIDC + PKCE) · Prisma + Postgres · Tailwind 4 + MA-App-UI · zod · pino · Vitest · Biome · pnpm.

## What it does

- **Two workspaces.** Everyone gets _My VMs_, _Images_, _GPUs_ and _Services_.
  Systems & Infra (`ADMIN_GROUPS`) also get _Infrastructure_: overview,
  approvals, every VM, GPU swaps, image library, network policy, people,
  activity and audit log.
- **Multiple clusters**, each with its own access groups, images, limits,
  quota, network policy and approval policy.
- **Homelab** is self-service within a quota. VMs are firewalled off from each
  other; owners publish individual ports as _public services_ reachable over
  NetBird.
- **Research** requests (with or without GPU access) are approved by Systems &
  Infra. VMs sit on the labs network.
- **GPUs.** Who holds each card is read from the VMs' Proxmox config, so it is
  right even for VMs the portal does not manage. Infra can swap a GPU between
  VMs; approved users book GPU time and a scheduler attaches and detaches the
  card, migrating the VM to a node with a free GPU.
- **One-click installs.** A library of ready-made setups (Docker, Gitea,
  Jellyfin, a web server…) and clean operating systems: one click creates the
  VM, sets up the login and networking, installs the software and publishes
  its address. Or install from an ISO yourself, the normal way.
- **Looking after a VM.** Snapshots and roll back, rebuild, resize, daily power
  schedules, adding SSH keys and resetting the password, sharing with
  teammates, and a first-steps checklist. Homelab VMs expire unless extended
  (shut down, never deleted).
- **Labs.** Several VMs deployed together (two servers, web + database, a k3s
  cluster) that can reach each other and nobody else.
- **Notifications** in the app, with a webhook for the Discord bot.
- **Image library** of prepared templates (flagged _GPU-ready_ when NVIDIA
  drivers are baked in) and install ISOs, curated in the app.
- **Console and terminal** in the browser (noVNC, xterm.js), plus SSH / RDP / Moonlight details.
- **Usage at a glance.** CPU, memory and network history on each VM, cluster
  load and GPU-hours booked per day for Systems & Infra, all read from Proxmox.
- **Backups** to Proxmox Backup Server: back up, roll back, archive, restore.

## Local development

No Proxmox or Authentik needed: `config.dev.yaml` uses an in-memory mock of
both clusters, and `scripts/mock-authentik.mjs` is a development-only OpenID
provider with a "who do you want to be?" page.

```bash
pnpm install
docker compose up -d                 # Postgres on localhost:5432
cp .env.example .env                 # then set the values below
pnpm db:migrate
node scripts/mock-authentik.mjs &    # http://localhost:9000
pnpm dev                             # http://localhost:3000
```

`.env` for the mock setup:

```bash
BETTER_AUTH_SECRET=<32+ random characters>
AUTHENTIK_ISSUER=http://localhost:9000/application/o/macs/
AUTHENTIK_CLIENT_ID=macs-dev
AUTHENTIK_CLIENT_SECRET=macs-dev-secret
ADMIN_GROUPS=automation-admins
MACS_CONFIG=./config.dev.yaml
```

Sign in as Ada (infrastructure), Alice or Bob (research members) or Sam
(student, homelab only). The mock clusters keep their state in
`.mock-state-*.json`; delete those and reset the database to start over.

```bash
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # what CI runs
```

The engine tests need Postgres. Point `TEST_DATABASE_URL` at an **empty**
database (they truncate it); without it those tests are skipped:

```bash
TEST_DATABASE_URL=postgresql://postgres:dev@localhost:5432/macs_test pnpm test
```

## Layout

```
src/app/                 pages and API routes (thin)
src/components/macs/     this app's screens, built from @monashautomation/ui components
src/server/config.ts     cluster config file (YAML, zod-validated)
src/server/proxmox/      Proxmox REST client, and the mock used in dev/tests
src/server/services/     the engine: provisioning, GPUs, scheduler, backups, firewall, images
src/server/handlers/     what each API route does (authorisation, validation, ownership)
src/server/core.ts       in-process state: jobs, locks, caches, console sessions
src/server/boot.ts       started once per process: scheduler + console relay
prisma/                  schema and migrations
deploy/                  ArgoCD values, ExternalSecret, NetworkPolicy
```

## Shared UI

Every shared component and the whole theme come from the `@monashautomation/ui`
package (MA-App-UI). `src/app/globals.css` imports its `theme.css`,
`next.config.ts` lists it in `transpilePackages`, and `pnpm lint` runs its
`ma-brand-lint`. Nothing shared is copied into this repo.

The dependency is pinned to a git commit of MA-App-UI until that package has a
published release; then switch it to a version (`^0.2.0`) and add the GitHub
Packages registry line to `.npmrc` (see MA-App-UI's README). Either way,
installing it needs read access to that repo/package: CI and the Docker build
need a token for it.

## Configuration

Two places:

- **Environment** (`src/env.ts`, `.env.example`): the template's settings
  (`APP_URL`, `DATABASE_URL`, `AUTHENTIK_*`, `ADMIN_GROUPS`, `MEMBER_GROUPS`…)
  plus `MACS_CONFIG`, `CONSOLE_WS_PORT`, `CONSOLE_WS_URL`,
  `SCHEDULER_INTERVAL_SECONDS`. Secrets come from OpenBao.
- **Cluster file** (`MACS_CONFIG`, see `config.example.yaml`): the clusters,
  their limits, GPUs and network policy. It holds no secrets: Proxmox tokens
  are `${ENV_VAR}` references.

Roles: `MEMBER_GROUPS` decides who may use the app at all, `ADMIN_GROUPS` is
Systems & Infra, and each cluster's `allowed_groups` decides who can use that
cluster. Groups refresh at every sign-in.

### Authentik

OAuth2/OpenID provider + application. Redirect URI
`<APP_URL>/api/auth/callback/authentik`; scopes `openid profile email` plus the
`groups` scope mapping.

### Proxmox

One API token per cluster. As a starting point (tighten to taste, and check the
role names on your PVE version):

```bash
pveum user add macs@pve
pveum user token add macs@pve portal --privsep 0
pveum acl modify / --users macs@pve --roles PVEAdmin
pveum acl modify /mapping/pci/rtx4090 --users macs@pve --roles PVEMappingUser
```

- **GPU passthrough:** create one PCI **resource mapping** (Datacenter →
  Resource Mappings) containing the GPU on each node and name it in
  `gpu.mapping`. Proxmox only lets `root@pam` attach raw PCI addresses, so
  without a mapping you must set `pci:` per device and use
  `username`/`password` instead of a token.
- **Templates** must be q35 machines with a cloud-init drive and the guest
  agent (the `img-builds/` images are). The portal sets the login user and SSH
  key; anything else every VM needs (NetBird enrolment) goes in a vendor-data
  snippet named in the image's _cloud-init vendor snippet_.
- **Backups:** add the PBS datastore as a storage and name it in
  `backup_storage`. Retention stays in PBS.
- **Isolation** (`network.isolate`) needs the datacenter firewall enabled.

## How it behaves

**Networks.** With `network.isolate` the portal turns on each VM's Proxmox
firewall with inbound dropped, then allows only the owner's `access_ports` from
`access_sources`, and each published service's port from `public_sources`. It
only writes rules whose comment starts with `macs:`. After changing the policy,
use Infrastructure → Network & services → _Re-apply to all VMs_. If your NetBird
routing peer masquerades, the source VMs see is that peer's address — use it in
the `*_sources` lists. The portal does not configure NetBird itself.

**GPU booking.** A booking reserves one GPU from the pool, not a specific card;
bookings that would exceed the number of GPUs are refused. At the start the VM
is shut down, migrated to the node of a free GPU if needed
(`shared_storage: true`), given the `hostpci` entry and started; at the end the
reverse. If every GPU is held, the scheduler may take one from a portal VM with
no active booking. It never touches VMs the portal does not manage.

**Images.** `templates:` in the cluster file only seeds the library on first
start; after that it is curated under Infrastructure → Image library, which
lists templates and ISOs found on the cluster. ISO installs create an empty
UEFI/q35 VM booted from the installer.

**One-click installs and setups.** On clusters with `setups: true` (and no
approval step), the Library page deploys in one click. The portal picks the
name and size, clones the default Linux image (`default_image`, else the first
Ubuntu/Debian template), and through cloud-init sets DHCP networking, the login
user, the person's saved SSH key if they have one, and a generated password. That
password is shown once on the VM's page and never stored: it is held in memory
only until the provisioning job hands it to Proxmox, which keeps a hash.

A _setup_ is a bash script run as root inside the new VM through the QEMU guest
agent once it has booted, so templates need `qemu-guest-agent` installed and the
API token needs guest-agent rights. If the script fails the VM stays up and the
owner can retry. Setups declare a minimum size and the ports they serve; on an
isolated cluster those ports are published (or sent for approval). Systems &
Infra manage the scripts under Infrastructure → Image library; members never see
them. The nine built-ins are starting points and have not been run on real VMs.

The manual path is unchanged: pick an installer under _Install it yourself_ and
the VM boots the ISO on an empty disk for a normal install from the console.

**Console.** The app asks Proxmox for a one-time VNC ticket and relays the
stream to noVNC in the browser, so users need no Proxmox login or route to the
nodes. Next.js route handlers cannot serve websockets, so the relay listens on
a second port (`CONSOLE_WS_PORT`, 3001) and the ingress maps `/console-ws` to
it. A connection needs the single-use token (20 s lifetime) that
`POST /api/v1/vms/:id/console` gives the VM's owner, and must come from the
app's own origin. While a GPU is the guest's primary display the Proxmox
console is blank; that is what Sunshine/Moonlight is for.

### Looking after a VM

Each VM page has four tabs: Overview, Snapshots (& backups), Settings, Activity.

- **Snapshots** are Proxmox disk snapshots (no RAM, so they also work with a
  GPU attached), up to `max_snapshots` per VM. Rolling back restarts a running
  VM and keeps today's GPU assignment and firewall, not the snapshot's.
- **Rebuild** erases the VM and deploys the same image and setup again under
  the same VMID. Name, size, sharing, keys and published ports survive;
  snapshots do not. A new one-time password is shown.
- **Resize** changes CPU, memory and disk (grow only) within the per-VM limits
  and the owner's quota; a running VM is restarted only for CPU/memory. On
  approval clusters only Systems & Infra can resize.
- **Expiry** (`lifetime_days`, 0 = off): the owner is warned
  `expiry_warning_days` ahead, then the VM is shut down, never deleted, and
  cannot be started until someone extends it (one click, a full lifetime from
  now).
- **Power schedule**: a daily shut-down and/or start time in the owner's time
  zone. A VM with an active GPU booking is not stopped until the booking ends.
- **Login**: SSH keys are added to the image's login account through the guest
  agent, after being rebuilt from their parts so nothing but
  `type base64 comment` reaches the shell. **Reset password** generates a
  password, sets it with Proxmox's `agent/set-user-password` call (not a shell
  command) and shows it once; it is never stored, logged or audited.
- **Terminal**: the VM's serial console (`serial0`, added at provisioning) in
  xterm.js, through the same one-time-token websocket relay as the console.
  It needs a getty on `ttyS0`, which cloud images have. VMs created before
  this get the port on first use and need one cold restart.
- **Sharing**: the owner adds people by name. They can see the VM, power it,
  open its console and terminal, extend it and add their own SSH key. Delete,
  rebuild, resize, schedules, publishing, backups, password reset and sharing
  stay with the owner (`getVm(who, id, "use")` vs the default `"own"`).

### Labs

With `labs: true` on a self-service cluster, the Library offers blueprints
(`src/server/services/labs.ts`): two plain servers, a Docker host with a
PostgreSQL server, a three-node k3s cluster. The members are created together,
then wired up once they have addresses: on an isolated cluster each gets a
`macs:lab` firewall rule admitting the other members (and still nobody else),
their names go into each other's `/etc/hosts`, and setup scripts get `LAB_*`
variables. The lab secret (database password, k3s token) is derived from
`BETTER_AUTH_SECRET` and the lab id, so it is in no table; it is written to
`/root/lab-secret` in each member. Peer rules use the members' current
addresses: if DHCP moves one, run Network sync.

### Notifications

Approvals and rejections, VM ready or failed, setup failures, expiry warnings,
GPU bookings starting or failing, sharing and labs each create a notification
for the people concerned, shown under the bell. If `NOTIFY_WEBHOOK_URL` is set,
each is also POSTed there (with `Authorization: Bearer $NOTIFY_WEBHOOK_TOKEN`):

```json
{
  "id": "…",
  "kind": "vm.expiring",
  "title": "…",
  "body": "…",
  "url": "https://macs…/vms/…",
  "user": { "sub": "<Authentik sub>", "name": "…" },
  "createdAt": "2026-11-25T03:00:00.000Z"
}
```

Anything the receiver does not answer 2xx is retried by the scheduler for a
day, so de-duplicate on `id`. This is the hook for the Discord bot: it maps
`user.sub` to a Discord account and sends the DM.

## Deploying

As for any template app (see `deploy/`), with three differences:

1. **One replica** (`strategy: Recreate`). The scheduler, running jobs and
   console sessions are in memory. After a restart, interrupted jobs are marked
   failed and bookings resume on the next scheduler pass.
2. **Two ports:** 3000 (app) and 3001 (console relay); the ingress routes
   `/console-ws` to 3001 and `CONSOLE_WS_URL` tells browsers where that is.
3. **Cluster file** mounted from a ConfigMap at `/config/config.yaml`, and the
   NetworkPolicy allows egress to the Proxmox API (8006).

OpenBao `apps/macs` needs the template's keys plus one Proxmox token secret per
cluster, named as in the cluster file, and `NOTIFY_WEBHOOK_URL` /
`NOTIFY_WEBHOOK_TOKEN` once the Discord bot has an endpoint for them (the
NetworkPolicy must then allow egress to it).

The app lives in `portal/` of this repo, so CI is `.github/workflows/portal-ci.yml`
at the repo root and the ArgoCD source path is `portal/deploy/extra`.

## Known gaps

- The built-in setup scripts and the guest-agent exec call are untested on
  real VMs.
- Not yet run against real Proxmox, Authentik or PBS: only the mock cluster,
  the mock OpenID provider and scripted Proxmox HTTP responses.
- `deploy/` values and the image-build CI job are adapted from the template but
  unverified against the platform (two ports, ConfigMap mount, app in a
  subdirectory).
- The snapshot, `termproxy` terminal and `set-user-password` calls, the lab
  setups and the notification webhook have only run against the mock.
  `termproxy` with an API token in particular needs checking on a real node.
- No idle detection (expiry is by date), no weekday-only power schedules.
- No in-browser SSH/RDP (console and serial terminal only), no
  NetBird API integration, no per-VM first-boot snippets (NetBird join is a
  static vendor snippet per image).
