import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import handler, { buildReadingsPrompt, config, overviewTool, prepareReadings, systemPrompt, WRITE_OVERVIEW_PROMPT_VERSION } from "../api/write-overview.js";
import { parseArguments, runWritingOverview } from "./write-overview.mjs";
import { formatGroupedRuns, loadRunRecords } from "./overview-records.mjs";

const reading = (overrides = {}) => ({ noteId: "Notes/Workshop.md", date: "2020-02-03T04:05:06.000Z", description: "A plan for a workshop.", establishes: "You considered teaching woodworking; running it is not established.", kind: "planned_or_considered", ownWriting: "yes", confidence: "high", connections: "", ...overrides });
const overview = (overrides = {}) => ({ portrait: "You like making things people can use.", read: "You considered teaching woodworking.", forgottenIdeas: [{ title: "A woodworking workshop", sourceNoteId: reading().noteId, why: "You had a clear idea for sharing a practical skill." }], tender: "", questions: ["What drew you to teaching woodworking?", "Who did you imagine joining your workshop?", "Which skill did you want to share first?"], ...overrides });
const provider = (input = overview(), overrides = {}) => new Response(JSON.stringify({ model: "claude-sonnet-5", stop_reason: "tool_use", content: [{ type: "tool_use", name: overviewTool.name, input }], usage: { input_tokens: 1000, output_tokens: 200 }, ...overrides }));

function environment(context, fetchImpl) {
  for (const key of ["LAB_KEY", "ANTHROPIC_API_KEY"]) {
    const old = process.env[key];
    context.after(() => old === undefined ? delete process.env[key] : process.env[key] = old);
    process.env[key] = "test-key";
  }
  context.mock.method(globalThis, "fetch", fetchImpl);
  context.mock.method(console, "log", () => {});
}

async function invoke(body = { readings: [reading()] }, changes = {}) {
  const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  await handler({ method: "POST", headers: { "x-lab-key": "test-key" }, body, ...changes }, response);
  return { status: response.statusCode, headers: response.headers, payload: JSON.parse(response.body) };
}

