# MACS portal

Web front end for deploying and managing VMs across our Proxmox clusters, with
GPU tracking, swapping and time-booking on the research cluster.

- **Two workspaces** — everyone gets *My workspace* (their VMs, the image
  library, GPU time, services). Members of `auth.admin_groups` also get the
  *Infrastructure* console: overview, approvals, every VM, GPU swaps, image
  library, network policy, people, activity and audit log.
- **Multiple clusters** — each with its own access groups, images, limits,
  network policy and approval policy (`config.yaml`).
- **Homelab** — self-service: a student picks an image and size and gets a
  running VM within their quota. VMs are firewalled off from each other;
  owners publish individual ports as *public services* reachable over NetBird.
- **Image library** — prepared templates (flagged *GPU-ready* when NVIDIA
  drivers are baked in) and install ISOs, curated per cluster by the
  infrastructure team.
- **Research** — requests (with or without GPU access) wait for an admin.
- **GPUs** — the portal reads every VM's `hostpciN` config, so it always shows
  which VM really holds each card, including VMs it does not manage. Admins can
  swap a GPU between VMs; approved users book GPU time and a scheduler attaches
  and detaches the card on time, migrating the VM to a node with a free GPU.
- **Backups** — back up to Proxmox Backup Server, roll back, or *archive* a VM
  (backup, then destroy) and restore it later.
- **Console and connection details** — each VM page opens the VM's screen in
  the browser (noVNC, proxied through the portal) and lists how to reach it:
  SSH command, RDP (with a downloadable `.rdp` file), Moonlight/Sunshine.
- **Authentik** sign-in (OIDC); roles come from Authentik groups.

```
backend/    FastAPI app: Proxmox client, scheduler, API   (Python)
frontend/   React single-page app                         (TypeScript, Vite, Tailwind)
```

## Try it locally (no Proxmox needed)

`config.dev.yaml` uses fake sign-in and an in-memory mock of both clusters.

```sh
cd backend
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
MACS_CONFIG=../config.dev.yaml .venv/bin/uvicorn app.main:app --factory --reload
```

```sh
cd frontend
npm install
npm run dev        # http://localhost:5173, proxies /api and /auth to :8000
```

Sign in as `sam` (student, homelab only), `alice`/`bob` (research members) or
`admin`. Delete `backend/macs-dev.db` and `backend/mock-*.json` to reset.

Tests: `cd backend && .venv/bin/pytest`.

## Deploy

```sh
cp config.example.yaml config.yaml    # edit clusters, groups, templates
cp .env.example .env                  # secrets referenced as ${VAR} in config.yaml
docker compose up -d --build
```

Put it behind your TLS reverse proxy and set `app.base_url` to the public URL.
Run **one** instance: the scheduler and job runner live in the web process.

### Authentik

1. Create an **OAuth2/OpenID Provider** (confidential client) and an
   application for it.
2. Redirect URI: `<base_url>/auth/callback`.
3. Scopes `openid profile email` — Authentik's default `profile` scope carries
   the `groups` claim the portal uses.
4. Copy the client id/secret into `.env`, and the provider's *OpenID
   Configuration Issuer* into `auth.issuer`.

Group membership is read at sign-in: `auth.admin_groups` are admins, and each
cluster's `allowed_groups` decides who can use it. To restrict who can sign in
at all, bind a group policy to the application in Authentik.

### Proxmox

Create an API token per cluster and give it rights over VMs, storage and the
GPU mapping. As a starting point (tighten to taste, and check the role names on
your PVE version):

```sh
pveum user add macs@pve
pveum user token add macs@pve portal --privsep 0
pveum acl modify / --users macs@pve --roles PVEAdmin
pveum acl modify /mapping/pci/rtx4090 --users macs@pve --roles PVEMappingUser
```

**GPU passthrough** — create one PCI **resource mapping** (Datacenter →
Resource Mappings) that contains the 4090 on each node, and name it in
`gpu.mapping`. Proxmox only lets `root@pam` attach raw PCI addresses, so
without a mapping you must set `pci:` on each device and use
`username`/`password` instead of a token.

**Templates** must be q35 machines with a cloud-init drive and the guest agent
(the `img-builds/` images are). The portal sets the login user and SSH key via
cloud-init; anything else every VM needs (e.g. NetBird enrolment) goes in a
vendor-data snippet referenced by the template's `cicustom`.

**Backups** — add the PBS datastore as a storage on the cluster and put its
storage id in `backup_storage`. Pruning/retention stays in PBS.

## Console and connecting

