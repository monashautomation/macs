"use client";

import { Button } from "@monashautomation/ui/button";
import { EmptyState } from "@monashautomation/ui/empty-state";
import { PageHeader } from "@monashautomation/ui/page-header";
import { SectionCard } from "@monashautomation/ui/section-card";
import Link from "next/link";
import { useState } from "react";
import { useClusters } from "@/lib/client";
import { ImageBadges } from "./common";
import { OsIcon } from "./os-icon";

type Filter = "all" | "gpu" | "template" | "iso";

export function Images() {
  const clusters = useClusters();
  const [clusterId, setClusterId] = useState("all");
  const [filter, setFilter] = useState<Filter>("all");
  if (!clusters.data) return null;
  const rows = clusters.data
    .filter((c) => clusterId === "all" || c.id === clusterId)
    .flatMap((c) => c.images.map((image) => ({ image, cluster: c })))
    .filter(({ image }) => filter === "all" || (filter === "gpu" ? image.gpuReady : image.kind === filter));
  const anyGpu = clusters.data.some((c) => c.images.some((i) => i.gpuReady));
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
  return (
    <>
      <PageHeader
        title="Image library"
        description="Prepared images boot ready to use with your SSH key. ISO installers give you an empty machine to set up yourself from the console."
      />
      <div className="mb-5 flex flex-wrap gap-1">
        {chip(clusterId === "all", "All clusters", () => setClusterId("all"))}
        {clusters.data.map((c) => chip(clusterId === c.id, c.name, () => setClusterId(c.id)))}
        <span className="mx-2 w-px bg-border" />
        {chip(filter === "all", "Everything", () => setFilter("all"))}
        {anyGpu ? chip(filter === "gpu", "GPU-ready", () => setFilter("gpu")) : null}
        {chip(filter === "template", "Ready to boot", () => setFilter("template"))}
        {chip(filter === "iso", "ISO installers", () => setFilter("iso"))}
      </div>
      {rows.length ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map(({ image, cluster }) => (
            <SectionCard
              key={`${cluster.id}/${image.id}`}
              title={
                <>
                  <OsIcon image={image} /> {image.name}
                </>
              }
              className="h-full"
            >
              <div className="flex h-full flex-col">
                <p className="-mt-3 text-xs text-muted-foreground">{cluster.name}</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <ImageBadges image={image} />
                </div>
                <p className="mt-3 flex-1 text-sm text-muted-foreground">
                  {image.description ||
                    (image.kind === "iso"
                      ? "Boots the installer on an empty disk; you install the OS from the console."
                      : "Cloned from a prepared template.")}
                </p>
                <Button asChild variant="outline" className="mt-4 self-start">
                  <Link
                    href={`/new?cluster=${cluster.id}&image=${image.id}`}
                    className="text-foreground no-underline"
                  >
                    Deploy
                  </Link>
                </Button>
              </div>
            </SectionCard>
          ))}
        </div>
      ) : (
        <EmptyState
          title="No images match"
          description="Try another filter, or ask Systems & Infra to add the image you need."
        />
      )}
    </>
  );
}
