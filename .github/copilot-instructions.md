# Copilot Instructions for ABAP FS

This is the VS Code extension that mounts a SAP system as a virtual filesystem and ships its own MCP
server. Full contributor guide: [CONTRIBUTING.md](../CONTRIBUTING.md). The Hard Rules below are the
source-of-truth ruleset every contribution must follow.

## Project shape

- Monorepo: `client/` (the VS Code extension), `server/` (language server — completions, CDS,
  syntax), and `modules/` (`abapObject`, `abapfs`, `sharedapi`).
- Build with `npm run build`, test with `npm run test`, format with `npm run format`.
- The extension only ever talks to the user's own SAP system — treat any other network target as a
  bug.

## Hard Rules

These are the rules that get a PR rejected. Source of truth: [CONTRIBUTING.md](../CONTRIBUTING.md) —
if anything here drifts, CONTRIBUTING.md wins.

- **No dynamic imports** — no `import()` or `require()` at runtime. Everything must be statically
  analyzable so webpack can bundle it.
- **No external network calls** — the extension talks to the user's SAP system and nowhere else.
  No calls to external services.
- **No semicolons, double quotes, trailing commas off, 100-char line width** — Prettier config
  lives in [.prettierrc.json](../.prettierrc.json); don't fight it.
- **TypeScript strict mode; no `any`** without a genuinely good reason ("it was easier" is not one).
- **Run `npm run format`** (Prettier) before committing — it is NOT run automatically on build.
- **CI must pass on Node 24** — `npm run build` and `npm run test` must be green.
- **Commands need `"category": "ABAP FS"`** in `package.json`; do NOT repeat "ABAP FS:" in the
  command title.
- **Never commit scratch files** — AI session notes/plans, debug logs, SAP hostnames or passwords,
  `node_modules`, stray `.bat`/`.ps1`. Review your diff file by file; update `.gitignore` if needed.
- **One focused PR per change**, plain commit messages (no `feat(scope):` prefixes, no emoji), and
  create a changeset with `npx changeset`.
- **Update `docs/` for feature changes**; never edit the auto-generated `DOCUMENTATION.md` directly.
- **New Language Model tools**: add the `abap-fs` tag to the registration if the tool should also be
  exposed via the MCP server.
- **Prefer early returns and short functions**; user-facing error messages must be actionable
  ("Authentication failed — check your credentials", not "HTTP 401").
