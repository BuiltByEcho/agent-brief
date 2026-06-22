#!/usr/bin/env node
import { resolve } from 'node:path';
import { generateBrief, formatJson, formatMarkdown, writeBundle } from './index.js';

function parseArgs(argv) {
  const args = { path: '.', format: 'markdown', maxFileBytes: 12000, noSnippets: false, failOnHighRisk: false, diffRef: null, bundleDir: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--format' || arg === '-f') args.format = argv[++i];
    else if (arg === '--max-file-bytes') args.maxFileBytes = Number(argv[++i]);
    else if (arg === '--no-snippets') args.noSnippets = true;
    else if (arg === '--fail-on-high-risk') args.failOnHighRisk = true;
    else if (arg === '--diff') args.diffRef = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'HEAD';
    else if (arg === '--bundle') args.bundleDir = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '.agent-brief';
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
      --diff [ref]             Include changed files vs ref (default: HEAD)
      --bundle [dir]           Write brief.md, brief.json, and verification.md (default: .agent-brief)
      --fail-on-high-risk      Exit 2 if high-severity risk patterns are found
  -h, --help                   Show help

Examples:
  npx repo-agent-brief
  agent-brief ~/dev/my-app --format json
  agent-brief . --diff origin/main
  agent-brief . --diff HEAD --bundle
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
  const brief = generateBrief(resolve(args.path), {
    maxFileBytes: args.maxFileBytes,
    includeSnippets: !args.noSnippets,
    diffRef: args.diffRef
  });
  if (args.bundleDir) {
    const files = writeBundle(resolve(args.path), brief, args.bundleDir);
    console.log(`Agent brief bundle written:
- Markdown: ${files.markdown}
- JSON: ${files.json}
- Verification: ${files.verification}`);
  } else {
    console.log(args.format === 'json' ? formatJson(brief) : formatMarkdown(brief));
  }
  if (args.failOnHighRisk && brief.risks.some(r => r.severity === 'high')) process.exit(2);
} catch (error) {
  console.error(`agent-brief: ${error.message}`);
  process.exit(1);
}
