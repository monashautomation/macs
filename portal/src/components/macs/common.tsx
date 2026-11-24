"use client";

import { Badge } from "@monashautomation/ui/badge";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@monashautomation/ui/breadcrumb";
import { Button } from "@monashautomation/ui/button";
import { Label } from "@monashautomation/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@monashautomation/ui/select";
import { StatusBadge } from "@monashautomation/ui/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@monashautomation/ui/table";
import { cn } from "@monashautomation/ui/utils";
import { Play, SquareTerminal } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { api, type Cluster, type Image, type Job, type Service, useAct, type Vm } from "@/lib/client";
import { OsIcon } from "./os-icon";

export function Field({
  label,
  hint,
  htmlFor,
  children,
}: {
  label: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** The MA Select with plain value/label options. */
export function Pick<T extends string>({
  value,
  onChange,
  options,
  placeholder,
  className,
  id,
}: {
  value: T | "";
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  placeholder?: string;
  className?: string;
  id?: string;
}) {
  return (
    <Select value={value || undefined} onValueChange={(v) => onChange(v as T)}>
      <SelectTrigger id={id} className={cn("w-full", className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Note({
  tone = "muted",
  children,
}: {
  tone?: "muted" | "warning" | "danger" | "success";
  children: ReactNode;
}) {
  const tones = {
    muted: "bg-muted text-muted-foreground",
    warning: "bg-warning-bg text-warning",
    danger: "bg-danger-bg text-destructive",
    success: "bg-success-bg text-success",
  };
  return <p className={cn("rounded-md px-3 py-2 text-sm", tones[tone])}>{children}</p>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-sm text-muted-foreground">{children}</p>;
}

export function VmStatus({ vm }: { vm: Pick<Vm, "status" | "power" | "busy"> }) {
  if (vm.busy && vm.status === "active") return <StatusBadge tone="info">working…</StatusBadge>;
  switch (vm.status) {
    case "pending":
      return <StatusBadge tone="warning">awaiting approval</StatusBadge>;
    case "rejected":
      return <StatusBadge tone="neutral">rejected</StatusBadge>;
    case "provisioning":
      return <StatusBadge tone="info">provisioning…</StatusBadge>;
    case "error":
      return <StatusBadge tone="danger">failed</StatusBadge>;
    case "archived":
      return <StatusBadge tone="neutral">archived</StatusBadge>;
    case "active":
      if (vm.power === "running") return <StatusBadge tone="success">running</StatusBadge>;
      if (vm.power === "stopped") return <StatusBadge tone="neutral">stopped</StatusBadge>;
      if (vm.power === "missing") return <StatusBadge tone="danger">missing on cluster</StatusBadge>;
      return <StatusBadge tone="warning">{vm.power ?? "unknown"}</StatusBadge>;
    default:
      return <StatusBadge tone="neutral">{vm.status}</StatusBadge>;
  }
}

const osLabel: Record<string, string> = { linux: "Linux", windows: "Windows", other: "Other" };

export function ImageBadges({ image }: { image: Image }) {
  return (
    <>
      {image.gpuReady ? <StatusBadge tone="success">GPU-ready</StatusBadge> : null}
      <Badge variant="secondary">{image.kind === "iso" ? "ISO installer" : "ready to boot"}</Badge>
      <Badge variant="secondary">{osLabel[image.os] ?? image.os}</Badge>
      {image.tags.map((t) => (
        <Badge key={t} variant="outline">
          {t}
        </Badge>
      ))}
    </>
  );
}

/**
 * The VM list. With `actions`, each row gets the next thing its owner is most
 * likely to do (open the console, or start it), so common tasks don't need
 * the detail page.
 */
export function VmTable({
  vms,
  clusters,
  showOwner = false,
  actions = false,
}: {
  vms: Vm[];
  clusters: Cluster[];
  showOwner?: boolean;
  actions?: boolean;
}) {
  const cluster = (id: string) => clusters.find((c) => c.id === id);
  const start = useAct(
    (vm: Vm) => api(`/vms/${vm.id}/power`, { method: "POST", body: { action: "start" } }),
    {
      success: (vm) => `Starting ${vm.name}`,
    },
  );
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          {showOwner ? <TableHead>Owner</TableHead> : null}
          <TableHead>Cluster</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Size</TableHead>
          <TableHead>GPU</TableHead>
          {actions ? <TableHead className="text-right">Quick action</TableHead> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {vms.map((vm) => {
          const c = cluster(vm.clusterId);
          const running = vm.status === "active" && vm.power === "running";
          const stopped = vm.status === "active" && vm.power === "stopped";
          return (
            <TableRow key={vm.id}>
              <TableCell>
                <span className="flex items-center gap-2">
                  <OsIcon image={c?.images.find((i) => i.id === vm.imageSlug)} />
                  <Link href={`/vms/${vm.id}`} className="font-semibold">
                    {vm.name}
                  </Link>
                  {vm.vmid !== null ? (
                    <span className="text-xs text-muted-foreground tabular-nums">#{vm.vmid}</span>
                  ) : null}
                </span>
              </TableCell>
              {showOwner ? <TableCell className="text-muted-foreground">{vm.owner.name}</TableCell> : null}
              <TableCell className="text-muted-foreground">
                {c?.name ?? vm.clusterId}
                {vm.node ? <span className="text-xs"> · {vm.node}</span> : null}
              </TableCell>
              <TableCell>
                <VmStatus vm={vm} />
              </TableCell>
              <TableCell className="text-muted-foreground tabular-nums">
                {vm.cores} vCPU · {fmtGB(vm.memoryMb)} · {vm.diskGb} GB
              </TableCell>
              <TableCell>
                {vm.gpu ? (
                  <StatusBadge tone="success">{vm.gpu} attached</StatusBadge>
                ) : vm.gpuAccess === "approved" ? (
                  <StatusBadge tone="neutral">eligible</StatusBadge>
                ) : vm.gpuAccess === "requested" ? (
                  <StatusBadge tone="warning">requested</StatusBadge>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </TableCell>
              {actions ? (
                <TableCell className="text-right">
                  {running ? (
                    <Button asChild variant="ghost" size="sm">
                      <a
                        href={`/vms/${vm.id}/console`}
                        target="_blank"
                        rel="noopener"
                        className="text-foreground no-underline"
                      >
                        <SquareTerminal aria-hidden /> Console
                      </a>
                    </Button>
                  ) : stopped ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={vm.busy || start.isPending}
                      onClick={() => start.mutate(vm)}
                    >
                      <Play aria-hidden /> Start
                    </Button>
                  ) : null}
                </TableCell>
              ) : null}
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

export function JobRow({ job }: { job: Job }) {
  const [open, setOpen] = useState(job.status === "running");
  return (
    <li className="border-b border-border py-2 last:border-0">
      <button
        type="button"
        className="flex w-full flex-wrap items-center gap-2 text-left text-sm"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <StatusBadge
          tone={job.status === "succeeded" ? "success" : job.status === "failed" ? "danger" : "info"}
        >
          {job.status}
        </StatusBadge>
        <span className="font-semibold">{job.kind}</span>
        {job.vmName ? <span className="text-muted-foreground">{job.vmName}</span> : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {job.user?.name ?? "scheduler"} · {fmtDateTime(job.createdAt)}
        </span>
      </button>
      {open ? (
        <pre className="mt-2 overflow-x-auto rounded-md bg-muted p-3 text-xs leading-relaxed">
          {job.log || "starting…"}
        </pre>
      ) : null}
    </li>
  );
}

export function ServiceAddress({ s }: { s: Service }) {
  if (!s.address) {
    return (
      <span className="text-muted-foreground">
        {s.protocol}/{s.port}
      </span>
    );
  }
  return s.url ? (
    <a href={s.url} target="_blank" rel="noopener noreferrer" className="font-mono text-xs">
      {s.url}
    </a>
  ) : (
    <code className="text-xs">
      {s.address} ({s.protocol})
    </code>
  );
}

export const fmtGB = (mb: number) => `${mb % 1024 === 0 ? mb / 1024 : (mb / 1024).toFixed(1)} GB`;
export const fmtSize = (bytes: number) => (bytes > 0 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "—");
export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
export const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export function fmtUptime(seconds: number) {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** "in 2 h", "5 min ago": for times where how soon matters more than the date. */
export function relTime(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  const unit =
    abs < 3_600_000
      ? [Math.round(abs / 60_000), "min"]
      : abs < 86_400_000
        ? [Math.round(abs / 3_600_000), "h"]
        : [Math.round(abs / 86_400_000), "d"];
  if (abs < 45_000) return "now";
  return diff > 0 ? `in ${unit[0]} ${unit[1]}` : `${unit[0]} ${unit[1]} ago`;
}

/** Where am I, and the way back. */
export function Crumbs({
  here,
  parent = { label: "My VMs", href: "/" },
}: {
  here: string;
  parent?: { label: string; href: string };
}) {
  return (
    <Breadcrumb className="mb-3">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link href={parent.href}>{parent.label}</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{here}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}
