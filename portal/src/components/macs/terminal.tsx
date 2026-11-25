"use client";

import "@xterm/xterm/css/xterm.css";
import { Button } from "@monashautomation/ui/button";
import { StatusBadge } from "@monashautomation/ui/status-badge";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/client";

type State = "connecting" | "connected" | "closed";

/**
 * The VM's serial terminal in the browser: a text login that copies and pastes
 * like any terminal, and works without the VM's network. Like the console it
 * sits outside the AppShell, because it needs the whole window.
 */
export function VmTerminal({ id, wsUrl }: { id: string; wsUrl: string }) {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>("connecting");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    setState("connecting");
    setError("");
    Promise.all([
      api<{ token: string; name: string }>(`/vms/${id}/terminal`, { method: "POST", body: {} }),
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
    ])
      .then(([grant, xterm, fitAddon]) => {
        if (cancelled || !host.current) return;
        setName(grant.name);
        document.title = `${grant.name} — terminal`;
        const term = new xterm.Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000 });
        const fit = new fitAddon.FitAddon();
        term.loadAddon(fit);
        term.open(host.current);
        const ws = new WebSocket(`${wsUrl}/${grant.token}`, "binary");
        ws.binaryType = "arraybuffer";
        const encoder = new TextEncoder();
        const resize = () => {
          fit.fit();
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ resize: [term.cols, term.rows] }));
        };
        ws.onopen = () => {
          setState("connected");
          resize();
          term.focus();
          ws.send(encoder.encode("\r")); // wake the login prompt
        };
        ws.onmessage = (e) => term.write(new Uint8Array(e.data as ArrayBuffer));
        ws.onclose = () => {
          if (!cancelled) setState("closed");
        };
        const typed = term.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(encoder.encode(data));
        });
        const observer = new ResizeObserver(resize);
        observer.observe(host.current);
        cleanup = () => {
          observer.disconnect();
          typed.dispose();
          ws.close();
          term.dispose();
        };
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState("closed");
        setError(e.message);
      });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [id, wsUrl, attempt]);

  const live = state === "connected";
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 text-sm">
        <Link href={`/vms/${id}`}>← {name || "VM"}</Link>
        <StatusBadge tone={live ? "success" : state === "connecting" ? "info" : "danger"}>
          {live ? "connected" : state === "connecting" ? "connecting…" : "disconnected"}
        </StatusBadge>
        <span className="hidden text-xs text-muted-foreground sm:inline">
          Sign in with the VM's user and password. Copy and paste work as in any terminal.
        </span>
        <Button asChild variant="outline" size="sm" className="ml-auto">
          <a href={`/vms/${id}/console`} className="text-foreground no-underline">
            Switch to screen console
          </a>
        </Button>
      </div>
      <div className="relative min-h-0 flex-1 bg-foreground dark:bg-background">
        <div ref={host} className="absolute inset-2" />
        {state !== "connected" ? (
          <div className="absolute inset-0 z-10 grid place-items-center bg-overlay p-6 text-center">
            <div className="max-w-sm space-y-3 rounded-xl bg-card p-6">
              <p className="text-sm text-muted-foreground">
                {state === "connecting" ? "Opening terminal…" : error || "Terminal closed."}
              </p>
              {state === "closed" ? <Button onClick={() => setAttempt(attempt + 1)}>Reconnect</Button> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
