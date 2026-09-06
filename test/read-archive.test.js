import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import handler, { MAX_READING_NOTE_TEXT, READING_CONFIG, READING_SIGNATURE } from "../api/read-note.js";
import { formatSummary, loadReadingCorpus, parseArguments, readArchive, summarizeAttempts } from "./read-archive.mjs";

const reading = { description: "A shopping list.", establishes: "The person listed food to buy.", kind: "planned_or_considered", ownWriting: "unclear", confidence: "medium", connections: "" };
const usage = { input_tokens: 100, output_tokens: 20 };

async function fixture(context, count = 3) {
  const directory = await mkdtemp(join(tmpdir(), "read-archive-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const folderPath = join(directory, "notes");
  const outputPath = join(directory, "readings.json");
  await mkdir(folderPath);
  const filenames = Array.from({ length: count }, (_, i) => `note-${String(i).padStart(3, "0")}.md`);
  await Promise.all(filenames.map((name) => writeFile(join(folderPath, name), `# ${name}\nPrivate source: apples and bread.`)));
  const old = process.env.LAB_KEY;
  process.env.LAB_KEY = "test-lab-key";
  context.after(() => old === undefined ? delete process.env.LAB_KEY : process.env.LAB_KEY = old);
  return { directory, folderPath, outputPath, filenames };
}

function resultFor(options, overrides = {}) {
  const note = JSON.parse(options.body);
  return new Response(JSON.stringify({
    record: { noteId: note.noteId, date: note.date, ...reading },
    providerCalled: true, reader: READING_CONFIG, readerSignature: READING_SIGNATURE,
    model: READING_CONFIG.model, usage, ...overrides
  }));
}

test("reading CLI combines frozen subsets with a pending-note limit and validates flags", () => {
  const options = parseArguments(["/notes", "--subset", "test/overview-subset.json", "--limit", "50"]);
  assert.equal(options.limit, 50);
  assert.equal(options.concurrency, 5);
  assert.equal(options.subsetPath, resolve("test/overview-subset.json"));
  assert.equal(parseArguments(["/notes", "--concurrency", "2", "--endpoint", "http://localhost:3000/api/read-note"]).concurrency, 2);
  assert.deepEqual(parseArguments(["--help"]), { help: true });
  for (const args of [[], ["/notes", "--limit", "0"], ["/notes", "--limit", "1.5"], ["/notes", "--limit", "1", "--limit", "2"], ["/notes", "--concurrency", "21"], ["/notes", "--output", "notes.md"], ["/notes", "--subset"], ["/notes", "--unknown"], ["/notes", "--endpoint", "http://example.com"], ["/notes", "--endpoint", "https://key:secret@example.com"]]) assert.throws(() => parseArguments(args));
});

test("reading loader retains empty and large notes without the overview's content filters", async (context) => {
  const fixtureData = await fixture(context, 0);
  await writeFile(join(fixtureData.folderPath, "empty.md"), "");
  await writeFile(join(fixtureData.folderPath, "large.md"), "x".repeat(110_000));
  await writeFile(join(fixtureData.folderPath, "too-large.md"), "x".repeat(MAX_READING_NOTE_TEXT + 1));
  const { notes } = await loadReadingCorpus(fixtureData.folderPath);
  assert.equal(notes.length, 3);
  assert.equal(notes[0].text, "");
  assert.equal(notes[1].text.length, 110_000);
  assert.equal(notes[2].error.type, "source_error");
  assert.match(notes[2].error.message, /not truncated/u);
  const info = await stat(join(fixtureData.folderPath, "empty.md"));
  assert.equal(notes[0].date, (info.birthtimeMs > 0 ? info.birthtime : info.mtime).toISOString());
});

test("reading requires LAB_KEY before loading an archive or contacting an endpoint", async (context) => {
  const data = await fixture(context);
  delete process.env.LAB_KEY;
  await assert.rejects(readArchive({ ...data, folderPath: "/does-not-exist" }, { fetchImpl: () => assert.fail("must not fetch") }), /LAB_KEY/u);
  await assert.rejects(stat(data.outputPath), { code: "ENOENT" });
});

test("mocked 50-note reading uses concurrency five, checkpoints, then resumes the same frozen subset", async (context) => {
  const data = await fixture(context, 700);
  const subsetPath = join(data.directory, "subset.json");
  await writeFile(subsetPath, JSON.stringify([...data.filenames].reverse()));
  await writeFile(join(data.folderPath, "not-in-subset.md"), "Do not send me");
  const oldApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "test-api-key";
  context.after(() => oldApiKey === undefined ? delete process.env.ANTHROPIC_API_KEY : process.env.ANTHROPIC_API_KEY = oldApiKey);
  let active = 0;
  let peak = 0;
  const sent = [];
  context.mock.method(globalThis, "fetch", async (_url, options) => {
    const input = JSON.parse(options.body);
    sent.push(JSON.parse(input.messages[0].content[0].text));
    active += 1;
    peak = Math.max(peak, active);
    await setTimeout(5);
    active -= 1;
    return new Response(JSON.stringify({ model: READING_CONFIG.model, stop_reason: "tool_use", content: [{ type: "tool_use", name: "record_note_reading", input: reading }], usage }));
  });
  const bridge = async (_url, options) => {
    assert.equal(options.headers["x-lab-key"], "test-lab-key");
    assert.equal(options.redirect, "manual");
    const response = { setHeader() {}, end(body) { this.body = body; } };
    await handler({ method: "POST", headers: options.headers, body: JSON.parse(options.body) }, response);
    return new Response(response.body, { status: response.statusCode });
  };
  const first = await readArchive({ ...data, subsetPath, limit: 50 }, { fetchImpl: bridge });
  assert.equal(sent.length, 50);
  assert.equal(peak, 5);
  assert.deepEqual(sent.map((note) => note.noteId).sort(), data.filenames.slice(0, 50));
  assert.equal(first.run.status, "completed");
  assert.equal(first.run.summary.knownTokens, 6000);
  assert.equal(first.run.summary.totalCostUsd, 0.02); // Synthetic usage, NOT a live benchmark.
  assert.equal(first.run.remaining, 650);
  assert.equal(Object.keys(first.state.records).length, 50);
  const saved = JSON.parse(await readFile(data.outputPath, "utf8"));
  assert.deepEqual(saved, first.state);
  assert.equal((await stat(data.outputPath)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(saved), /test-lab-key|test-api-key|Private source:/u);
  assert.deepEqual(saved.records[sent[0].noteId], { noteId: sent[0].noteId, date: sent[0].date, ...reading, filename: sent[0].noteId, sourceHash: saved.records[sent[0].noteId].sourceHash, model: READING_CONFIG.model, readAt: saved.records[sent[0].noteId].readAt });
  const second = await readArchive({ ...data, subsetPath, limit: 10 }, { fetchImpl: bridge });
  assert.equal(sent.length, 60);
  assert.equal(second.run.skipped, 50);
  assert.equal(second.run.remaining, 640);
  assert.equal(second.state.totals.totalCostUsd, 0.024);
  assert.deepEqual(second.state.records[data.filenames[0]], first.state.records[data.filenames[0]]);
  assert.match(formatSummary(second), /50 skipped/u);
  assert.match(formatSummary(second), /All invocations: 60 saved readings/u);
});

test("per-note failures preserve successes, retain billed usage, and retry on resume", async (context) => {
  const data = await fixture(context, 3);
  let calls = 0;
  const first = await readArchive(data, { fetchImpl: async (_url, options) => {
    calls += 1;
    if (JSON.parse(options.body).noteId === data.filenames[1]) return new Response(JSON.stringify({ providerCalled: true, usage, reader: READING_CONFIG, error: { type: "reading_validation_error", message: "Incomplete reading" } }), { status: 502 });
    return resultFor(options);
  } });
  assert.equal(calls, 3);
  assert.equal(first.run.status, "completed_with_failures");
  assert.equal(Object.keys(first.state.records).length, 2);
  assert.equal(first.run.summary.totalCostUsd, 0.0012);
  assert.equal(first.state.failures[data.filenames[1]].error.type, "reading_validation_error");
  assert.match(formatSummary(first), /FAILED note-001.md/u);
  const second = await readArchive(data, { fetchImpl: async (_url, options) => { calls += 1; return resultFor(options); } });
  assert.equal(calls, 4);
  assert.equal(second.run.skipped, 2);
  assert.deepEqual(second.state.failures, {});
  assert.equal(second.state.totals.totalCostUsd, 0.0016);
  const third = await readArchive(data, { fetchImpl: () => assert.fail("All notes should be skipped") });
  assert.equal(third.run.attempts.length, 0);
  assert.equal(third.run.summary.totalCostUsd, 0);
  assert.equal(third.state.totals.totalCostUsd, 0.0016);
});

test("network, non-JSON, reader mismatch and identity errors are per-note failures", async (context) => {
  const data = await fixture(context, 5);
  const responses = [
    () => { throw new DOMException("timed out", "TimeoutError"); },
    () => new Response("bad gateway", { status: 504 }),
    (options) => resultFor(options, { readerSignature: "different" }),
    (options) => resultFor(options, { record: { ...reading, noteId: "wrong", date: JSON.parse(options.body).date } }),
    (options) => resultFor(options)
  ];
  const result = await readArchive(data, { fetchImpl: async (_url, options) => responses.shift()(options) });
  assert.equal(Object.keys(result.state.records).length, 1);
  assert.equal(Object.keys(result.state.failures).length, 4);
  assert.equal(result.run.summary.unknownCostAttempts, 2);
  assert.equal(result.run.summary.unknownUsageAttempts, 2);
  assert.equal(result.run.summary.totalCostUsd, null);
  assert.equal(result.run.summary.knownCostUsd, 0.0012);
  assert.match(formatSummary(result), /2 attempt\(s\) with unknown cost/u);
});

test("changed source, foreign archive, changed reader, malformed output and locks are not overwritten", async (context) => {
  const data = await fixture(context, 1);
  await readArchive(data, { fetchImpl: async (_url, options) => resultFor(options) });
  const original = await readFile(data.outputPath, "utf8");
  const noFetch = { fetchImpl: () => assert.fail("Must not call provider") };
  await writeFile(join(data.folderPath, data.filenames[0]), "Changed source");
  await assert.rejects(readArchive(data, noFetch), /Source changed/u);
  assert.equal(await readFile(data.outputPath, "utf8"), original);
  await writeFile(`${data.outputPath}.lock`, "Locked by another process");
  await assert.rejects(readArchive(data, noFetch), /Output is locked/u);
  await rm(`${data.outputPath}.lock`);
  for (const contents of ["{broken", JSON.stringify({ ...JSON.parse(original), folder: "/another-archive" }), JSON.stringify({ ...JSON.parse(original), readerSignature: "changed" }), JSON.stringify({ ...JSON.parse(original), records: { invalid: {} } })]) {
    await writeFile(data.outputPath, contents);
    await assert.rejects(readArchive(data, noFetch));
    assert.equal(await readFile(data.outputPath, "utf8"), contents);
  }
});

test("source failures do not send partial notes; frozen paths cannot escape the archive", async (context) => {
  const data = await fixture(context, 700);
  const subsetPath = join(data.directory, "subset.json");
  const names = [...data.filenames];
  names[0] = "../outside.md";
  await writeFile(subsetPath, JSON.stringify(names));
  await assert.rejects(loadReadingCorpus(data.folderPath, subsetPath), /Invalid archive-relative/u);
  await writeFile(join(data.directory, "outside.md"), "Must not send outside text");
  await symlink(join(data.directory, "outside.md"), join(data.folderPath, "escape.md"));
  names[0] = "escape.md";
  await writeFile(subsetPath, JSON.stringify(names));
  const loaded = await loadReadingCorpus(data.folderPath, subsetPath);
  assert.match(loaded.notes[0].error.message, /outside the archive/u);
  const result = await readArchive({ ...data, subsetPath, limit: 2 }, { fetchImpl: async (_url, options) => {
    assert.doesNotMatch(options.body, /outside text/u);
    return resultFor(options);
  } });
  assert.equal(result.run.attempts.length, 2);
  assert.equal(result.run.attempts[0].providerCalled, false);
  assert.equal(result.run.summary.totalCostUsd, 0.0004);
  assert.equal(result.run.summary.unknownCostAttempts, 0);
});

test("interrupt stops scheduling but saves in-flight results for resuming", async (context) => {
  const data = await fixture(context, 10);
  const stop = new AbortController();
  const result = await readArchive(data, { signal: stop.signal, fetchImpl: async (_url, options) => {
    stop.abort();
    return resultFor(options);
  } });
  assert.equal(result.run.status, "interrupted");
  assert.equal(result.run.attempts.length, 1);
  assert.equal(result.run.remaining, 9);
  assert.equal(Object.keys(JSON.parse(await readFile(data.outputPath, "utf8")).records).length, 1);
  await assert.rejects(stat(`${data.outputPath}.lock`), { code: "ENOENT" });
});

test("attempt totals include cache tokens and distinguish unknown cost from no provider call", () => {
  const summary = summarizeAttempts([
    { providerCalled: false },
    { providerCalled: true, usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 }, costEstimate: { totalUsd: 0.1 } },
    { providerCalled: true, usage: null, costEstimate: null }
  ]);
  assert.equal(summary.knownTokens, 100);
  assert.equal(summary.unknownCostAttempts, 1);
  assert.equal(summary.totalCostUsd, null);
  assert.equal(summary.knownCostUsd, 0.1);
});

test("reading CLI help works without credentials", async () => {
  const env = { ...process.env, LAB_KEY: "" };
  delete env.NODE_TEST_CONTEXT;
  const { stdout } = await promisify(execFile)(process.execPath, ["test/read-archive.mjs", "--help"], { env });
  assert.match(stdout, /--limit N/u);
  assert.match(stdout, /AFTER skipping saved readings/u);
});

test("reading CLI startup dry run processes 50 frozen notes in a real subprocess", async (context) => {
  const data = await fixture(context, 700);
  const subsetPath = join(data.directory, "subset.json");
  await writeFile(subsetPath, JSON.stringify(data.filenames));
  // Exercise the actual entrypoint, not imported main/readArchive. Stub transport
  // before startup so this test cannot send private notes or incur provider costs.
  const preload = `globalThis.fetch = async (_url, options) => {
    const note = JSON.parse(options.body);
    return new Response(JSON.stringify({
      record: { noteId: note.noteId, date: note.date, ...${JSON.stringify(reading)} },
      reader: ${JSON.stringify(READING_CONFIG)}, readerSignature: ${JSON.stringify(READING_SIGNATURE)},
      model: "claude-sonnet-5", providerCalled: false,
      usage: { input_tokens: 0, output_tokens: 0 }
    }));
  };`;
  const env = { ...process.env, LAB_KEY: "dry-run-only" };
  delete env.NODE_TEST_CONTEXT;
  delete env.ANTHROPIC_API_KEY;
  const preloadPath = join(data.directory, "dry-run-fetch.mjs");
  await writeFile(preloadPath, preload);
  const { stdout, stderr } = await promisify(execFile)(process.execPath, [
    "--import", preloadPath,
    "test/read-archive.mjs", data.folderPath,
    "--subset", subsetPath, "--limit", "50", "--output", data.outputPath
  ], { env, timeout: 30_000 });
  assert.equal(stderr, "");
  assert.match(stdout, /50 saved, 0 failed, 0 skipped; 650 pending/u);
  assert.match(stdout, /Status: completed/u);
  assert.doesNotMatch(stdout, /before initialization|Usage:/u);
  const saved = JSON.parse(await readFile(data.outputPath, "utf8"));
  assert.deepEqual(Object.keys(saved.records).sort(), data.filenames.slice(0, 50));
  assert.equal(saved.runs[0].attempts.length, 50);
  assert.ok(saved.runs[0].attempts.every((attempt) => attempt.providerCalled === false));
  assert.equal(saved.totals.totalCostUsd, 0);
});