async function fixture(context, contents = { records: { [reading().noteId]: reading() }, failures: { omitted: {} }, reader: { promptVersion: "reader-fixture" }, readerSignature: "fixture-signature", runs: [{ privateMetadata: "never send this ledger" }] }) {
  const directory = await mkdtemp(join(tmpdir(), "write-overview-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const readingsPath = join(directory, "readings.json");
  await writeFile(readingsPath, JSON.stringify(contents));
  return { readingsPath, recordPaths: { runsDirectory: join(directory, "runs"), backlogPath: join(directory, "backlog.json") } };
}

test("lab privacy helpers are an unchanged copy of the app's screening", async () => {
  const source = await readFile(new URL("../api/import-overview.js", import.meta.url), "utf8");
  const copy = await readFile(new URL("../api/_write-overview-privacy.js", import.meta.url), "utf8");
  const blocks = [
    source.slice(source.indexOf("const SELF_HARM_PRIVACY_PATTERN"), source.indexOf("const systemPrompt")),
    source.slice(source.indexOf("function buildKeywordPattern"), source.indexOf("function sanitizeNotes")),
    source.slice(source.indexOf("function verifyProse"), source.indexOf("function computeNoteDate")),
    source.slice(source.indexOf("function recordVerificationFailure"))
  ];
  assert.equal(copy.slice(copy.indexOf("const SELF_HARM_PRIVACY_PATTERN"), copy.indexOf("\nexport {")), blocks.join("\n"));
});

test("writer authenticates before reading a body, including when evaluation is disabled", async (context) => {
  environment(context, () => { throw new Error("Must not call provider"); });
  for (const headers of [{}, { "x-lab-key": "wrong" }]) {
    const result = await invoke({ includeEvaluation: false }, { headers });
    assert.equal(result.status, 401);
    assert.equal(result.headers["Cache-Control"], "no-store");
    assert.equal(result.payload.evaluation, undefined);
  }
  delete process.env.LAB_KEY;
  assert.equal((await invoke("broken JSON")).status, 401);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("writer sends all readings once, chronologically, with original IDs and only evidence fields", async (context) => {
  let request;
  environment(context, (_url, options) => { request = options; return provider(); });
  const late = reading({ noteId: "z.md", date: "2025-01-01", kind: "someone_elses_words", ownWriting: "no", confidence: "low", text: "ORIGINAL ARCHIVE TEXT", sourceHash: "not-evidence" });
  const sameDate = reading({ noteId: "a.md", date: late.date, kind: "imagined_or_fictional", ownWriting: "mixed" });
  const file = { records: { [late.noteId]: late, [reading().noteId]: reading(), [sameDate.noteId]: sameDate }, reader: { systemPrompt: "READER PROMPT" }, folder: "/does/not/exist", runs: [{ secretLedger: true }] };
  const result = await invoke(file);
  assert.equal(result.status, 200);
  assert.equal(globalThis.fetch.mock.callCount(), 1);
  assert.equal(config.maxDuration, 300);
  const body = JSON.parse(request.body);
  assert.equal(body.model, "claude-sonnet-5");
  assert.equal(body.max_tokens, 32000);
  assert.equal(body.system, systemPrompt);
  assert.deepEqual(body.tools, [overviewTool]);
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].content.length, 1);
  const rows = body.messages[0].content[0].text.split("\n").slice(2).map((line) => JSON.parse(line));
  assert.deepEqual(rows.map((row) => row[0]), [reading().noteId, "a.md", "z.md"]);
  assert.deepEqual(rows[2].slice(4), ["someone_elses_words", "no", "low", ""]);
  assert.doesNotMatch(request.body, /ORIGINAL ARCHIVE TEXT|READER PROMPT|secretLedger|not-evidence/u);
  assert.equal(result.payload.forgottenIdeas[0].sourceNoteId, reading().noteId);
  assert.equal(result.payload.questions.length, 3);
  assert.equal(result.payload.tender, "");
  assert.equal(result.payload.evaluation.promptVersion, WRITE_OVERVIEW_PROMPT_VERSION);
  assert.equal(result.payload.evaluation.generation.cache_control, null);
  assert.equal(result.payload.evaluation.corpus.usedNoteCount, 3);
  assert.equal(result.payload.evaluation.costEstimate.totalUsd, 0.004);
  assert.equal(result.payload.evaluation.screeningApplied, true);
  assert.ok(result.payload.evaluation.serverLatencyMs >= 0);
  assert.match(systemPrompt, /careful reader went through the archive one note at a time/u);
  assert.match(systemPrompt, /only source of facts/u);
  assert.match(systemPrompt, /Be generous and be honest/u);
  assert.match(systemPrompt, /Where the readings are thin on something, say less/u);
  assert.match(systemPrompt, /If you can't establish a count, don't state one/u);
  assert.match(systemPrompt, /including questions/u);
});

test("input validation rejects bad evidence before provider calls and never silently drops readings", async (context) => {
  environment(context, () => { throw new Error("Must not call provider"); });
  assert.equal((await invoke(undefined, { method: "GET" })).status, 405);
  assert.equal((await invoke("invalid JSON")).status, 400);
  for (const readings of [[], null, {}, [reading(), reading()], [reading({ date: "unknown" })], [reading({ kind: "maybe" })], [reading({ ownWriting: true })], [reading({ confidence: 1 })], [reading({ establishes: null })], [reading({ connections: [] })], { records: { wrongId: reading() } }]) {
    assert.equal((await invoke({ readings })).status, 400);
  }
  assert.equal((await invoke({ notes: [{ text: "original archive" }] })).status, 400);
  assert.equal((await invoke({ readings: Array.from({ length: 3001 }, (_, i) => reading({ noteId: `${i}.md` })) })).status, 413);
  assert.equal((await invoke({ readings: [reading({ establishes: "x".repeat(2_100_000) })] })).status, 413);
  assert.equal(prepareReadings([reading({ establishes: "", connections: "", kind: "imagined" })]).length, 1);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await invoke()).status, 500);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
});

