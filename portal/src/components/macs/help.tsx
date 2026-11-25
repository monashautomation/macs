"use client";

import { Popover, PopoverContent, PopoverTrigger } from "@monashautomation/ui/popover";
import { CircleHelp } from "lucide-react";
import { useRef, useState } from "react";

/**
 * What things are. One place for the wording, so the same term is explained
 * the same way wherever it appears. Each entry is a title, a sentence or two,
 * and optionally a short list of terms.
 */
interface Topic {
  title: string;
  body: string;
  terms?: [string, string][];
}

export const HELP = {
  cluster: {
    title: "Clusters",
    body: "A cluster is a group of servers that run VMs. Each has its own rules for who can use it and whether requests need approval.",
    terms: [["Quota", "the bars below: the most you may use here across all your VMs."]],
  },
  lab: {
    title: "Labs",
    body: "A set of VMs deployed together. They can reach each other by name and share one login. Other people's VMs still cannot reach them.",
  },
  vmStatus: {
    title: "Status",
    body: "What the VM is doing right now.",
    terms: [
      ["Running", "switched on."],
      ["Stopped", "switched off, disk kept."],
      ["Working", "the portal is changing it."],
      ["Awaiting approval", "Systems & Infra have not decided yet."],
      ["Expired", "shut down until someone extends it."],
    ],
  },
  gpuColumn: {
    title: "GPU",
    body: "GPUs are shared and booked by the hour.",
    terms: [
      ["Eligible", "approved to book GPU time."],
      ["Requested", "waiting for Systems & Infra."],
      ["Attached", "a GPU is plugged in right now."],
    ],
  },
  newWhere: {
    title: "Where it runs",
    body: "Pick the cluster for this VM.",
    terms: [
      ["Self-service", "created straight away, within your quota."],
      ["Needs approval", "a request goes to Systems & Infra first."],
    ],
  },
  newHow: {
    title: "How it is set up",
    body: "Two ways to get to a working machine.",
    terms: [
      ["Automatic", "a prepared image, with your login and network configured for you."],
      ["Manual", "an empty VM boots an installer and you set it up on the console, like a real PC."],
    ],
  },
  newWhat: {
    title: "What goes on it",
    body: "You can change the size later on self-service clusters.",
    terms: [
      ["Image", "the operating system it starts from."],
      ["Setup", "software installed on top once it boots."],
      ["vCPUs, memory, disk", "processor cores, RAM and storage."],
    ],
  },
  newApproval: {
    title: "Approval",
    body: "Tell the approvers what the VM is for. GPU access is approved separately, per VM, and lets you book GPU time once granted.",
  },
  login: {
    title: "Your login",
    body: "The user name and a generated password for the terminal, the console and sudo. It is shown once and the portal does not keep it. Lost it? Reset it under Settings.",
  },
  details: {
    title: "Details",
    body: "Where the VM lives and how big it is.",
    terms: [
      ["Node", "the physical server it is on right now."],
      ["VMID", "its number in Proxmox. Quote it when asking for help."],
    ],
  },
  node: {
    title: "Node",
    body: "The physical server this VM is running on. On the research cluster VMs move between nodes, for example to reach a free GPU.",
  },
  vmid: {
    title: "VMID",
    body: "The VM's number in Proxmox. Quote it when asking Systems & Infra about this VM.",
  },
  expiry: {
    title: "Runs until",
    body: "To free unused resources, VMs on this cluster are shut down on this date unless someone extends them. Nothing is deleted, and extending is one click.",
  },
  firstSteps: {
    title: "First steps",
    body: "A suggested order for getting started. Ticks are saved in this browser only; nothing on the VM depends on them.",
  },
  usage: {
    title: "Usage",
    body: "CPU, memory and network over time, measured from outside the VM. Useful for spotting a VM that is too small, or one doing nothing.",
  },
  connect: {
    title: "Ways to connect",
    body: "Terminal and console work even when the VM's network is broken.",
    terms: [
      ["Terminal", "a text login in your browser, with copy and paste."],
      ["Console", "the VM's screen and keyboard, as if you sat in front of it."],
      ["SSH / remote desktop", "from your own computer, with NetBird running."],
    ],
  },
  services: {
    title: "Public services",
    body: "VMs here are isolated: nothing can connect to them except you, on the login port. Publishing a port opens just that port to everyone on NetBird, so others can use a website or server you run.",
  },
  gpu: {
    title: "GPU time",
    body: "GPUs are shared. Once this VM is approved, you book a time slot. The GPU is plugged in when the slot starts and removed when it ends, and the VM restarts both times.",
  },
  snapshots: {
    title: "Snapshots",
    body: "A snapshot remembers the disk exactly as it is now, in seconds. Rolling back returns to that moment and loses everything since. Snapshots live with the VM: deleting or rebuilding it removes them.",
  },
  backups: {
    title: "Backups",
    body: "A full copy on a separate backup server, so it survives even if the VM is deleted.",
    terms: [
      ["Archive", "back up, then remove the VM from the cluster to free your quota."],
      ["Restore", "bring it back from a backup."],
    ],
  },
  activity: {
    title: "Activity",
    body: "Everything the portal has done to this VM, newest first. Open an entry to read its log: the first place to look when something failed.",
  },
  size: {
    title: "Size",
    body: "Changing CPU or memory restarts a running VM. A disk can grow but never shrink.",
    terms: [
      ["vCPUs", "processor cores."],
      ["Memory", "RAM."],
      ["Disk", "storage."],
    ],
  },
  schedule: {
    title: "Power schedule",
    body: "Switch the VM off and on automatically at set times, so it is not running when you are not using it. A stopped VM keeps its disk and everything on it.",
  },
  keys: {
    title: "SSH keys",
    body: "A key lets you sign in over SSH without a password. Paste the public half: the line starting ssh-ed25519 or ssh-rsa, from the .pub file. Never paste a private key.",
  },
  sharing: {
    title: "Sharing",
    body: "Give teammates access to use this VM without handing it over. They can start, stop and sign in to it. Only you can delete, rebuild, resize or share it.",
  },
  startOver: {
    title: "Starting over",
    body: "Neither of these can be undone.",
    terms: [
      ["Rebuild", "erase the disk and install the same thing again, keeping the name and address."],
      ["Delete", "remove the VM completely and free your quota."],
    ],
  },
  idle: {
    title: "Idle VMs",
    body: "A VM that uses almost no CPU or network for several days is treated as forgotten and shut down to free resources. Keep running tells the portal it is still needed.",
  },
  bookGpu: {
    title: "Booking GPU time",
    body: "Choose one of your approved VMs and a time slot. The VM restarts when the slot starts and ends, so save your work before the end.",
  },
  gpuHours: {
    title: "GPU hours per day",
    body: "How many GPU hours are booked on each day. Quieter days are the easiest time to get a long slot.",
  },
} as const satisfies Record<string, Topic>;

