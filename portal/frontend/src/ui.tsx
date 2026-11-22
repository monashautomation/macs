import { type ButtonHTMLAttributes, type ReactNode, useEffect } from "react";
import type { VM } from "./api";

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(" ");

type Tone = "neutral" | "ok" | "warn" | "bad" | "brand" | "gpu";
const tones: Record<Tone, string> = {
  neutral: "bg-sunken text-mute",
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  bad: "bg-bad-soft text-bad",
  brand: "bg-brand-soft text-brand",
  gpu: "bg-gpu-soft text-gpu",
};

export function Badge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap", tones[tone])}>{children}</span>;
}

export function Button({ variant = "default", className, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "default" | "primary" | "danger" | "ghost" }) {
  const styles = {
    default: "border border-line bg-panel hover:bg-sunken",
    primary: "bg-brand text-brand-ink hover:opacity-90",
    danger: "border border-bad/40 text-bad hover:bg-bad-soft",
    ghost: "text-mute hover:bg-sunken hover:text-ink",
  }[variant];
  return <button type="button" {...props} className={cx("rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition disabled:cursor-not-allowed disabled:opacity-50", styles, className)} />;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("rounded-xl border border-line bg-panel", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <div className="flex flex-wrap gap-2">{actions}</div>
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-mute">{hint}</span>}
    </label>
  );
}

export const inputCls = "w-full rounded-md border border-line bg-panel px-3 py-2 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20";

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  return <p role="alert" className="rounded-md bg-bad-soft px-3 py-2 text-sm text-bad">{error instanceof Error ? error.message : String(error)}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-mute">{children}</p>;
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-md rounded-xl border border-line bg-panel shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button aria-label="Close" className="text-mute hover:text-ink" onClick={onClose}>✕</button>
        </header>
        <div className="space-y-4 p-4">{children}</div>
      </div>
    </div>
  );
}

export function VMStatus({ vm }: { vm: Pick<VM, "status" | "power" | "busy"> }) {
  if (vm.busy && vm.status === "active") return <Badge tone="brand">● working…</Badge>;
  switch (vm.status) {
    case "pending": return <Badge tone="warn">awaiting approval</Badge>;
    case "rejected": return <Badge tone="bad">rejected</Badge>;
    case "provisioning": return <Badge tone="brand">● provisioning…</Badge>;
    case "error": return <Badge tone="bad">failed</Badge>;
    case "archived": return <Badge>archived</Badge>;
    case "active":
      if (vm.power === "running") return <Badge tone="ok">● running</Badge>;
      if (vm.power === "stopped") return <Badge>○ stopped</Badge>;
      if (vm.power === "missing") return <Badge tone="bad">missing on cluster</Badge>;
      return <Badge tone="warn">{vm.power ?? "unknown"}</Badge>;
    default: return <Badge>{vm.status}</Badge>;
  }
}

export const fmtGB = (mb: number) => (mb % 1024 === 0 ? `${mb / 1024}` : (mb / 1024).toFixed(1)) + " GB";
export const fmtSize = (bytes: number) => (bytes > 0 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : "—");
export const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
export function fmtUptime(seconds: number) {
  if (!seconds) return "—";
  const d = Math.floor(seconds / 86400), h = Math.floor((seconds % 86400) / 3600), m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
