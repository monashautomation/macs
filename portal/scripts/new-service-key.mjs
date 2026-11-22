// Prints a new service key and its SHA-256 for SERVICE_KEYS.
// Give the key to the calling service (store it in its OpenBao path);
// put only the hash in this app's SERVICE_KEYS.
import { createHash, randomBytes } from "node:crypto";

const name = process.argv[2];
if (!name) {
  console.error("usage: node scripts/new-service-key.mjs <caller-name>");
  process.exit(1);
}
const key = `ma_${randomBytes(32).toString("base64url")}`;
const hash = createHash("sha256").update(key).digest("hex");
console.log(`key  (give to ${name}): ${key}`);
console.log(`SERVICE_KEYS entry: "${name}": "${hash}"`);
