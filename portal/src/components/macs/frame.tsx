"use client";

import { Cpu, Disc3, Globe, Server, Wrench } from "lucide-react";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppShell } from "@/components/app-shell";
import { SignOutButton } from "@/components/auth-buttons";
import { SectionNav } from "@/components/section-nav";
import { Badge } from "@/components/ui/badge";
import { pendingCount, useApprovals } from "@/lib/client";

export interface FrameProps {
  appName: string;
  libraryUrl: string;
  userName: string;
  isAdmin: boolean;
  hasGpus: boolean;
  hasServices: boolean;
  children: ReactNode;
}

const INFRA: [string, string][] = [
  ["/infra", "Overview"],
  ["/infra/approvals", "Approvals"],
  ["/infra/machines", "Virtual machines"],
  ["/infra/gpus", "GPUs"],
  ["/infra/images", "Image library"],
  ["/infra/network", "Network & services"],
  ["/infra/people", "People"],
  ["/infra/activity", "Activity"],
  ["/infra/audit", "Audit log"],
];

/**
 * The MA AppShell for every signed-in page. Members get their workspace nav;
 * the infrastructure team also gets an "Infrastructure" entry, and inside it a
 * second row of sections.
 */
export function Frame({
  appName,
  libraryUrl,
  userName,
  isAdmin,
  hasGpus,
  hasServices,
  children,
}: FrameProps) {
  const path = usePathname();
  const inInfra = path === "/infra" || path.startsWith("/infra/");
  const approvals = useApprovals(isAdmin);
  const waiting = pendingCount(approvals.data);
  const at = (href: string) =>
    href === "/" ? path === "/" || path.startsWith("/vms") || path === "/new" : path.startsWith(href);
  const nav = [
    {
      label: "My VMs",
      href: "/",
      icon: <Server className="size-4" aria-hidden />,
      active: !inInfra && at("/"),
    },
    {
      label: "Images",
      href: "/images",
      icon: <Disc3 className="size-4" aria-hidden />,
      active: at("/images"),
    },
    ...(hasGpus
      ? [{ label: "GPUs", href: "/gpus", icon: <Cpu className="size-4" aria-hidden />, active: at("/gpus") }]
      : []),
    ...(hasServices
      ? [
          {
            label: "Services",
            href: "/services",
            icon: <Globe className="size-4" aria-hidden />,
            active: at("/services"),
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            label: "Infra",
            href: "/infra",
            icon: <Wrench className="size-4" aria-hidden />,
            active: inInfra,
          },
        ]
      : []),
  ];
  return (
    <AppShell
      appName={appName}
      libraryUrl={libraryUrl}
      nav={nav}
      user={
        <>
          <span className="hidden text-sm text-muted-foreground lg:inline">{userName}</span>
          <SignOutButton />
        </>
      }
    >
      {inInfra ? (
        <SectionNav
          label="Infrastructure"
          className="-mt-2"
          items={INFRA.map(([href, label]) => ({
            href,
            label,
            active: href === "/infra" ? path === "/infra" : path.startsWith(href),
            badge:
              href === "/infra/approvals" && waiting > 0 ? (
                <Badge variant="warning">{waiting}</Badge>
              ) : undefined,
          }))}
        />
      ) : null}
      {children}
    </AppShell>
  );
}
