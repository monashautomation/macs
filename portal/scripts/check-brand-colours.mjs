#!/usr/bin/env node
// Fails if UI code uses colours that bypass the Monash Automation theme tokens:
// raw Tailwind palette classes (bg-red-500, text-white, ...) or hex literals.
// Usage: node scripts/check-brand-colours.mjs [dir ...]   (default: src)
// Allow a line with: // brand-colours-allow: <reason>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const PALETTE =
  "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
const RAW_CLASS = new RegExp(
  String.raw`\b(?:bg|text|border|ring|fill|stroke|outline|from|via|to|decoration|divide|shadow|accent|caret)-(?:(?:${PALETTE})-\d{2,3}|white|black)(?:\/\d+)?\b`,
);
const HEX = /(?<![\w&])#(?:[0-9a-fA-F]{3}){1,2}\b/;
const EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".css"]);
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "public", "coverage"]);
// Token definition files are where colours are *meant* to live.
const SKIP_FILE = /(tokens|theme|globals|index)\.css$|check-brand-colours\.mjs$/;

const roots = process.argv.slice(2);
const hits = [];
function walk(path) {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const name of readdirSync(path)) if (!SKIP_DIRS.has(name)) walk(join(path, name));
    return;
  }
  if (!EXT.has(extname(path)) || SKIP_FILE.test(path)) return;
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (line.includes("brand-colours-allow")) return;
      const m = line.match(RAW_CLASS) ?? line.match(HEX);
      if (m) hits.push(`${path}:${i + 1}  ${m[0]}`);
    });
}
for (const r of roots.length ? roots : ["src"]) walk(r);
if (hits.length) {
  console.error(
    `Colours must come from theme tokens (bg-primary, text-muted-foreground, bg-warning-bg ...):\n${hits.join("\n")}`,
  );
  process.exit(1);
}
console.log("brand colours: ok");
