import pino from "pino";

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
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

