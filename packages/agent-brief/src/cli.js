#!/usr/bin/env node
import { resolve } from 'node:path';
import { generateBrief, formatJson, formatMarkdown } from './index.js';

function parseArgs(argv) {
  const args = { path: '.', format: 'markdown', maxFileBytes: 12000, noSnippets: false, failOnHighRisk: false, minScore: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--format' || arg === '-f') args.format = argv[++i];
    else if (arg === '--max-file-bytes') args.maxFileBytes = Number(argv[++i]);
    else if (arg === '--no-snippets') args.noSnippets = true;
    else if (arg === '--fail-on-high-risk') args.failOnHighRisk = true;
    else if (arg === '--min-score') args.minScore = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (!arg.startsWith('-')) args.path = arg;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
}

function help() {
  return `agent-brief — generate concise, safety-aware project briefs for coding agents

Usage:
  agent-brief [path] [options]

Options:
  -f, --format markdown|json   Output format (default: markdown)
      --max-file-bytes N       Max bytes to read per context file (default: 12000)
      --no-snippets            Omit context snippets from output
      --fail-on-high-risk      Exit 2 if high-severity risk patterns are found
      --min-score N            Exit 3 if readiness score is below N (0-100)
  -h, --help                   Show help

Examples:
  npx @builtbyecho/agent-brief
  agent-brief ~/dev/my-app --format json
  agent-brief . --fail-on-high-risk > AGENT_BRIEF.md
`;
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(help());
    process.exit(0);
  }
  if (!['markdown', 'json'].includes(args.format)) throw new Error('--format must be markdown or json');
  if (args.minScore !== null && (!Number.isInteger(args.minScore) || args.minScore < 0 || args.minScore > 100)) {
    throw new Error('--min-score must be an integer from 0 to 100');
  }
  const brief = generateBrief(resolve(args.path), {
    maxFileBytes: args.maxFileBytes,
    includeSnippets: !args.noSnippets
  });
  console.log(args.format === 'json' ? formatJson(brief) : formatMarkdown(brief));
  if (args.failOnHighRisk && brief.risks.some(r => r.severity === 'high')) process.exit(2);
  if (args.minScore !== null && brief.score.points < args.minScore) {
    console.error(`agent-brief: readiness score ${brief.score.points} is below required minimum ${args.minScore}`);
    process.exit(3);
  }
} catch (error) {
  console.error(`agent-brief: ${error.message}`);
  process.exit(1);
}
