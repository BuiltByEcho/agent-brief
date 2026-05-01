import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateBrief, formatMarkdown, formatJson } from '../src/index.js';

test('generates a useful brief for a node repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-brief-'));
  writeFileSync(join(dir, 'AGENTS.md'), '# Rules\n- Run tests before final answer\n');
  writeFileSync(join(dir, 'README.md'), '# Demo\n');
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' }, dependencies: { react: '^19.0.0' }, bin: { demo: 'cli.js' } }, null, 2));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'index.js'), 'export {};\n');

  const brief = generateBrief(dir, { includeSnippets: false });
  assert.equal(brief.project.startsWith('agent-brief-'), true);
  assert.ok(brief.stack.includes('Node.js package'));
  assert.ok(brief.stack.includes('React'));
  assert.ok(brief.commands.some(c => c.command === 'npm run test'));
  assert.ok(brief.contextFiles.some(f => f.path === 'AGENTS.md'));
  assert.equal(brief.risks.length, 0);
  assert.match(formatMarkdown(brief), /Agent Brief/);
  assert.doesNotThrow(() => JSON.parse(formatJson(brief)));
});

test('flags high risk secret-looking assignments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-brief-risk-'));
  writeFileSync(join(dir, 'README.md'), 'API_TOKEN="super-secret-token-value"\n');
  const brief = generateBrief(dir, { includeSnippets: false });
  assert.ok(brief.risks.some(r => r.severity === 'high'));
});
