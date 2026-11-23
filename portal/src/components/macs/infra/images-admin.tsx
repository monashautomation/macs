"use client";

import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { PageHeader } from "@/components/page-header";
import { useConfirm } from "@/components/providers";
import { SectionCard } from "@/components/section-card";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { type AdminImage, type AdminImages, api, useAct, useClusters } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Field, fmtSize, Muted, Note, Pick } from "../common";

type Os = "linux" | "windows" | "other";
interface Draft {
  dbId?: string;
  kind: "template" | "iso";
  vmid?: number | null;
  volid?: string;
  name: string;
  description: string;
  os: Os;
  defaultUser: string;
  cicustom: string;
  gpuReady: boolean;
  enabled: boolean;
  tagText: string;
  connectText: string;
}

const blank = (over: Partial<Draft>): Draft => ({
  kind: "template",
  name: "",
  description: "",
  os: "linux",
  defaultUser: "",
  cicustom: "",
  gpuReady: false,
  enabled: true,
  tagText: "",
  connectText: "",
  ...over,
});
const guessOs = (name: string): Os =>
  /win/i.test(name) ? "windows" : /nix|bsd/i.test(name) && !/linux/i.test(name) ? "other" : "linux";
const list = (text: string) =>
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function Editor({
  draft,
  clusterId,
  hasGpus,
  onClose,
}: {
  draft: Draft;
  clusterId: string;
  hasGpus: boolean;
  onClose: () => void;
}) {
  const [d, setD] = useState(draft);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });
  const save = useAct(
    () => {
      const body = {
        name: d.name,
        description: d.description,
        os: d.os,
        defaultUser: d.defaultUser,
        cicustom: d.cicustom,
        gpuReady: d.gpuReady,
        enabled: d.enabled,
        tags: list(d.tagText),
        connect: list(d.connectText),
      };
      return (
        d.dbId
          ? api(`/admin/images/${d.dbId}`, { method: "PUT", body })
          : api("/admin/images", {
              method: "POST",
              body: { ...body, clusterId, kind: d.kind, vmid: d.vmid ?? undefined, volid: d.volid ?? "" },
            })
      ).then(onClose);
    },
    { quiet: true },
  );
  const prepared = d.kind === "template";
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{d.dbId ? `Edit ${draft.name}` : "Add to the library"}</DialogTitle>
          <DialogDescription>{prepared ? `Proxmox template #${d.vmid}` : d.volid}</DialogDescription>
        </DialogHeader>
        <Field label="Name shown to users" htmlFor="img-name">
          <Input id="img-name" value={d.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Description" htmlFor="img-desc" hint="What is installed, who it is for.">
          <Textarea
            id="img-desc"
            rows={3}
            value={d.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Operating system">
            <Pick
              value={d.os}
              onChange={(os) => set({ os })}
              options={[
                { value: "linux", label: "Linux" },
                { value: "windows", label: "Windows" },
                { value: "other", label: "Other" },
              ]}
            />
          </Field>
          {prepared ? (
            <Field label="Login user" htmlFor="img-user" hint="Set by cloud-init on Linux.">
              <Input
                id="img-user"
                value={d.defaultUser}
                onChange={(e) => set({ defaultUser: e.target.value })}
                placeholder="ubuntu"
              />
            </Field>
          ) : null}
        </div>
        <Field label="Tags" htmlFor="img-tags" hint="Comma separated, e.g. desktop, cuda, ros2">
          <Input id="img-tags" value={d.tagText} onChange={(e) => set({ tagText: e.target.value })} />
        </Field>
        {prepared ? (
          <>
            <Field
              label="Connection methods"
              htmlFor="img-connect"
              hint="Comma separated from ssh, rdp, sunshine. Blank = ssh for Linux, rdp for Windows."
            >
              <Input
                id="img-connect"
                value={d.connectText}
                onChange={(e) => set({ connectText: e.target.value })}
                placeholder="ssh, sunshine"
              />
            </Field>
            <Field
              label="cloud-init vendor snippet (optional)"
              htmlFor="img-ci"
              hint="Proxmox cicustom value, e.g. for NetBird enrolment."
            >
              <Input
                id="img-ci"
                className="font-mono text-xs"
                value={d.cicustom}
                onChange={(e) => set({ cicustom: e.target.value })}
                placeholder="vendor=cephfs:snippets/macs-vendor.yaml"
              />
            </Field>
          </>
        ) : null}
        {hasGpus ? (
          <div className="flex items-start gap-2 text-sm">
            <Checkbox
              id="img-gpu"
              className="mt-0.5"
              checked={d.gpuReady}
              onCheckedChange={(v) => set({ gpuReady: v === true })}
            />
            <label htmlFor="img-gpu">
              GPU-ready
              <span className="block text-xs text-muted-foreground">
                NVIDIA drivers are installed, so it works with the passthrough GPUs out of the box.
              </span>
            </label>
          </div>
        ) : null}
        <div className="flex items-center gap-2 text-sm">
          <Checkbox
            id="img-enabled"
            checked={d.enabled}
            onCheckedChange={(v) => set({ enabled: v === true })}
          />
          <label htmlFor="img-enabled">Visible to users</label>
        </div>
        {save.error ? <Note tone="danger">{save.error.message}</Note> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!d.name.trim() || save.isPending} onClick={() => save.mutate()}>
            {d.dbId ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function InfraImages() {
  const clusters = useClusters();
  const confirm = useConfirm();
  const [clusterId, setClusterId] = useState("");
  const cid = clusterId || clusters.data?.[0]?.id || "";
  const cluster = clusters.data?.find((c) => c.id === cid);
  const q = useQuery({
    queryKey: ["admin-images", cid],
    queryFn: () => api<AdminImages>(`/admin/images?clusterId=${cid}`),
    enabled: !!cid,
    refetchInterval: 30_000,
  });
  const [draft, setDraft] = useState<Draft | null>(null);
  const remove = useAct((id: string) => api(`/admin/images/${id}`, { method: "DELETE" }));
  const edit = (i: AdminImage) =>
    setDraft({
      ...i,
      os: i.os as Os,
      kind: i.kind as Draft["kind"],
      tagText: i.tags.join(", "),
      connectText: i.connect.join(", "),
    });
  const data = q.data;
  return (
    <>
      <PageHeader
        title="Image library"
        description="What people can deploy from. Build templates with Packer (img-builds/) or upload ISOs in Proxmox, then list them here."
        actions={
          <Pick
            className="w-56"
            value={cid}
            onChange={setClusterId}
            options={(clusters.data ?? []).map((c) => ({ value: c.id, label: c.name }))}
          />
        }
      />
      <div className="space-y-5">
        {data?.error ? (
          <Note tone="danger">Cluster unreachable, so discovery is unavailable: {data.error}</Note>
        ) : null}
        <SectionCard title="In the library">
          {data?.images.length ? (
            <ul className="text-sm">
              {data.images.map((i) => (
                <li
                  key={i.dbId}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border py-2.5 last:border-0"
                >
                  <span className={cn("font-semibold", !i.enabled && "text-muted-foreground line-through")}>
                    {i.name}
                  </span>
                  {i.gpuReady ? <StatusBadge tone="success">GPU-ready</StatusBadge> : null}
                  <Badge variant="secondary">{i.kind === "iso" ? "ISO" : `template #${i.vmid}`}</Badge>
                  {!i.enabled ? <Badge variant="secondary">hidden</Badge> : null}
                  {i.missing ? <StatusBadge tone="danger">missing on cluster</StatusBadge> : null}
                  {i.tags.map((t) => (
                    <Badge key={t} variant="outline">
                      {t}
                    </Badge>
                  ))}
                  <span className="text-xs text-muted-foreground">
                    {i.vmCount} VM{i.vmCount === 1 ? "" : "s"}
                  </span>
                  <span className="ml-auto flex gap-1">
                    <Button variant="ghost" size="sm" onClick={() => edit(i)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        if (
                          await confirm({
                            title: `Remove ${i.name} from the library?`,
                            description: `The ${i.kind === "iso" ? "ISO" : "template"} itself stays on the cluster.`,
                            confirm: "Remove",
                          })
                        )
                          remove.mutate(i.dbId);
                      }}
                    >
                      Remove
                    </Button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>{q.isLoading ? "Loading…" : "The library is empty for this cluster."}</Muted>
          )}
        </SectionCard>

        <SectionCard title="Templates on the cluster not yet listed">
          {data?.unlisted.templates.length ? (
            <ul className="text-sm">
              {data.unlisted.templates.map((t) => (
                <li
                  key={t.vmid}
                  className="flex flex-wrap items-center gap-3 border-b border-border py-2 last:border-0"
                >
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    #{t.vmid} · {t.node}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto"
                    onClick={() =>
                      setDraft(blank({ kind: "template", vmid: t.vmid, name: t.name, os: guessOs(t.name) }))
                    }
                  >
                    Add to library…
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <Muted>Every template on the cluster is listed.</Muted>
          )}
        </SectionCard>

        <SectionCard title={`ISO installers${data?.isoStorage ? ` on ${data.isoStorage}` : ""}`}>
          {!data?.isoStorage ? (
            <Muted>Set iso_storage for this cluster in the config file to offer ISO installs.</Muted>
          ) : data.unlisted.isos.length ? (
            <ul className="text-sm">
              {data.unlisted.isos.map((i) => {
                const file = i.volid.split("/").pop() ?? i.volid;
                return (
                  <li
                    key={i.volid}
                    className="flex flex-wrap items-center gap-3 border-b border-border py-2 last:border-0"
                  >
                    <span className="font-mono text-xs">{file}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">{fmtSize(i.size)}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="ml-auto"
                      onClick={() =>
                        setDraft(
                          blank({
                            kind: "iso",
                            volid: i.volid,
                            name: file.replace(/\.iso$/i, ""),
                            os: guessOs(file),
                          }),
                        )
                      }
                    >
                      Add to library…
                    </Button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Muted>Every ISO on the storage is listed.</Muted>
          )}
        </SectionCard>
      </div>
      {draft ? (
        <Editor
          key={draft.dbId ?? draft.vmid ?? draft.volid}
          draft={draft}
          clusterId={cid}
          hasGpus={!!cluster?.hasGpus}
          onClose={() => setDraft(null)}
        />
      ) : null}
    </>
  );
}
