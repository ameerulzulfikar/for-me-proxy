# Overview evaluation lab

The system prompt, tool schema, model, output budget, note formatting, and privacy processing are unchanged. This infrastructure records experiments; it does not verify factual claims.

## Setup

Deploy the updated endpoints. Set `LAB_KEY` on the server and export the same value in the terminal running the lab. `ANTHROPIC_API_KEY` stays on the server. Evaluation requests use `includeEvaluation: true` and the `x-lab-key` header. Normal app requests never receive raw, unscreened model output.

The default endpoint remains `https://project-ymuos.vercel.app/api/import-overview`. Use `--endpoint URL` to target another deployment. The runner uses metadata returned by that endpoint, **not** the local copy of its prompt.

## Freeze a random subset

```sh
node test/overview-lab.mjs build-subset "/path/to/Apple Notes export"
node test/overview-lab.mjs "/path/to/Apple Notes export" --subset test/overview-subset.json
```

The builder recursively enumerates regular `.md` and `.txt` files, sorts filenames only to make enumeration deterministic, shuffles with fixed seed `1331053906` (Mulberry32 + Fisher–Yates), and saves 700 filenames as a JSON array. It never reads text or uses dates, file sizes, or content quality to choose notes. Fewer than 700 files is an error. Use `--output another-subset.json` for an alternative manifest location.

Once saved, the manifest is the source of truth. New files in the folder do not change it. Rebuilding an identical manifest is harmless; rebuilding a different selection at the same path is refused. A subset cannot be combined with `--limit`. Missing files, paths outside the archive, and selected notes exceeding existing API limits fail explicitly—there is no replacement, truncation, or resampling. Empty selected files remain in the sample.

This freezes **membership**, not file contents or timestamps. Keep the exported folder unchanged for comparable experiments. Every run records filenames and a SHA-256 hash of the submitted notes, including their text and dates, to reveal corpus changes. The existing filesystem-birthtime/mtime date behaviour remains unchanged.

## Run and compare

```sh
# Full folder (the existing full-folder loader's empty/oversize exclusions still apply)
node test/overview-lab.mjs "/path/to/Apple Notes export"

# Latest 20 recorded runs, or an explicit limit
node test/overview-lab.mjs runs
node test/overview-lab.mjs runs --limit 50

# Every recorded run grouped by prompt version
node test/overview-lab.mjs runs --group-by-version
```

Tables show version, corpus and note count, estimated USD cost, request latency, timestamp, and HTTP status. If the server drops notes because of the existing full-corpus cap, the table also shows the actual count used. Legacy response-only files remain untouched and are not listed: their versions, costs, and latency cannot be recovered reliably.

`--limit N` remains available for most-recent-note tests; these are labelled `recent`, never `full`. The existing `--lab "instructions or @file.txt"` mode also saves JSON run records now. It still uses its original separate prompt, 16,000-token budget, and no server privacy screen or new caching. Its version combines the overview version constant with a hash of its actual custom prompt, keeping it distinct from overview runs.

## Records and backlog

Each call saves one JSON record in `test/overview-runs/`, including failed HTTP/model calls. It includes:

- Server-reported prompt version, full system prompt, tool schema, requested and returned model strings, and generation settings.
- Corpus kind, selected and used note counts, filenames, content hash, and character count.
- The full raw provider response, before validation/privacy screening, and the final response with evaluation metadata removed.
- Provider usage, including `cache_read_input_tokens`, `cache_creation_input_tokens`, and TTL breakdown when present.
- A USD cost estimate with itemised token-category costs and dated rate assumptions.
- Timestamp, client request latency, server processing latency, HTTP status, and errors.

If no provider output exists, raw output/usage/cost are `null`, not fabricated or zero. If the server cannot return its metadata (network failure, rejected authentication, or an old deployment), prompt/model metadata is also explicitly unknown. The run is still recorded and the command fails visibly. Legacy `--lab` records explicitly say screening was not applied.

`test/overview-prompt-backlog.json` contains version, description, date, and the full prompt. Bump `OVERVIEW_PROMPT_VERSION` in `api/import-overview.js` manually before deploying a prompt change. The first run of an unseen version appends a snapshot with `TODO: describe what changed`; replace that description with your one-line change note. Existing descriptions are preserved. Reusing a label with different prompt text raises a warning/nonzero exit instead of overwriting history; the actual run is still saved. Concurrent backlog updates are locked.

Run records contain private **unscreened** material. They are created with owner-only permissions and ignored by Git, as is the default subset manifest. Custom manifests may contain private filenames; do not commit them. Prompt snapshots are not raw archives. Keep journal content out of custom `--lab` instructions if you intend to commit that backlog entry.

## Cache behaviour and cost

Overview requests mark both the system text and the complete timeline/notes block with `cache_control: { type: "ephemeral", ttl: "1h" }`. Version labels, timestamps, and all evaluation metadata stay outside the model request. The system and note text are byte-for-byte unchanged.

Anthropic caches a **prefix**: tools → system → messages. An identical repeat within the one-hour lifetime can reuse the large input. Editing the system prompt or tool schema invalidates the notes cache too, even if the archive is unchanged. Merely bumping the version label does not invalidate it. A first request must establish the cache before repeats can hit it. This caches input processing, not responses: every run still generates a fresh reading.

Standard Sonnet 5 rates checked September 6, 2026 (USD per million tokens): uncached input $2; one-hour cache write $4; cache read $0.20; output $10. Warm cached input is 90% cheaper than uncached input; the initial write is twice the uncached input rate. Output cost is unchanged. `input_tokens` excludes cache reads/writes, and `output_tokens` already includes thinking; neither is double-counted.

Using **100,000 input tokens and 3,000 total output tokens** as an illustrative 700-note budget:

| Run | Estimated cost |
| --- | ---: |
| Without caching | $0.23 |
| First run / cold one-hour cache | $0.43 |
| Identical warm repeat | $0.05 |

The supplied full-corpus estimate of 300k tokens across 2,284 notes suggests roughly 92k tokens for a random 700-note subset before overhead, but note sizes and reasoning output vary. Use the saved usage to measure actual costs. More output/reasoning increases every estimate; these are not flat per-run prices.

To confirm a **live** hit, run the identical subset twice within an hour and inspect `usage.cache_read_input_tokens` in the second record (also printed in the terminal). A positive value is evidence of a hit; marking blocks alone is not. Automated tests exercise usage passthrough and accounting with mocked provider responses and do not prove a live cache hit.

References: [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [pricing](https://platform.claude.com/docs/en/about-claude/pricing).
