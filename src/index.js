import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_IGNORES = new Set([
  '.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.cache',
  'vendor', 'target', '__pycache__', '.venv', 'venv', '.idea', '.vscode'
]);

const CONTEXT_FILES = [
  'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'CURSOR.md', '.cursorrules',
  'README.md', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod',
  'Makefile', 'justfile', 'docker-compose.yml', 'compose.yml'
];

const SECRET_PATTERNS = [
  [/\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/g, 'possible API token'],
  [/\b[A-Za-z0-9_]*(?:SECRET|TOKEN|API_KEY|PRIVATE_KEY|PASSWORD)[A-Za-z0-9_]*\s*=\s*['\"][^'\"]{8,}['\"]/gi, 'secret-looking assignment'],
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g, 'private key block']
];

const RISKY_TEXT = [
  [/\brm\s+-rf\b/i, 'destructive rm -rf instruction'],
  [/\bsudo\b/i, 'sudo/elevated command mentioned'],
  [/\bcurl\b[^\n|;&]+\|\s*(?:sh|bash)\b/i, 'curl pipe-to-shell pattern'],
  [/\bchmod\s+777\b/i, 'chmod 777 pattern'],
  [/\bdisable\s+(?:safety|guardrails?|checks?)\b/i, 'instruction to disable safety/checks']
];

export function generateBrief(root = process.cwd(), options = {}) {
  const opts = {
    maxFileBytes: 12_000,
    maxTreeEntries: 120,
    includeSnippets: true,
    ...options
  };
  const absRoot = root;
  const project = basename(absRoot);
  const context = collectContext(absRoot, opts);
  const tree = collectTree(absRoot, opts.maxTreeEntries);
  const packageInfo = readPackage(absRoot);
  const git = readGit(absRoot);
  const risks = scanRisks(absRoot, context.files);
  const commands = inferCommands(absRoot, packageInfo);
  const stack = inferStack(absRoot, packageInfo);
  const score = scoreRepo({ context, commands, risks });

  return {
    generatedAt: new Date().toISOString(),
    project,
    root: absRoot,
    score,
    git,
    stack,
    commands,
    contextFiles: context.files,
    tree,
    risks,
    recommendations: recommendations({ context, commands, risks, packageInfo })
  };
}

export function formatMarkdown(brief) {
  const lines = [];
  lines.push(`# Agent Brief: ${brief.project}`);
  lines.push('');
  lines.push(`Generated: ${brief.generatedAt}`);
  lines.push(`Readiness: **${brief.score.grade}** (${brief.score.points}/100)`);
  if (brief.git.branch || brief.git.status) lines.push(`Git: ${brief.git.branch || 'unknown'}${brief.git.status ? ` — ${brief.git.status}` : ''}`);
  lines.push('');

  lines.push('## Stack');
  lines.push(brief.stack.length ? brief.stack.map(s => `- ${s}`).join('\n') : '- Unknown / mixed');
  lines.push('');

  lines.push('## High-signal commands');
  if (brief.commands.length) {
    for (const cmd of brief.commands) lines.push(`- ${cmd.name}: \`${cmd.command}\`${cmd.source ? ` (${cmd.source})` : ''}`);
  } else {
    lines.push('- No obvious build/test/lint commands found.');
  }
  lines.push('');

  lines.push('## Agent context files');
  if (brief.contextFiles.length) {
    for (const file of brief.contextFiles) {
      lines.push(`### ${file.path}`);
      lines.push(`- ${file.bytes} bytes${file.truncated ? ' (truncated)' : ''}`);
      if (file.summary.length) lines.push(...file.summary.map(s => `- ${s}`));
      if (file.snippet) {
        lines.push('');
        lines.push('```');
        lines.push(file.snippet.trim());
        lines.push('```');
      }
      lines.push('');
    }
  } else {
    lines.push('- No AGENTS.md/README/package metadata found. Add an AGENTS.md for better agent handoff.');
    lines.push('');
  }

  lines.push('## Repo map');
  lines.push('```text');
  lines.push(brief.tree.join('\n') || '(empty)');
  lines.push('```');
  lines.push('');

  lines.push('## Risk scan');
  if (brief.risks.length) {
    for (const risk of brief.risks) lines.push(`- [${risk.severity}] ${risk.path}: ${risk.message}`);
  } else {
    lines.push('- No obvious secret/risky-instruction patterns found in scanned context files.');
  }
  lines.push('');

  lines.push('## Recommendations');
  for (const rec of brief.recommendations) lines.push(`- ${rec}`);
  lines.push('');
  return lines.join('\n');
}

export function formatJson(brief) {
  return JSON.stringify(brief, null, 2);
}

function collectContext(root, opts) {
  const files = [];
  for (const name of CONTEXT_FILES) {
    const path = join(root, name);
    if (!existsSync(path) || !statSync(path).isFile()) continue;
    const raw = readFileSync(path, 'utf8');
    const truncated = Buffer.byteLength(raw) > opts.maxFileBytes;
    const text = truncated ? raw.slice(0, opts.maxFileBytes) : raw;
    files.push({
      path: name,
      bytes: Buffer.byteLength(raw),
      truncated,
      summary: summarizeText(text),
      snippet: opts.includeSnippets ? firstUsefulLines(text, 24) : ''
    });
  }
  return { files };
}

function collectTree(root, maxEntries) {
  const out = [];
  walk(root, '', 0);
  return out;

  function walk(base, prefix, depth) {
    if (out.length >= maxEntries || depth > 3) return;
    let entries = [];
    try { entries = readdirSync(base, { withFileTypes: true }); } catch { return; }
    entries = entries
      .filter(e => !DEFAULT_IGNORES.has(e.name) && !e.name.startsWith('.DS_Store'))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (out.length >= maxEntries) break;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      out.push(`${'  '.repeat(depth)}${entry.isDirectory() ? '📁' : '📄'} ${rel}`);
      if (entry.isDirectory()) walk(join(base, entry.name), rel, depth + 1);
    }
  }
}