test("privacy screens every prose field and preserves unscreened output only in evaluation", async (context) => {
  const raw = overview({
    portrait: "You like making furniture. You attended therapy. This changed everything.",
    read: "Your wife Maya helps with the workshop. Maya likes the plans. You wrote about self-harm. You keep useful tools.",
    forgottenIdeas: [
      { title: "Medication tracking", sourceNoteId: reading().noteId, why: "You tracked prescriptions." },
      { title: "A workshop", sourceNoteId: "invented.md", why: "You considered sharing your skills." },
      { title: "A joint workshop", sourceNoteId: reading().noteId, why: "Maya shares your interest in making furniture." }
    ],
    tender: "You wrote about Oliver's death. This stayed with you. You make breakfast for your family. You remember what they like.",
    questions: ["How does Maya see the workshop?", "What drew you to teaching?", "Which skill would you share first?"]
  });
  environment(context, () => provider(raw));
  const result = await invoke();
  assert.equal(result.status, 200);
  const { evaluation, ...screened } = result.payload;
  assert.deepEqual(evaluation.rawModelResponse.content[0].input, raw);
  assert.doesNotMatch(JSON.stringify(screened), /Maya|Oliver|therapy|Medication|prescriptions|self-harm|This changed|This stayed/u);
  assert.match(screened.read, /Your wife helps/u);
  assert.match(screened.questions[0], /your partner/u);
  assert.equal(screened.questions.length, 3);
  assert.equal(screened.forgottenIdeas.length, 1);
  assert.equal(screened.forgottenIdeas[0].sourceNoteId, reading().noteId);
  for (const reason of ["privacy_health", "privacy_selfharm", "privacy_deceased", "privacy_partner", "note_not_found"]) {
    assert.ok(screened.verification.failures.some((failure) => failure.reason === reason), reason);
  }
});

test("unsafe questions fail closed without invented replacements or a second provider request", async (context) => {
  let input;
  environment(context, () => provider(input));
  for (const question of ["Did therapy affect your workshop?", "How did Oliver's death affect you?", "What stopped you from self-harm?"]) {
    input = overview({ questions: [question, ...overview().questions.slice(1)] });
    const result = await invoke();
    assert.equal(result.status, 502);
    assert.equal(result.payload.error.type, "screened_overview_incomplete");
    assert.equal(result.payload.questions.length, 2);
    assert.equal(result.payload.evaluation.screeningApplied, true);
    assert.equal(result.payload.evaluation.costEstimate.totalUsd, 0.004);
  }
  assert.equal(globalThis.fetch.mock.callCount(), 3);
  input = overview({ portrait: "You attended therapy." });
  assert.equal((await invoke()).status, 502);
});

test("output validation requires the whole schema and exactly three questions, with supported wrappers", async (context) => {
  let input;
  environment(context, () => provider(input));
  for (input of [null, {}, overview({ portrait: " " }), overview({ read: null }), overview({ tender: undefined }), overview({ forgottenIdeas: [{}] }), overview({ questions: [] }), overview({ questions: [...overview().questions, "Fourth?"] }), overview({ questions: [1, "Second?", "Third?"] })]) {
    const result = await invoke();
    assert.equal(result.status, 502);
    assert.equal(result.payload.error.type, "overview_validation_error");
    assert.equal(result.payload.evaluation.costEstimate.totalUsd, 0.004);
  }
  for (const wrapper of ["parameters", "input", "arguments", "properties"]) {
    input = { [wrapper]: overview() };
    assert.equal((await invoke()).status, 200);
  }
});

test("provider errors preserve raw output and available accounting without retries", async (context) => {
  let send;
  environment(context, () => send());
  const cases = [
    [() => provider(overview(), { stop_reason: "max_tokens" }), "incomplete_output", true],
    [() => provider(overview(), { stop_reason: "model_context_window_exceeded" }), "incomplete_output", true],
    [() => provider(overview(), { stop_reason: "refusal" }), "incomplete_output", true],
    [() => provider(overview(), { content: [] }), "overview_validation_error", true],
    [() => new Response(JSON.stringify({ error: { message: "private provider error" } }), { status: 429 }), "provider_http_error", false],
    [() => new Response("non-JSON private provider error"), "provider_parse_error", false],
    [() => { throw new DOMException("timeout", "TimeoutError"); }, "provider_timeout", false],
    [() => { throw new Error("private network details"); }, "overview_failed", false]
  ];
  for (const [implementation, type, billed] of cases) {
    send = implementation;
    const result = await invoke();
    assert.equal(result.status, 502);
    assert.equal(result.payload.error.type, type);
    assert.equal(result.payload.evaluation.costEstimate?.totalUsd ?? null, billed ? 0.004 : null);
    assert.doesNotMatch(JSON.stringify(result.payload.error), /private/u);
  }
  assert.equal(globalThis.fetch.mock.callCount(), cases.length);
});

