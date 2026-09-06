# Archive reading pass — lab only

This is stage one only: one note per `claude-sonnet-5` request, producing a short source-bound reading for a later writer. It does not call or modify `api/import-overview.js`, write an overview, resolve identities across the archive, or verify that the note's claims are true.

## Commands

Run from the repository root, with `LAB_KEY` already set in your environment. The deployed endpoint needs the same `LAB_KEY` and its existing `ANTHROPIC_API_KEY`. Deploy the new `api/read-note.js` before running against the default URL.

Test 50 pending notes from the existing frozen 700-note subset:

```sh
node test/read-archive.mjs "/path/to/Apple Notes export" --subset test/overview-subset.json --limit 50 --output test/overview-runs/readings-condition-b.json
```

Continue the same file through the rest of the subset:

```sh
node test/read-archive.mjs "/path/to/Apple Notes export" --subset test/overview-subset.json --output test/overview-runs/readings-condition-b.json
```

Read a full archive into a separate file:

```sh
node test/read-archive.mjs "/path/to/Apple Notes export" --output test/overview-runs/readings-full.json
```

Optional controls:

- `--concurrency 5`: default five concurrent requests; configurable from 1 to 20.
- `--limit N`: attempt at most N **pending** notes this invocation, after skipping successful saved readings. Repeating `--limit 50` advances to the next pending batch, including any previous failures. It does not regenerate or alter the frozen subset.
- `--endpoint https://your-deployment.example/api/read-note`: override the default `https://project-ymuos.vercel.app/api/read-note`. HTTP is accepted only for localhost testing. Redirects are not followed with the lab key.
- `--output path.json`: defaults to `test/overview-runs/archive-reading.json`. Use a different file for a different reading prompt or archive.
- `--help`: no credentials needed.

The runner uses deterministic filename order, not content ranking. It reads `.md` and `.txt` notes, including empty notes. A frozen subset must be the existing format: exactly 700 unique archive-relative filenames. No replacements are selected for missing or unreadable notes. Unlike the overview's bulk loader, this pass does not silently omit empty or large notes and has no aggregate archive-text cap. Individual notes over 200,000 characters are recorded as failures without truncation or a provider call.

## Saved file

All readings are in one JSON file under `records[noteId]`. IDs are archive-relative filenames, stable across subset, limit, and resume operations. They are not the overview model's temporary chronological `n1`, `n2`, … labels.

Each record has:

```json
{
  "noteId": "iCloud/Notes/Invitation.md",
  "date": "2020-02-03T04:05:06.000Z",
  "description": "A draft invitation.",
  "establishes": "The person drafted an invitation; sending is not established.",
  "kind": "draft",
  "ownWriting": "yes",
  "confidence": "high",
  "connections": "",
  "filename": "iCloud/Notes/Invitation.md",
  "sourceHash": "...",
  "model": "claude-sonnet-5",
  "readAt": "..."
}
```

`kind` is one of `happened`, `planned_or_considered`, `imagined_or_fictional`, `someone_elses_words`, `draft`, or `unclear`. Mixed material can use `unclear` with a short explanation in the prose. `ownWriting` is `yes`, `no`, `mixed`, or `unclear`; `confidence` is `low`, `medium`, or `high`. Empty `establishes` and `connections` strings are valid. These are model judgments, not proof of authorship or factual accuracy.

The endpoint supplies `noteId` and `date` from the request; the model schema contains neither field. Dates use the same filesystem birth-time/fallback-to-modification-time convention as the existing lab. Export metadata is not proof of an event's date. The runner validates the returned identity and date before saving.

The top level also contains the actual reading configuration (version, complete prompt, schema, model and token cap), its fingerprint, outstanding `failures`, per-invocation `runs`, and cumulative `totals`. Every attempt stores usage, a USD cost estimate, latency and any error, including billed validation failures. Raw source text and credentials are not copied into the saved file; the readings themselves can contain sensitive information.

## Resume and failures

Every completion is saved with an atomic replacement, private file permissions (`0600`), and a single-writer lock. Successes are skipped on resume; failures are attempted once per invocation. No automatic model retries hide costs. Per-note errors do not discard other readings.

A changed source/date, different archive folder, incompatible reading configuration, or malformed saved file is rejected before further model calls. Use a new output file for such changes. A full-folder run may reuse successful subset records in the same file when their sources and reading configuration match.

Ctrl-C stops scheduling new requests and lets in-flight readings finish and save. A second interrupt/forced termination may lose an in-flight result even if the provider billed it. After a forced termination, a `.lock` file can remain; inspect its PID and confirm no reader is running before removing that specific lock. Do not delete the readings JSON to resume.

The summary reports this invocation's tokens, elapsed wall time, failures and cost, plus cumulative tokens/cost across resumes. Network failures or missing provider usage are reported as unknown, not free; known subtotals are kept. Estimates use the repository's existing Anthropic cost helper, not a provider billing statement. Historical usage and failures stay in `runs` even after a successful retry. An interrupted invocation remains in the ledger with its last checkpoint.

These are **unscreened, authenticated lab records**, not material to display in the app. The existing app's privacy screen is untouched and is not reused here to erase source evidence. Keep outputs under the already-ignored `test/overview-runs/` directory, or another private location; a custom output path outside it is not automatically Git-ignored.

## Endpoint and tests

`POST /api/read-note` requires `x-lab-key` and `{ noteId, date, title, text }`. It returns `{ record, model, reader, readerSignature, usage, costEstimate, latencyMs, providerCalled }`, or an error with available accounting metadata. Provider/network error messages do not log private note text. The new route uses its own inline `config.maxDuration`, without changing `vercel.json` ([Vercel Node.js route configuration](https://vercel.com/docs/functions/configuring-functions/duration)).

```sh
node --test test/read-note.test.js test/read-archive.test.js
npm test
```

The test suite includes a **mocked** 50-note endpoint-to-runner exercise from a synthetic 700-note subset. Its costs and timings are not a live-model benchmark. No live 50-note measurement has been made as part of this implementation.
