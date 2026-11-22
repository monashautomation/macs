#!/usr/bin/env node
// A stand-in for Authentik, for LOCAL DEVELOPMENT ONLY: a minimal OpenID
// provider with a "who do you want to be?" page instead of a password.
// The app itself stays Authentik-only; point AUTHENTIK_ISSUER at this:
//
//   node scripts/mock-authentik.mjs            # http://localhost:9000
//   AUTHENTIK_ISSUER=http://localhost:9000/application/o/macs/
//   AUTHENTIK_CLIENT_ID=macs-dev  AUTHENTIK_CLIENT_SECRET=macs-dev-secret
//
// Never run it anywhere reachable by other people.
import { createHash, createSign, generateKeyPairSync, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.MOCK_AUTHENTIK_PORT ?? 9000);
const ISSUER = `http://localhost:${PORT}/application/o/macs/`;
const USERS = [
  {
    sub: "dev-admin",
    name: "Ada Admin",
    email: "ada@example.test",
    groups: ["automation-admins", "automation-members"],
  },
  { sub: "dev-alice", name: "Alice Researcher", email: "alice@example.test", groups: ["automation-members"] },
  { sub: "dev-bob", name: "Bob Researcher", email: "bob@example.test", groups: ["automation-members"] },
  { sub: "dev-sam", name: "Sam Student", email: "sam@example.test", groups: ["students"] },
];

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "dev", use: "sig", alg: "RS256" };
const b64 = (v) => Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString("base64url");
function jwt(claims) {
  const body = `${b64({ alg: "RS256", typ: "JWT", kid: "dev" })}.${b64(claims)}`;
  return `${body}.${createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url")}`;
}
const profile = (u) => ({
  sub: u.sub,
  name: u.name,
  preferred_username: u.email.split("@")[0],
  email: u.email,
  email_verified: true,
  groups: u.groups,
});

const codes = new Map(); // code -> { user, challenge, nonce, clientId }
const tokens = new Map(); // access token -> user

const json = (res, status, data) =>
  res
    .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
    .end(JSON.stringify(data));
const readForm = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(new URLSearchParams(raw)));
  });

createServer(async (req, res) => {
  const url = new URL(req.url, ISSUER);
  const path = url.pathname.replace(/^\/application\/o\/macs/, "") || "/";
  if (path === "/.well-known/openid-configuration") {
    return json(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}authorize`,
      token_endpoint: `${ISSUER}token`,
      userinfo_endpoint: `${ISSUER}userinfo`,
      jwks_uri: `${ISSUER}jwks`,
      end_session_endpoint: `${ISSUER}end-session`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid", "profile", "email", "groups"],
      token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
      code_challenge_methods_supported: ["S256"],
    });
  }
  if (path === "/jwks") return json(res, 200, { keys: [jwk] });
  if (path === "/authorize") {
    const q = url.searchParams;
    const pick = q.get("login_hint_user");
    const user = USERS.find((u) => u.sub === pick);
    if (!user) {
      const links = USERS.map((u) => {
        const next = new URL(url);
        next.searchParams.set("login_hint_user", u.sub);
        return `<li><a href="${next.pathname}${next.search.replaceAll("&", "&amp;")}" data-user="${u.sub}"><b>${u.name}</b> <small>${u.groups.join(", ")}</small></a></li>`;
      }).join("");
      return res
        .writeHead(200, { "content-type": "text/html" })
        .end(`<!doctype html><meta name=viewport content="width=device-width"><title>Mock Authentik</title>
<body style="font:16px system-ui;max-width:28rem;margin:4rem auto;padding:0 1rem">
<h1 style="font-size:1.25rem">Mock Authentik <small>(development only)</small></h1><p>Sign in as:</p>
<ul style="list-style:none;padding:0;display:grid;gap:.5rem">${links}</ul>
<style>a{display:block;padding:.75rem 1rem;border:1px solid;border-radius:.5rem;text-decoration:none;color:inherit}small{opacity:.7}</style>`);
    }
    const code = randomBytes(16).toString("hex");
    codes.set(code, {
      user,
      challenge: q.get("code_challenge"),
      nonce: q.get("nonce"),
      clientId: q.get("client_id"),
    });
    const back = new URL(q.get("redirect_uri"));
    back.searchParams.set("code", code);
    if (q.get("state")) back.searchParams.set("state", q.get("state"));
    return res.writeHead(302, { location: back.toString() }).end();
  }
  if (path === "/token" && req.method === "POST") {
    const form = await readForm(req);
    const grant = codes.get(form.get("code"));
    codes.delete(form.get("code"));
    if (!grant) return json(res, 400, { error: "invalid_grant" });
    if (grant.challenge) {
      const got = createHash("sha256")
        .update(form.get("code_verifier") ?? "")
        .digest("base64url");
      if (got !== grant.challenge)
        return json(res, 400, { error: "invalid_grant", error_description: "PKCE check failed" });
    }
    const access = randomBytes(24).toString("hex");
    tokens.set(access, grant.user);
    const now = Math.floor(Date.now() / 1000);
    const idToken = jwt({
      iss: ISSUER,
      aud: grant.clientId,
      iat: now,
      exp: now + 3600,
      nonce: grant.nonce ?? undefined,
      ...profile(grant.user),
    });
    return json(res, 200, {
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      id_token: idToken,
      scope: "openid profile email groups",
    });
  }
  if (path === "/userinfo") {
    const user = tokens.get((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""));
    return user ? json(res, 200, profile(user)) : json(res, 401, { error: "invalid_token" });
  }
  if (path === "/end-session")
    return res
      .writeHead(302, {
        location: url.searchParams.get("post_logout_redirect_uri") ?? "http://localhost:3000/",
      })
      .end();
  json(res, 404, { error: "not_found" });
}).listen(PORT, "127.0.0.1", () => console.log(`mock Authentik (dev only) at ${ISSUER}`));
