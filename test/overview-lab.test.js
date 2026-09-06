import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import handler, { OVERVIEW_PROMPT_VERSION } from "../api/import-overview.js";
import { buildSubset, loadNotes, selectSubset, SUBSET_SIZE } from "./overview-corpus.mjs";
import { parseArguments, runOverview } from "./overview-lab.mjs";
import { formatGroupedRuns, formatRunTable, loadRunRecords, saveRun, updatePromptBacklog } from "./overview-records.mjs";

test("subset selection is deterministic, unique, and independent of enumeration order", () => {
  const filenames = Array.from({ length: 2284 }, (_, index) => `folder/note-${index}.md`);
  const selection = selectSubset(filenames);
  assert.equal(selection.length, SUBSET_SIZE);
  assert.equal(new Set(selection).size, SUBSET_SIZE);
  assert.deepEqual(selection, selectSubset([...filenames].reverse()));
  assert.deepEqual(selection, [...selection].sort());
  assert.equal(createHash("sha256").update(JSON.stringify(selection)).digest("hex"), "b191960f9b887a7a488ae09f132bb0a66885bedee7d989074069eeaa30693111");
  assert.ok(selection.every((name) => filenames.includes(name)));
  assert.throws(() => selectSubset(filenames.slice(0, 699)), /at least 700/u);
});

test("subset builder samples filenames without excluding empty or oversized notes, then preserves the manifest", async (context) => {
  const directory = await temporaryDirectory(context);
  const folder = join(directory, "notes");
  await mkdir(join(folder, "nested"), { recursive: true });
  for (let index = 0; index < 698; index += 1) {
    await writeFile(join(folder, `note-${index}.md`), `# Note ${index}\nText`);
  }
  await writeFile(join(folder, "nested", "empty.txt"), "");
  await writeFile(join(folder, "oversized.md"), "x".repeat(110000));
  await writeFile(join(folder, "not-a-note.png"), "not sampled");
  const manifest = join(directory, "subset.json");
  const selection = await buildSubset(folder, manifest);
  assert.equal(selection.length, 700);
  assert.ok(selection.includes("nested/empty.txt"));
  assert.ok(selection.includes("oversized.md"));
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), selection);
  assert.deepEqual(await buildSubset(folder, manifest), selection);
  assert.equal((await stat(manifest)).mode & 0o777, 0o600);
  assert.equal((await loadNotes(folder)).length, 698); // Existing full-folder behaviour.
  await assert.rejects(loadNotes(folder, manifest), /Frozen note exceeds/u);
  await writeFile(join(folder, "oversized.md"), "Now within the existing API limit");
  const loaded = await loadNotes(folder, manifest);
  assert.equal(loaded.length, 700);
  assert.equal(loaded.find((note) => note.id === "nested/empty.txt").text, "");
  await writeFile(join(folder, "new-file.md"), "Added later, must not enter a saved subset");
  assert.equal((await loadNotes(folder, manifest)).length, 700);
  await assert.rejects(buildSubset(folder, manifest), /Refusing to replace frozen subset/u);
  assert.deepEqual(JSON.parse(await readFile(manifest, "utf8")), selection);
  await rm(join(folder, "note-0.md"));
  await assert.rejects(loadNotes(folder, manifest), /ENOENT/u);
});

test("saved subsets reject malformed lists, traversal, and symlinks escaping the archive", async (context) => {
  const directory = await temporaryDirectory(context);
  const folder = join(directory, "notes");
  await mkdir(folder);
  const manifest = join(directory, "subset.json");
  await writeFile(manifest, JSON.stringify(["one.md"]));
  await assert.rejects(loadNotes(folder, manifest), /exactly 700/u);
  await writeFile(manifest, JSON.stringify(Array(700).fill("one.md")));
  await assert.rejects(loadNotes(folder, manifest), /unique/u);
  const filenames = Array.from({ length: 700 }, (_, index) => `${index}.md`);
  filenames[0] = "../outside.md";
  await writeFile(manifest, JSON.stringify(filenames));
  await assert.rejects(loadNotes(folder, manifest), /Invalid note filename/u);
  await writeFile(join(directory, "outside.md"), "Outside the archive");
  await symlink(join(directory, "outside.md"), join(folder, "escape.md"));
  filenames[0] = "escape.md";
  await writeFile(manifest, JSON.stringify(filenames));
  await assert.rejects(loadNotes(folder, manifest), /outside the archive/u);
});