test("runner saves comparable private records using actual endpoint metadata and only reads its input file", async (context) => {
  environment(context, () => provider());
  const { readingsPath, recordPaths } = await fixture(context);
  let calls = 0;
  const { record, outputPath, backlogWarning } = await runWritingOverview({ readingsPath }, {
    recordPaths,
    fetchImpl: async (_url, options) => {
      calls += 1;
      assert.equal(options.headers["x-lab-key"], "test-key");
      assert.equal(options.redirect, "manual");
      const body = JSON.parse(options.body);
      assert.deepEqual(body, { readings: [reading()] });
      const result = await invoke(body);
      // The runner must snapshot the deployed version, not its local import.
      result.payload.evaluation.promptVersion = "write-from-readings-deployed-fixture";
      return new Response(JSON.stringify(result.payload), { status: result.status });
    }
  });
  assert.equal(calls, 1);
  assert.equal(backlogWarning, null);
  assert.equal(record.recordVersion, 1);
  assert.equal(record.promptVersion, "write-from-readings-deployed-fixture");
  assert.equal(record.corpus.failedReadingCount, 1);
  assert.equal(record.corpus.noteCount, 1);
  assert.equal(record.corpus.characterCount, buildReadingsPrompt([reading()]).length);
  assert.match(record.corpus.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(record.rawModelResponse.content[0].input.portrait, overview().portrait);
  assert.equal(record.finalScreenedResponse.evaluation, undefined);
  assert.equal(record.screeningApplied, true);
  assert.equal(record.costEstimate.totalUsd, 0.004);
  assert.ok(record.latencyMs >= 0 && record.serverLatencyMs >= 0);
  assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), record);
  const records = await loadRunRecords(recordPaths.runsDirectory);
  assert.equal(records.length, 1);
  assert.match(formatGroupedRuns(records), /write-from-readings-deployed-fixture/u);
  assert.equal(JSON.parse(await readFile(recordPaths.backlogPath, "utf8"))[0].systemPrompt, systemPrompt);
});

test("runner records failed calls and missing metadata as unknown, and requires LAB_KEY before file access", async (context) => {
  environment(context, () => provider(overview({ questions: ["Did therapy help?", ...overview().questions.slice(1)] })));
  const { readingsPath, recordPaths } = await fixture(context);
  for (const fetchImpl of [
    async () => { const result = await invoke(); return new Response(JSON.stringify(result.payload), { status: result.status }); },
    async () => new Response("not JSON", { status: 502 }),
    async () => new Response(JSON.stringify(overview())),
    async () => new Response("", { status: 307 }),
    async () => { throw new Error("network down"); }
  ]) {
    const { record } = await runWritingOverview({ readingsPath }, { recordPaths, fetchImpl });
    assert.ok(record.error);
    if (record.error.type === "screened_overview_incomplete") {
      assert.equal(record.costEstimate.totalUsd, 0.004);
      assert.equal(record.screeningApplied, true);
      assert.equal(record.finalScreenedResponse.questions.length, 2);
    } else {
      assert.equal(record.costEstimate, null);
      assert.equal(record.model, null);
      assert.equal(record.promptVersion, null);
      assert.equal(record.screeningApplied, false);
    }
  }
  assert.equal((await loadRunRecords(recordPaths.runsDirectory)).length, 5);
  delete process.env.LAB_KEY;
  await assert.rejects(runWritingOverview({ readingsPath: "/nonexistent" }), /LAB_KEY/u);
});

test("CLI accepts a single readings file and safe endpoint URLs", () => {
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  assert.match(parseArguments(["readings.json"]).endpoint, /\/api\/write-overview$/u);
  assert.equal(parseArguments(["readings.json", "--endpoint", "http://localhost:3000/api/write-overview"]).endpoint, "http://localhost:3000/api/write-overview");
  for (const args of [[], ["a", "b"], ["a", "--limit", "2"], ["a", "--endpoint"], ["a", "--endpoint", "http://example.com"], ["a", "--endpoint", "https://user:secret@example.com"], ["a", "--endpoint", "https://example.com/#secret"], ["a", "--endpoint", "https://example.com", "--endpoint", "https://example.com"]]) {
    assert.throws(() => parseArguments(args));
  }
});
