import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

import { buildSubset, DEFAULT_SUBSET_PATH, loadNotes, SUBSET_SEED } from "./overview-corpus.mjs";
import { formatGroupedRuns, formatRunTable, loadRunRecords, saveRun } from "./overview-records.mjs";

const OVERVIEW_ENDPOINT = "https://project-ymuos.vercel.app/api/import-overview";
const LAB_ENDPOINT = "https://project-ymuos.vercel.app/api/lab";
const REQUEST_TIMEOUT_MS = 300_000;
const USAGE = `Usage:
  node test/overview-lab.mjs build-subset <folder> [--output test/overview-subset.json]
  node test/overview-lab.mjs <folder> [--subset test/overview-subset.json | --limit N]
  node test/overview-lab.mjs <folder> [--lab "instructions or @file.txt"] [--endpoint URL]
  node test/overview-lab.mjs runs [--limit N]
  node test/overview-lab.mjs runs --group-by-version

All model runs require LAB_KEY for private evaluation metadata. Listing/building needs no key.
The saved subset is 700 filenames selected with fixed seed ${SUBSET_SEED}.`;

if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}

export async function main(args = process.argv.slice(2)) {
  try {
    const options = await parseArguments(args);
    if (options.command === "help") {
      console.log(USAGE);
      return;
    }
    if (options.command === "build-subset") {
      const filenames = await buildSubset(options.folderPath, options.outputPath);
      console.log(`Saved ${filenames.length} randomly selected filenames (seed ${SUBSET_SEED}) to ${options.outputPath}`);
      return;
    }
    if (options.command === "runs") {
      const records = await loadRunRecords();
      console.log(options.groupByVersion ? formatGroupedRuns(records) : formatRunTable(records.slice(0, options.limit ?? 20)));
      return;
    }

    const { record, outputPath, backlogWarning } = await runOverview(options);
    printSection(`RESPONSE — HTTP ${record.statusCode ?? "unavailable"}`);
    console.log(typeof record.finalScreenedResponse === "string" ? record.finalScreenedResponse : JSON.stringify(record.finalScreenedResponse, null, 2));
    printVerificationSummary(record.finalScreenedResponse);
    printSection("RUN SUMMARY");
    console.log(formatRunTable([record]));
    console.log(`Cache read tokens: ${record.usage?.cache_read_input_tokens ?? "unknown"}`);
    console.log(`Cache write tokens: ${record.usage?.cache_creation_input_tokens ?? "unknown"}`);
    console.log(`Saved to: ${outputPath}`);
    if (backlogWarning) console.error(`Backlog: ${backlogWarning}`);
    if (record.error) console.error(JSON.stringify(record.error));
    if (record.error || record.statusCode < 200 || record.statusCode >= 300 || backlogWarning) process.exitCode = 1;
  } catch (error) {
    printSection("ERROR");
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exitCode = 1;
  }
}