test("CLI parses subset/run/list commands and rejects combinations that alter frozen samples", async () => {
  assert.equal((await parseArguments(["build-subset", "/notes"])).command, "build-subset");
  assert.equal((await parseArguments(["/notes", "--subset", "selection.json"])).subsetPath, resolve("selection.json"));
  assert.deepEqual(await parseArguments(["runs", "--limit", "5"]), { command: "runs", limit: 5, groupByVersion: false });
  assert.deepEqual(await parseArguments(["runs", "--group-by-version"]), { command: "runs", limit: undefined, groupByVersion: true });
  assert.equal((await parseArguments(["/notes", "--lab", "Test instructions"])).labInstructions, "Test instructions");
  for (const args of [
    ["/notes", "--subset", "selection.json", "--limit", "3"],
    ["runs", "--group-by-version", "--limit", "3"],
    ["build-subset", "/notes", "--limit", "3"],
    ["/notes", "--limit", "0"],
    ["/notes", "--subset"],
    ["/notes", "--lab", "@"],
    ["/notes", "--birthdate", "1990-01-01"]
  ]) await assert.rejects(parseArguments(args));
});

test("run records round-trip deployed prompt, raw output, privacy-screened result, cache usage, cost and corpus", async (context) => {
  const directory = await temporaryDirectory(context);
  const folder = join(directory, "notes");
  await mkdir(folder);
  await writeFile(join(folder, "source.md"), "# Source\nA source note");
  const restore = installEnvironment(context);
  const raw = {
    model: "claude-sonnet-5",
    content: [{ type: "tool_use", name: "submit_import_overview", input: {
      portrait: "You keep useful lists. Therapy shaped your plans. You build practical things.",
      read: "You work in drafts.", forgottenIdeas: [], tender: "You packed lunch. You kept the note.",
      questions: ["What changed?", "What stayed?", "What matters?"]
    } }],
    stop_reason: "tool_use",
    usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 100000, output_tokens: 3000 }
  };
  let upstream;
  globalThis.fetch = async (_url, options) => {
    upstream = JSON.parse(options.body);
    return new Response(JSON.stringify(raw));
  };
  const result = await runOverview({ folderPath: folder }, {
    recordPaths: { runsDirectory: join(directory, "runs"), backlogPath: join(directory, "backlog.json") },
    fetchImpl: async (_url, options) => {
      const response = { headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
      await handler({ method: "POST", headers: options.headers, body: JSON.parse(options.body) }, response);
      return new Response(response.body, { status: response.statusCode });
    }
  });
  const saved = JSON.parse(await readFile(result.outputPath, "utf8"));
  assert.deepEqual(saved, result.record);
  assert.equal(saved.promptVersion, OVERVIEW_PROMPT_VERSION);
  assert.equal(saved.systemPrompt, upstream.system[0].text);
  assert.deepEqual(saved.toolSchema, upstream.tools[0]);
  assert.deepEqual(saved.rawModelResponse, raw);
  assert.doesNotMatch(saved.finalScreenedResponse.portrait, /Therapy/u);
  assert.equal(saved.finalScreenedResponse.evaluation, undefined);
  assert.deepEqual(saved.usage, raw.usage);
  assert.equal(saved.costEstimate.totalUsd, 0.05);
  assert.equal(saved.corpus.type, "full");
  assert.equal(saved.corpus.noteCount, 1);
  assert.equal(saved.corpus.usedNoteCount, 1);
  assert.deepEqual(saved.corpus.filenames, ["source.md"]);
  assert.match(saved.corpus.sha256, /^[a-f0-9]{64}$/u);
  assert.ok(saved.latencyMs >= 0);
  assert.equal((await stat(result.outputPath)).mode & 0o777, 0o600);
  assert.equal(saved.error, null);
  assert.equal(result.backlogWarning, null);
  assert.equal(JSON.parse(await readFile(join(directory, "backlog.json"), "utf8"))[0].systemPrompt, upstream.system[0].text);
  assert.ok(restore.logs.length > 0);
});

