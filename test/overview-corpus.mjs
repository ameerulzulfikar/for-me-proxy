import { mkdir, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { LIMITS } from "../api/_validation.js";

export const SUBSET_SIZE = 700;
export const SUBSET_SEED = 0x4f564552;
export const DEFAULT_SUBSET_PATH = resolve("test", "overview-subset.json");
const MAX_FILE_BYTES = 100 * 1024;

export async function listNoteFiles(rootPath) {
  if (!(await stat(rootPath)).isDirectory()) {
    throw new Error(`Not a directory: ${rootPath}`);
  }
  const filenames = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile() && [".md", ".txt"].includes(extname(entry.name).toLowerCase())) {
        filenames.push(relative(rootPath, filePath).split(sep).join("/"));
      }
    }
  }
  await visit(rootPath);
  return filenames;
}

export function selectSubset(filenames) {
  if (filenames.length < SUBSET_SIZE) {
    throw new Error(`Need at least ${SUBSET_SIZE} note files; found ${filenames.length}`);
  }
  // Sort ONLY to make filesystem enumeration irrelevant. No text, date, or size is read.
  const shuffled = [...filenames].sort();
  let seed = SUBSET_SEED;
  const random = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
  }
  return shuffled.slice(0, SUBSET_SIZE).sort();
}

export async function buildSubset(rootPath, outputPath = DEFAULT_SUBSET_PATH) {
  const filenames = selectSubset(await listNoteFiles(rootPath));
  const contents = `${JSON.stringify(filenames, null, 2)}\n`;
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, contents, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    if (await readFile(outputPath, "utf8") !== contents) {
      throw new Error(`Refusing to replace frozen subset ${outputPath}; use a new --output path`);
    }
  }
  return filenames;
}

export async function loadNotes(rootPath, subsetPath) {
  const frozen = subsetPath !== undefined;
  const filenames = frozen ? JSON.parse(await readFile(subsetPath, "utf8")) : await listNoteFiles(rootPath);
  if (frozen && (!Array.isArray(filenames) || filenames.length !== SUBSET_SIZE || filenames.some((name) => typeof name !== "string" || !name) || new Set(filenames).size !== SUBSET_SIZE)) {
    throw new Error(`Subset must be a JSON array of exactly ${SUBSET_SIZE} unique relative filenames`);
  }
  const root = await realpath(rootPath);
  const notes = [];
  for (const filename of filenames) {
    if (isAbsolute(filename) || filename.split(/[\\/]/u).includes("..") || ![".md", ".txt"].includes(extname(filename).toLowerCase())) {
      throw new Error(`Invalid note filename in subset: ${filename}`);
    }
    const filePath = resolve(root, filename);
    const actualPath = await realpath(filePath);
    const fromRoot = relative(root, actualPath);
    if (fromRoot.startsWith(`..${sep}`) || fromRoot === ".." || isAbsolute(fromRoot)) {
      throw new Error(`Note resolves outside the archive: ${filename}`);
    }
    const fileStats = await stat(actualPath);
    if (!fileStats.isFile()) {
      throw new Error(`Not a note file: ${filename}`);
    }
    // Preserve the legacy full-folder loader's exclusions; NEVER apply them to a frozen sample.
    if (!frozen && (fileStats.size === 0 || fileStats.size > MAX_FILE_BYTES)) {
      continue;
    }
    const text = await readFile(actualPath, "utf8");
    if (!frozen && !text.trim()) {
      continue;
    }
    if (frozen && text.length > LIMITS.overviewNoteText) {
      throw new Error(`Frozen note exceeds the endpoint's ${LIMITS.overviewNoteText}-character limit: ${filename}; no notes were replaced or sent`);
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(text);
    notes.push({
      id: filename,
      title: heading?.[1]?.trim() || basename(filename, extname(filename)),
      text,
      createdAt: (fileStats.birthtimeMs > 0 ? fileStats.birthtime : fileStats.mtime).toISOString()
    });
  }
  if (frozen && notes.reduce((total, note) => total + note.text.length, 0) > 2_100_000) {
    throw new Error("Frozen subset exceeds the endpoint's total text limit; refusing a run that would silently drop notes");
  }
  return notes;
}
