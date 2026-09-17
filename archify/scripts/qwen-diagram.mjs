#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const DEFAULT_BASE_URL = process.env.QWEN_BASE_URL || 'http://127.0.0.1:8081/v1';
const DEFAULT_MODEL = process.env.QWEN_MODEL || 'qwen38-code';
const DEFAULT_MAX_SOURCE_BYTES = 180000;
const DEFAULT_MAX_FILES = 80;
const TYPES = new Set(['architecture', 'workflow', 'sequence', 'dataflow', 'lifecycle']);
const SOURCE_EXTENSIONS = new Set([
  '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.java', '.cs', '.go', '.rs', '.rb', '.php',
  '.ps1', '.sh', '.sql', '.yaml', '.yml', '.json', '.toml', '.ini', '.env.example', '.md', '.bicep', '.tf'
]);
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'build', 'coverage', '.next', '.idea', '.vs', 'bin', 'obj']);

function usage(exitCode = 0) {
  console.log(`Usage:
  node scripts/qwen-diagram.mjs --repo <path> --type <type> --prompt <text> [options]

Types:
  architecture | workflow | sequence | dataflow | lifecycle

Options:
  --repo <path>          Repository/code directory to inspect (required)
  --type <type>          Diagram type (default: architecture)
  --prompt <text>        What Qwen should explain or emphasize (required)
  --files <a,b,c>        Only include these repository-relative files
  --output <path>        Output HTML (default: qwen-<type>.html)
  --spec <path>          Output JSON spec (default: qwen-<type>.json)
  --base-url <url>       OpenAI-compatible base URL (default: ${DEFAULT_BASE_URL})
  --model <name>         Model alias (default: ${DEFAULT_MODEL})
  --max-files <n>        Max source files supplied to Qwen (default: ${DEFAULT_MAX_FILES})
  --max-bytes <n>        Max source bytes supplied to Qwen (default: ${DEFAULT_MAX_SOURCE_BYTES})
  --no-deliver           Generate + validate JSON only
  --help                 Show this help

Examples:
  node scripts/qwen-diagram.mjs --repo C:\\AI\\my-app --type architecture --prompt "Show API, workers, databases and external services"
  node scripts/qwen-diagram.mjs --repo C:\\AI\\my-app --files src/api.ts,src/worker.ts --type sequence --prompt "Trace POST /jobs from request to completion"
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { type: 'architecture', deliver: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--no-deliver') { out.deliver = false; continue; }
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    if (arg === '--repo') out.repo = next;
    else if (arg === '--type') out.type = next;
    else if (arg === '--prompt') out.prompt = next;
    else if (arg === '--files') out.files = next.split(',').map((v) => v.trim()).filter(Boolean);
    else if (arg === '--output') out.output = next;
    else if (arg === '--spec') out.spec = next;
    else if (arg === '--base-url') out.baseUrl = next;
    else if (arg === '--model') out.model = next;
    else if (arg === '--max-files') out.maxFiles = Number(next);
    else if (arg === '--max-bytes') out.maxBytes = Number(next);
    else throw new Error(`Unknown argument: ${arg}`);
    i += 1;
  }
  if (!out.repo) throw new Error('--repo is required');
  if (!out.prompt) throw new Error('--prompt is required');
  if (!TYPES.has(out.type)) throw new Error(`Unsupported --type: ${out.type}`);
  out.baseUrl ||= DEFAULT_BASE_URL;
  out.model ||= DEFAULT_MODEL;
  out.maxFiles ||= DEFAULT_MAX_FILES;
  out.maxBytes ||= DEFAULT_MAX_SOURCE_BYTES;
  out.output ||= `qwen-${out.type}.html`;
  out.spec ||= `qwen-${out.type}.json`;
  return out;
}

async function exists(filePath) {
  try { await fs.access(filePath); return true; } catch { return false; }
}

function isSourceFile(name) {
  const lower = name.toLowerCase();
  if (lower === 'dockerfile' || lower === 'makefile') return true;
  if (lower.endsWith('.env.example')) return true;
  return SOURCE_EXTENSIONS.has(path.extname(lower));
}

async function walk(dir, root, acc, maxFiles) {
  if (acc.length >= maxFiles) return;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (acc.length >= maxFiles) break;
    if (entry.name.startsWith('.') && entry.name !== '.env.example') {
      if (entry.isDirectory()) continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) await walk(full, root, acc, maxFiles);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      acc.push(rel);
    }
  }
}

async function collectSources(repo, requestedFiles, maxFiles, maxBytes) {
  const root = path.resolve(repo);
  const selected = [];
  if (requestedFiles?.length) {
    for (const rel of requestedFiles) {
      const safe = rel.replaceAll('\\', '/').replace(/^\.\//, '');
      const full = path.resolve(root, safe);
      if (!full.startsWith(root + path.sep) && full !== root) throw new Error(`File escapes repo: ${rel}`);
      if (!(await exists(full))) throw new Error(`File not found: ${rel}`);
      selected.push(safe);
    }
  } else {
    await walk(root, root, selected, maxFiles);
  }

  let used = 0;
  const blocks = [];
  for (const rel of selected.slice(0, maxFiles)) {
    const full = path.join(root, rel);
    let text;
    try { text = await fs.readFile(full, 'utf8'); } catch { continue; }
    const remaining = maxBytes - used;
    if (remaining <= 0) break;
    if (text.length > remaining) text = text.slice(0, remaining) + '\n/* truncated */';
    used += text.length;
    blocks.push(`===== FILE: ${rel} =====\n${text}`);
  }
  if (!blocks.length) throw new Error('No readable source files found. Use --files to select files explicitly.');
  return { root, blocks, fileCount: blocks.length, bytes: used };
}

async function readArchifyContext(type) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const archifyRoot = path.resolve(here, '..');
  const schemaPath = path.join(archifyRoot, 'schemas', `${type}.schema.json`);
  const commonPath = path.join(archifyRoot, 'schemas', 'common.schema.json');
  const exampleDir = path.join(archifyRoot, 'examples');
  const names = await fs.readdir(exampleDir);
  const exampleName = names.find((name) => name.endsWith(`.${type}.json`));
  if (!exampleName) throw new Error(`No ${type} example found in ${exampleDir}`);
  return {
    archifyRoot,
    schema: await fs.readFile(schemaPath, 'utf8'),
    common: await fs.readFile(commonPath, 'utf8'),
    example: await fs.readFile(path.join(exampleDir, exampleName), 'utf8'),
    exampleName
  };
}

function stripCodeFence(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

async function callQwen(baseUrl, model, prompt) {
  const endpoint = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      max_tokens: 8192,
      messages: [
        {
          role: 'system',
          content: [
            'You are an architecture diagram author.',
            'Return exactly one JSON object that conforms to the supplied Archify schema.',
            'Use only facts supported by the provided source files or the user request.',
            'Every component/state/participant that comes from code should include source path evidence when the schema supports it.',
            'Prefer a clear main path and no more than 12 primary nodes.',
            'Set meta.quality_profile to "showcase".',
            'Do not wrap the JSON in markdown fences and do not add commentary.'
          ].join(' ')
        },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Qwen request failed: ${response.status} ${response.statusText}\n${body}`);
  }
  const payload = await response.json();
  const text = payload?.choices?.[0]?.message?.content;
  if (!text) throw new Error('Qwen returned no message content');
  return text;
}

