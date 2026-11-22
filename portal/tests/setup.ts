// Runs before each test file, before anything imports @/env or @/lib/db.
Object.assign(process.env, {
  APP_URL: "http://localhost:3000",
  APP_NAME: "MACS",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgresql://unused:unused@127.0.0.1:1/unused",
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-test",
  AUTHENTIK_ISSUER: "http://localhost:9000/application/o/macs/",
  AUTHENTIK_CLIENT_ID: "test",
  AUTHENTIK_CLIENT_SECRET: "test",
  ADMIN_GROUPS: "admins",
  MEMBER_GROUPS: "",
  LOG_LEVEL: "error",
});
