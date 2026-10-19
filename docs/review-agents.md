# Review agents

Implementation is staged. The configuration module is available for integration; the portal, new HTTP route and container runner are not yet activated. Existing personal and CI text routes are unchanged.

The private store lives under `APP_DATA_DIR/review/`. `config.json` contains versioned agents, projects and skill references. Project keys are generated once and only their SHA-256 hashes are retained. Public configuration views omit hashes and secret references. `secrets.json` contains versioned GitHub tokens with mode 0600. Tokens are never returned by the portal. Changing a project's repository clears its token unless a replacement is explicitly supplied.

Writes are serialized and files are replaced atomically. Secret versions are written before the config commit point; interrupted saves can leave an unreferenced secret version, never a committed reference to a missing token. Obsolete versions are removed on later mutations. Skill revisions are immutable and content-addressed, so queued job snapshots retain their original instructions, settings and skill contents. Runtime data is private and must not be committed.

Invalid persisted data disables the review store with `review_config_invalid`, rather than overwriting it. The HTTP integration must isolate that failure from the existing personal API. Skills accept bounded text files and a standard `SKILL.md` with simple name/description frontmatter; path traversal, symlinks, binary content and missing metadata are rejected. Multiline YAML metadata is currently unsupported and reports validation failure.

The remaining phases add the owner-only portal, project-scoped async jobs, a tested read-only container runner, deployment documentation, and client migrations for both Slice and CuseSublets. The legacy `/ci/slice/review` endpoint, including Cuse's `full-context-v1` mode, must remain available until both clients have migrated successfully. A review job must pin both source revisions when base-side evidence is needed. Tool access does not replace independent citation or completion checks.

Validation: `npm ci`, `npm test`, `npm run check`. No live configuration or gateway restart is required to exercise the isolated store tests.