export type HelpTopic = keyof typeof HELP;

/**
 * A small "?" that explains a term in a card: on hover with a mouse, and on
 * click, tap or Enter otherwise (which also pins it open).
 */
export function HelpTip({ topic, label }: { topic: HelpTopic; label?: string }) {
  const [open, setOpen] = useState(false);
  const pinned = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const help: Topic = HELP[topic];
  const hover = (next: boolean) => (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse" || pinned.current) return;
    clearTimeout(timer.current);
    // A short delay either way: no flicker when passing over, time to reach the card.
    timer.current = setTimeout(() => setOpen(next), next ? 120 : 180);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        clearTimeout(timer.current);
        pinned.current = next;
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`What is ${label ?? help.title}?`}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-ring data-[state=open]:text-primary"
          onPointerEnter={hover(true)}
          onPointerLeave={hover(false)}
        >
          <CircleHelp className="size-4" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        alignOffset={-12}
        sideOffset={6}
        collisionPadding={12}
        className="w-80 max-w-[calc(100vw-1.5rem)] rounded-xl p-0 text-left font-normal whitespace-normal shadow-lg"
        onOpenAutoFocus={(e) => e.preventDefault()}
        onPointerEnter={hover(true)}
        onPointerLeave={hover(false)}
      >
        <p className="flex items-center gap-2 border-b border-border px-4 py-2.5 text-sm font-semibold text-foreground">
          <CircleHelp className="size-4 text-primary" aria-hidden />
          {help.title}
        </p>
        <div className="space-y-2.5 px-4 py-3 text-[13px] leading-relaxed tracking-normal text-muted-foreground">
          <p>{help.body}</p>
          {help.terms ? (
            <dl className="space-y-1.5">
              {help.terms.map(([term, text]) => (
                <div key={term} className="flex gap-2">
                  <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
                  <div>
                    <dt className="inline font-semibold text-foreground">{term}</dt>{" "}
                    <dd className="inline">{text}</dd>
                  </div>
                </div>
              ))}
            </dl>
          ) : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
