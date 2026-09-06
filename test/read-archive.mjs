import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { estimateAnthropicCost } from "../api/_evaluation.js";
import { isPlainObject } from "../api/_validation.js";
import { MAX_READING_NOTE_TEXT, READING_CONFIG, READING_SIGNATURE, validateReading } from "../api/read-note.js";
import { listNoteFiles, SUBSET_SIZE } from "./overview-corpus.mjs";

const DEFAULT_ENDPOINT = "https://project-ymuos.vercel.app/api/read-note";
const DEFAULT_OUTPUT = resolve("test/overview-runs/archive-reading.json");
const REQUEST_TIMEOUT_MS = 165_000;
const USAGE = `Usage:
  node test/read-archive.mjs <folder> [--subset test/overview-subset.json]
    [--limit N] [--concurrency N] [--output test/overview-runs/archive-reading.json]
    [--endpoint URL]

Requires LAB_KEY. Default concurrency: 5 (maximum 20).
--limit caps pending notes attempted this invocation, AFTER skipping saved readings.
Reuse --output to resume; failed notes are retried once on the next invocation.
Note IDs are stable archive-relative filenames, not renumbered by subset or limit.
Readings are private, unscreened lab material, NOT an app-facing overview.`;

if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

export function parseArguments(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  const values = {};
  let folder;
  for (let i = 0; i < args.length; i += 1) {
    const argument = args[i];
    if (["--subset", "--limit", "--concurrency", "--output", "--endpoint"].includes(argument)) {
      if (Object.hasOwn(values, argument)) throw new Error(`Duplicate option: ${argument}`);
      const value = args[++i];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      values[argument] = value;
    } else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (folder !== undefined) throw new Error("Provide exactly one archive folder");
    else folder = argument;
  }
  if (!folder) throw new Error("Missing archive folder");
  const positiveInteger = (name, fallback) => {
    if (values[name] === undefined) return fallback;
    const number = Number(values[name]);
    if (!/^\d+$/u.test(values[name]) || !Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive integer`);
    return number;
  };
  const options = {
    folderPath: expandPath(folder),
    subsetPath: values["--subset"] ? expandPath(values["--subset"]) : undefined,
    outputPath: values["--output"] ? expandPath(values["--output"]) : DEFAULT_OUTPUT,
    endpoint: values["--endpoint"] || DEFAULT_ENDPOINT,
    concurrency: positiveInteger("--concurrency", 5),
    limit: positiveInteger("--limit", undefined)
  };
  validateOptions(options);
  return options;
}

function validateOptions(options) {
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 20) throw new Error("--concurrency must be between 1 and 20");
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error("--limit must be a positive integer");
  if (extname(options.outputPath).toLowerCase() !== ".json") throw new Error("--output must name a JSON file");
  const url = new URL(options.endpoint);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("--endpoint requires HTTPS (HTTP is allowed only for localhost); do not put credentials in the URL");
  }
}

function expandPath(path) {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function loadReadingCorpus(folderPath, subsetPath) {
  const folder = await realpath(folderPath);
  if (!(await stat(folder)).isDirectory()) throw new Error("Archive must be a directory");
  const names = subsetPath ? JSON.parse(await readFile(subsetPath, "utf8")) : await listNoteFiles(folder);
  if (!Array.isArray(names) || (subsetPath && names.length !== SUBSET_SIZE) || new Set(names).size !== names.length) {
    throw new Error(`Frozen subset must contain exactly ${SUBSET_SIZE} unique relative filenames`);
  }
  // Validate the whole manifest before reading/sending anything, including a limited run.
  for (const name of names) {
    if (typeof name !== "string" || !name || isAbsolute(name) || name.includes("\\") || name.split("/").includes("..") || ![".md", ".txt"].includes(extname(name).toLowerCase())) {
      throw new Error("Invalid archive-relative note filename");
    }
  }
  const notes = [];
  for (const filename of [...names].sort()) {
    const note = { noteId: filename, filename };
    try {
      const actual = await realpath(resolve(folder, filename));
      const fromRoot = relative(folder, actual);
      if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) throw new Error("Note resolves outside the archive");
      const info = await stat(actual);
      if (!info.isFile()) throw new Error("Not a regular note file");
      if (info.size > MAX_READING_NOTE_TEXT * 4) throw new Error(`Note exceeds ${MAX_READING_NOTE_TEXT} characters; not truncated`);
      note.text = await readFile(actual, "utf8");
      if (note.text.length > MAX_READING_NOTE_TEXT) throw new Error(`Note exceeds ${MAX_READING_NOTE_TEXT} characters; not truncated`);
      const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(note.text);
      note.title = heading?.[1]?.trim() || basename(filename, extname(filename));
      note.date = (info.birthtimeMs > 0 ? info.birthtime : info.mtime).toISOString();
      note.sourceHash = hash({ noteId: note.noteId, date: note.date, title: note.title, text: note.text });
    } catch (error) {
      note.error = { type: "source_error", message: error.code ? `Cannot read source (${error.code})` : error.message };
      delete note.text;
    }
    notes.push(note);
  }
  return { folder, notes, selection: subsetPath ? "frozen_subset" : "full", filenamesHash: hash([...names].sort()) };
}

export function summarizeAttempts(attempts) {
  const usage = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
  let knownCostUsd = 0;
  let unknownCostAttempts = 0;
  let unknownUsageAttempts = 0;
  for (const attempt of attempts) {
    if (!attempt.providerCalled) continue;
    if (attempt.usage && Number.isFinite(attempt.usage.input_tokens) && Number.isFinite(attempt.usage.output_tokens)) {
      for (const field of Object.keys(usage)) usage[field] += Math.max(0, Number(attempt.usage[field]) || 0);
    } else unknownUsageAttempts += 1;
    if (Number.isFinite(attempt.costEstimate?.totalUsd)) knownCostUsd += attempt.costEstimate.totalUsd;
    else unknownCostAttempts += 1;
  }
  return {
    usage, knownTokens: Object.values(usage).reduce((sum, value) => sum + value, 0), unknownUsageAttempts,
    knownCostUsd: Number(knownCostUsd.toFixed(9)), unknownCostAttempts,
    totalCostUsd: unknownCostAttempts ? null : Number(knownCostUsd.toFixed(9))
  };
}

async function requestReading(note, endpoint, labKey, fetchImpl) {
  const startedAt = Date.now();
  const attempt = { noteId: note.noteId, startedAt: new Date(startedAt).toISOString(), status: "failed", providerCalled: false, usage: null, costEstimate: null, statusCode: null };
  let record;
  if (note.error) attempt.error = note.error;
  else {
    // Network loss may hide a billed provider call; do not report it as free.
    attempt.providerCalled = true;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST", redirect: "manual",
        headers: { "Content-Type": "application/json", "x-lab-key": labKey },
        body: JSON.stringify({ noteId: note.noteId, date: note.date, title: note.title, text: note.text }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
      attempt.statusCode = response.status;
      let payload;
      try { payload = JSON.parse(await response.text()); }
      catch { throw new Error(`Endpoint returned non-JSON (HTTP ${response.status})`); }
      attempt.providerCalled = payload?.providerCalled !== false;
      attempt.usage = isPlainObject(payload?.usage) ? payload.usage : null;
      attempt.costEstimate = estimateAnthropicCost(attempt.usage, payload?.reader?.model);
      if (!response.ok) {
        attempt.error = { type: payload?.error?.type || "endpoint_error", message: typeof payload?.error?.message === "string" ? payload.error.message : `Endpoint returned HTTP ${response.status}`, ...(payload?.error?.providerStatus ? { providerStatus: payload.error.providerStatus } : {}) };
      } else if (payload?.readerSignature !== READING_SIGNATURE || hash(payload.reader) !== READING_SIGNATURE) {
        attempt.error = { type: "reader_mismatch", message: "Endpoint reader differs from this runner; deploy matching code or use a matching checkout" };
      } else if (!validateReading(payload.record) || payload.record.noteId !== note.noteId || payload.record.date !== note.date) {
        attempt.error = { type: "invalid_record", message: "Endpoint returned an invalid reading or mismatched note identity/date" };
      } else {
        record = { noteId: note.noteId, date: note.date, ...validateReading(payload.record), filename: note.filename, sourceHash: note.sourceHash, model: payload.model || payload.reader.model, readAt: new Date().toISOString() };
        attempt.status = "succeeded";
      }
    } catch (error) {
      attempt.error = { type: ["TimeoutError", "AbortError"].includes(error.name) ? "request_timeout" : "request_error", message: error.message };
    }
  }
  attempt.latencyMs = Date.now() - startedAt;
  return { attempt, record };
}

async function atomicSave(path, state) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(state, null, 2)}\n`);
    await file.sync();
    await file.close();
    file = undefined;
    await rename(temporary, path);
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; });
  }
}