**Open console** shows the VM's display and keyboard in a browser tab. The
portal asks Proxmox for a one-time VNC ticket (`vncproxy`) and relays the
stream over its own websocket, so users never need a Proxmox login or a network
route to the nodes, and it works before the guest has networking. Each console
is single-use, tied to the signed-in owner (or an admin) and audit-logged.

- The reverse proxy in front of the portal must pass websocket upgrades for
  `/api/console/`.
- The API token needs `VM.Console` (included in `PVEAdmin` / `PVEVMUser`).
- While a GPU is passed through with `x-vga=1`, or the guest only draws to the
  GPU, the Proxmox display is blank — that is what Sunshine/Moonlight is for.
- VNC has no clipboard into the guest; **Paste as keystrokes** types the
  clipboard instead (US layout).

Network connection details come from each template's `connect` list (`ssh`,
`rdp`, `sunshine`; default `ssh` for Linux, `rdp` for Windows). The address is
`<vm-name>.<connect_domain>` if the cluster sets `connect_domain` (e.g. the
NetBird domain), otherwise the IPs reported by the guest agent. These are
details for the user's own client; the portal does not proxy SSH or RDP.

## Networks, isolation and public services

Each cluster has a `network` block in `config.yaml`.

**Research** leaves `isolate` off: VMs are attached to the configured
`bridge`/`vlan` (your labs network) and the portal adds no filtering, so
services run locally on the lab LAN.

**Homelab** sets `isolate: true`. For every VM it manages there, the portal
turns on the VM's Proxmox firewall with inbound traffic dropped by default,
then allows only:

| What | Config | Typical value |
| --- | --- | --- |
| The owner's login ports | `access_ports` from `access_sources` | `[22, 3389]` from the NetBird range |
| Ports the owner publishes | each service's port from `public_sources` | the NetBird range / routing peer |

So homelab VMs cannot connect to each other, an unpublished port is closed to
everyone, and a published port is reachable from NetBird only. Published
services are listed for users on the Services page; the infrastructure team
sees and can close any of them, and `service_approval: required` makes each
one wait for approval.

Things to know:

- **The datacenter firewall must be enabled** (Datacenter → Firewall → Options)
  or Proxmox enforces none of this. The Infrastructure overview warns when it
  is off.
- If your NetBird routing peer masquerades, the source the VMs see is the
  routing peer's address on the homelab network — put that in the two
  `*_sources` lists rather than the NetBird range.
- The portal only writes rules whose comment starts with `macs:`; rules added
  by hand are left alone. After changing the policy in `config.yaml`, use
  Infrastructure → Network & services → *Re-apply to all VMs*.
- Only portal-managed VMs are covered. Adopting a VM applies the policy to it.
  For defence in depth against unmanaged VMs, also enable *Isolate Ports* on
  the homelab SDN VNet.
- The portal does not configure NetBird itself (routes, DNS, access policies).

## Image library

Users deploy from a per-cluster library (Images page, and the picker when
creating a VM). The infrastructure team curates it under Infrastructure →
Image library, which lists Proxmox templates and ISOs found on the cluster that
are not yet in the library.

- **Prepared images** are Proxmox templates (e.g. built by `img-builds/`),
  cloned and personalised with cloud-init. Tick **GPU-ready** for ones with
  NVIDIA drivers baked in; users can filter on it and are warned if they
  request a GPU with an image that is not.
- **ISO installers** come from the cluster's `iso_storage`. The user gets an
  empty UEFI/q35 VM booted from the ISO and installs from the console.
  (Windows ISOs get SATA, e1000 and a vTPM so setup needs no extra drivers.)
- Hiding an image removes it from the picker without affecting existing VMs.
- `templates:` in `config.yaml` only seeds the library on first start.

## How GPU booking behaves

- A booking reserves *one GPU from the pool*, not a specific card. The portal
  refuses a booking that would exceed the number of GPUs at any moment.
- At the start time the VM is shut down, migrated to the node of a free GPU if
  needed (needs `shared_storage: true`), given the `hostpci` entry and started.
  At the end it is shut down, the entry removed, and started again without it.
- If every GPU is taken, the scheduler may take one from a portal VM that holds
  a GPU *without* an active booking (e.g. left over from a manual admin swap).
  It never touches VMs the portal does not manage — adopt those under
  Admin → Unmanaged, or release them by hand from the GPUs page.
- Passthrough changes always need the VM powered off; users are warned that
  their VM restarts at both ends of a booking.

## Not done yet

- No in-browser SSH terminal or RDP session (console only); users connect
  with their own client using the details shown.
- No email/chat notifications for approvals or upcoming bookings.
- No NetBird API integration; ISO upload is done in Proxmox, not the portal.
- No expiry or idle reclamation of VMs.
- Database schema is created on start; there are no migrations yet.
