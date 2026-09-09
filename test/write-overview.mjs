import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildReadingsPrompt, prepareReadings } from "../api/write-overview.js";
import { formatRunTable, saveRun } from "./overview-records.mjs";

const DEFAULT_ENDPOINT = "https://project-ymuos.vercel.app/api/write-overview";
const REQUEST_TIMEOUT_MS = 300_000;
const USAGE = `Usage:
  node test/write-overview.mjs <readings.json> [--endpoint URL]

Requires LAB_KEY, matching the server's LAB_KEY. Sends all successful readings in
one request; never reads the original archive and never retries automatically.
Saves private evaluation records under test/overview-runs/ and prints cost/latency.
Compare with: node test/overview-lab.mjs runs --group-by-version`;

export function parseArguments(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { help: true };
  let readingsPath;
  let endpoint;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--endpoint") {
      if (endpoint !== undefined) throw new Error("--endpoint may only be provided once");
      endpoint = args[++index];
      if (!endpoint || endpoint.startsWith("--")) throw new Error("--endpoint requires a URL");
    } else if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    else if (readingsPath !== undefined) throw new Error("Provide exactly one readings file");
    else readingsPath = resolve(argument === "~" ? homedir() : argument.startsWith("~/") ? join(homedir(), argument.slice(2)) : argument);
  }
  if (!readingsPath) throw new Error("Missing readings file");
  validateEndpoint(endpoint || DEFAULT_ENDPOINT);
  return { readingsPath, endpoint: endpoint || DEFAULT_ENDPOINT };
}

function validateEndpoint(endpoint) {
  const url = new URL(endpoint);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && local))) {
    throw new Error("--endpoint requires HTTPS (HTTP is allowed only for localhost); do not put credentials in the URL");
  }
}

export async function runWritingOverview(options, { fetchImpl = globalThis.fetch, recordPaths } = {}) {
  if (!process.env.LAB_KEY) throw new Error("LAB_KEY must be set for the lab-only writing pass");
  const endpoint = options.endpoint || DEFAULT_ENDPOINT;
  validateEndpoint(endpoint);
  const readingsPath = resolve(options.readingsPath);
  const fileText = await readFile(readingsPath, "utf8");
  const source = JSON.parse(fileText);
  const readings = prepareReadings(source);
  const characterCount = buildReadingsPrompt(readings).length;
  const failedReadingCount = source?.failures && typeof source.failures === "object" ? Object.keys(source.failures).length : 0;
  console.log(`Endpoint: ${endpoint}\nReadings: ${readings.length}\nCompact input characters: ${characterCount.toLocaleString("en-US")}`);
  if (failedReadingCount) console.log(`Stage-one failures excluded: ${failedReadingCount}`);

  const startedAt = Date.now();
  let statusCode = null;
  let responseBody = null;
  let runError = null;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/json", "x-lab-key": process.env.LAB_KEY },
      body: JSON.stringify({ readings }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    statusCode = response.status;
    const responseText = await response.text();
    try { responseBody = JSON.parse(responseText); }
    catch {
      responseBody = responseText;
      runError = { message: `Endpoint returned non-JSON (HTTP ${statusCode})` };
    }
    if (!response.ok) runError = responseBody?.error || runError || { message: `Endpoint returned HTTP ${statusCode}` };
    else if (!responseBody?.evaluation) runError ||= { message: "Endpoint did not return evaluation metadata; deploy api/write-overview.js" };
  } catch (error) {
    runError = { name: error.name, message: error.message };
  }
  const latencyMs = Date.now() - startedAt;
  const evaluation = responseBody?.evaluation;
  let finalScreenedResponse = responseBody;
  if (evaluation) {
    const { evaluation: _evaluation, ...finalResponse } = responseBody;
    finalScreenedResponse = finalResponse;
  }
  const record = {
    recordVersion: 1,
    timestamp: new Date(startedAt).toISOString(),
    endpoint,
    mode: "write-overview",
    promptVersion: evaluation?.promptVersion ?? null,
    systemPrompt: evaluation?.systemPrompt ?? null,
    toolSchema: evaluation?.toolSchema ?? null,
    model: evaluation?.model ?? null,
    requestedModel: evaluation?.requestedModel ?? null,
    generation: evaluation?.generation ?? null,
    corpus: {
      type: "readings", selection: "all_successful_readings",
      readingsFile: readingsPath,
      readerPromptVersion: source?.reader?.promptVersion ?? null,
      readerSignature: source?.readerSignature ?? null,
      failedReadingCount,
      noteCount: readings.length,
      usedNoteCount: evaluation?.corpus?.usedNoteCount ?? null,
      characterCount,
      sha256: createHash("sha256").update(JSON.stringify(readings)).digest("hex"),
      readingsFileSha256: createHash("sha256").update(fileText).digest("hex"),
      filenames: readings.map((reading) => reading.noteId)
    },
    rawModelResponse: evaluation?.rawModelResponse ?? null,
    finalScreenedResponse,
    screeningApplied: evaluation?.screeningApplied === true,
    usage: evaluation?.usage ?? null,
    costEstimate: evaluation?.costEstimate ?? null,
    latencyMs,
    serverLatencyMs: evaluation?.serverLatencyMs ?? null,
    statusCode,
    error: runError
  };
  return { record, ...await saveRun(record, recordPaths) };
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args);
    if (options.help) { console.log(USAGE); return; }
    const { record, outputPath, backlogWarning } = await runWritingOverview(options);
    console.log(`\n${JSON.stringify(record.finalScreenedResponse, null, 2)}\n`);
    console.log(formatRunTable([record]));
    console.log(`Server latency: ${record.serverLatencyMs == null ? "unknown" : `${(record.serverLatencyMs / 1000).toFixed(2)}s`}`);
    console.log(`Usage: ${JSON.stringify(record.usage)}\nSaved to: ${outputPath}`);
    if (record.error) console.error(JSON.stringify(record.error));
    if (backlogWarning) console.error(`Backlog: ${backlogWarning}`);
    if (record.error || record.statusCode !== 200 || backlogWarning) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
  }
}

// Keep initialization above execution (the default node --test discovers .mjs).
if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
