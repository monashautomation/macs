import { execFileSync } from "node:child_process";

/** Engine tests need Postgres: set TEST_DATABASE_URL to an empty database. Without it they are skipped. */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  execFileSync("node", ["node_modules/prisma/build/index.js", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
