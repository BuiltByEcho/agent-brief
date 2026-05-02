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
  const diff = opts.diffRef ? collectDiff(absRoot, opts.diffRef) : null;
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
    diff,
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

  if (brief.diff) {
    lines.push(`## Git diff vs ${brief.diff.ref}`);
    if (brief.diff.available) {
      lines.push(`- ${brief.diff.files.length} changed file(s), +${brief.diff.insertions} -${brief.diff.deletions}`);
      if (brief.diff.files.length) {
        for (const file of brief.diff.files) {
          lines.push(`- ${file.status} ${file.path}${file.additions || file.deletions ? ` (+${file.additions}/-${file.deletions})` : ''}${file.risky ? ' ⚠️' : ''}`);
        }
      }
      if (brief.diff.riskNotes.length) {
        lines.push('');
        lines.push(...brief.diff.riskNotes.map(note => `- ⚠️ ${note}`));
      }
    } else {
      lines.push(`- Diff unavailable: ${brief.diff.error}`);
    }
    lines.push('');
  }

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

function collectDiff(root, ref) {
  const diff = { ref, available: false, files: [], insertions: 0, deletions: 0, riskNotes: [], error: '' };
  try {
    const numstat = execFileSync('git', ['-C', root, 'diff', '--numstat', ref, '--'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const nameStatus = execFileSync('git', ['-C', root, 'diff', '--name-status', ref, '--'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const status = execFileSync('git', ['-C', root, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    diff.available = true;
    const byPath = new Map();
    for (const line of numstat ? numstat.split('\n') : []) {
      const parts = line.split('\t');
      if (parts.length >= 3 && /^(?:\d+|-)$/.test(parts[0]) && /^(?:\d+|-)$/.test(parts[1])) {
        const additions = parts[0] === '-' ? 0 : Number(parts[0]);
        const deletions = parts[1] === '-' ? 0 : Number(parts[1]);
        const path = parts.slice(2).join('\t');
        const entry = byPath.get(path) || { path, status: 'M', additions: 0, deletions: 0, risky: false };
        entry.additions += additions;
        entry.deletions += deletions;
        byPath.set(path, entry);
        diff.insertions += additions;
        diff.deletions += deletions;
      }
    }
    for (const line of nameStatus ? nameStatus.split('\n') : []) {
      const parts = line.split('\t');
      if (parts.length >= 2 && /^[A-Z]/.test(parts[0])) {
        const status = parts[0];
        const path = parts[parts.length - 1];
        const entry = byPath.get(path) || { path, status, additions: 0, deletions: 0, risky: false };
        entry.status = status;
        byPath.set(path, entry);
      }
    }
    for (const line of status ? status.split('\n') : []) {
      if (!line.startsWith('?? ')) continue;
      const path = line.slice(3).trim();
      for (const filePath of expandUntracked(root, path)) {
        if (!byPath.has(filePath)) byPath.set(filePath, { path: filePath, status: '??', additions: 0, deletions: 0, risky: false });
      }
    }
    diff.files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of diff.files) {
      file.risky = isRiskyChangedPath(file.path);
      if (file.risky) diff.riskNotes.push(`${file.path} is a high-impact path; inspect carefully before handing changes to an agent.`);
    }
  } catch (error) {
    diff.error = error.message;
  }
  return diff;
}

function expandUntracked(root, path) {
  const fullPath = join(root, path);
  try {
    const stat = statSync(fullPath);
    if (!stat.isDirectory()) return [path];
    const out = [];
    walkUntracked(fullPath, path, out);
    return out;
  } catch {
    return [path];
  }
}

function walkUntracked(base, prefix, out) {
  let entries = [];
  try { entries = readdirSync(base, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (DEFAULT_IGNORES.has(entry.name)) continue;
    const rel = `${prefix.replace(/\/$/, '')}/${entry.name}`;
    if (entry.isDirectory()) walkUntracked(join(base, entry.name), rel, out);
    else out.push(rel);
  }
}

function isRiskyChangedPath(path) {
  return /(^|\/)(\.env|\.npmrc|\.pypirc|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(path)
    || /(^|\/)\.github\/workflows\//i.test(path)
    || /(^|\/)(migrations?|supabase|terraform|infra|deploy|scripts?)\//i.test(path);
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
