import pino from "pino";

function parseBool(value: string | undefined): boolean {
  if (!value) return false;
  return /^(1|true|yes|on)$/i.test(value.trim());
}

const nodeEnv = (process.env.NODE_ENV ?? "development").trim();
const devLogRequested = parseBool(process.env.RELAY_DEV_LOG);
const devLogForce = parseBool(process.env.RELAY_DEV_LOG_FORCE);
const devLogEnabled = devLogRequested && (nodeEnv !== "production" || devLogForce);
const defaultLevel = devLogEnabled ? "debug" : "info";

export const logger = pino({
  level: process.env.LOG_LEVEL || defaultLevel,
  redact: {
    paths: [
      "RELAY_TOKEN",
      "*.RELAY_TOKEN",
      "OPENCLAW_GATEWAY_TOKEN",
      "*.OPENCLAW_GATEWAY_TOKEN",
      "Authorization",
      "*.Authorization",
      "headers.authorization",
      "*.headers.authorization",
      "token",
      "*.token",
      "password",
      "*.password",
      "privateKey",
      "*.privateKey",
      "deviceToken",
      "*.deviceToken",
      "signature",
      "*.signature",
    ],
    remove: true,
  },
});

