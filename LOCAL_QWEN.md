# Local Qwen + Archify

Use your local Qwen model to inspect source code, generate an Archify JSON specification, validate it, and render a standalone HTML diagram.

This repo now includes `archify/scripts/qwen-diagram.mjs`, which talks to an OpenAI-compatible endpoint such as `llama.cpp`.

## Defaults for your local setup

The script defaults to:

- Base URL: `http://127.0.0.1:8081/v1`
- Model alias: `qwen38-code`
- Diagram quality: `showcase`
- Source limit: 40 files / 100,000 source characters (safer default for a 64K local context)

Those defaults match a llama.cpp server exposing your Qwen model as `qwen38-code`.

Verify the server first from PowerShell:

```powershell
Invoke-RestMethod http://127.0.0.1:8081/v1/models
```

You should see `qwen38-code` in the returned models.

## Clone and install

```powershell
Set-Location C:\AI
git clone https://github.com/rkatepally/archify.git
Set-Location C:\AI\archify\archify
npm install
```

If you already cloned the repo:

```powershell
Set-Location C:\AI\archify
git checkout main
git pull origin main
Set-Location .\archify
npm install
```

## 1. Generate an architecture diagram from a repository

Point `--repo` at the codebase you want Qwen to inspect:

```powershell
Set-Location C:\AI\archify\archify

npm run qwen:diagram -- `
  --repo C:\AI\qanda-yt `
  --type architecture `
  --prompt "Show the application entry points, API layer, LLM integration, transcript/caption flow, storage and external dependencies. Only include components supported by the code." `
  --spec C:\AI\qanda-yt-architecture.json `
  --output C:\AI\qanda-yt-architecture.html
```

Result:

- `C:\AI\qanda-yt-architecture.json` - Qwen-generated Archify specification
- `C:\AI\qanda-yt-architecture.html` - validated standalone diagram

For architecture diagrams, the script now reads the target repository's `remote.origin.url` and full Git `HEAD` revision, injects those values into `meta.repository`, and passes `--repo-root` to Archify validation and delivery. This is required when Qwen attaches `components[].sources` evidence.

Open the HTML file in a browser.

## 2. Point Qwen at specific files

Use `--files` when you know the important code paths. Paths are relative to `--repo`.

```powershell
npm run qwen:diagram -- `
  --repo C:\AI\qanda-yt `
  --files "app.py,src\youtube.py,src\llm.py,src\quiz.py" `
  --type architecture `
  --prompt "Explain how a YouTube URL becomes captions, LLM context and a generated quiz. Include source-file evidence on diagram components where the schema supports it." `
  --output C:\AI\qanda-yt-focused.html
```

This is the best mode when you want the generated diagram to stay tightly grounded in code rather than scanning the whole repository.

## 3. Generate a sequence diagram for one code path

Example: trace an API request through code.

```powershell
npm run qwen:diagram -- `
  --repo C:\AI\my-app `
  --files "src\api.ts,src\jobs.ts,src\worker.ts,src\db.ts" `
  --type sequence `
  --prompt "Trace POST /jobs from the HTTP request through validation, persistence, queueing, worker execution and final status update. Preserve actual function names and protocols from the code." `
  --output C:\AI\job-request-sequence.html
```

## 4. Generate a data-flow diagram

```powershell
npm run qwen:diagram -- `
  --repo "Z:\Tactical Review Project" `
  --type dataflow `
  --prompt "Show how source documents move through ingestion, embeddings, concepts, wiki entries, entities and relations. Use only storage systems and processing stages visible in the repository." `
  --output "Z:\Tactical Review Project\knowledge-flow.html"
```

## 5. Generate a workflow diagram

```powershell
npm run qwen:diagram -- `
  --repo C:\AI\powerbi-dax-review `
  --type workflow `
  --prompt "Show the end-to-end DAX review workflow from selecting model files through analysis, findings, recommendations and output artifacts. Show decision points only when they exist in code." `
  --output C:\AI\powerbi-dax-review-workflow.html
```

## 6. Generate a lifecycle diagram

```powershell
npm run qwen:diagram -- `
  --repo C:\AI\my-agent `
  --files "src\agent.ts,src\state.ts,src\retry.ts" `
  --type lifecycle `
  --prompt "Show the agent run lifecycle including queued, running, tool-call, retry, success and failure states, but only if those states are implemented in code." `
  --output C:\AI\agent-lifecycle.html
```

## Change the Qwen endpoint or model

Command-line override:

```powershell
npm run qwen:diagram -- `
  --repo C:\AI\my-app `
  --type architecture `
  --prompt "Create a code-grounded architecture diagram" `
  --base-url http://127.0.0.1:8081/v1 `
  --model qwen38-code
```

Or set environment variables once in the current PowerShell session:

```powershell
$env:QWEN_BASE_URL = "http://127.0.0.1:8081/v1"
$env:QWEN_MODEL = "qwen38-code"
```

## Control context size

For a large repository, reduce the source supplied to Qwen:

```powershell
npm run qwen:diagram -- `
  --repo C:\AI\large-repo `
  --type architecture `
  --prompt "Show the main service architecture" `
  --max-files 40 `
  --max-bytes 120000
```

For the highest-quality result, prefer `--files` over simply increasing context size. Give Qwen the entry points, configuration, service clients, data-access code and orchestration files that actually establish the architecture.

## Generate JSON without rendering

