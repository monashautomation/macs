import RFB from "@novnc/novnc";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";
import { Button, cx } from "../ui";

type State = "connecting" | "connected" | "closed";

const tool = "rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm font-medium whitespace-nowrap text-neutral-100 hover:bg-neutral-700 disabled:cursor-not-allowed disabled:opacity-50";
const SHIFTED = new Set('~!@#$%^&*()_+{}|:"<>?');
const XK = { Return: 0xff0d, Tab: 0xff09, Shift: 0xffe1 };

/** VNC has no paste, so type the text key by key (US layout). */
async function typeText(rfb: RFB, text: string) {
  for (const ch of text.replace(/\r\n/g, "\n")) {
    const cp = ch.codePointAt(0)!;
    const keysym = ch === "\n" ? XK.Return : ch === "\t" ? XK.Tab : cp < 0x100 ? cp : 0x01000000 + cp;
    const shift = SHIFTED.has(ch) || (ch >= "A" && ch <= "Z");
    if (shift) rfb.sendKey(XK.Shift, "ShiftLeft", true);
    rfb.sendKey(keysym, null);
    if (shift) rfb.sendKey(XK.Shift, "ShiftLeft", false);
    await new Promise((r) => setTimeout(r, 8));
  }
}

export default function Console() {
  const id = Number(useParams().id);
  const screen = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let conn: RFB | null = null;
    setState("connecting");
    setError("");
    api<{ token: string; password: string; name: string }>(`/api/vms/${id}/console`, { method: "POST", body: {} })
      .then((grant) => {
        if (cancelled || !screen.current) return;
        setName(grant.name);
        document.title = `${grant.name} — console`;
        const scheme = location.protocol === "https:" ? "wss" : "ws";
        conn = new RFB(screen.current, `${scheme}://${location.host}/api/console/${grant.token}`, {
          credentials: { password: grant.password },
          wsProtocols: ["binary"],
        });
        conn.scaleViewport = true;
        conn.background = "#000";
        conn.addEventListener("connect", () => { setState("connected"); conn?.focus(); });
        conn.addEventListener("disconnect", (e) => {
          if (cancelled) return;
          setState("closed");
          if (!(e as CustomEvent<{ clean: boolean }>).detail.clean) setError("The connection to the VM was lost.");
        });
        conn.addEventListener("securityfailure", () => setError("Proxmox rejected the console ticket. Try reconnecting."));
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
      try { conn?.disconnect(); } catch { /* never connected */ }
    };
  }, [id, attempt]);

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
    <div ref={frame} className="fixed inset-0 z-50 flex flex-col bg-black text-white">
      <div className="flex flex-wrap items-center gap-2 bg-neutral-900 px-3 py-2 text-sm">
        <Link to={`/vms/${id}`} className="text-neutral-400 hover:text-white">← {name || "VM"}</Link>
        <span className={cx("ml-1 rounded-full px-2 py-0.5 text-xs", live ? "bg-emerald-900 text-emerald-300" : state === "connecting" ? "bg-sky-900 text-sky-300" : "bg-red-900 text-red-300")}>
          {live ? "connected" : state === "connecting" ? "connecting…" : "disconnected"}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <button className={tool} disabled={!live} onClick={() => { rfb.current?.sendCtrlAltDel(); rfb.current?.focus(); }}>Ctrl+Alt+Del</button>
          <button className={tool} disabled={!live} onClick={paste} title="Types your clipboard into the VM (US keyboard layout)">Paste as keystrokes</button>
          <button className={tool} onClick={() => (document.fullscreenElement ? document.exitFullscreen() : frame.current?.requestFullscreen())}>Fullscreen</button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={screen} className="absolute inset-0" />
        {state !== "connected" && (
          <div className="absolute inset-0 grid place-items-center bg-black/80 p-6 text-center">
            <div className="max-w-sm space-y-3">
              <p className="text-sm text-neutral-300">{state === "connecting" ? "Opening console…" : error || "Console closed."}</p>
              {state === "closed" && <Button variant="primary" onClick={() => setAttempt(attempt + 1)}>Reconnect</Button>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
