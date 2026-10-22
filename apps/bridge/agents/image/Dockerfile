# hardening/12 (ADR 0031): the one image every agent runs inside. den:install and den:update build it into the rootless
# daemon when this file changes; a CLI bump is a change to the ARG below, and any change here is a risk-check hit.
# The base is the multi-arch index digest of node:22-bookworm-slim, looked up with `docker buildx imagetools inspect` on 2026-10-22.
FROM node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
ARG CLAUDE_CODE_VERSION=2.1.293
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
USER node
WORKDIR /home/node
