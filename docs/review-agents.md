# Review agents

Implementation is staged. The owner portal at `/reviews` manages configuration; the new CI route and container runner are not yet activated. Existing personal and CI text routes are unchanged.

The private store lives under `APP_DATA_DIR/review/`. `config.json` contains versioned agents, projects and skill references. Project keys are generated once and only their SHA-256 hashes are retained. Public configuration views omit hashes and secret references. `secrets.json` contains versioned GitHub tokens with mode 0600. Tokens are never returned by the portal. Changing a project's repository clears its token unless a replacement is explicitly supplied.

Writes are serialized and files are replaced atomically. Secret versions are written before the config commit point; interrupted saves can leave an unreferenced secret version, never a committed reference to a missing token. Obsolete versions are removed on later mutations. Skill revisions are immutable and content-addressed, so queued job snapshots retain their original instructions, settings and skill contents. Runtime data is private and must not be committed.

Invalid persisted data disables the review store with `review_config_invalid`, rather than overwriting it. The HTTP integration must isolate that failure from the existing personal API. Skills accept bounded text files and a standard `SKILL.md` with simple name/description frontmatter; path traversal, symlinks, binary content and missing metadata are rejected. Multiline YAML metadata is currently unsupported and reports validation failure.

The remaining phases add the owner-only portal, project-scoped async jobs, a tested read-only container runner, deployment documentation, and client migrations for both Slice and CuseSublets. The legacy `/ci/slice/review` endpoint, including Cuse's `full-context-v1` mode, must remain available until both clients have migrated successfully. A review job must pin both source revisions when base-side evidence is needed. Tool access does not replace independent citation or completion checks.

Validation: `npm ci`, `npm test`, `npm run check`. No live configuration or gateway restart is required to exercise the isolated store tests.

## Owner portal

Open **Manage review agents** from the dashboard through the authenticated owner launcher. Ordinary gateway keys and project keys cannot access management APIs. All mutations require the exact browser Origin. Skills accept pasted SKILL.md or bounded ZIP files; encrypted entries, links, traversal, invalid UTF-8, binary content and over-limit expansion are rejected before storage.

Create skills, then agents, then projects. Choose allowed agents per project, and use a fine-grained GitHub token with Contents: read on that repository for private source. Leave the token blank during edits to retain it, or select Remove saved token. Changing repositories clears the token unless a replacement is supplied. Project creation and rotation return a key once; copy it into CI secrets before dismissing it. Rotation immediately revokes the old key.

Desktop and mobile demo screenshots use synthetic project data: [agents](review-agents/portal-agents.png), [projects on mobile](review-agents/portal-projects-mobile.png). Browser validation exercised agent editing/saving, tab switching, and a 390px layout without horizontal overflow. HTTP tests cover access boundaries, reference deletion, rotation and secret redaction.
