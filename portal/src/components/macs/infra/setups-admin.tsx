"use client";

import { Badge } from "@monashautomation/ui/badge";
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
import { cn } from "@monashautomation/ui/utils";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useConfirm } from "@/components/providers";
import { type AdminSetup, api, useAct } from "@/lib/client";
import { Field, fmtGB, Muted, Note } from "../common";
import { SetupIcon } from "../images";

interface Draft {
  dbId?: string;
  name: string;
  category: string;
  description: string;
  script: string;
  cores: number;
  memoryGb: number;
  diskGb: number;
  portsText: string;
  afterInstall: string;
  enabled: boolean;
}

const blank: Draft = {
  name: "",
  category: "",
  description: "",
  script: "apt-get update -qq\n",
  cores: 2,
  memoryGb: 2,
  diskGb: 20,
  portsText: "",
  afterInstall: "",
  enabled: true,
};

/** "Gitea, 3000, http" per line -> ports. Scheme is optional: http, https, tcp or udp. */
function parsePorts(text: string) {
  return text
    .split("\n")
    .map((line) => line.split(",").map((x) => x.trim()))
    .filter((p) => p[0] && p[1])
    .map(([name, port, kind = "tcp"]) => ({
      name,
      port: Number(port),
      protocol: kind === "udp" ? "udp" : "tcp",
      scheme: kind === "http" || kind === "https" ? kind : "",
    }));
}