Useful while refining prompts:

```powershell
npm run qwen:diagram -- `
  --repo C:\AI\my-app `
  --type architecture `
  --prompt "Show the core runtime architecture" `
  --no-deliver
```

The script still runs Archify validation. It skips only final HTML delivery.

## Recommended prompt pattern

Use prompts like this:

```text
Create a code-grounded architecture diagram.

Focus on:
- application entry points
- major runtime components
- LLM/model calls
- databases, files, queues and caches
- external APIs
- important protocols or request flows

Rules:
- use exact code identifiers where useful
- do not invent components
- collapse utility/helper files into their owning component
- keep the main diagram under 12 primary nodes
- attach repository-relative source paths where the Archify schema supports evidence
```

## How the integration works

`qwen-diagram.mjs` performs four steps:

1. Reads either selected files (`--files`) or a bounded set of source files under `--repo`.
2. Loads the matching Archify JSON schema plus one existing example.
3. Sends the code, schema and your prompt to local Qwen through `/v1/chat/completions`.
4. Writes the JSON, runs `archify validate`, then runs `archify deliver` to create the standalone HTML.

The existing Archify renderer remains unchanged. Qwen is used only as the code-understanding and JSON-authoring layer.


## Troubleshooting repository evidence

If an older version fails validation with a message similar to:

```text
add the pinned repository metadata or remove component sources
```

update Archify first:

```powershell
Set-Location C:\AI\archify
git checkout main
git pull origin main
Set-Location .\archify
```

Then confirm the repository you are diagramming is a Git checkout with an origin and a commit:

```powershell
Set-Location C:\AI\qanda-yt
git remote get-url origin
git rev-parse HEAD
```

The revision should be a 40-character commit SHA. The Qwen driver uses these values automatically; you do not need to add `meta.repository` by hand.

If the target repository has uncommitted changes, the command prints a warning because Qwen reads the working tree while Archify source links are pinned to the current `HEAD` commit.


### Invalid source line evidence

If Qwen names a real file but invents a line number that does not exist at the pinned revision, older versions fail with diagnostics such as:

```text
requestedLine: 50
lineCount: 12
use a line range that exists at the pinned revision
```

The Qwen driver now verifies architecture `components[].sources` against the pinned Git commit before Archify validation. Invalid line/end-line values are removed and the valid file-level `path` evidence is retained. Source paths that do not exist at the pinned revision are dropped instead of being passed to Archify.


## Automatic layout repair

Architecture generation now performs up to three deterministic validation-repair rounds for connection-label overlap diagnostics. When Archify reports a concrete suggested `labelAt [x,y]` position, the Qwen driver applies that exact validator suggestion, rewrites the JSON specification, and validates again before stopping.

Typical console output:

```text
Layout repair: moved label "Cards & MCQs" to [890, 414].
Layout repair: moved label "Persist State" to [780, 414].
Layout auto-repair round 1: applied 2 fix(es), revalidating...
```

The repair changes geometry only; it does not change component names, source evidence, or architecture semantics. Diagnostics without a deterministic validator-supplied position are still reported rather than guessed.


## Repair an existing JSON without rerunning Qwen

If Qwen already generated a useful JSON specification and only Archify geometry validation failed, reuse that file instead of paying the inference cost again:

```powershell
Set-Location C:\AI\archify\archify

npm run qwen:diagram -- `
  --repo C:\AI\qanda-yt `
  --type architecture `
  --repair-existing `
  --spec C:\AI\qanda-yt-architecture.json `
  --output C:\AI\qanda-yt-architecture.html
```

`--repair-existing` does not call Qwen. It re-verifies repository evidence, applies supported deterministic geometry repairs, validates the JSON, and delivers the HTML when validation succeeds.

Current automatic architecture repairs include:

- exact validator-suggested `labelAt [x,y]` moves for labels overlapping components;
- label-to-route clearance moves derived from Archify's structured geometry evidence;
- removal of an undersized explicit `meta.viewBox`, allowing Archify's built-in auto-fit to size the canvas;
- pinned source-file/path and line-range evidence normalization.

The repair loop remains bounded to three rounds and stops rather than guessing when a diagnostic does not provide enough deterministic evidence.


### Ambiguous shared relationship corridors

Showcase validation rejects unrelated connections that visually merge by sharing the same horizontal or vertical corridor. The repair loop now detects `composition/ambiguous-corridor` diagnostics and reroutes one of the two relationships through the perpendicular orthogonal route family, then validates the result again.

For example, a shared vertical segment is changed to an `orthogonal-v` route (horizontal middle corridor); a shared horizontal segment is changed to `orthogonal-h`. Explicit `via` and endpoint-side overrides on the repaired connection are cleared so the renderer can recompute a clean route. The validator remains authoritative: if the new route creates a different geometry violation, another bounded repair round runs or the command stops with that diagnostic.


### Edges crossing unrelated components

Architecture validation also rejects a connection that passes through an unrelated component (`clean-flow/edge-through-node`). The repair loop now uses the diagnostic's relationship id plus obstacle id, evaluates short left/right/top/bottom orthogonal detours against the free-position component boxes, selects the shortest corridor that clears all unrelated components, writes explicit `fromSide`/`toSide`/`via`, and revalidates.

This is useful for cases such as an LLM-to-storage connection whose direct vertical route passes through a cloud-provider component. The repair changes only route geometry; it does not change the architecture relationship itself.
