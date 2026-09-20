#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';

const DEFAULT_BASE_URL = process.env.QWEN_BASE_URL || 'http://127.0.0.1:8081/v1';
const DEFAULT_MODEL = process.env.QWEN_MODEL || 'qwen38-code';
const DEFAULT_MAX_SOURCE_BYTES = 100000;
const DEFAULT_MAX_FILES = 40;
const MAX_LAYOUT_REPAIR_ROUNDS = 3;
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
  --repair-existing      Skip Qwen; repair/validate the existing --spec JSON
  --no-deliver           Generate + validate JSON only
  --help                 Show this help

Examples:
  node scripts/qwen-diagram.mjs --repo C:\\AI\\my-app --type architecture --prompt "Show API, workers, databases and external services"
  node scripts/qwen-diagram.mjs --repo C:\\AI\\my-app --files src/api.ts,src/worker.ts --type sequence --prompt "Trace POST /jobs from request to completion"
  node scripts/qwen-diagram.mjs --repo C:\\AI\\my-app --type architecture --repair-existing --spec C:\\AI\\my-app-architecture.json --output C:\\AI\\my-app-architecture.html
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const out = { type: 'architecture', deliver: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') usage(0);
    if (arg === '--no-deliver') { out.deliver = false; continue; }
    if (arg === '--repair-existing') { out.repairExisting = true; continue; }
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
  if (!out.repairExisting && !out.prompt) throw new Error('--prompt is required unless --repair-existing is used');
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

function runCapture(command, args, cwd) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = (stderr || error.message || '').trim();
        reject(new Error(detail || `${command} ${args.join(' ')} failed`));
        return;
      }
      resolve(stdout.trim());
    });
  });
}

function normalizeRepositoryUrl(origin) {
  const value = origin.trim();
  const githubSsh = value.match(/^git@github\.com:(.+?)(?:\.git)?$/i);
  if (githubSsh) return { url: `https://github.com/${githubSsh[1].replace(/\.git$/i, '')}`, provider: 'github' };

  const giteeSsh = value.match(/^git@gitee\.com:(.+?)(?:\.git)?$/i);
  if (giteeSsh) return { url: `https://gitee.com/${giteeSsh[1].replace(/\.git$/i, '')}`, provider: 'gitee' };

  if (/^https?:\/\/github\.com\//i.test(value)) {
    return { url: value.replace(/\.git\/?$/i, '').replace(/\/$/, ''), provider: 'github' };
  }
  if (/^https?:\/\/gitee\.com\//i.test(value)) {
    return { url: value.replace(/\.git\/?$/i, '').replace(/\/$/, ''), provider: 'gitee' };
  }

  if (/^(?:https?:\/\/|ssh:\/\/|git@[^:]+:)/i.test(value)) {
    return { url: value, link_mode: 'local-only' };
  }

  throw new Error(`Unsupported git remote.origin.url for Archify source evidence: ${value}`);
}

async function readRepositoryEvidence(repo) {
  let revision;
  let origin;
  try {
    revision = await runCapture('git', ['rev-parse', 'HEAD'], repo);
    origin = await runCapture('git', ['config', '--get', 'remote.origin.url'], repo);
  } catch (error) {
    throw new Error(
      `Architecture diagrams with source evidence require --repo to be a Git checkout with remote.origin.url. ` +
      `Repository: ${repo}\nGit error: ${error.message}`
    );
  }

  if (!/^[a-f0-9]{40}$/i.test(revision)) {
    throw new Error(`Expected a full 40-character Git revision, received: ${revision}`);
  }
  if (!origin) {
    throw new Error('Git remote.origin.url is empty. Add an origin remote before generating an architecture diagram with source evidence.');
  }

  const identity = normalizeRepositoryUrl(origin);
  let dirty = false;
  try { dirty = Boolean(await runCapture('git', ['status', '--porcelain'], repo)); } catch { /* best-effort warning only */ }

  return {
    meta: { ...identity, revision },
    dirty
  };
}

