import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeArchitectureLayout, inspectArchitectureGeometry } from './qwen-layout-stabilizer.mjs';

function fixture() {
  return {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'qanda-yt Architecture', quality_profile: 'showcase' },
    components: [
      { id: 'streamlit_app', type: 'frontend', label: 'Streamlit App', sources: [{ path: 'app.py' }], pos: [50, 100], size: [180, 80] },
      { id: 'youtube_ingestion', type: 'backend', label: 'YouTube Ingestion', sources: [{ path: 'qanda_yt/youtube.py' }], pos: [300, 100], size: [180, 80] },
      { id: 'llm_engine', type: 'backend', label: 'LLM Engine', sources: [{ path: 'qanda_yt/llm.py' }], pos: [550, 100], size: [180, 80] },
      { id: 'quiz_scoring', type: 'backend', label: 'Quiz Scoring', pos: [800, 100], size: [180, 80] },
      { id: 'anki_export', type: 'backend', label: 'Anki Export', pos: [1050, 100], size: [180, 80] },
      { id: 'local_llm', type: 'external', label: 'Local LLM', pos: [300, 300], size: [180, 80] },
      { id: 'cloud_llms', type: 'external', label: 'Cloud LLMs', pos: [550, 300], size: [180, 80] },
      { id: 'cli_providers', type: 'external', label: 'CLI Providers', pos: [800, 300], size: [180, 80] },
      { id: 'local_storage', type: 'database', label: 'Local Storage', pos: [550, 500], size: [180, 80] },
      { id: 'youtube_api', type: 'external', label: 'YouTube API', pos: [50, 300], size: [180, 80] },
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
      { id: 'llm_to_storage', from: 'llm_engine', to: 'local_storage', label: 'Iteration Data', fromSide: 'left', toSide: 'left', labelAt: [554.6, 420], via: [[520, 140], [520, 540]] },
    ],
  };
}

function semantics(spec) {
  return {
    components: spec.components.map(({ id, type, label, sources, pos, size }) => ({ id, type, label, sources, pos, size })),
    connections: spec.connections.map(({ id, from, to, label, variant }) => ({ id, from, to, label, variant })),
  };
}

test('global stabilizer produces a geometry-clean qanda-yt layout without changing semantics', () => {
  const spec = fixture();
  const before = semantics(spec);
  const result = stabilizeArchitectureLayout(spec);
  assert.equal(result.changed, true, result.reason);
  assert.equal(result.routed, spec.connections.length);
  assert.deepEqual(semantics(spec), before);
  const inspection = inspectArchitectureGeometry(spec);
  assert.equal(inspection.ok, true, JSON.stringify(inspection.issues, null, 2));
});

test('stabilizer is deterministic and idempotent', () => {
  const first = fixture();
  const second = fixture();
  stabilizeArchitectureLayout(first);
  stabilizeArchitectureLayout(second);
  assert.deepEqual(first, second);
  const firstJson = JSON.stringify(first);
  stabilizeArchitectureLayout(first);
  assert.equal(JSON.stringify(first), firstJson);
});

test('global stabilizer routes around an unrelated central obstacle', () => {
  const spec = {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'obstacle', quality_profile: 'showcase' },
    components: [
      { id: 'a', type: 'backend', label: 'A', pos: [100, 100], size: [120, 60] },
      { id: 'block', type: 'external', label: 'Block', pos: [100, 250], size: [120, 60] },
      { id: 'b', type: 'database', label: 'B', pos: [100, 400], size: [120, 60] },
      { id: 'c', type: 'frontend', label: 'C', pos: [350, 100], size: [120, 60] },
    ],
    connections: [
      { id: 'a_b', from: 'a', to: 'b', label: 'data' },
      { id: 'c_block', from: 'c', to: 'block', label: 'call' },
    ],
  };
  const result = stabilizeArchitectureLayout(spec);
  assert.equal(result.changed, true, result.reason);
  const inspection = inspectArchitectureGeometry(spec);
  assert.equal(inspection.ok, true, JSON.stringify(inspection.issues, null, 2));
});

test('unsupported grid layout is skipped rather than corrupted', () => {
  const spec = {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: { title: 'grid', quality_profile: 'showcase' },
    components: [
      { id: 'a', type: 'backend', label: 'A', row: 0, col: 0 },
      { id: 'b', type: 'backend', label: 'B', row: 0, col: 1 },
    ],
    connections: [{ id: 'a_b', from: 'a', to: 'b', label: 'call' }],
  };
  const before = JSON.stringify(spec);
  const result = stabilizeArchitectureLayout(spec);
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'unsupported-layout');
  assert.equal(JSON.stringify(spec), before);
});
