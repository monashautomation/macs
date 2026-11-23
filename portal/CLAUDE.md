# MACS portal — agent rules

Built from monashautomation/MA-App-Template. Platform rules: central-platform-argocd (`CLAUDE.md`, `docs/standards/app-standard.md`, `docs/brand/`).

## Commands

```bash
pnpm install && docker compose up -d && cp .env.example .env   # then fill .env
pnpm db:migrate        # create/apply migrations (dev)
pnpm dev               # http://localhost:3000
pnpm lint && pnpm typecheck && pnpm test && pnpm build   # what CI runs
# engine tests need an EMPTY Postgres database, else they are skipped:
TEST_DATABASE_URL=postgresql://postgres:dev@localhost:5432/macs_test pnpm test
node scripts/mock-authentik.mjs   # dev-only sign-in; with MACS_CONFIG=./config.dev.yaml nothing real is touched
# engine tests need an EMPTY Postgres database, else they are skipped:
TEST_DATABASE_URL=postgresql://postgres:dev@localhost:5432/macs_test pnpm test
node scripts/mock-authentik.mjs   # dev-only sign-in; with MACS_CONFIG=./config.dev.yaml nothing real is touched
```

## Hard rules

- Every API route is wrapped in `api(role, handler)` (`src/server/http.ts`), which is the template's `withAuth` plus error mapping. Throw `HttpError(status, message)` for anything the caller should see. Pages use `requireUser`. Hiding UI is not access control.
- Rows members own carry `ownerId`; every query filters on it (see `getVm` in `src/server/handlers/vms.ts`). Someone else's id → 404.
- Identity is the Authentik `sub`. Never match or link users by email. Don't re-enable better-auth account linking.
- Roles come from Authentik groups (`ADMIN_GROUPS`, `MEMBER_GROUPS`), checked per request. Never store a role a user can edit.
- Validate every input with zod. Return `toPublicUser()` for other people; no emails/groups unless the view needs them.
- Build URLs with `absoluteUrl()` / `safeRedirectPath()` (`src/lib/url.ts`), never from `request.url` or Host.
- Services call with their own key (`SERVICE_KEYS`), never a shared secret.
- No secrets in Git. New env var → `src/env.ts`, `.env.example`, and the OpenBao entry (tell Systems & Infra).
- UI: use the components from the `@monashautomation/ui` package (`import { Button } from "@monashautomation/ui/button"`; catalogue in MA-App-UI's `COMPONENTS.md`). `AppShell` frames every page, one primary button per view, `StatusBadge` for states. Never copy a shared component into this repo. Need one that doesn't exist? Add it to MA-App-UI, release it, and bump the dependency here.
- Colours only from brand tokens (`bg-primary`, `text-muted-foreground`…); no hex or raw palette classes (`pnpm lint` runs `ma-brand-lint`).
- Schema changes: new Prisma migration, forward-only. Data work against local Postgres unless a human says "live".
- Logs: `logger` (JSON); log user ids, never emails or tokens.

## This app

- Layout: route files in `src/app/api/v1` stay thin; behaviour lives in `src/server/handlers` (authorisation, validation) and `src/server/services` (the Proxmox engine). Screens are in `src/components/macs`.
- Proxmox is reached only through the `ProxmoxDriver` interface (`src/server/proxmox/types.ts`). Add a call to the interface, the real client **and** the mock, and cover it in `tests/`.
- Anything slow on Proxmox runs as a job (`startJob`): one running job per VM, enforced by a partial unique index.
- The engine keeps state in memory (`src/server/core.ts`): the app is a single replica. Don't add anything that assumes two.
- GPU holders are always derived from live `hostpci` config, never stored.
- Firewall rules the portal owns are marked `macs:`; never touch others.
- Cluster config keys are snake_case (they mirror the YAML); everything else is camelCase.
- Never point tests or `config.dev.yaml` at a real cluster.
