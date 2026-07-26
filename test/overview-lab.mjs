import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve } from "node:path";
import process from "node:process";

const OVERVIEW_ENDPOINT = "https://project-ymuos.vercel.app/api/import-overview";
const LAB_ENDPOINT = "https://project-ymuos.vercel.app/api/lab";
const MAX_FILE_BYTES = 100 * 1024;
const REQUEST_TIMEOUT_MS = 300_000;

if (!process.env.NODE_TEST_CONTEXT) {
  await main();
}

async function main() {
  const startedAt = Date.now();

  try {
    const { folderPath, limit, labInstructions } = await parseArguments(process.argv.slice(2));
    const notes = await loadNotes(folderPath);
    notes.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

    const selectedNotes = limit === undefined ? notes : notes.slice(0, limit);
    const totalCharacters = selectedNotes.reduce((total, note) => total + note.text.length, 0);
    const labMode = labInstructions !== undefined;

    printSection("REQUEST");
    console.log(`Endpoint: ${labMode ? LAB_ENDPOINT : OVERVIEW_ENDPOINT}`);
    console.log(`Folder: ${folderPath}`);
    console.log(`Notes: ${selectedNotes.length}`);
    console.log(`Total characters: ${totalCharacters.toLocaleString("en-US")}`);
    if (limit !== undefined) {
      console.log(`Most-recent limit: ${limit}`);
    }

    const headers = { "Content-Type": "application/json" };
    if (labMode) {
      const labKey = process.env.LAB_KEY;
      if (!labKey) {
        throw new Error("LAB_KEY must be set when using --lab");
      }
      headers["x-lab-key"] = labKey;
    }

    const response = await fetch(labMode ? LAB_ENDPOINT : OVERVIEW_ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify(labMode
        ? { notes: selectedNotes, instructions: labInstructions }
        : { notes: selectedNotes }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const responseText = await response.text();
    const elapsedMs = Date.now() - startedAt;
    const responseBody = labMode && response.ok
      ? responseText
      : parseJsonResponse(responseText, response.status);
    const outputPath = await saveRun(responseBody, labMode);

    printSection(`RESPONSE — HTTP ${response.status}`);
    console.log(typeof responseBody === "string" ? responseBody : JSON.stringify(responseBody, null, 2));

    printSection("RUN SUMMARY");
    console.log(`Notes sent: ${selectedNotes.length}`);
    console.log(`Total characters sent: ${totalCharacters.toLocaleString("en-US")}`);
    console.log(`Elapsed time: ${formatElapsed(elapsedMs)}`);
    console.log(`Saved to: ${outputPath}`);

    if (!response.ok) {
      process.exitCode = 1;
    }
  } catch (error) {
    printSection("ERROR");
    console.error(error instanceof Error ? error.message : String(error));
    console.error('Usage: node test/overview-lab.mjs <folder> [--limit N] [--lab "instructions text or @file.txt"]');
    process.exitCode = 1;
  }
}

async function parseArguments(args) {
  let folderArgument;
  let limit;
  let labArgument;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--limit") {
      const value = args[index + 1];
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
        throw new Error("--limit must be a positive integer");
      }
      limit = Number(value);
      index += 1;
      continue;
    }

    if (argument === "--lab") {
      if (labArgument !== undefined) {
        throw new Error("--lab may only be provided once");
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--lab requires instructions text or @file.txt");
      }
      labArgument = value;
      index += 1;
      continue;
    }

    if (argument.startsWith("--")) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (folderArgument !== undefined) {
      throw new Error("Provide exactly one folder path");
    }
    folderArgument = argument;
  }

  if (!folderArgument) {
    throw new Error("Missing folder path");
  }

  const expandedFolder = folderArgument === "~"
    ? homedir()
    : folderArgument.startsWith("~/")
      ? join(homedir(), folderArgument.slice(2))
      : folderArgument;

  return {
    folderPath: resolve(expandedFolder),
    limit,
    labInstructions: await loadLabInstructions(labArgument)
  };
}

async function loadLabInstructions(labArgument) {
  if (labArgument === undefined || !labArgument.startsWith("@")) {
    return labArgument;
  }

  const fileArgument = labArgument.slice(1);
  if (!fileArgument) {
    throw new Error("--lab @file.txt requires a file path");
  }

  const expandedFile = fileArgument === "~"
    ? homedir()
    : fileArgument.startsWith("~/")
      ? join(homedir(), fileArgument.slice(2))
      : fileArgument;

  return readFile(resolve(expandedFile), "utf8");
}

async function loadNotes(rootPath) {
  const rootStats = await stat(rootPath);
  if (!rootStats.isDirectory()) {
    throw new Error(`Not a directory: ${rootPath}`);
  }

  const notes = [];
  await visitDirectory(rootPath, rootPath, notes);
  return notes;
}

async function visitDirectory(rootPath, directoryPath, notes) {
  const entries = await readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const filePath = join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      await visitDirectory(rootPath, filePath, notes);
      continue;
    }
    if (!entry.isFile() || ![".md", ".txt"].includes(extname(entry.name).toLowerCase())) {
      continue;
    }

    const fileStats = await stat(filePath);
    if (fileStats.size === 0 || fileStats.size > MAX_FILE_BYTES) {
      continue;
    }

    const text = await readFile(filePath, "utf8");
    if (!text.trim()) {
      continue;
    }

    const relativePath = relative(rootPath, filePath);
    notes.push({
      id: relativePath,
      title: extractTitle(text, entry.name),
      text,
      createdAt: getCreatedAt(fileStats).toISOString()
    });
  }
}

function extractTitle(text, filename) {
  const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text);
  return heading?.[1]?.trim() || basename(filename, extname(filename));
}

function getCreatedAt(fileStats) {
  return fileStats.birthtimeMs > 0 ? fileStats.birthtime : fileStats.mtime;
}

function parseJsonResponse(responseText, status) {
  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(`Endpoint returned non-JSON (HTTP ${status}): ${responseText.slice(0, 500)}`);
  }
}

async function saveRun(responseBody, labMode) {
  const runsDirectory = resolve("test", "overview-runs");
  await mkdir(runsDirectory, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(runsDirectory, labMode ? `lab-${timestamp}.txt` : `run-${timestamp}.json`);
  const contents = typeof responseBody === "string"
    ? responseBody
    : JSON.stringify(responseBody, null, 2);
  await writeFile(outputPath, `${contents}\n`, "utf8");
  return outputPath;
}

function printSection(title) {
  console.log(`\n${"=".repeat(72)}\n${title}\n${"=".repeat(72)}`);
}

function formatElapsed(elapsedMs) {
  return `${(elapsedMs / 1000).toFixed(2)}s`;
}