function readPackage(root) {
  const path = join(root, 'package.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function readGit(root) {
  const git = { branch: '', status: '' };
  try { git.branch = execFileSync('git', ['-C', root, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
  try {
    const status = execFileSync('git', ['-C', root, 'status', '--short'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    git.status = status ? `${status.split('\n').length} changed file(s)` : 'clean';
  } catch {}
  return git;
}

function inferCommands(root, pkg) {
  const commands = [];
  if (pkg?.scripts) {
    for (const key of ['dev', 'test', 'lint', 'typecheck', 'build', 'start']) {
      if (pkg.scripts[key]) commands.push({ name: key, command: `npm run ${key}`, source: 'package.json' });
    }
  }
  if (existsSync(join(root, 'Makefile'))) commands.push({ name: 'make', command: 'make', source: 'Makefile' });
  if (existsSync(join(root, 'pyproject.toml'))) commands.push({ name: 'python tests', command: 'pytest', source: 'pyproject.toml' });
  if (existsSync(join(root, 'Cargo.toml'))) commands.push({ name: 'rust tests', command: 'cargo test', source: 'Cargo.toml' });
  if (existsSync(join(root, 'go.mod'))) commands.push({ name: 'go tests', command: 'go test ./...', source: 'go.mod' });
  return dedupe(commands, c => c.command);
}

function inferStack(root, pkg) {
  const stack = [];
  if (pkg) {
    stack.push('Node.js package');
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) stack.push('Next.js');
    if (deps.react) stack.push('React');
    if (deps.typescript) stack.push('TypeScript');
    if (deps.vite) stack.push('Vite');
    if (pkg.bin) stack.push('CLI tool');
  }
  if (existsSync(join(root, 'pyproject.toml'))) stack.push('Python');
  if (existsSync(join(root, 'Cargo.toml'))) stack.push('Rust');
  if (existsSync(join(root, 'go.mod'))) stack.push('Go');
  if (existsSync(join(root, 'docker-compose.yml')) || existsSync(join(root, 'compose.yml'))) stack.push('Docker Compose');
  return dedupe(stack, s => s);
}

function scanRisks(root, files) {
  const risks = [];
  for (const file of files) {
    const path = join(root, file.path);
    let text = '';
    try { text = readFileSync(path, 'utf8'); } catch { continue; }
    for (const [pattern, message] of SECRET_PATTERNS) {
      if (pattern.test(text)) risks.push({ severity: 'high', path: file.path, message });
      pattern.lastIndex = 0;
    }
    for (const [pattern, message] of RISKY_TEXT) {
      if (pattern.test(text)) risks.push({ severity: 'medium', path: file.path, message });
      pattern.lastIndex = 0;
    }
  }
  return risks;
}

function scoreRepo({ context, commands, risks }) {
  let points = 50;
  if (context.files.some(f => f.path === 'AGENTS.md')) points += 20;
  if (context.files.some(f => f.path === 'README.md')) points += 10;
  if (commands.some(c => c.name.includes('test') || c.name === 'test')) points += 10;
  if (commands.some(c => c.name === 'lint' || c.name === 'typecheck')) points += 5;
  points -= risks.filter(r => r.severity === 'high').length * 20;
  points -= risks.filter(r => r.severity === 'medium').length * 8;
  points = Math.max(0, Math.min(100, points));
  const grade = points >= 85 ? 'excellent' : points >= 70 ? 'good' : points >= 50 ? 'usable' : 'needs work';
  return { points, grade };
}

function recommendations({ context, commands, risks, packageInfo }) {
  const recs = [];
  if (!context.files.some(f => f.path === 'AGENTS.md')) recs.push('Add AGENTS.md with project rules, safe commands, and test gates for coding agents.');
  if (!commands.some(c => c.name === 'test' || c.name.includes('tests'))) recs.push('Expose one obvious test command so agents can verify changes before finalizing.');
  if (!commands.some(c => c.name === 'lint' || c.name === 'typecheck')) recs.push('Expose lint/typecheck commands for fast feedback.');
  if (risks.some(r => r.severity === 'high')) recs.push('Review high-severity risk matches before sharing this repo with external agents.');
  if (packageInfo && !packageInfo.repository) recs.push('Add package.json repository metadata for easier agent/source navigation.');
  if (!recs.length) recs.push('Looks agent-friendly. Keep context files concise and commands current.');
  return recs;
}

function summarizeText(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => /^(#|[-*]\s|"(?:name|description|scripts)"\s*:)/.test(line))
    .slice(0, 8)
    .map(line => line.replace(/^#+\s*/, '').slice(0, 160));
}

function firstUsefulLines(text, maxLines) {
  return text
    .split('\n')
    .filter(line => line.trim().length > 0)
    .slice(0, maxLines)
    .join('\n')
    .slice(0, 2000);
}

function dedupe(items, keyFn) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyFn(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
