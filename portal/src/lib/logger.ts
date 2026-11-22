import pino from "pino";

/**
 * JSON logs to stdout (collected by Loki). Log the Authentik user id, never
 * email or tokens; the redact list is a safety net, not a licence.
 */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { service: process.env.APP_NAME ?? "ma-app" },
  redact: {
    paths: [
      "*.password",
      "*.token",
      "*.accessToken",
      "*.refreshToken",
      "*.authorization",
      "headers.authorization",
      "headers.cookie",
      "*.email",
    ],
    censor: "[redacted]",
  },
});
