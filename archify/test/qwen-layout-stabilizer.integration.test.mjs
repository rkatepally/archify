import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stabilizeArchitectureLayout } from '../scripts/qwen-layout-stabilizer.mjs';

const archifyRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function qandaFixture() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'qanda-yt Architecture', subtitle: 'YouTube to Anki & Quiz via Local & Cloud LLMs', quality_profile: 'showcase' },
    components: [
      { id: 'streamlit_app', type: 'frontend', label: 'Streamlit App', sublabel: 'Entry Point & UI', pos: [50, 100], size: [180, 80] },
      { id: 'youtube_ingestion', type: 'backend', label: 'YouTube Ingestion', sublabel: 'Transcript & Channel Discovery', pos: [300, 100], size: [180, 80] },
      { id: 'llm_engine', type: 'backend', label: 'LLM Engine', sublabel: 'Study Pack Generation', pos: [550, 100], size: [180, 80] },
      { id: 'quiz_scoring', type: 'backend', label: 'Quiz Scoring', sublabel: 'Answer Validation', pos: [800, 100], size: [180, 80] },
      { id: 'anki_export', type: 'backend', label: 'Anki Export', sublabel: '.apkg Package Builder', pos: [1050, 100], size: [180, 80] },
      { id: 'local_llm', type: 'external', label: 'Local LLM', sublabel: 'llama.cpp / Qwen3.8', pos: [300, 300], size: [180, 80] },
      { id: 'cloud_llms', type: 'external', label: 'Cloud LLMs', sublabel: 'OpenAI, Anthropic, OpenRouter', pos: [550, 300], size: [180, 80] },
      { id: 'cli_providers', type: 'external', label: 'CLI Providers', sublabel: 'Claude Code, Codex CLI', pos: [800, 300], size: [180, 80] },
      { id: 'local_storage', type: 'database', label: 'Local Storage', sublabel: 'JSON State & Benchmarks', pos: [550, 500], size: [180, 80] },
      { id: 'youtube_api', type: 'external', label: 'YouTube API', sublabel: 'Subtitles & Metadata', pos: [50, 300], size: [180, 80] }
    ],
    connections: [
      { id: 'app_to_ingestion', from: 'streamlit_app', to: 'youtube_ingestion', label: 'URL Input', variant: 'emphasis' },
      { id: 'ingestion_to_llm', from: 'youtube_ingestion', to: 'llm_engine', label: 'Transcript' },
      { id: 'llm_to_quiz', from: 'llm_engine', to: 'quiz_scoring', label: 'Quiz Data' },
      { id: 'llm_to_anki', from: 'llm_engine', to: 'anki_export', label: 'Flashcards', labelAt: [890, 194], fromSide: 'top', toSide: 'top', via: [[640, 76], [1140, 76]] },
      { id: 'ingestion_to_yt_api', from: 'youtube_ingestion', to: 'youtube_api', label: 'Fetch Subtitles', fromSide: 'bottom', toSide: 'top' },
      { id: 'llm_to_local', from: 'llm_engine', to: 'local_llm', label: 'Local Inference', labelAt: [451, 230], fromSide: 'left', toSide: 'right', via: [[526, 140], [526, 340]] },
      { id: 'llm_to_cloud', from: 'llm_engine', to: 'cloud_llms', label: 'API Calls', fromSide: 'bottom', toSide: 'top', labelAt: [685.6, 194] },
      { id: 'llm_to_cli', from: 'llm_engine', to: 'cli_providers', label: 'Subprocess', fromSide: 'bottom', toSide: 'top' },
      { id: 'ingestion_to_storage', from: 'youtube_ingestion', to: 'local_storage', label: 'Channel State', fromSide: 'right', toSide: 'right', labelAt: [568.2, 394], via: [[504, 140], [504, 540]] },
      { id: 'llm_to_storage', from: 'llm_engine', to: 'local_storage', label: 'Iteration Data', fromSide: 'left', toSide: 'left', labelAt: [554.6, 420], via: [[520, 140], [520, 540]] }
    ]
  };
}

function runArchify(args) {
  return spawnSync(process.execPath, ['bin/archify.mjs', ...args], {
    cwd: archifyRoot,
    encoding: 'utf8'
  });
}

test('stabilized qanda-yt regression passes real Archify showcase validation and delivery', () => {
  const spec = qandaFixture();
  const stabilized = stabilizeArchitectureLayout(spec);
  assert.equal(stabilized.changed, true, stabilized.reason);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-qwen-layout-'));
  const input = path.join(tempDir, 'qanda-yt.architecture.json');
  const output = path.join(tempDir, 'qanda-yt.architecture.html');
  fs.writeFileSync(input, JSON.stringify(spec, null, 2) + '\n', 'utf8');

  const validation = runArchify(['validate', 'architecture', input, '--quality', 'showcase', '--json']);
  assert.equal(validation.status, 0, validation.stdout + '\n' + validation.stderr);
  const validationReceipt = JSON.parse(validation.stdout);
  assert.equal(validationReceipt.ok, true);

  const delivery = runArchify(['deliver', 'architecture', input, output, '--quality', 'showcase', '--json']);
  assert.equal(delivery.status, 0, delivery.stdout + '\n' + delivery.stderr);
  const deliveryReceipt = JSON.parse(delivery.stdout);
  assert.equal(deliveryReceipt.ok, true);
  assert.equal(fs.existsSync(output), true);
});