function runGitShow(repo, revision, relPath) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['show', `${revision}:${relPath}`],
      { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr || error.message || '').trim();
          reject(new Error(detail || `git show failed for ${relPath}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function pinnedLineCount(text) {
  if (!text) return 0;
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const parts = normalized.split('\n');
  if (parts.at(-1) === '') parts.pop();
  return parts.length;
}

function normalizeEvidencePath(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split('/');
  if (parts.some((part) => part === '..' || part === '')) return null;
  return normalized;
}

async function sanitizeArchitectureEvidence(spec, repo, revision) {
  if (!Array.isArray(spec?.components)) return { repaired: 0, dropped: 0 };
  let repaired = 0;
  let dropped = 0;

  for (const component of spec.components) {
    if (!Array.isArray(component?.sources)) continue;
    const verified = [];

    for (const source of component.sources) {
      const relPath = normalizeEvidencePath(source?.path);
      if (!relPath) {
        dropped += 1;
        console.warn(`Evidence repair: dropped invalid source path on component ${component.id || component.label || '<unknown>'}`);
        continue;
      }

      let pinnedText;
      try {
        pinnedText = await runGitShow(repo, revision, relPath);
      } catch {
        dropped += 1;
        console.warn(`Evidence repair: dropped ${relPath} from ${component.id || component.label || '<unknown>'}; file is not present at pinned revision ${revision.slice(0, 12)}`);
        continue;
      }

      const clean = { ...source, path: relPath };
      const lineCount = pinnedLineCount(pinnedText);
      const lineValid = Number.isInteger(clean.line) && clean.line >= 1 && clean.line <= lineCount;
      if (clean.line !== undefined && !lineValid) {
        console.warn(`Evidence repair: ${component.id || component.label || '<unknown>'} ${relPath} requested line ${clean.line}, but pinned file has ${lineCount} lines; keeping file-level evidence instead.`);
        delete clean.line;
        delete clean.end_line;
        repaired += 1;
      } else if (clean.line === undefined && clean.end_line !== undefined) {
        delete clean.end_line;
        repaired += 1;
      } else if (clean.end_line !== undefined && (!Number.isInteger(clean.end_line) || clean.end_line < clean.line || clean.end_line > lineCount)) {
        console.warn(`Evidence repair: removed invalid end_line ${clean.end_line} for ${relPath}; pinned file has ${lineCount} lines.`);
        delete clean.end_line;
        repaired += 1;
      }

      verified.push(clean);
    }

    if (verified.length) component.sources = verified.slice(0, 3);
    else delete component.sources;
  }

  return { repaired, dropped };
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

function runNodeCapture(args, cwd) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      args,
      { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (Number.isInteger(error.code) ? error.code : 1) : 0,
          stdout: stdout || '',
          stderr: stderr || ''
        });
      }
    );
  });
}

function parseReceipt(stdout) {
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return null;
  }
}

function findArchitectureConnection(spec, diagnostic, fallbackLabel) {
  if (!Array.isArray(spec?.connections)) return null;
  const subject = diagnostic?.subject || {};

  if (subject.id) {
    const byId = spec.connections.find((connection) => connection?.id === subject.id);
    if (byId) return byId;
  }
  if (Number.isInteger(subject.index) && spec.connections[subject.index]) {
    return spec.connections[subject.index];
  }
  if (fallbackLabel) {
    const matches = spec.connections.filter((connection) => connection?.label === fallbackLabel);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function setConnectionLabelAt(connection, labelAt) {
  connection.labelAt = labelAt.map((value) => Math.round(value * 10) / 10);
  delete connection.labelDx;
  delete connection.labelDy;
  delete connection.labelSegment;
}

function applyArchitectureRepairs(spec, diagnostics = []) {
  if (!Array.isArray(spec?.connections)) return 0;
  let repaired = 0;
  const touchedConnections = new Set();

  // Highest confidence: use the validator's exact suggested labelAt.
  for (const diagnostic of diagnostics) {
    if (diagnostic?.code !== 'layout/constraint') continue;
    const message = diagnostic?.message || '';
    const labelMatch = message.match(/Label\s+"([^"]+)"/i);
    const pointMatch = message.match(/Suggested fix:\s*labelAt\s*\[\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\]/i);
    if (!labelMatch || !pointMatch) continue;

    const label = labelMatch[1];
    const connection = findArchitectureConnection(spec, diagnostic, label);
    if (!connection || touchedConnections.has(connection)) continue;

    const labelAt = [Number(pointMatch[1]), Number(pointMatch[2])];
    setConnectionLabelAt(connection, labelAt);
    touchedConnections.add(connection);
    repaired += 1;
    console.log(`Layout repair: moved label "${label}" to [${labelAt.join(', ')}] using validator suggestion.`);
  }

  // Showcase label-to-route clearance has structured geometry evidence.
  for (const diagnostic of diagnostics) {
    if (diagnostic?.code !== 'composition/label-route-clearance') continue;
    const evidence = diagnostic?.evidence || {};
    const label = evidence.label || '';
    const connection = findArchitectureConnection(spec, diagnostic, label);
    if (!connection || touchedConnections.has(connection)) continue;

    const rect = evidence.labelRect;
    const from = evidence.from;
    const to = evidence.to;
    if (!rect || !Array.isArray(from) || !Array.isArray(to)
        || ![rect.x, rect.y, rect.width, rect.height, ...from, ...to].every(Number.isFinite)) continue;

    const current = [rect.x + rect.width / 2, rect.y + 10];
    const threshold = Number.isFinite(evidence.minimumPx) ? evidence.minimumPx : 4;
    const padding = threshold + 8;
    const dx = Math.abs(to[0] - from[0]);
    const dy = Math.abs(to[1] - from[1]);
    let labelAt;

    if (dy > dx * 2) {
      const routeX = from[0];
      const direction = current[0] >= routeX ? 1 : -1;
      labelAt = [routeX + direction * (rect.width / 2 + padding), current[1]];
    } else if (dx > dy * 2) {
      const routeY = from[1];
      const direction = current[1] >= routeY ? 1 : -1;
      labelAt = [current[0], routeY + direction * (rect.height + padding)];
    } else {
      continue;
    }

    setConnectionLabelAt(connection, labelAt);
    touchedConnections.add(connection);
    repaired += 1;
    console.log(`Layout repair: moved label "${label || connection.label || connection.id || '<unnamed>'}" away from a conflicting route to [${connection.labelAt.join(', ')}].`);
  }

  // An explicit undersized viewBox defeats Archify's built-in auto-fit. If the
  // validator reports overflow, remove only that authored bound and let the
  // renderer compute a viewBox from the actual components/boundaries.
  const outsideViewBox = diagnostics.some((diagnostic) =>
    diagnostic?.code === 'layout/constraint'
    && /outside the viewBox/i.test(diagnostic?.message || '')
  );
  if (outsideViewBox && Array.isArray(spec?.meta?.viewBox)) {
    const old = spec.meta.viewBox;
    delete spec.meta.viewBox;
    repaired += 1;
    console.log(`Layout repair: removed undersized viewBox ${old.join('x')} so Archify can auto-fit the diagram.`);
  }

  return repaired;
}

async function validateWithRepairs({ type, spec, specPath, repoRootArgs, archifyRoot }) {
  const validationArgs = [
    'bin/archify.mjs',
    'validate',
    type,
    path.resolve(specPath),
    '--quality',
    'showcase',
    '--json',
    ...repoRootArgs
  ];

  for (let round = 0; round <= MAX_LAYOUT_REPAIR_ROUNDS; round += 1) {
    const result = await runNodeCapture(validationArgs, archifyRoot);
    if (result.code === 0) {
      if (result.stdout.trim()) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
      return;
    }

    const receipt = parseReceipt(result.stdout);
    const repairs = type === 'architecture'
      ? applyArchitectureRepairs(spec, receipt?.diagnostics)
      : 0;

    if (repairs > 0 && round < MAX_LAYOUT_REPAIR_ROUNDS) {
      await fs.writeFile(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
      console.log(`Layout auto-repair round ${round + 1}: applied ${repairs} fix(es), revalidating...`);
      continue;
    }

    if (result.stderr.trim()) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : `${result.stderr}\n`);
    if (result.stdout.trim()) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : `${result.stdout}\n`);
    throw new Error(`Archify validation failed after ${round} auto-repair round(s).`);
  }

  throw new Error(`Archify validation still failed after ${MAX_LAYOUT_REPAIR_ROUNDS} auto-repair rounds.`);
}

async function repairExistingSpec(args) {
  const repoRoot = path.resolve(args.repo);
  const ctx = await readArchifyContext(args.type);
  if (!(await exists(args.spec))) throw new Error(`Existing spec not found: ${args.spec}`);

  let spec;
  try {
    spec = JSON.parse(await fs.readFile(args.spec, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read existing spec ${args.spec}: ${error.message}`);
  }
  if (spec?.diagram_type && spec.diagram_type !== args.type) {
    throw new Error(`Existing spec diagram_type is "${spec.diagram_type}", but --type is "${args.type}".`);
  }

  const repositoryEvidence = args.type === 'architecture' ? await readRepositoryEvidence(repoRoot) : null;
  if (repositoryEvidence) {
    spec.meta ||= {};
    spec.meta.repository = repositoryEvidence.meta;
    const evidenceResult = await sanitizeArchitectureEvidence(
      spec,
      repoRoot,
      repositoryEvidence.meta.revision
    );
    if (evidenceResult.repaired || evidenceResult.dropped) {
      console.log(`Repository evidence normalized: ${evidenceResult.repaired} repaired, ${evidenceResult.dropped} dropped.`);
    }
  }

  await fs.writeFile(args.spec, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  console.log(`Repairing existing spec ${args.spec} without calling Qwen.`);

  const repoRootArgs = repositoryEvidence ? ['--repo-root', repoRoot] : [];
  await validateWithRepairs({
    type: args.type,
    spec,
    specPath: args.spec,
    repoRootArgs,
    archifyRoot: ctx.archifyRoot
  });

  if (args.deliver) {
    await runNode(['bin/archify.mjs', 'deliver', args.type, path.resolve(args.spec), path.resolve(args.output), '--quality', 'showcase', '--json', ...repoRootArgs], ctx.archifyRoot);
    console.log(`Wrote ${args.output}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.repairExisting) {
    await repairExistingSpec(args);
    return;
  }

  const sources = await collectSources(args.repo, args.files, args.maxFiles, args.maxBytes);
  const repositoryEvidence = args.type === 'architecture' ? await readRepositoryEvidence(sources.root) : null;
  const ctx = await readArchifyContext(args.type);
  const repositoryRule = repositoryEvidence
    ? `\n- Set meta.repository exactly to this verified value: ${JSON.stringify(repositoryEvidence.meta)}.\n- Attach component sources only to repository-relative paths that actually appear in the supplied source files.\n- Prefer file-level source evidence with only "path". Do not guess "line" or "end_line"; include line numbers only when they are explicitly known from the supplied evidence.`
    : '';
  const prompt = `Create an Archify ${args.type} diagram for this codebase.\n\nUSER GOAL:\n${args.prompt}\n\nRULES:\n- Return valid JSON only.\n- Use fresh IDs and labels; the example is shape guidance only.\n- Do not invent services, protocols, databases, queues, or flows not evidenced by code.\n- Prefer repository-relative source paths in source evidence.\n- Keep the diagram readable and concise.${repositoryRule}\n\nTYPE SCHEMA:\n${ctx.schema}\n\nCOMMON SCHEMA:\n${ctx.common}\n\nREFERENCE EXAMPLE (${ctx.exampleName}):\n${ctx.example}\n\nSOURCE FILES (${sources.fileCount} files, ${sources.bytes} characters):\n${sources.blocks.join('\n\n')}`;

  console.log(`Calling ${args.model} at ${args.baseUrl}...`);
  console.log(`Supplying ${sources.fileCount} files (${sources.bytes} characters) from ${sources.root}`);
  if (repositoryEvidence) {
    console.log(`Repository evidence: ${repositoryEvidence.meta.url} @ ${repositoryEvidence.meta.revision}`);
    if (repositoryEvidence.dirty) {
      console.warn('WARNING: The target repository has uncommitted changes. Source links are pinned to HEAD, while Qwen reads the current working tree.');
    }
  }
  const raw = await callQwen(args.baseUrl, args.model, prompt);
  const jsonText = stripCodeFence(raw);
  let spec;
  try { spec = JSON.parse(jsonText); } catch (error) {
    await fs.writeFile(`${args.spec}.qwen-response.txt`, raw, 'utf8');
    throw new Error(`Qwen response was not valid JSON. Raw response saved to ${args.spec}.qwen-response.txt\n${error.message}`);
  }
  if (repositoryEvidence) {
    spec.meta ||= {};
    spec.meta.repository = repositoryEvidence.meta;
    const evidenceResult = await sanitizeArchitectureEvidence(
      spec,
      sources.root,
      repositoryEvidence.meta.revision
    );
    if (evidenceResult.repaired || evidenceResult.dropped) {
      console.log(`Repository evidence normalized: ${evidenceResult.repaired} repaired, ${evidenceResult.dropped} dropped.`);
    }
  }

  await fs.writeFile(args.spec, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${args.spec}`);

  const repoRootArgs = repositoryEvidence ? ['--repo-root', sources.root] : [];
  await validateWithRepairs({
    type: args.type,
    spec,
    specPath: args.spec,
    repoRootArgs,
    archifyRoot: ctx.archifyRoot
  });
  if (args.deliver) {
    await runNode(['bin/archify.mjs', 'deliver', args.type, path.resolve(args.spec), path.resolve(args.output), '--quality', 'showcase', '--json', ...repoRootArgs], ctx.archifyRoot);
    console.log(`Wrote ${args.output}`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
});