test("failed and old-server runs are saved with unknown metadata rather than invented local prompt versions", async (context) => {
  const directory = await temporaryDirectory(context);
  const folder = join(directory, "notes");
  await mkdir(folder);
  await writeFile(join(folder, "one.md"), "Source");
  installEnvironment(context);
  const recordPaths = { runsDirectory: join(directory, "runs"), backlogPath: join(directory, "backlog.json") };
  const failed = await runOverview({ folderPath: folder }, { recordPaths, fetchImpl: async () => { throw new Error("network failure"); } });
  assert.equal(failed.record.error.message, "network failure");
  assert.equal(failed.record.costEstimate, null);
  assert.equal(failed.record.systemPrompt, null);
  const old = await runOverview({ folderPath: folder }, { recordPaths, fetchImpl: async () => new Response(JSON.stringify({ portrait: "An old server response" })) });
  assert.match(old.record.error.message, /deploy the updated endpoint/u);
  assert.equal(old.record.promptVersion, null);
  assert.equal((await loadRunRecords(recordPaths.runsDirectory)).length, 2);
});

test("frozen runs send exactly the saved filenames and record subset identity", async (context) => {
  const directory = await temporaryDirectory(context);
  const folder = join(directory, "notes");
  await mkdir(folder);
  const filenames = Array.from({ length: 700 }, (_, index) => `${index}.md`);
  for (const name of filenames) await writeFile(join(folder, name), "Source");
  await writeFile(join(folder, "not-selected.md"), "Must not be included");
  const subsetPath = join(directory, "subset.json");
  await writeFile(subsetPath, JSON.stringify(filenames));
  installEnvironment(context);
  const result = await runOverview({ folderPath: folder, subsetPath }, {
    recordPaths: { runsDirectory: join(directory, "runs"), backlogPath: join(directory, "backlog.json") },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.notes.map((note) => note.id).sort(), [...filenames].sort());
      assert.equal(body.includeEvaluation, true);
      return new Response(JSON.stringify({ error: { message: "Simulated provider failure" } }), { status: 502 });
    }
  });
  assert.equal(result.record.corpus.type, "subset");
  assert.equal(result.record.corpus.selection, "frozen_random");
  assert.equal(result.record.corpus.noteCount, 700);
  assert.equal(result.record.corpus.subsetFile, subsetPath);
  assert.equal(result.record.statusCode, 502);
});

test("backlog auto-appends new versions, preserves descriptions, and rejects version reuse", async (context) => {
  const directory = await temporaryDirectory(context);
  const backlogPath = join(directory, "backlog.json");
  const record = sampleRecord();
  await updatePromptBacklog(record, backlogPath);
  const entries = JSON.parse(await readFile(backlogPath, "utf8"));
  entries[0].description = "A manually written change description";
  await writeFile(backlogPath, JSON.stringify(entries));
  await updatePromptBacklog(record, backlogPath);
  assert.equal(JSON.parse(await readFile(backlogPath, "utf8"))[0].description, entries[0].description);
  await assert.rejects(updatePromptBacklog({ ...record, systemPrompt: "Changed without a version bump" }, backlogPath), /version bump/u);
  await Promise.all(["v2", "v3"].map((promptVersion) => updatePromptBacklog({ ...record, promptVersion }, backlogPath)));
  const updated = JSON.parse(await readFile(backlogPath, "utf8"));
  assert.deepEqual(updated.map((entry) => entry.version).sort(), ["v1", "v2", "v3"]);
  assert.equal(updated.find((entry) => entry.version === "v2").description, "TODO: describe what changed");
});

