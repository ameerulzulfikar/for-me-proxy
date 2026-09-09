# Writing from structured readings

Stage two is a lab-only endpoint and runner. It uses `claude-sonnet-5` with prompt version `write-from-readings-v1`. Deploy the new route, set `LAB_KEY` and `ANTHROPIC_API_KEY` on the server, and export the matching `LAB_KEY` in the runner's shell. The provider key stays on the server.

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

Successful responses contain `portrait`, `read`, `forgottenIdeas` (`title`, `sourceNoteId`, `why`), `tender`, and exactly three `questions`, plus verification, usage, and authenticated evaluation metadata. Empty `read`/`tender` and an empty ideas array are valid. Idea IDs must match supplied readings; unsupported ideas are removed and reported in verification. The lab keeps `sourceNoteId` as requested, without converting it to the app's `whenWritten` display field.

The existing privacy and prose-cleanup helpers are copied verbatim into `api/_write-overview-privacy.js`, with a parity test against `api/import-overview.js`. This keeps all app code untouched. Health, deceased references, self-harm, and partner names are screened in every prose field, including questions; partner names identified anywhere in the output are redacted across sections. As in the existing overview, incomplete tender text is omitted (represented here by an empty string). These are the existing heuristic checks, not factual verification.

If screening removes the portrait or leaves fewer than three questions, the endpoint returns HTTP 502 with a screened partial result and an error, preserving the raw output in lab evaluation metadata. It does not fabricate replacement questions or make an automatic second model request. Provider, validation, and screening failures remain billable when usage exists.

Each invocation saves the existing lab's `recordVersion: 1` format through `saveRun`, including server-reported prompt/schema/model/generation settings, reading counts and hashes, raw provider response, screened result, usage, cost estimate, client/server latency, and errors. It also snapshots new prompt versions in the existing prompt backlog. Prompt text must get a new version when changed. Run files are owner-only and stay in the already-ignored `test/overview-runs/`; raw output is private. Network failures and unavailable usage remain unknown, not zero. No automatic retries or archive reads occur.

There is no explicit prompt caching in this pass, avoiding a cache-write premium for a single run. Sonnet 5 rates are $2 per million input tokens and $10 per million output tokens ([Anthropic model documentation](https://platform.claude.com/docs/en/models/sonnet-5/whats-new-sonnet-5), checked September 9, 2026); accounting reuses the repository's dated pricing helper. The supplied 699 readings produce about 431,000 compact-input characters. At a rough 3–4 characters per token plus prompt/tool overhead, and 3,000–10,000 output tokens including thinking, budget approximately **US$0.25–$0.40 per writing run**. This is a character-based estimate, not a measured token count. The 32,000-token output cap can bring a run near $0.61 at the upper end of that input estimate. Actual usage, cost, and latency print after every call and are saved in its record. Stage-one costs are not charged again or folded into this writing-pass estimate.

```sh
node --test test/write-overview.test.js
npm test
```

Tests use synthetic readings and mocked provider responses. They exercise the endpoint-to-runner path, privacy behavior, chronological input, validation, and accounting, without spending API credits.
