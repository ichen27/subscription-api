Reviewed head `aa1a5a86b1e2e1945d2b5f6d7a8eb96e0706af34` against base `79bced08790fb7a5abdbeaab7b5a59db83c2f260`.

This PR changes only docs and examples. I checked its claims against the head source. They all match: the \`/ci/review\` request fields \(agent, repository, commit, optional base, messages, response\_format\); the required \`Prefer: respond-async\` header; the 640 KB body and 400K-character limits; the legacy full-context-v1 limits \(3 MB, 2M characters, 900 s\); the 60–600 s agent time limit and 10–100 tool-step limit; the 28 s internal shutdown deadline, which fits the 30 s grace period the docs recommend; the env names REVIEW\_IMAGE\_DIGEST, DOCKER\_BIN and CI\_REVIEW\_KEY\_FILE; the pinned CLI 2.1.301 in sandbox/Dockerfile; and the image digest in both smoke evidence files. Every file the docs link to exists. The one gap is low severity: the artifact index lists the offline sandbox evidence but not the new live evidence file that README and validation.md rely on.

**LOW: Artifact index omits the live acceptance evidence it now depends on**

[Source line](https://github.com/ichen27/subscription-api/blob/aa1a5a86b1e2e1945d2b5f6d7a8eb96e0706af34/docs/artifacts.md#L14)

The index adds only smoke-offline.json and warns that it has no completed inference. README and validation.md now say live acceptance passed, citing docs/review-agents/smoke-live.json, but that file is missing from the index. So anyone using the artifact index \(which README links to\) finds only the offline evidence, which does not support the acceptance claim. Add a row for review-agents/smoke-live.json \(mode \`live\`\).

Evidence: \| \[Offline sandbox evidence\]\(review-agents/smoke-offline.json\) \| Docker isolation and CLI startup checks; no completed inference \| JSON; check \`mode\` before interpreting \`completed\` \|

This advisory review does not replace tests or human judgment.