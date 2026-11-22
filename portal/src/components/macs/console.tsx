"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/client";

type State = "connecting" | "connected" | "closed";
// The slice of noVNC's RFB class this page uses (the package ships no types).
interface Rfb extends EventTarget {
  scaleViewport: boolean;
  background: string;
  disconnect(): void;
  focus(): void;
  sendCtrlAltDel(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
}
type RfbClass = new (
  target: HTMLElement,
  url: string,
  options: { credentials: { password: string }; wsProtocols: string[] },
) => Rfb;

const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?');
const XK = { Return: 0xff0d, Tab: 0xff09, Shift: 0xffe1 };

/** VNC has no paste, so type the text key by key (US layout). */
async function typeText(rfb: Rfb, text: string) {
  for (const ch of text.replace(/\r\n/g, "\n")) {
    const cp = ch.codePointAt(0) ?? 0;
    const keysym = ch === "\n" ? XK.Return : ch === "\t" ? XK.Tab : cp < 0x100 ? cp : 0x01000000 + cp;
    const shift = SHIFTED.has(ch) || (ch >= "A" && ch <= "Z");
    if (shift) rfb.sendKey(XK.Shift, "ShiftLeft", true);
    rfb.sendKey(keysym, null);
    if (shift) rfb.sendKey(XK.Shift, "ShiftLeft", false);
    await new Promise((r) => setTimeout(r, 8));
  }
}

/** Full-window VM screen. Deliberately outside the AppShell: the guest display needs the space. */
export function VmConsole({ id, wsUrl }: { id: string; wsUrl: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const rfb = useRef<Rfb | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let conn: Rfb | null = null;
    setState("connecting");
    setError("");
    Promise.all([
      api<{ token: string; password: string; name: string }>(`/vms/${id}/console`, {
        method: "POST",
        body: {},
      }),
      // @ts-expect-error noVNC ships no type declarations
      import("@novnc/novnc") as Promise<{ default: RfbClass }>,
    ])
      .then(([grant, novnc]) => {
        if (cancelled || !screen.current) return;
        setName(grant.name);
        document.title = `${grant.name} — console`;
        conn = new novnc.default(screen.current, `${wsUrl}/${grant.token}`, {
          credentials: { password: grant.password },
          wsProtocols: ["binary"],
        });
        conn.scaleViewport = true;
        conn.background = "black";
        conn.addEventListener("connect", () => {
          setState("connected");
          conn?.focus();
        });
        conn.addEventListener("disconnect", (e) => {
          if (cancelled) return;
          setState("closed");
          if (!(e as CustomEvent<{ clean: boolean }>).detail.clean)
            setError("The connection to the VM was lost.");
        });
        conn.addEventListener("securityfailure", () =>
          setError("Proxmox rejected the console ticket. Try reconnecting."),
        );
        rfb.current = conn;
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setState("closed");
        setError(e.message);
      });
    return () => {
      cancelled = true;
      rfb.current = null;
      try {
        conn?.disconnect();
      } catch {
        // never connected
      }
    };
  }, [id, wsUrl, attempt]);

  const paste = useCallback(async () => {
    let text: string | null;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      text = prompt("Text to type into the VM:");
    }
    if (text && rfb.current) {
      await typeText(rfb.current, text);
      rfb.current.focus();
    }
  }, []);

  const live = state === "connected";
  return (
    <div ref={frame} className="fixed inset-0 z-50 flex flex-col bg-background">
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-card px-3 py-2 text-sm">
        <Link href={`/vms/${id}`}>← {name || "VM"}</Link>
        <StatusBadge tone={live ? "success" : state === "connecting" ? "info" : "danger"}>
          {live ? "connected" : state === "connecting" ? "connecting…" : "disconnected"}
        </StatusBadge>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!live}
            onClick={() => {
              rfb.current?.sendCtrlAltDel();
              rfb.current?.focus();
            }}
          >
            Ctrl+Alt+Del
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!live}
            onClick={paste}
            title="Types your clipboard into the VM (US keyboard layout)"
          >
            Paste as keystrokes
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen()
            }
          >
            Fullscreen
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 bg-foreground">
        <div ref={screen} className="absolute inset-0" />
        {state !== "connected" ? (
          <div className="absolute inset-0 grid place-items-center bg-overlay p-6 text-center">
            <div className="max-w-sm space-y-3 rounded-xl bg-card p-6">
              <p className="text-sm text-muted-foreground">
                {state === "connecting" ? "Opening console…" : error || "Console closed."}
              </p>
              {state === "closed" ? <Button onClick={() => setAttempt(attempt + 1)}>Reconnect</Button> : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
