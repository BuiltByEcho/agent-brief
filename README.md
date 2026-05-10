# agent-brief

Generate a concise, safety-aware project brief for coding agents.

Agents waste a surprising amount of time rediscovering the same basics: What stack is this? Which command runs tests? Is there an AGENTS.md? Are there risky instructions or secret-looking strings in the handoff context?

`agent-brief` turns a repo into a short briefing an agent can read before it starts changing code.

```bash
npx repo-agent-brief
```

## What it does

- Finds high-signal files: `AGENTS.md`, `CLAUDE.md`, `README.md`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.
- Infers stack and common commands.
- Builds a compact repo map.
- Suggests a prioritized verification plan (`must` / `should` / `optional`) from detected scripts, risks, and changed files.
- Optionally summarizes the current git diff so agents can start from “what changed?” instead of rereading the whole repo.
- Scans context files for obvious secrets and risky operational instructions.
- Emits Markdown for humans/agents or JSON for automation.

## Install

```bash
npm install -g repo-agent-brief
agent-brief /path/to/repo
```

Or run without installing:

```bash
npx repo-agent-brief /path/to/repo
```

## Usage

```bash
agent-brief [path] [options]
```

Options:

- `--format markdown|json` / `-f` — output format. Default: `markdown`.
- `--max-file-bytes N` — max bytes to read per context file. Default: `12000`.
- `--no-snippets` — omit source snippets.
- `--diff [ref]` — include changed files, insertions/deletions, and high-impact path warnings versus a git ref. Defaults to `HEAD` when no ref is provided.
- `--bundle [dir]` — write a durable handoff bundle with `brief.md`, `brief.json`, and `verification.md`. Default: `.agent-brief`.
- `--fail-on-high-risk` — exit `2` if high-severity risk patterns are found.

Examples:

```bash
agent-brief . > AGENT_BRIEF.md
agent-brief ~/dev/my-app --format json
agent-brief . --diff origin/main
agent-brief . --diff HEAD --bundle
agent-brief . --fail-on-high-risk
```

## Diff-aware handoffs

When you are handing an in-progress branch to an agent, run:

```bash
agent-brief . --diff origin/main > AGENT_HANDOFF.md
```

The brief adds a `Git diff` section with changed paths, line counts, and warnings for high-impact files such as GitHub Actions workflows, deploy scripts, migrations, Docker Compose files, and lockfiles. This keeps the first agent turn grounded in the actual patch instead of a vague repo overview.

## Verification plans

Every brief now includes a `Suggested verification plan` section. It turns discovered scripts plus patch context into a short checklist an agent can follow before finalizing:

```markdown
## Suggested verification plan
- [must] Run type checks for changed code paths — `npm run typecheck`
- [should] Run lint for fast static feedback — `npm run lint`
- [must] Run the primary test suite before final handoff — `npm run test`
```

If you pass `--diff`, the plan gets sharper: docs-only changes downgrade expensive checks, source changes promote tests/typechecks, and CI/deploy/infra/lockfile changes add a manual high-impact-path review. If no test/lint/build commands are found, the plan calls that gap out plainly so the agent does not pretend verification happened.

## Handoff bundles

For longer-running work, use `--bundle` to leave a stable artifact another agent or human can inspect later:

```bash
agent-brief . --diff HEAD --bundle
```

This writes:

- `.agent-brief/brief.md` — the full human-readable project brief.
- `.agent-brief/brief.json` — the same data for automation.
- `.agent-brief/verification.md` — a focused checklist of the exact checks the next agent should run or document.

Use a custom directory when you want to attach the bundle to a ticket, run log, or CI artifact:

```bash
agent-brief . --diff origin/main --bundle artifacts/agent-brief
```

## Why this exists

The current agent tooling boom has plenty of orchestration, MCP servers, and observability dashboards. The missing small thing is a cheap, local preflight that gives any agent the same crisp project orientation before it spends tokens or touches files.

This is intentionally zero-dependency and boring. It should be safe to run in almost any repo.

## Library API

```js
import { generateBrief, formatMarkdown } from 'repo-agent-brief';

const brief = generateBrief(process.cwd(), { diffRef: 'origin/main' });
console.log(formatMarkdown(brief));
```

## Notes on risk scanning

This is not a full secret scanner. It catches common token/private-key/secret-assignment patterns in the context files most likely to be pasted into agents. Use a dedicated scanner like Gitleaks or TruffleHog for full repository security reviews.

## License

MIT

## Agent Skill

This package includes an OpenClaw/Claude-style skill at `skills/repo-agent-brief` that teaches agents to run repo preflight and diff-aware handoff briefs before editing or reviewing code.
