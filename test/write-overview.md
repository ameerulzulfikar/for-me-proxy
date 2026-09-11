# Writing from structured readings

Stage two is a lab-only endpoint and runner. It uses `claude-sonnet-5` with prompt version `write-from-readings-v2`. This version changes the request layout and adds caching; the writing instructions, tool schema, output budget, validation and privacy screen retain their previous behavior. Deploy the new route, set `LAB_KEY` and `ANTHROPIC_API_KEY` on the server, and export the matching `LAB_KEY` in the runner's shell. The provider key stays on the server.

```sh
export LAB_KEY='your-existing-lab-key'
node test/write-overview.mjs test/overview-runs/readings-v2.json

# Another deployment or a local server
node test/write-overview.mjs test/overview-runs/readings-v2.json \
  --endpoint https://your-deployment.example/api/write-overview

node test/overview-lab.mjs runs --group-by-version
```

The default endpoint is `https://project-ymuos.vercel.app/api/write-overview`. HTTPS is required except on localhost. Redirects are not followed with the lab key. `--help` needs no credentials.

The runner reads only the supplied JSON file. It accepts the stage-one file with `records[noteId]` or an array of readings. All successful records are used, sorted oldest first by note date, with exact note IDs preserved. Same-date ties sort by ID. The supplied v2 file has 699 successful readings and one failed attempt; the failed attempt is reported and excluded. This does not rerun stage one.

`POST /api/write-overview` accepts `{ "readings": <stage-one file or readings array> }`; the file/array can also be the body directly. It requires `x-lab-key` for every request and returns `Cache-Control: no-store`. Only `noteId`, `date`, `description`, `establishes`, `kind`, `ownWriting`, `confidence`, and `connections` enter the model's single request, as compact JSON arrays with a shared column header. Original text, filenames outside `noteId`, reader prompts, and run ledgers are not forwarded. The endpoint rejects empty, invalid, duplicate, oversized, or mismatched-ID readings without truncating or selecting a subset. Limits are 3,000 readings and 2.1 million compact-input characters.

Successful responses contain `portrait`, `read`, `forgottenIdeas` (`title`, `sourceNoteId`, `why`), `tender`, and up to three `questions`, plus verification, usage, and authenticated evaluation metadata. The model is still asked for three questions, but the endpoint keeps the first three that survive privacy screening and accepts fewer, including none. Missing or wrongly typed optional fields default to empty strings/arrays; malformed ideas and non-string questions are omitted. Either a usable `portrait` or a usable `read` is sufficient. Idea IDs must match supplied readings; unsupported ideas are removed and reported in verification. The lab keeps `sourceNoteId` as requested, without converting it to the app's `whenWritten` display field.

Single-key `parameters`, `input`, `arguments`, `properties`, and `overview` wrappers are unwrapped when they contain an overview object with a `portrait` or `read` field, even if optional fields are absent. Ambiguous wrappers with sibling keys are left alone. Unusable output returns diagnostics with `top_level_keys`, `first_forgotten_idea_keys`, and `failed_fields` identifying missing, wrongly typed, or empty fields. Raw provider output remains unchanged in evaluation metadata.

The existing privacy and prose-cleanup helpers are copied verbatim into `api/_write-overview-privacy.js`, with a parity test against `api/import-overview.js`. This keeps all app code untouched. Health, deceased references, self-harm, and partner names are screened in every prose field, including questions; partner names identified anywhere in the output are redacted across sections. As in the existing overview, incomplete tender text is omitted (represented here by an empty string). These are the existing heuristic checks, not factual verification.

If screening leaves neither a usable portrait nor a usable read, the endpoint returns HTTP 502 with a screened partial result and diagnostics, preserving the raw output in lab evaluation metadata. Question count never causes a failure. It does not fabricate replacement questions or make an automatic second model request. Provider, validation, and screening failures remain billable when usage exists.

Each invocation saves the existing lab's `recordVersion: 1` format through `saveRun`, including server-reported prompt/schema/model/generation settings, reading counts and hashes, raw provider response, screened result, usage, cost estimate, client/server latency, and errors. It also snapshots new prompt versions in the existing prompt backlog. Prompt text must get a new version when changed. Run files are owner-only and stay in the already-ignored `test/overview-runs/`; raw output is private. Network failures and unavailable usage remain unknown, not zero. No automatic retries or archive reads occur.

## Prompt caching and cost

Anthropic processes the prefix in the order **tools → system blocks → messages**, regardless of JSON property order. The request now contains the unchanged tool schema, then two system text blocks: the compact readings with `cache_control: { type: "ephemeral", ttl: "1h" }`, followed by the existing writing instructions without a cache marker. A short user message requests the overview. The instructions continue to treat all readings as source material rather than instructions to obey.

The cache ends at the readings block. Editing `systemPrompt` changes only the second system block, leaving that prefix intact. Bump the prompt version whenever instructions change so the lab can compare them; version labels are evaluation metadata and do not enter the cached prefix. Reordering the input records produces the same sorted readings text. Changing readings or their formatting changes the prefix. Changing the tool schema/model or expiry of the one-hour cache can also prevent a hit: native tools necessarily precede the readings. This is input-processing caching; each request still generates a fresh overview. See [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

Evaluation records retain the instruction text as `systemPrompt` and now record `generation.cache_control` and `generation.prompt_layout: "readings-first-system-blocks-v1"`. Raw provider usage passes through to the response, evaluation metadata and saved run record. The runner also prints `Cache read tokens` and `Cache write tokens (1h)` explicitly. The cost helper receives the one-hour TTL, including when the provider omits a per-TTL write breakdown.

Sonnet 5 rates checked September 12, 2026 are $2 per million uncached input tokens, $4 per million one-hour cache-write tokens, $0.20 per million cache-read tokens and $10 per million output tokens ([pricing](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing)). Accounting uses the existing dated repository helper, whose rates match these values. The four saved Condition C runs each used 157,474 total input tokens and generated 1,828–2,136 output tokens. Using approximately 155,000 cached-prefix tokens, 2,474 uncached instruction/request tokens and 2,000 output tokens gives:

| Run | Estimated USD cost |
| --- | ---: |
| Cold: first run after changing readings/layout or cache expiry | $0.645 (about $0.65) |
| Warm: same readings, including edits to trailing writing instructions | $0.056 (about $0.05–$0.06) |

The prefix/suffix split is an estimate, not a live token count for the new layout. Cost is `(4 × cache-write tokens + 0.20 × cache-read tokens + 2 × uncached input tokens + 10 × output tokens) / 1,000,000`; output includes any thinking. Longer output or instructions increases the price. The 32,000-token output cap could bring the illustrative cold run to about $0.945 and the warm run to $0.356. Stage-one costs are not charged again.

To verify a live hit after deployment, run the command above twice within an hour, after the first has completed. A positive `usage.cache_read_input_tokens` on the second run confirms reuse; the first should report `cache_creation_input_tokens` and normally `cache_creation.ephemeral_1h_input_tokens`. An instruction-only edit keeps that prefix unchanged. A zero count is not a hit, and unavailable usage remains unknown. Automated tests confirm prefix stability under instruction changes, one-hour cost accounting, and cache usage surviving the full endpoint-to-runner path. No live cache hit was verified during implementation because this shell had neither `LAB_KEY` nor `ANTHROPIC_API_KEY`.

```sh
node --test test/write-overview.test.js
npm test
```

Tests use synthetic readings and mocked provider responses. They exercise the endpoint-to-runner path, privacy behavior, chronological input, validation, and accounting, without spending API credits.
