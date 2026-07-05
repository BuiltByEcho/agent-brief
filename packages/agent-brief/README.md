# agent-brief

Generate a concise, safety-aware project brief for coding agents.

Agents waste a surprising amount of time rediscovering the same basics: What stack is this? Which command runs tests? Is there an AGENTS.md? Are there risky instructions or secret-looking strings in the handoff context?

`agent-brief` turns a repo into a short briefing an agent can read before it starts changing code.

```bash
npx @builtbyecho/agent-brief
```

## What it does

- Finds high-signal files: `AGENTS.md`, `CLAUDE.md`, `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.
- Infers stack and common commands.
- Builds a compact repo map.
- Scans context files for obvious secrets and risky operational instructions.
- Emits Markdown for humans/agents or JSON for automation.

## Fits in the Echo agent toolchain

Use `agent-brief` at the start of a repo task, before an agent spends tokens or edits files. It pairs well with `@builtbyecho/git-digest` for live git state and `agent-runlog` for verified command receipts after the work is done.

For public build logs, this gives the clean "what repo am I in and what should I know first?" layer.

## Refresh smoke

```bash
npm test
npm run smoke
npm pack --dry-run --json
```

## Install

```bash
npm install -g @builtbyecho/agent-brief
agent-brief /path/to/repo
```

Or run without installing:

```bash
npx @builtbyecho/agent-brief /path/to/repo
```

## Usage

```bash
agent-brief [path] [options]
```

Options:

- `--format markdown|json` / `-f` — output format. Default: `markdown`.
- `--max-file-bytes N` — max bytes to read per context file. Default: `12000`.
- `--no-snippets` — omit source snippets.
- `--fail-on-high-risk` — exit `2` if high-severity risk patterns are found.

Examples:

```bash
agent-brief . > AGENT_BRIEF.md
agent-brief ~/dev/my-app --format json
agent-brief . --fail-on-high-risk
```

## Why this exists

The current agent tooling boom has plenty of orchestration, MCP servers, and observability dashboards. The missing small thing is a cheap, local preflight that gives any agent the same crisp project orientation before it spends tokens or touches files.

This is intentionally zero-dependency and boring. It should be safe to run in almost any repo.

## Library API

```js
import { generateBrief, formatMarkdown } from '@builtbyecho/agent-brief';

const brief = generateBrief(process.cwd());
console.log(formatMarkdown(brief));
```

## Notes on risk scanning

This is not a full secret scanner. It catches common token/private-key/secret-assignment patterns in the context files most likely to be pasted into agents. Use a dedicated scanner like Gitleaks or TruffleHog for full repository security reviews.

## License

MIT

## Release Automation

This package is published from GitHub Actions using npm Trusted Publishing with provenance. Releases are built on GitHub-hosted runners and no long-lived npm publish token is required.
