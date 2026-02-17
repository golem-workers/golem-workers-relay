FROM node:22-bookworm-slim

# `openclaw` may pull git-based deps; slim image doesn't ship git.
RUN apt-get update && \
  apt-get install -y --no-install-recommends git ca-certificates && \
  rm -rf /var/lib/apt/lists/*

# Install OpenClaw CLI/Gateway from npm.
RUN npm install -g openclaw@latest && npm cache clean --force

USER node
WORKDIR /home/node

ENTRYPOINT ["openclaw"]

