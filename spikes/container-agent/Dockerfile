# hardening/05 spike: one Claude CLI agent per container. Throwaway.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl && rm -rf /var/lib/apt/lists/*
RUN npm install -g @anthropic-ai/claude-code@2.1.293 && npm cache clean --force
USER node
WORKDIR /home/node
