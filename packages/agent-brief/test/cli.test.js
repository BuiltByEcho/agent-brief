import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('CLI --min-score exits 3 when repository readiness is below the requested floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-brief-score-'));
  writeFileSync(join(dir, 'README.md'), '# Bare repo\n');

  const result = spawnSync(process.execPath, [cli, dir, '--format', 'json', '--min-score', '100'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 3);
  const brief = JSON.parse(result.stdout);
  assert.ok(brief.score.points < 100);
  assert.match(result.stderr, /readiness score \d+ is below required minimum 100/);
});

test('CLI --min-score keeps the normal exit code when readiness meets the floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-brief-score-pass-'));
  writeFileSync(join(dir, 'README.md'), '# Bare repo\n');

  const result = spawnSync(process.execPath, [cli, dir, '--format', 'json', '--min-score', '0'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.doesNotThrow(() => JSON.parse(result.stdout));
  assert.equal(result.stderr, '');
});
