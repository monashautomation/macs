"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, useAct, useClusters, useSession, type Vm } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Field, ImageBadges, Note, Panel, Pick } from "./common";

const upTo = (options: number[], max: number) => options.filter((o) => o <= max);
const choice = (active: boolean) =>
  cn(
    "rounded-lg border p-3 text-left text-sm",
    active ? "border-primary bg-info-bg" : "border-border hover:bg-accent",
  );

export function NewVm() {
  const clusters = useClusters();
  const me = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [clusterId, setClusterId] = useState(params.get("cluster") ?? "");
  const [imageId, setImageId] = useState(params.get("image") ?? "");
  const [name, setName] = useState("");
  const [cores, setCores] = useState(2);
  const [memory, setMemory] = useState(4096);
  const [disk, setDisk] = useState(40);
  const [sshKey, setSshKey] = useState<string | null>(null);
  const [wantsGpu, setWantsGpu] = useState(false);
  const [why, setWhy] = useState("");

  const cluster = clusters.data?.find((c) => c.id === clusterId) ?? clusters.data?.[0];
  const image = cluster?.images.find((i) => i.id === imageId) ?? cluster?.images[0];
  const needsKey = image?.kind === "template" && image.os === "linux";
  const key = sshKey ?? me.data?.sshPublicKey ?? "";
  const gpuPossible = !!cluster?.hasGpus;
  const needsApproval = cluster?.approval === "required";

  useEffect(() => {
    if (!cluster) return;
    setCores((v) => Math.min(v, cluster.limits.maxCores));
    setMemory((v) => Math.min(v, cluster.limits.maxMemoryMb));
    setDisk((v) => Math.min(v, cluster.limits.maxDiskGb));
  }, [cluster]);

  const create = useAct(
    () =>
      api<Vm>("/vms", {
        method: "POST",
        body: {
          clusterId: cluster?.id,
          imageSlug: image?.id,
          name,
          cores,
          memoryMb: memory,
          diskGb: disk,
          sshPublicKey: needsKey ? key : "",
          wantsGpu: wantsGpu && gpuPossible,
          justification: why,
        },
      }).then((vm) => router.push(`/vms/${vm.id}`)),
    { quiet: true },
  );

  if (!clusters.data) return null;
  if (!cluster)
    return (
      <EmptyState
        title="No cluster access yet"
        description="Ask Systems & Infra to add you to a group in Authentik."
      />
    );

  return (
    <form
      className="mx-auto max-w-2xl space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <PageHeader title="New VM" />
      <Panel title="Where">
        <div className="grid gap-3 sm:grid-cols-2">
          {clusters.data.map((c) => (
            <button
              type="button"
              key={c.id}
              aria-pressed={c.id === cluster.id}
              className={choice(c.id === cluster.id)}
              onClick={() => {
                setClusterId(c.id);
                setImageId("");
              }}
            >
              <span className="flex flex-wrap items-center gap-2 font-semibold">
                {c.name}
                {c.hasGpus ? <Badge variant="secondary">GPU</Badge> : null}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {c.approval === "none"
                  ? "Ready in a minute or two, no approval needed."
                  : "Systems & Infra review each request."}
              </span>
              {c.network.description ? (
                <span className="mt-1 block text-xs text-muted-foreground">{c.network.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      </Panel>

      <Panel title="What">
        <div className="space-y-4">
          <Field
            label="Name"
            htmlFor="vm-name"
            hint="Becomes the hostname. Lowercase letters, digits and dashes."
          >
            <Input
              id="vm-name"
              value={name}
              onChange={(e) => setName(e.target.value.toLowerCase())}
              placeholder="my-vm"
              required
              pattern="[a-z]([a-z0-9\-]{0,38}[a-z0-9])?"
            />
          </Field>
          <div>
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className="text-sm font-medium">Image</span>
              <Link href="/images" className="text-xs">
                Browse the library
              </Link>
            </div>
            {cluster.images.length ? (
              <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                {cluster.images.map((i) => (
                  <button
                    type="button"
                    key={i.id}
                    aria-pressed={i.id === image?.id}
                    className={choice(i.id === image?.id)}
                    onClick={() => setImageId(i.id)}
                  >
                    <span className="block font-semibold">{i.name}</span>
                    <span className="mt-1.5 flex flex-wrap gap-1">
                      <ImageBadges image={i} />
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No images are available on this cluster yet.</p>
            )}
            {image?.description ? (
              <p className="mt-2 text-xs text-muted-foreground">{image.description}</p>
            ) : null}
            {image?.kind === "iso" ? (
              <div className="mt-2">
                <Note tone="warning">
                  This boots an installer on an empty disk. Open the VM's console afterwards to install the
                  operating system yourself.
                </Note>
              </div>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="vCPUs">
              <Pick
                value={String(cores)}
                onChange={(v) => setCores(+v)}
                options={upTo([1, 2, 4, 8, 12, 16, 24, 32], cluster.limits.maxCores).map((n) => ({
                  value: String(n),
                  label: String(n),
                }))}
              />
            </Field>
            <Field label="Memory">
              <Pick
                value={String(memory)}
                onChange={(v) => setMemory(+v)}
                options={upTo(
                  [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072],
                  cluster.limits.maxMemoryMb,
                ).map((n) => ({ value: String(n), label: `${n / 1024} GB` }))}
              />
            </Field>
            <Field label="Disk">
              <Pick
                value={String(disk)}
                onChange={(v) => setDisk(+v)}
                options={upTo([20, 40, 80, 100, 160, 250, 500], cluster.limits.maxDiskGb).map((n) => ({
                  value: String(n),
                  label: `${n} GB`,
                }))}
              />
            </Field>
          </div>
          {needsKey ? (
            <Field
              label="SSH public key"
              htmlFor="ssh-key"
              hint={
                <>
                  You will sign in as <code>{image?.defaultUser || "the image's default user"}</code> with
                  this key. Remembered for next time.
                </>
              }
            >
              <Textarea
                id="ssh-key"
                className="font-mono text-xs"
                rows={3}
                value={key}
                onChange={(e) => setSshKey(e.target.value)}
                placeholder="ssh-ed25519 AAAA… you@laptop"
                required
              />
            </Field>
          ) : null}
        </div>
      </Panel>

      {needsApproval || gpuPossible ? (
        <Panel title={needsApproval ? "Approval" : "GPU"}>
          <div className="space-y-4">
            {gpuPossible ? (
              <div className="flex items-start gap-3">
                <Checkbox
                  id="wants-gpu"
                  className="mt-0.5"
                  checked={wantsGpu}
                  onCheckedChange={(v) => setWantsGpu(v === true)}
                />
                <label htmlFor="wants-gpu" className="text-sm">
                  <span className="font-medium">Request GPU access</span>
                  <span className="block text-xs text-muted-foreground">
                    Once approved you can book GPU time for this VM. The GPU is attached only during your
                    bookings.
                  </span>
                  {wantsGpu && image && !image.gpuReady ? (
                    <span className="mt-1 block text-xs text-warning">
                      This image has no NVIDIA drivers installed; pick a GPU-ready image unless you plan to
                      install them yourself.
                    </span>
                  ) : null}
                </label>
              </div>
            ) : null}
            {needsApproval || wantsGpu ? (
              <Field
                label="What is it for?"
                htmlFor="why"
                hint="Shown to the people who approve the request."
              >
                <Textarea
                  id="why"
                  rows={3}
                  value={why}
                  onChange={(e) => setWhy(e.target.value)}
                  required={needsApproval}
                />
              </Field>
            ) : null}
          </div>
        </Panel>
      ) : null}

      {create.error ? <Note tone="danger">{create.error.message}</Note> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" onClick={() => router.push("/")}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending || !image}>
          {create.isPending ? "Submitting…" : needsApproval ? "Request VM" : "Create VM"}
        </Button>
      </div>
    </form>
  );
}
