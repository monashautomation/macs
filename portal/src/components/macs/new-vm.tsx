"use client";

import { Badge } from "@monashautomation/ui/badge";
import { Button } from "@monashautomation/ui/button";
import { Checkbox } from "@monashautomation/ui/checkbox";
import { ChoiceCard } from "@monashautomation/ui/choice-card";
import { EmptyState } from "@monashautomation/ui/empty-state";
import { Input } from "@monashautomation/ui/input";
import { PageHeader } from "@monashautomation/ui/page-header";
import { SectionCard } from "@monashautomation/ui/section-card";
import { Textarea } from "@monashautomation/ui/textarea";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, useAct, useClusters, useSession, type Vm } from "@/lib/client";
import { Crumbs, Field, ImageBadges, Note, Pick } from "./common";
import { OsIcon } from "./os-icon";

const upTo = (options: number[], max: number) => options.filter((o) => o <= max);
const CORES = [1, 2, 4, 8, 12, 16, 24, 32];
const MEMORY = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
const DISKS = [20, 40, 80, 100, 160, 250, 500];
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

  // Three starting points that fit this cluster's per-VM limits.
  const lim = cluster?.limits;
  const fit = (options: number[], max: number, want: number) =>
    upTo(options, max)
      .filter((o) => o <= want)
      .at(-1) ??
    options[0] ??
    want;
  const presets = lim
    ? [
        { name: "Small", cores: 2, memory: 4096, disk: 40 },
        { name: "Medium", cores: 4, memory: 8192, disk: 80 },
        { name: "Large", cores: 8, memory: 16384, disk: 160 },
      ]
        .map((p) => ({
          name: p.name,
          cores: fit(CORES, lim.maxCores, p.cores),
          memory: fit(MEMORY, lim.maxMemoryMb, p.memory),
          disk: fit(DISKS, lim.maxDiskGb, p.disk),
        }))
        .filter(
          (p, i, all) =>
            all.findIndex((q) => q.cores === p.cores && q.memory === p.memory && q.disk === p.disk) === i,
        )
    : [];

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
      <Crumbs here="New VM" />
      <PageHeader title="New VM" />
      <SectionCard title="Where">
        <div className="grid gap-3 sm:grid-cols-2">
          {clusters.data.map((c) => (
            <ChoiceCard
              key={c.id}
              selected={c.id === cluster.id}
              onClick={() => {
                setClusterId(c.id);
                setImageId("");
              }}
              title={
                <>
                  {c.name}
                  {c.hasGpus ? <Badge variant="secondary">GPU</Badge> : null}
                </>
              }
              description={
                <>
                  {c.approval === "none"
                    ? "Ready in a minute or two, no approval needed."
                    : "Systems & Infra review each request."}
                  {c.network.description ? <span className="mt-1 block">{c.network.description}</span> : null}
                </>
              }
            />
          ))}
        </div>
      </SectionCard>

      <SectionCard title="What">
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
                  <ChoiceCard
                    key={i.id}
                    selected={i.id === image?.id}
                    onClick={() => setImageId(i.id)}
                    title={
                      <>
                        <OsIcon image={i} /> {i.name}
                      </>
                    }
                  >
                    <ImageBadges image={i} />
                  </ChoiceCard>
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
          <div>
            <span className="mb-1.5 block text-sm font-medium">Size</span>
            <div className="grid gap-2 sm:grid-cols-3">
              {presets.map((p) => (
                <ChoiceCard
                  key={p.name}
                  selected={cores === p.cores && memory === p.memory && disk === p.disk}
                  onClick={() => {
                    setCores(p.cores);
                    setMemory(p.memory);
                    setDisk(p.disk);
                  }}
                  title={p.name}
                  description={`${p.cores} vCPU · ${p.memory / 1024} GB memory · ${p.disk} GB disk`}
                />
              ))}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">Or set each one yourself:</p>
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
      </SectionCard>

      {needsApproval || gpuPossible ? (
        <SectionCard title={needsApproval ? "Approval" : "GPU"}>
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
        </SectionCard>
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
