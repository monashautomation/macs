"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@monashautomation/ui/tooltip";
import { CircleHelp } from "lucide-react";
import { useState } from "react";

/**
 * What things are, in a sentence or two. One place for the wording, so the
 * same term is explained the same way wherever it appears.
 */
export const HELP = {
  cluster:
    "A cluster is a group of servers that run VMs. Each has its own rules: who can use it, whether requests need approval, and how much you can use (your quota, shown as the bars below).",
  quota:
    "Your quota is the total you may use on this cluster across all your VMs. Stopped VMs still count, because their disk and reserved size are kept. Delete or shrink a VM to free some.",
  lab: "A lab is a set of VMs deployed together. They can reach each other by name and share one login. Other people's VMs still cannot reach them.",
  vmStatus:
    "Running: switched on. Stopped: switched off, with its disk kept. Working: the portal is doing something to it. Awaiting approval: Systems & Infra have not decided yet. Expired: shut down until someone extends it.",
  gpuColumn:
    "Eligible: approved to book GPU time. Requested: waiting for Systems & Infra. Attached: a GPU is plugged into this VM right now.",
  newWhere:
    "Pick the cluster the VM runs on. Self-service clusters create it straight away within your quota. Clusters that need approval send a request to Systems & Infra first.",
  newHow:
    "Automatic: the portal clones a prepared image, creates your login and connects the network. Manual: an empty VM boots an installer disc and you set everything up yourself on the console, like installing on a real PC.",
  newWhat:
    "The image is the operating system the VM starts from. A setup is software installed on top once it boots. vCPUs, memory and disk are the VM's size; you can change them later on self-service clusters.",
  newApproval:
    "Tell the approvers what the VM is for. GPU access is approved separately, per VM, and lets you book GPU time once granted.",
  login:
    "The user name and a generated password for signing in on the terminal or console, and for sudo. It is shown once and the portal does not keep it. If you lose it, reset it under Settings.",
  details:
    "Where the VM lives and how big it is. Node is the physical server it is on right now (it can move). VMID is its number in Proxmox, useful when asking Systems & Infra for help.",
  node: "The physical server this VM is running on. On the research cluster VMs move between nodes, for example to reach a free GPU.",
  vmid: "The VM's number in Proxmox. Quote it when asking Systems & Infra about this VM.",
  expiry:
    "To free unused resources, VMs on this cluster are shut down on this date unless someone extends them. Nothing is deleted, and extending is one click.",
  firstSteps:
    "A suggested order for getting started. Ticks are only saved in this browser; nothing on the VM depends on them.",
  usage:
    "CPU, memory and network use over time, measured by the cluster from outside the VM. Handy for spotting a VM that is too small, or one that is doing nothing.",
  connect:
    "Ways in. Terminal: a text login in your browser, with copy and paste. Console: the VM's screen and keyboard, as if you sat in front of it. Both work even if the VM's network is broken. SSH and remote desktop need NetBird running on your computer.",
  services:
    "VMs here are isolated: nothing can connect to them except you, on the login port. Publishing a port opens just that port to everyone on NetBird, so others can use a website or server you run.",
  gpu: "GPUs are shared. Once this VM is approved for GPU use, you book a time slot; the GPU is plugged in when the slot starts and removed when it ends. The VM restarts both times.",
  snapshots:
    "A snapshot remembers the disk exactly as it is now, in seconds. Roll back to return to that moment, losing everything since. Snapshots live with the VM: deleting or rebuilding the VM removes them.",
  backups:
    "A backup is a full copy stored on a separate backup server, so it survives even if the VM is deleted. Archive backs the VM up and removes it from the cluster to free your quota; restore brings it back.",
  activity:
    "Everything the portal has done to this VM, newest first. Open an entry to read its log, which is the first place to look when something failed.",
  size: "vCPUs are processor cores, memory is RAM, disk is storage. Changing CPU or memory restarts a running VM. A disk can grow but never shrink.",
  schedule:
    "Switch the VM off and on automatically at set times, so it is not running when you are not using it. A stopped VM keeps its disk and everything on it.",
  keys: "An SSH key lets you sign in over SSH without a password. Paste the public half (the line starting ssh-ed25519 or ssh-rsa, from the .pub file). Never paste a private key.",
  sharing:
    "Give teammates access to use this VM without handing it over. They can start, stop and sign in to it, but only you can delete, rebuild, resize or share it.",
  startOver:
    "Rebuild erases the disk and installs the same thing again: a fresh start with the same name and address. Delete removes the VM completely and frees your quota. Neither can be undone.",
  idle: "A VM that uses almost no CPU or network for several days is treated as forgotten and shut down to free resources. Keep running tells the portal it is still needed.",
  bookGpu:
    "Choose one of your approved VMs and a time slot. The VM gets a GPU for that slot and restarts when it starts and ends, so save your work before the end.",
  gpuHours:
    "How many GPU hours are booked on each day. Quieter days are the easiest time to get a long slot.",
} as const;

export type HelpTopic = keyof typeof HELP;

/** A small "?" that explains a term on hover or focus, and on tap for touch screens. */
export function HelpTip({ topic, label }: { topic: HelpTopic; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label ? `What is ${label}?` : "What is this?"}
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-full align-middle text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={(e) => {
            e.preventDefault();
            setOpen(true);
          }}
        >
          <CircleHelp className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent
        collisionPadding={12}
        className="max-w-72 text-left text-sm font-normal leading-snug text-pretty"
      >
        {HELP[topic]}
      </TooltipContent>
    </Tooltip>
  );
}
