# Subscription API

Canonical repository: `ichen27/subscription-api`. Development runs on the Mac mini SSD; resolve its path through `/Volumes/SamsungSSD1/project-registry.json`.

- Read README.md before changing API behavior; its compatibility limits are intentional.
- HTTP/auth belongs in `src/server.mjs`; provider adaptation in `src/providers.mjs`; child lifetime and environment in `src/process.mjs`. Keep these boundaries and the dependency-free Node design.
- Preserve subscription-only authentication. Never add an automatic paid-API fallback. Credentials and runtime data stay outside Git.
- Keep managed agent tools, MCP, hooks, and inherited customization disabled for text requests. Recheck flags against installed CLI help when upgrading.
- Run `npm ci`, `npm test`, and `npm run check`. Changes to provider adapters require a harmless live request through each available subscription; report any unavailable provider explicitly.
- Use feature branches, push commits, open and review a PR, and wait for current-revision CI before merging within the authorized scope. Document external branch protection if unavailable.
- For launcher registration, service restart, domain configuration, or data relocation, read `docs/deployment.md` and the launcher's `docs/agent-deploy.md` first. Preserve unrelated launcher apps and the stopped historical messaging routers.
- For public release, resolve redistribution licensing and replace machine-specific manifest paths. The existing LICENSE reserves rights while private.
