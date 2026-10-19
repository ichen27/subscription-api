FROM node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS builder
ARG CLAUDE_VERSION=2.1.301
RUN npm install --prefix /opt/claude --omit=dev --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_VERSION} \
    && cp /opt/claude/node_modules/@anthropic-ai/claude-code/bin/claude.exe /opt/claude-bin
FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e
COPY --from=builder /opt/claude-bin /usr/local/bin/claude
COPY src/egress-proxy.mjs /opt/review/egress-proxy.mjs
COPY sandbox/managed-settings.json /etc/claude-code/managed-settings.json
USER 10001:10001
ENV HOME=/home/reviewer
WORKDIR /workspace
ENTRYPOINT ["/usr/local/bin/claude"]
