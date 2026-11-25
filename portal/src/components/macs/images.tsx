"use client";

import { Badge } from "@monashautomation/ui/badge";
import { Button } from "@monashautomation/ui/button";
import { CopyField } from "@monashautomation/ui/copy-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@monashautomation/ui/dialog";
import { EmptyState } from "@monashautomation/ui/empty-state";
import { Input } from "@monashautomation/ui/input";
import { PageHeader } from "@monashautomation/ui/page-header";
import { SectionCard } from "@monashautomation/ui/section-card";
import {
  Boxes,
  Clapperboard,
  Code,
  Gamepad2,
  Globe,
  HeartPulse,
  Home,
  Network,
  Package,
  Wrench,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import {
  api,
  type Blueprint,
  type Cluster,
  type Created,
  type Image,
  type LabCreated,
  rememberLogin,
  type Setup,
  useAct,
  useClusters,
} from "@/lib/client";
import { Field, fmtGB, ImageBadges, Note } from "./common";
import { HelpTip } from "./help";
import { OsIcon } from "./os-icon";

const CATEGORY_ICONS: Record<string, ReactNode> = {
  containers: <Boxes aria-hidden />,
  web: <Globe aria-hidden />,
  monitoring: <HeartPulse aria-hidden />,
  development: <Code aria-hidden />,
  media: <Clapperboard aria-hidden />,
  automation: <Home aria-hidden />,
  games: <Gamepad2 aria-hidden />,
};

export function SetupIcon({ setup, className }: { setup: Pick<Setup, "category">; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 text-muted-foreground [&_svg]:size-5 ${className ?? ""}`}>
      {CATEGORY_ICONS[setup.category.toLowerCase()] ?? <Package aria-hidden />}
    </span>
  );
}

type Filter = "all" | "setups" | "labs" | "os" | "manual";

/** Name a lab, deploy it, and show the one-time login for its VMs. */
function LabDialog({
  pick,
  onClose,
}: {
  pick: { blueprint: Blueprint; cluster: Cluster } | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [made, setMade] = useState<LabCreated | null>(null);
  const create = useAct(
    () =>
      api<LabCreated>("/labs", {
        method: "POST",
        body: { clusterId: pick?.cluster.id, blueprint: pick?.blueprint.id, name },
      }).then((lab) => {
        for (const vm of lab.vms) rememberLogin({ id: vm.id, login: lab.login });
        setMade(lab);
      }),
    { quiet: true },
  );
  const close = () => {
    setName("");
    setMade(null);
    create.reset();
    onClose();
  };
  return (
    <Dialog open={pick !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent>
        {made ? (
          <>
            <DialogHeader>
              <DialogTitle>Lab {made.name} is being created</DialogTitle>
              <DialogDescription>
                {made.vms.map((v) => v.name).join(", ")} will be ready in a few minutes. They share this
                login, which is shown only now.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-xs text-muted-foreground">User</p>
                <CopyField value={made.login.user} label="Copy user name" />
              </div>
              <div>
                <p className="mb-1 text-xs text-muted-foreground">Password</p>
                <CopyField value={made.login.password} label="Copy password" />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={() => router.push("/")}>Go to my VMs</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Deploy {pick?.blueprint.name}</DialogTitle>
              <DialogDescription>
                {pick?.blueprint.members.length} VMs on {pick?.cluster.name}, named after the lab:{" "}
                {pick?.blueprint.members.map((m) => `${name || "name"}-${m.role}`).join(", ")}.
              </DialogDescription>
            </DialogHeader>
            <Field label="Lab name" htmlFor="lab-name" hint="Lowercase letters, digits and dashes.">
              <Input
                id="lab-name"
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))}
                placeholder="demo"
                maxLength={24}
              />
            </Field>
            {create.error ? <Note tone="danger">{create.error.message}</Note> : null}
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button disabled={!name || create.isPending} onClick={() => create.mutate()}>
                {create.isPending ? "Creating…" : "Deploy lab"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Everything you can deploy. Three ways in, from least to most hands-on:
 * a ready-made setup, a bare operating system (both one click: the portal
 * configures login and networking), or an installer you drive yourself.
 */
export function Images() {
  const clusters = useClusters();
  const router = useRouter();
  const [clusterId, setClusterId] = useState("all");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState("");
  const [labPick, setLabPick] = useState<{ blueprint: Blueprint; cluster: Cluster } | null>(null);
  const deploy = useAct(
    (a: { key: string; clusterId: string; setupSlug?: string; imageSlug?: string }) =>
      api<Created>("/vms/quick", {
        method: "POST",
        body: { clusterId: a.clusterId, setupSlug: a.setupSlug ?? "", imageSlug: a.imageSlug ?? "" },
      }).then((vm) => {
        rememberLogin(vm);
        router.push(`/vms/${vm.id}`);
      }),
    { quiet: true },
  );
  if (!clusters.data) return null;
  const shown = clusters.data.filter((c) => clusterId === "all" || c.id === clusterId);
  const setups = shown.flatMap((c) => c.setups.map((setup) => ({ setup, cluster: c })));
  const labs = shown.flatMap((c) => c.labs.map((blueprint) => ({ blueprint, cluster: c })));
  const systems = shown.flatMap((c) =>
    c.images.filter((i) => i.kind === "template").map((image) => ({ image, cluster: c })),
  );
  const installers = shown.flatMap((c) =>
    c.images.filter((i) => i.kind === "iso").map((image) => ({ image, cluster: c })),
  );
  const chip = (active: boolean, label: string, onClick: () => void) => (
    <Button
      key={label}
      size="sm"
      variant={active ? "secondary" : "ghost"}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  const oneClick = (
    key: string,
    cluster: Cluster,
    what: { setupSlug?: string; imageSlug?: string },
    label: string,
  ) => (
    <Button
      variant="outline"
      disabled={deploy.isPending}
      onClick={() => {
        setBusy(key);
        deploy.mutate({ key, clusterId: cluster.id, ...what });
      }}
    >
      <Zap aria-hidden /> {deploy.isPending && busy === key ? "Creating…" : label}
    </Button>
  );
  const customise = (href: string, label = "Customise") => (
    <Button asChild variant="ghost">
      <Link href={href} className="text-foreground no-underline">
        {label}
      </Link>
    </Button>
  );
  const card = (key: string, title: ReactNode, cluster: Cluster, body: ReactNode, actions: ReactNode) => (
    <SectionCard key={key} title={title} className="h-full">
      <div className="flex h-full flex-col">
        <p className="-mt-3 text-xs text-muted-foreground">{cluster.name}</p>
        {body}
        <div className="mt-4 flex flex-wrap gap-2">{actions}</div>
      </div>
    </SectionCard>
  );
  const section = (id: Filter, title: string, blurb: string, cards: ReactNode[]) =>
    (filter === "all" || filter === id) && cards.length ? (
      <section key={id} className="mb-8">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {title}
          <HelpTip
            topic={
              ({ setups: "libSetups", labs: "lab", os: "libOs", manual: "libManual", all: "libOs" } as const)[
                id
              ]
            }
            label={title}
          />
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{blurb}</p>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards}</div>
      </section>
    ) : null;

  const osCard = ({ image, cluster }: { image: Image; cluster: Cluster }) => {
    const key = `os/${cluster.id}/${image.id}`;
    const form = `/new?cluster=${cluster.id}&image=${image.id}`;
    return card(
      key,
      <>
        <OsIcon image={image} /> {image.name}
      </>,
      cluster,
      <>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <ImageBadges image={image} />
        </div>
        <p className="mt-3 flex-1 text-sm text-muted-foreground">
          {image.description || "Cloned from a prepared template."}
        </p>
      </>,
      cluster.approval === "none" && image.os === "linux" ? (
        <>
          {oneClick(key, cluster, { imageSlug: image.id }, "Deploy")}
          {customise(form)}
        </>
      ) : (
        customise(form, cluster.approval === "none" ? "Deploy…" : "Request…")
      ),
    );
  };

  return (
    <>
      <PageHeader
        title="Library"
        description="Pick something and it is running in a couple of minutes. One-click installs set up your login and networking for you; installers leave all of that to you."
      />
      <div className="mb-5 flex flex-wrap gap-1">
        {chip(clusterId === "all", "All clusters", () => setClusterId("all"))}
        {clusters.data.map((c) => chip(clusterId === c.id, c.name, () => setClusterId(c.id)))}
        <span className="mx-2 w-px bg-border" />
        {chip(filter === "all", "Everything", () => setFilter("all"))}
        {chip(filter === "setups", "Ready-made setups", () => setFilter("setups"))}
        {labs.length ? chip(filter === "labs", "Labs", () => setFilter("labs")) : null}
        {chip(filter === "os", "Operating systems", () => setFilter("os"))}
        {chip(filter === "manual", "Install it yourself", () => setFilter("manual"))}
      </div>
      {deploy.error ? (
        <div className="mb-5">
          <Note tone="danger">{deploy.error.message}</Note>
        </div>
      ) : null}
      {section(
        "setups",
        "Ready-made setups",
        "One click: a new VM with the software installed and its web address published. You get a login for the VM itself too.",
        setups.map(({ setup, cluster }) => {
          const key = `setup/${cluster.id}/${setup.id}`;
          return card(
            key,
            <>
              <SetupIcon setup={setup} /> {setup.name}
            </>,
            cluster,
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {setup.category ? <Badge variant="secondary">{setup.category}</Badge> : null}
                <Badge variant="outline">
                  {setup.cores} vCPU · {fmtGB(setup.memoryMb)} · {setup.diskGb} GB
                </Badge>
                {setup.ports.map((p) => (
                  <Badge key={`${p.protocol}${p.port}`} variant="outline">
                    port {p.port}
                  </Badge>
                ))}
              </div>
              <p className="mt-3 flex-1 text-sm text-muted-foreground">{setup.description}</p>
            </>,
            <>
              {oneClick(key, cluster, { setupSlug: setup.id }, "Install")}
              {customise(`/new?cluster=${cluster.id}&setup=${setup.id}`)}
            </>,
          );
        }),
      )}
      {section(
        "labs",
        "Labs",
        "Several VMs deployed together. They can reach each other by name and share one login; everyone else's VMs still cannot reach them.",
        labs.map(({ blueprint, cluster }) =>
          card(
            `lab/${cluster.id}/${blueprint.id}`,
            <>
              <span className="inline-flex shrink-0 text-muted-foreground [&_svg]:size-5">
                <Network aria-hidden />
              </span>{" "}
              {blueprint.name}
            </>,
            cluster,
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <Badge variant="secondary">{blueprint.members.length} VMs</Badge>
                <Badge variant="outline">
                  {blueprint.cores} vCPU · {fmtGB(blueprint.memoryMb)} · {blueprint.diskGb} GB in total
                </Badge>
              </div>
              <p className="mt-3 flex-1 text-sm text-muted-foreground">{blueprint.description}</p>
            </>,
            <Button variant="outline" onClick={() => setLabPick({ blueprint, cluster })}>
              <Zap aria-hidden /> Deploy lab…
            </Button>,
          ),
        ),
      )}
      {section(
        "os",
        "Operating systems",
        "A clean machine, ready to sign in to. One click where no approval is needed.",
        systems.map(osCard),
      )}
      {section(
        "manual",
        "Install it yourself",
        "Boots the installer on an empty disk. You choose the user, password, disks and network from the console, like a normal install.",
        installers.map(({ image, cluster }) =>
          card(
            `iso/${cluster.id}/${image.id}`,
            <>
              <OsIcon image={image} /> {image.name}
            </>,
            cluster,
            <>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <ImageBadges image={image} />
              </div>
              <p className="mt-3 flex-1 text-sm text-muted-foreground">
                {image.description || "Installer ISO."}
              </p>
            </>,
            <Button asChild variant="outline">
              <Link
                href={`/new?cluster=${cluster.id}&mode=manual&image=${image.id}`}
                className="text-foreground no-underline"
              >
                <Wrench aria-hidden /> Set up manually
              </Link>
            </Button>,
          ),
        ),
      )}
      <LabDialog pick={labPick} onClose={() => setLabPick(null)} />
      {!setups.length && !systems.length && !installers.length ? (
        <EmptyState
          title="Nothing here yet"
          description="Ask Systems & Infra to add images or setups for this cluster."
        />
      ) : null}
    </>
  );
}
