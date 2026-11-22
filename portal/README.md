# MACS portal

Web front end for deploying and managing VMs across our Proxmox clusters, with
GPU tracking, swapping and time-booking on the research cluster.

- **Multiple clusters** — each with its own access groups, templates, limits
  and approval policy (`config.yaml`).
- **Homelab** — self-service: a student picks an image and size and gets a
  running VM within their quota.
- **Research** — requests (with or without GPU access) wait for an admin.
- **GPUs** — the portal reads every VM's `hostpciN` config, so it always shows
  which VM really holds each card, including VMs it does not manage. Admins can
  swap a GPU between VMs; approved users book GPU time and a scheduler attaches
  and detaches the card on time, migrating the VM to a node with a free GPU.
- **Backups** — back up to Proxmox Backup Server, roll back, or *archive* a VM
  (backup, then destroy) and restore it later.
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

- No in-browser console (noVNC); the VM page shows the IP and SSH command.
- No email/chat notifications for approvals or upcoming bookings.
- No expiry or idle reclamation of VMs.
- Database schema is created on start; there are no migrations yet.