test("run listings sort newest first, group every version, retain failed runs and skip legacy files", async (context) => {
  const directory = await temporaryDirectory(context);
  const paths = { runsDirectory: join(directory, "runs"), backlogPath: join(directory, "backlog.json") };
  await saveRun(sampleRecord(), paths);
  await saveRun({ ...sampleRecord(), promptVersion: "v2", timestamp: "2026-09-06T12:00:00.000Z", corpus: { type: "subset", noteCount: 700, usedNoteCount: 700 } }, paths);
  await saveRun({ ...sampleRecord(), promptVersion: "v2", timestamp: "2026-09-06T13:00:00.000Z", statusCode: 502, costEstimate: null }, paths);
  await writeFile(join(paths.runsDirectory, "legacy.json"), JSON.stringify({ portrait: "No metadata" }));
  const records = await loadRunRecords(paths.runsDirectory);
  assert.equal(records.length, 3);
  assert.equal(records[0].statusCode, 502);
  const table = formatRunTable(records);
  assert.match(table, /VERSION\s+CORPUS\s+COST USD\s+LATENCY\s+TIMESTAMP/u);
  assert.match(table, /subset \(700\)/u);
  assert.match(table, /\$0\.0500/u);
  assert.match(table, /unknown/u);
  const groups = formatGroupedRuns(records);
  assert.match(groups, /v2 — 2 run\(s\)/u);
  assert.match(groups, /v1 — 1 run\(s\)/u);
});

test("actual CLI lists recent runs and groups all versions without API credentials", async (context) => {
  const directory = await temporaryDirectory(context);
  const paths = { runsDirectory: join(directory, "test", "overview-runs"), backlogPath: join(directory, "test", "overview-prompt-backlog.json") };
  await saveRun(sampleRecord(), paths);
  await saveRun({ ...sampleRecord(), promptVersion: "v2", timestamp: "2026-09-06T12:00:00.000Z" }, paths);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.LAB_KEY;
  delete env.ANTHROPIC_API_KEY;
  const cli = fileURLToPath(new URL("./overview-lab.mjs", import.meta.url));
  const recent = await promisify(execFile)(process.execPath, [cli, "runs", "--limit", "1"], { cwd: directory, env });
  assert.match(recent.stdout, /v2/u);
  assert.doesNotMatch(recent.stdout, /v1/u);
  const grouped = await promisify(execFile)(process.execPath, [cli, "runs", "--group-by-version"], { cwd: directory, env });
  assert.match(grouped.stdout, /v1 — 1 run/u);
  assert.match(grouped.stdout, /v2 — 1 run/u);
});

function sampleRecord() {
  return { recordVersion: 1, timestamp: "2026-09-06T11:00:00.000Z", promptVersion: "v1", systemPrompt: "Full test prompt", corpus: { type: "full", noteCount: 2284 }, costEstimate: { totalUsd: 0.05 }, latencyMs: 1200, statusCode: 200 };
}

async function temporaryDirectory(context) {
  const directory = await mkdtemp(join(tmpdir(), "overview-eval-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function installEnvironment(context) {
  const previous = { apiKey: process.env.ANTHROPIC_API_KEY, labKey: process.env.LAB_KEY, fetch: globalThis.fetch, log: console.log, error: console.error };
  const logs = [];
  process.env.ANTHROPIC_API_KEY = "test-provider-key";
  process.env.LAB_KEY = "test-lab-key";
  console.log = (...args) => logs.push(args);
  console.error = (...args) => logs.push(args);
  context.after(() => {
    for (const [name, value] of [["ANTHROPIC_API_KEY", previous.apiKey], ["LAB_KEY", previous.labKey]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    globalThis.fetch = previous.fetch;
    console.log = previous.log;
    console.error = previous.error;
  });
  return { logs };
}