export async function runOverview(options, { fetchImpl = globalThis.fetch, recordPaths } = {}) {
  if (!process.env.LAB_KEY) throw new Error("LAB_KEY must be set to save authenticated, pre-screening evaluation records");
  const { folderPath, limit, subsetPath, labInstructions } = options;
  const notes = await loadNotes(folderPath, subsetPath);
  notes.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const selectedNotes = limit === undefined ? notes : notes.slice(0, limit);
  const totalCharacters = selectedNotes.reduce((total, note) => total + note.text.length, 0);
  const labMode = labInstructions !== undefined;
  const endpoint = options.endpoint || (labMode ? LAB_ENDPOINT : OVERVIEW_ENDPOINT);

  printSection("REQUEST");
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Folder: ${folderPath}`);
  console.log(`Notes: ${selectedNotes.length}`);
  console.log(`Total characters: ${totalCharacters.toLocaleString("en-US")}`);
  if (subsetPath) console.log(`Frozen subset: ${subsetPath}`);
  if (limit !== undefined) console.log(`Most-recent limit: ${limit}`);

  const startedAt = Date.now();
  let statusCode = null;
  let responseBody = null;
  let runError = null;
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-lab-key": process.env.LAB_KEY },
      body: JSON.stringify({ notes: selectedNotes, includeEvaluation: true, ...(labMode ? { instructions: labInstructions } : {}) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    statusCode = response.status;
    const responseText = await response.text();
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      responseBody = responseText;
      runError = { message: `Endpoint returned non-JSON (HTTP ${statusCode}); deploy the evaluation-enabled endpoint` };
    }
    if (!response.ok) {
      runError = responseBody?.error || { message: `Endpoint returned HTTP ${statusCode}` };
    } else if (!responseBody?.evaluation) {
      runError ||= { message: "Endpoint did not return evaluation metadata; deploy the updated endpoint. Prompt, model, raw response and costs are unknown for this run." };
    }
  } catch (error) {
    runError = { name: error.name, message: error.message };
  }
  const latencyMs = Date.now() - startedAt;
  const evaluation = responseBody?.evaluation;
  let finalScreenedResponse = responseBody;
  if (evaluation) {
    const { evaluation: _evaluation, ...finalResponse } = responseBody;
    finalScreenedResponse = labMode && typeof finalResponse.analysis === "string" ? finalResponse.analysis : finalResponse;
  }
  const record = {
    recordVersion: 1,
    timestamp: new Date(startedAt).toISOString(),
    endpoint,
    mode: labMode ? "lab" : "overview",
    promptVersion: evaluation?.promptVersion ?? null,
    systemPrompt: evaluation?.systemPrompt ?? null,
    toolSchema: evaluation?.toolSchema ?? null,
    model: evaluation?.model ?? null,
    requestedModel: evaluation?.requestedModel ?? null,
    generation: evaluation?.generation ?? null,
    corpus: {
      type: subsetPath || limit !== undefined ? "subset" : "full",
      selection: subsetPath ? "frozen_random" : limit !== undefined ? "most_recent" : "full",
      folder: folderPath,
      subsetFile: subsetPath ?? null,
      noteCount: selectedNotes.length,
      usedNoteCount: evaluation?.corpus?.usedNoteCount ?? null,
      characterCount: totalCharacters,
      sha256: createHash("sha256").update(JSON.stringify(selectedNotes)).digest("hex"),
      filenames: selectedNotes.map((note) => note.id)
    },
    rawModelResponse: evaluation?.rawModelResponse ?? null,
    finalScreenedResponse,
    screeningApplied: labMode ? false : statusCode === 200 && !!evaluation,
    usage: evaluation?.usage ?? responseBody?.usage ?? responseBody?.error?.detail?.usage ?? null,
    costEstimate: evaluation?.costEstimate ?? null,
    latencyMs,
    serverLatencyMs: evaluation?.serverLatencyMs ?? null,
    statusCode,
    error: runError
  };
  return { record, ...await saveRun(record, recordPaths) };
}

export async function parseArguments(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { command: "help" };
  const command = ["build-subset", "runs"].includes(args[0]) ? args[0] : "run";
  const values = {};
  let folderArgument;
  let groupByVersion = false;
  for (let index = command === "run" ? 0 : 1; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--group-by-version") {
      if (groupByVersion) throw new Error("--group-by-version may only be provided once");
      groupByVersion = true;
      continue;
    }
    if (["--limit", "--lab", "--subset", "--output", "--endpoint"].includes(argument)) {
      if (Object.hasOwn(values, argument)) throw new Error(`${argument} may only be provided once`);
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
      values[argument] = value;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`Unknown option: ${argument}`);
    if (folderArgument !== undefined) throw new Error("Provide exactly one folder path");
    folderArgument = argument;
  }
  const allowed = command === "build-subset" ? ["--output"] : command === "runs" ? ["--limit"] : ["--limit", "--lab", "--subset", "--endpoint"];
  for (const name of Object.keys(values)) {
    if (!allowed.includes(name)) throw new Error(`${name} is not supported by ${command}`);
  }
  if (groupByVersion && command !== "runs") throw new Error("--group-by-version is only supported by runs");
  const limit = values["--limit"] === undefined ? undefined : Number(values["--limit"]);
  if (values["--limit"] !== undefined && (!/^\d+$/u.test(values["--limit"]) || !Number.isSafeInteger(limit) || limit < 1)) throw new Error("--limit must be a positive integer");
  if (command === "runs") {
    if (folderArgument) throw new Error("runs does not take a folder path");
    if (groupByVersion && limit !== undefined) throw new Error("Grouped output includes all runs; omit --limit");
    return { command, limit, groupByVersion };
  }
  if (!folderArgument) throw new Error("Missing folder path");
  if (values["--subset"] && limit !== undefined) throw new Error("--subset and --limit cannot be combined; frozen samples must run unchanged");
  if (values["--endpoint"]) {
    const url = new URL(values["--endpoint"]);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("--endpoint must be an HTTP(S) URL");
  }
  const labArgument = values["--lab"];
  if (labArgument === "@") throw new Error("--lab @file.txt requires a file path");
  return {
    command,
    folderPath: expandPath(folderArgument),
    limit,
    subsetPath: values["--subset"] ? expandPath(values["--subset"]) : undefined,
    outputPath: values["--output"] ? expandPath(values["--output"]) : DEFAULT_SUBSET_PATH,
    endpoint: values["--endpoint"],
    labInstructions: labArgument?.startsWith("@") ? await readFile(expandPath(labArgument.slice(1)), "utf8") : labArgument
  };
}

function expandPath(path) {
  return resolve(path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}

function printSection(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function printVerificationSummary(responseBody) {
  if (!responseBody?.verification) return;
  const { totalChecks, passed, failed, failures } = responseBody.verification;
  printSection("VERIFICATION (privacy/cleanup and source-ID checks, not factual accuracy)");
  console.log(`Total checks: ${totalChecks} | Passed: ${passed} | Failed: ${failed}`);
  for (const failure of Array.isArray(failures) ? failures : []) {
    console.log(`${failure.noteId || "(no noteId)"} | ${failure.reason}`);
  }
}
