# hardening/12 (ADR 0031): the one image every agent runs inside. den:install and den:update build it into the rootless
# daemon when this file changes; a CLI bump is a change to the ARG below, and any change here is a risk-check hit.
# The base is the multi-arch index digest of node:22-bookworm-slim, looked up with `docker buildx imagetools inspect` on 2026-10-22.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG CLAUDE_CODE_VERSION=2.1.293
# trust-ladder/02: Chromium for the browser verifier (apps/ci-cd/verify-ui.mjs). PW_CHROMIUM_PATH points Playwright at it, so a run in a container needs no browser on the host.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl chromium fonts-liberation && rm -rf /var/lib/apt/lists/*
ENV PW_CHROMIUM_PATH=/usr/bin/chromium
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
USER node
WORKDIR /home/node