function runNode(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Command failed (${code}): node ${args.join(' ')}`)));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = await collectSources(args.repo, args.files, args.maxFiles, args.maxBytes);
  const ctx = await readArchifyContext(args.type);
  const prompt = `Create an Archify ${args.type} diagram for this codebase.\n\nUSER GOAL:\n${args.prompt}\n\nRULES:\n- Return valid JSON only.\n- Use fresh IDs and labels; the example is shape guidance only.\n- Do not invent services, protocols, databases, queues, or flows not evidenced by code.\n- Prefer repository-relative source paths in source evidence.\n- Keep the diagram readable and concise.\n\nTYPE SCHEMA:\n${ctx.schema}\n\nCOMMON SCHEMA:\n${ctx.common}\n\nREFERENCE EXAMPLE (${ctx.exampleName}):\n${ctx.example}\n\nSOURCE FILES (${sources.fileCount} files, ${sources.bytes} characters):\n${sources.blocks.join('\n\n')}`;

  console.log(`Calling ${args.model} at ${args.baseUrl}...`);
  console.log(`Supplying ${sources.fileCount} files (${sources.bytes} characters) from ${sources.root}`);
  const raw = await callQwen(args.baseUrl, args.model, prompt);
  const jsonText = stripCodeFence(raw);
  let spec;
  try { spec = JSON.parse(jsonText); } catch (error) {
    await fs.writeFile(`${args.spec}.qwen-response.txt`, raw, 'utf8');
    throw new Error(`Qwen response was not valid JSON. Raw response saved to ${args.spec}.qwen-response.txt\n${error.message}`);
  }
  await fs.writeFile(args.spec, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${args.spec}`);

  await runNode(['bin/archify.mjs', 'validate', args.type, path.resolve(args.spec), '--quality', 'showcase', '--json'], ctx.archifyRoot);
  if (args.deliver) {
    await runNode(['bin/archify.mjs', 'deliver', args.type, path.resolve(args.spec), path.resolve(args.output), '--quality', 'showcase', '--json'], ctx.archifyRoot);
    console.log(`Wrote ${args.output}`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
