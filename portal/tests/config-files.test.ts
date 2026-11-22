import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseConfig } from "@/server/config";

/** The config files we ship must always load. */
describe("shipped config files", () => {
  it("config.example.yaml is valid", () => {
    const cfg = parseConfig(readFileSync("config.example.yaml", "utf8"), {
      RESEARCH_PVE_TOKEN: "x",
      HOMELAB_PVE_TOKEN: "y",
    });
    expect(cfg.clusters.map((c) => [c.id, c.approval, c.network.isolate, c.gpu.devices.length])).toEqual([
      ["research", "required", false, 5],
      ["homelab", "none", true, 0],
    ]);
  });

  it("config.dev.yaml is valid and all mock", () => {
    const cfg = parseConfig(readFileSync("config.dev.yaml", "utf8"), {});
    expect(cfg.clusters.every((c) => c.driver === "mock")).toBe(true);
  });
});
