import type { Image } from "@prisma/client";
import { db } from "@/lib/db";
import type { ConnectKind, MacsConfig } from "@/server/config";

/**
 * Add images listed in the config file that the library does not have yet.
 * Existing entries are left alone so edits made in the app stick.
 */
export async function seedImages(cfg: MacsConfig) {
  for (const cluster of cfg.clusters) {
    const have = new Set(
      (await db.image.findMany({ where: { clusterId: cluster.id }, select: { slug: true } })).map(
        (i) => i.slug,
      ),
    );
    for (const t of cluster.templates) {
      if (have.has(t.id)) continue;
      await db.image.create({
        data: {
          clusterId: cluster.id,
          slug: t.id,
          kind: t.kind,
          name: t.name,
          description: t.description,
          os: t.os,
          vmid: t.kind === "template" ? (t.vmid ?? null) : null,
          volid: t.kind === "iso" ? t.volid : "",
          cicustom: t.cicustom,
          gpuReady: t.gpu_ready,
          tags: t.tags,
          connect: t.connect,
          defaultUser: t.default_user || (t.os === "linux" && t.kind === "template" ? "ubuntu" : ""),
        },
      });
    }
  }
}

export function getImage(clusterId: string, slug: string) {
  return db.image.findUnique({ where: { clusterId_slug: { clusterId, slug } } });
}

export function connectKinds(image: Pick<Image, "connect" | "os"> | null): ConnectKind[] {
  if (!image) return ["ssh"];
  if (image.connect.length) return image.connect as ConnectKind[];
  return image.os === "windows" ? ["rdp"] : ["ssh"];
}

export function imageOut(i: Image) {
  return {
    id: i.slug,
    name: i.name,
    kind: i.kind,
    os: i.os,
    description: i.description,
    defaultUser: i.defaultUser,
    gpuReady: i.gpuReady,
    tags: i.tags,
  };
}

export function adminImageOut(i: Image) {
  return {
    ...imageOut(i),
    dbId: i.id,
    clusterId: i.clusterId,
    vmid: i.vmid,
    volid: i.volid,
    cicustom: i.cicustom,
    connect: i.connect,
    enabled: i.enabled,
  };
}
