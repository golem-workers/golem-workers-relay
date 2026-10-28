FROM node:24.22.1-bookworm-slim

# `openclaw` may pull git-based deps; slim image doesn't ship git.
RUN apt-get update && \
  apt-get install -y --no-install-recommends git ca-certificates && \
  rm -rf /var/lib/apt/lists/*

# Install OpenClaw CLI/Gateway from npm.
ARG OPENCLAW_VERSION
RUN test -n "$OPENCLAW_VERSION" && npm install -g "openclaw@${OPENCLAW_VERSION}" && npm cache clean --force

USER node
WORKDIR /home/node

ENTRYPOINT ["openclaw"]

