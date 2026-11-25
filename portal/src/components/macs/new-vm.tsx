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
import { Wrench, Zap } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Created, rememberLogin, useAct, useClusters, useSession } from "@/lib/client";
import { Crumbs, Field, ImageBadges, Note, Pick } from "./common";
import { HelpTip } from "./help";
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
  const [mode, setMode] = useState<"auto" | "manual">(params.get("mode") === "manual" ? "manual" : "auto");
  const [setupId, setSetupId] = useState(params.get("setup") ?? "");
  const [publish, setPublish] = useState(true);
  const [name, setName] = useState("");
  const [cores, setCores] = useState(2);
  const [memory, setMemory] = useState(4096);
  const [disk, setDisk] = useState(40);
  const [sshKey, setSshKey] = useState<string | null>(null);
  const [wantsGpu, setWantsGpu] = useState(false);
  const [why, setWhy] = useState("");

  const cluster = clusters.data?.find((c) => c.id === clusterId) ?? clusters.data?.[0];
  // Automatic: prepared images the portal can sign you in to. Manual: installers you drive yourself.
  const choices = (cluster?.images ?? []).filter((i) =>
    mode === "manual" ? i.kind === "iso" : i.kind === "template",
  );
  const setup = mode === "auto" ? cluster?.setups.find((x) => x.id === setupId) : undefined;
  const image =
    choices.find((i) => i.id === imageId) ??
    (setup ? choices.find((i) => i.id === cluster?.defaultImage) : undefined) ??
    choices[0];
  const setupFits = !setup || (image?.kind === "template" && image.os === "linux");
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

  // A setup has a minimum size: never let the form go below it.
  useEffect(() => {
    if (!setup) return;
    setCores((v) => Math.max(v, setup.cores));
    setMemory((v) => Math.max(v, setup.memoryMb));
    setDisk((v) => Math.max(v, setup.diskGb));
  }, [setup]);

  const create = useAct(
    () =>
      api<Created>("/vms", {
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
          setupSlug: setup && setupFits ? setup.id : "",
          publishPorts: !!setup && publish && !!cluster?.network.services,
          // Self-service VMs also get a console password, shown once on the next page.
          autoLogin: mode === "auto",
        },
      }).then((vm) => {
        rememberLogin(vm);
        router.push(`/vms/${vm.id}`);
      }),
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
      <SectionCard
        title={
          <>
            Where <HelpTip topic="newWhere" label="Where" />
          </>
        }
      >
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

      <SectionCard
        title={
          <>
            How <HelpTip topic="newHow" label="How" />
          </>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <ChoiceCard
            selected={mode === "auto"}
            onClick={() => {
              setMode("auto");
              setImageId("");
            }}
            title={
              <>
                <Zap className="size-4" aria-hidden /> Automatic
              </>
            }
            description="We set up the login and networking. It boots ready to sign in to, optionally with software installed."
          />
          <ChoiceCard
            selected={mode === "manual"}
            disabled={!cluster.images.some((i) => i.kind === "iso")}
            onClick={() => {
              setMode("manual");
              setImageId("");
              setSetupId("");
            }}
            title={
              <>
                <Wrench className="size-4" aria-hidden /> Manual install
              </>
            }
            description={
              cluster.images.some((i) => i.kind === "iso")
                ? "Boot an installer on an empty disk and configure the user, password and network yourself from the console."
                : "No installers are available on this cluster."
            }
          />
        </div>
      </SectionCard>

      <SectionCard
        title={
          <>
            What <HelpTip topic="newWhat" label="What" />
          </>
        }
      >
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
            {choices.length ? (
              <div className="grid max-h-72 gap-2 overflow-y-auto sm:grid-cols-2">
                {choices.map((i) => (
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
          {mode === "auto" && cluster.setups.length ? (
            <div className="space-y-2">
              <Field
                label="Install a ready-made setup (optional)"
                hint={setup ? setup.description : "Leave on “Nothing” for a clean machine."}
              >
                <Pick
                  value={setup?.id ?? "none"}
                  onChange={(v) => setSetupId(v === "none" ? "" : v)}
                  options={[
                    { value: "none", label: "Nothing, just the operating system" },
                    ...cluster.setups.map((x) => ({
                      value: x.id,
                      label: `${x.name}${x.category ? ` (${x.category})` : ""}`,
                    })),
                  ]}
                />
              </Field>
              {setup && !setupFits ? (
                <Note tone="warning">
                  Setups install on a prepared Linux image. Pick one above, or choose “Nothing”.
                </Note>
              ) : null}
              {setup && setup.ports.length && cluster.network.services ? (
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="publish-ports"
                    className="mt-0.5"
                    checked={publish}
                    onCheckedChange={(v) => setPublish(v === true)}
                  />
                  <label htmlFor="publish-ports" className="text-sm">
                    <span className="font-medium">Publish its address</span>
                    <span className="block text-xs text-muted-foreground">
                      Opens port{setup.ports.length > 1 ? "s" : ""}{" "}
                      {setup.ports.map((x) => x.port).join(", ")} so it is reachable over NetBird
                      {cluster.network.serviceApproval === "required"
                        ? " (after Systems & Infra approve)"
                        : ""}
                      .
                    </span>
                  </label>
                </div>
              ) : null}
            </div>
          ) : null}
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
                  {!needsApproval ? " Optional here: you also get a password for the console." : ""}
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
                required={needsApproval}
              />
            </Field>
          ) : null}
        </div>
      </SectionCard>

      {needsApproval || gpuPossible ? (
        <SectionCard
          title={
            <>
              {needsApproval ? "Approval" : "GPU"} <HelpTip topic={needsApproval ? "newApproval" : "gpu"} />
            </>
          }
        >
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
        <Button type="submit" disabled={create.isPending || !image || !setupFits}>
          {create.isPending ? "Submitting…" : needsApproval ? "Request VM" : "Create VM"}
        </Button>
      </div>
    </form>
  );
}