function Editor({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const [d, setD] = useState(draft);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const save = useAct(
    () => {
      const body = {
        name: d.name,
        category: d.category,
        description: d.description,
        script: d.script,
        cores: d.cores,
        memoryMb: Math.round(d.memoryGb * 1024),
        diskGb: d.diskGb,
        ports: parsePorts(d.portsText),
        afterInstall: d.afterInstall,
        enabled: d.enabled,
      };
      return (
        d.dbId
          ? api(`/admin/setups/${d.dbId}`, { method: "PUT", body })
          : api("/admin/setups", { method: "POST", body })
      ).then(onClose);
    },
    { quiet: true },
  );
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{d.dbId ? `Edit ${draft.name}` : "New setup"}</DialogTitle>
          <DialogDescription>
            The script runs as root inside the person's new Debian or Ubuntu VM, once, after first boot.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" htmlFor="setup-name">
            <Input id="setup-name" value={d.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field
            label="Category"
            htmlFor="setup-category"
            hint="Groups it in the library, e.g. Containers, Web, Media."
          >
            <Input
              id="setup-category"
              value={d.category}
              onChange={(e) => set({ category: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Description" htmlFor="setup-desc">
          <Input
            id="setup-desc"
            value={d.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        <Field
          label="Install script (bash)"
          htmlFor="setup-script"
          hint={
            <>
              Runs with <code>set -euo pipefail</code> after cloud-init finishes. <code>$MACS_USER</code> is
              the login user and <code>$MACS_HOSTNAME</code> the VM's name. A non-zero exit marks the setup
              failed.
            </>
          }
        >
          <Textarea
            id="setup-script"
            className="font-mono text-xs"
            rows={10}
            spellCheck={false}
            value={d.script}
            onChange={(e) => set({ script: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Min vCPUs" htmlFor="setup-cores">
            <Input
              id="setup-cores"
              type="number"
              min={1}
              value={d.cores}
              onChange={(e) => set({ cores: +e.target.value })}
            />
          </Field>
          <Field label="Min memory (GB)" htmlFor="setup-mem">
            <Input
              id="setup-mem"
              type="number"
              min={0.5}
              step={0.5}
              value={d.memoryGb}
              onChange={(e) => set({ memoryGb: +e.target.value })}
            />
          </Field>
          <Field label="Min disk (GB)" htmlFor="setup-disk">
            <Input
              id="setup-disk"
              type="number"
              min={8}
              value={d.diskGb}
              onChange={(e) => set({ diskGb: +e.target.value })}
            />
          </Field>
        </div>
        <Field
          label="Ports it serves"
          htmlFor="setup-ports"
          hint="One per line: name, port, type (http, https, tcp or udp). Offered as public services after install."
        >
          <Textarea
            id="setup-ports"
            className="font-mono text-xs"
            rows={2}
            value={d.portsText}
            onChange={(e) => set({ portsText: e.target.value })}
            placeholder="Gitea, 3000, http"
          />
        </Field>
        <Field label="What to tell the owner afterwards" htmlFor="setup-after">
          <Input
            id="setup-after"
            value={d.afterInstall}
            onChange={(e) => set({ afterInstall: e.target.value })}
            placeholder="Open it and create the admin account."
          />
        </Field>
        <div className="flex items-center gap-2 text-sm">
          <Checkbox
            id="setup-enabled"
            checked={d.enabled}
            onCheckedChange={(v) => set({ enabled: v === true })}
          />
          <label htmlFor="setup-enabled">Visible to users</label>
        </div>
        {save.error ? <Note tone="danger">{save.error.message}</Note> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!d.name.trim() || !d.script.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {d.dbId ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The ready-made setup library. Applies to every cluster with `setups: true`. */
export function SetupsAdmin() {
  const confirm = useConfirm();
  const q = useQuery({
    queryKey: ["admin-setups"],
    queryFn: () => api<AdminSetup[]>("/admin/setups"),
    refetchInterval: 30_000,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const remove = useAct((id: string) => api(`/admin/setups/${id}`, { method: "DELETE" }));
  const edit = (s: AdminSetup) =>
    setDraft({
      dbId: s.dbId,
      name: s.name,
      category: s.category,
      description: s.description,
      script: s.script,
      cores: s.cores,
      memoryGb: s.memoryMb / 1024,
      diskGb: s.diskGb,
      portsText: s.ports.map((p) => `${p.name}, ${p.port}, ${p.scheme || p.protocol}`).join("\n"),
      afterInstall: s.afterInstall,
      enabled: s.enabled,
    });
  return (
    <SectionCard
      title="Ready-made setups (one-click installs)"
      actions={
        <Button variant="outline" onClick={() => setDraft(blank)}>
          New setup
        </Button>
      }
    >
      <p className="mb-2 text-sm text-muted-foreground">
        Offered on clusters that set <code>setups: true</code>. Each is a script run as root in the person's
        new VM through the guest agent, so only Systems & Infra can see or change them.
      </p>
      {q.data?.length ? (
        <ul className="text-sm">
          {q.data.map((s) => (
            <li
              key={s.dbId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2.5 last:border-0"
            >
              <SetupIcon setup={s} />
              <span className={cn("font-semibold", !s.enabled && "text-muted-foreground line-through")}>
                {s.name}
              </span>
              {s.category ? <Badge variant="secondary">{s.category}</Badge> : null}
              {!s.enabled ? <Badge variant="secondary">hidden</Badge> : null}
              <span className="text-xs text-muted-foreground tabular-nums">
                {s.cores} vCPU · {fmtGB(s.memoryMb)} · {s.diskGb} GB
                {s.ports.length ? ` · ports ${s.ports.map((p) => p.port).join(", ")}` : ""} · {s.vmCount} VM
                {s.vmCount === 1 ? "" : "s"}
              </span>
              <span className="ml-auto flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => edit(s)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Remove ${s.name} from the library?`,
                        description: "VMs that already have it keep it.",
                        confirm: "Remove",
                      })
                    )
                      remove.mutate(s.dbId);
                  }}
                >
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Muted>{q.isLoading ? "Loading…" : "No setups yet."}</Muted>
      )}
      {draft ? <Editor key={draft.dbId ?? "new"} draft={draft} onClose={() => setDraft(null)} /> : null}
    </SectionCard>
  );
}
