import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

export const RUNS_DIRECTORY = resolve("test", "overview-runs");
export const BACKLOG_PATH = resolve("test", "overview-prompt-backlog.json");

export async function updatePromptBacklog(record, backlogPath = BACKLOG_PATH) {
  if (!record.promptVersion || typeof record.systemPrompt !== "string") {
    return;
  }
  await mkdir(dirname(backlogPath), { recursive: true });
  const lockPath = `${backlogPath}.lock`;
  let lock;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      lock = await open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      await setTimeout(100);
    }
  }
  if (!lock) throw new Error(`Prompt backlog is locked: ${lockPath}`);
  let temporaryPath;
  try {
    let backlog = [];
    try {
      backlog = JSON.parse(await readFile(backlogPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (!Array.isArray(backlog)) throw new Error("Prompt backlog must be a JSON array");
    const existing = backlog.find((entry) => entry.version === record.promptVersion);
    if (existing) {
      if (existing.systemPrompt !== record.systemPrompt) {
        throw new Error(`Prompt text changed without a version bump (${record.promptVersion}). Bump OVERVIEW_PROMPT_VERSION; the run was saved with its actual text, but the backlog was not overwritten.`);
      }
      return;
    }
    backlog.push({
      version: record.promptVersion,
      description: "TODO: describe what changed",
      date: record.timestamp.slice(0, 10),
      systemPrompt: record.systemPrompt
    });
    temporaryPath = `${backlogPath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(backlog, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporaryPath, backlogPath);
    temporaryPath = undefined;
  } finally {
    if (temporaryPath) await unlink(temporaryPath).catch(() => {});
    await lock.close();
    await unlink(lockPath);
  }
}

export async function saveRun(record, { runsDirectory = RUNS_DIRECTORY, backlogPath = BACKLOG_PATH } = {}) {
  await mkdir(runsDirectory, { recursive: true, mode: 0o700 });
  const timestamp = record.timestamp.replace(/[:.]/g, "-");
  const outputPath = join(runsDirectory, `run-${timestamp}-${randomUUID().slice(0, 8)}.json`);
  await writeFile(outputPath, `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  let backlogWarning = null;
  try {
    await updatePromptBacklog(record, backlogPath);
  } catch (error) {
    backlogWarning = error.message;
  }
  return { outputPath, backlogWarning };
}

export async function loadRunRecords(runsDirectory = RUNS_DIRECTORY) {
  let filenames;
  try {
    filenames = await readdir(runsDirectory);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const filename of filenames.filter((name) => name.endsWith(".json"))) {
    try {
      const record = JSON.parse(await readFile(join(runsDirectory, filename), "utf8"));
      // Older response-only files have no trustworthy version/cost metadata. Leave them untouched.
      if (record?.recordVersion === 1 && typeof record.timestamp === "string") records.push(record);
    } catch {
      console.warn(`Skipping unreadable run record: ${filename}`);
    }
  }
  return records.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function formatRunTable(records) {
  if (!records.length) return "No evaluation run records yet (legacy response-only files are not included).";
  const rows = [["VERSION", "CORPUS", "COST USD", "LATENCY", "TIMESTAMP", "HTTP"]];
  for (const record of records) {
    const count = record.corpus?.noteCount ?? "?";
    const used = record.corpus?.usedNoteCount;
    rows.push([
      record.promptVersion || "unknown",
      `${record.corpus?.selection === "most_recent" ? "recent" : record.corpus?.type || "unknown"} (${count}${used != null && used !== count ? ` → ${used} used` : ""})`,
      record.costEstimate?.totalUsd == null ? "unknown" : `$${record.costEstimate.totalUsd.toFixed(4)}`,
      record.latencyMs == null ? "unknown" : `${(record.latencyMs / 1000).toFixed(2)}s`,
      record.timestamp,
      String(record.statusCode ?? "error")
    ]);
  }
  const widths = rows[0].map((_, index) => Math.max(...rows.map((row) => row[index].length)));
  return rows.map((row) => row.map((value, index) => value.padEnd(widths[index])).join("  ").trimEnd()).join("\n");
}

export function formatGroupedRuns(records) {
  if (!records.length) return formatRunTable(records);
  const groups = new Map();
  for (const record of records) {
    const version = record.promptVersion || "unknown";
    if (!groups.has(version)) groups.set(version, []);
    groups.get(version).push(record);
  }
  return [...groups].map(([version, runs]) => `${version} — ${runs.length} run(s)\n${formatRunTable(runs)}`).join("\n\n");
}