export async function readArchive(options, { fetchImpl = globalThis.fetch, signal, onProgress = () => {} } = {}) {
  const labKey = process.env.LAB_KEY;
  if (!labKey) throw new Error("LAB_KEY must be set before reading an archive");
  options = { concurrency: 5, endpoint: DEFAULT_ENDPOINT, outputPath: DEFAULT_OUTPUT, ...options };
  validateOptions(options);
  const startedAt = Date.now();
  const corpus = await loadReadingCorpus(options.folderPath, options.subsetPath);
  const outputPath = resolve(options.outputPath);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const lockPath = `${outputPath}.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw new Error(`Output is locked: ${lockPath}; another reader may be running`); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date(startedAt).toISOString() }));
    let state;
    try {
      if (!(await lstat(outputPath)).isFile()) throw new Error("Output must be a regular file, not a symlink");
      state = JSON.parse(await readFile(outputPath, "utf8"));
      if (state?.formatVersion !== 1 || state.stage !== "archive-reading" || state.folder !== corpus.folder || state.readerSignature !== READING_SIGNATURE ||
          hash(state.reader) !== READING_SIGNATURE || !isPlainObject(state.records) || !isPlainObject(state.failures) || !Array.isArray(state.runs)) {
        throw new Error("Output belongs to a different archive/reader or is malformed; use a new --output file");
      }
      for (const [id, record] of Object.entries(state.records)) {
        if (!validateReading(record) || record.noteId !== id || typeof record.sourceHash !== "string") throw new Error("Saved reading is malformed; refusing to overwrite the output");
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      state = { formatVersion: 1, stage: "archive-reading", createdAt: new Date(startedAt).toISOString(), folder: corpus.folder, readerSignature: READING_SIGNATURE, reader: READING_CONFIG, records: {}, failures: {}, runs: [] };
    }
    for (const note of corpus.notes) {
      const saved = state.records[note.noteId];
      if (saved && (note.error || saved.sourceHash !== note.sourceHash || saved.date !== note.date)) throw new Error(`Source changed or cannot be checked for saved note ${note.noteId}; use a new --output file`);
    }
    const pending = corpus.notes.filter((note) => !Object.hasOwn(state.records, note.noteId));
    const selected = pending.slice(0, options.limit ?? pending.length);
    const run = {
      startedAt: new Date(startedAt).toISOString(), endpoint: options.endpoint,
      selection: corpus.selection, subsetFile: options.subsetPath ? resolve(options.subsetPath) : null,
      filenamesHash: corpus.filenamesHash, corpusNoteCount: corpus.notes.length,
      skipped: corpus.notes.length - pending.length, selected: selected.length,
      concurrency: options.concurrency, limit: options.limit ?? null, status: "running", attempts: []
    };
    state.runs.push(run);
    let checkpoint = Promise.resolve();
    const save = () => {
      checkpoint = checkpoint.then(async () => {
        state.updatedAt = new Date().toISOString();
        run.elapsedMs = Date.now() - startedAt;
        run.summary = summarizeAttempts(run.attempts);
        state.totals = summarizeAttempts(state.runs.flatMap((item) => item.attempts));
        await atomicSave(outputPath, state);
      });
      return checkpoint;
    };
    await save();
    let cursor = 0;
    let diskError;
    async function worker() {
      while (!diskError && !signal?.aborted && cursor < selected.length) {
        const note = selected[cursor++];
        const { record, attempt } = await requestReading(note, options.endpoint, labKey, fetchImpl);
        run.attempts.push(attempt);
        if (record) {
          state.records[note.noteId] = record;
          delete state.failures[note.noteId];
        } else state.failures[note.noteId] = attempt;
        try { await save(); }
        catch (error) { diskError = error; }
        onProgress({ noteId: note.noteId, status: attempt.status, completed: run.attempts.length, selected: selected.length });
      }
    }
    await Promise.all(Array.from({ length: Math.min(options.concurrency, selected.length) }, () => worker()));
    if (diskError) throw diskError;
    run.status = signal?.aborted ? "interrupted" : run.attempts.some((attempt) => attempt.status === "failed") ? "completed_with_failures" : "completed";
    run.finishedAt = new Date().toISOString();
    run.remaining = corpus.notes.filter((note) => !Object.hasOwn(state.records, note.noteId)).length;
    await save();
    return { outputPath, state, run };
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export function formatSummary({ outputPath, state, run }) {
  const cost = (summary) => summary.totalCostUsd === null
    ? `$${summary.knownCostUsd.toFixed(4)} known + ${summary.unknownCostAttempts} attempt(s) with unknown cost`
    : `$${summary.totalCostUsd.toFixed(4)}`;
  const failed = run.attempts.filter((attempt) => attempt.status === "failed");
  return [
    `Reader: ${state.reader.promptVersion} (${state.reader.model})`,
    `This invocation: ${run.attempts.length - failed.length} saved, ${failed.length} failed, ${run.skipped} skipped; ${run.remaining} pending in this corpus`,
    `Elapsed: ${(run.elapsedMs / 1000).toFixed(2)}s | Cost USD: ${cost(run.summary)}`,
    `Tokens (known): ${run.summary.knownTokens} | input ${run.summary.usage.input_tokens}, output ${run.summary.usage.output_tokens}, cache reads ${run.summary.usage.cache_read_input_tokens}, cache writes ${run.summary.usage.cache_creation_input_tokens} | unknown usage: ${run.summary.unknownUsageAttempts} attempt(s)`,
    `All invocations: ${Object.keys(state.records).length} saved readings | Cost USD: ${cost(state.totals)} | Known tokens: ${state.totals.knownTokens}`,
    ...failed.map((attempt) => `FAILED ${attempt.noteId}: ${attempt.error.type} — ${attempt.error.message}`),
    `Status: ${run.status} | Saved to: ${outputPath}`
  ].join("\n");
}

export async function main(args = process.argv.slice(2)) {
  const stop = new AbortController();
  const interrupt = () => { console.error("Stopping after in-flight readings are saved; rerun to resume."); stop.abort(); };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const options = parseArguments(args);
    if (options.help) { console.log(USAGE); return; }
    const result = await readArchive(options, { signal: stop.signal, onProgress: ({ completed, selected, status }) => console.log(`${completed}/${selected} ${status}`) });
    console.log(formatSummary(result));
    if (result.run.status !== "completed") process.exitCode = result.run.status === "interrupted" ? 130 : 1;
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
