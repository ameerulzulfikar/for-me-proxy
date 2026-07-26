import { timingSafeEqual } from "node:crypto";

import { LIMITS, isPlainObject, readJsonBody, sendJson, sendText, totalStringLength } from "./_validation.js";

const MAX_NOTES = 3_000;
const MAX_COMBINED_NOTE_TEXT = 2_100_000; // Approximately 700,000 tokens at 3 characters per token.

const integrityRules = `
INTEGRITY RULES — ABSOLUTE
1. Every date you write, including every whenWritten value and season period, must be copied from or derived strictly from the notes' createdAt fields. Never infer a date from note content or estimate one from memory. When precision is uncertain, use only the createdAt year.
2. Never state or imply a count greater than the number of notes actually supplied.
3. You may observe correlation, but never declare causation without evidence. Mark interpretation explicitly with language such as "one way to see this...", or return the question with "you would know why". Where the notes do not establish a cause, say less.
4. Never fabricate or alter a quote. Verbatim means exact text from the notes.
5. You must not name deceased people, partners, health conditions, or diagnose any medical or psychiatric condition.
`.trim();

export default async function handler(request, response) {
  if (!hasValidLabKey(request)) {
    return sendJson(response, 401, { error: { message: "Unauthorized" } });
  }

  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: { message: "Method not allowed" } });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return sendJson(response, 500, { error: { message: "Missing ANTHROPIC_API_KEY" } });
  }

  let body;
  try {
    body = await readJsonBody(request);
  } catch {
    return sendJson(response, 400, { error: { message: "Invalid JSON" } });
  }

  if (!isPlainObject(body)) {
    return sendJson(response, 400, { error: { message: "Invalid request body" } });
  }

  if (!Array.isArray(body.notes)) {
    return sendJson(response, 400, { error: { message: "Missing notes array" } });
  }

  if (typeof body.instructions !== "string") {
    return sendJson(response, 400, { error: { message: "Missing instructions" } });
  }

  if (body.notes.length > MAX_NOTES) {
    return sendJson(response, 413, { error: { message: "Too many notes" } });
  }

  const notes = sanitizeNotes(body.notes);
  if (!notes) {
    return sendJson(response, 400, { error: { message: "Invalid notes array" } });
  }

  if (notes.some((note) => note.text.length > LIMITS.overviewNoteText)) {
    return sendJson(response, 413, { error: { message: "Note text too large" } });
  }

  const boundedNotes = totalStringLength(notes, "text") > MAX_COMBINED_NOTE_TEXT
    ? dropOldestNotes(notes, MAX_COMBINED_NOTE_TEXT)
    : notes;

  try {
    const upstreamResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16000,
        system: `${integrityRules}\n\n${body.instructions}`,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildNotesPrompt(boundedNotes)
              }
            ]
          }
        ]
      })
    });

    const responseText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      return sendJson(response, 502, { error: { message: "Lab analysis failed" } });
    }

    const responseBody = JSON.parse(responseText);
    const analysis = responseBody.content
      ?.filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");

    if (!analysis?.trim()) {
      return sendJson(response, 502, { error: { message: "Lab analysis failed" } });
    }

    return sendText(response, 200, analysis);
  } catch {
    return sendJson(response, 502, { error: { message: "Lab analysis failed" } });
  }
}

function hasValidLabKey(request) {
  const expectedKey = process.env.LAB_KEY;
  const suppliedKey = typeof request.headers?.get === "function"
    ? request.headers.get("x-lab-key")
    : request.headers?.["x-lab-key"];

  if (typeof expectedKey !== "string" || !expectedKey || typeof suppliedKey !== "string") {
    return false;
  }

  const expected = Buffer.from(expectedKey);
  const supplied = Buffer.from(suppliedKey);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function sanitizeNotes(notes) {
  const sanitized = [];

  for (const note of notes) {
    if (!isPlainObject(note) || typeof note.id !== "string" || !note.id.trim() || typeof note.title !== "string" || typeof note.text !== "string" || typeof note.createdAt !== "string") {
      return null;
    }
    sanitized.push({ id: note.id.trim(), title: note.title, text: note.text, createdAt: note.createdAt });
  }

  return sanitized;
}

function dropOldestNotes(notes, limit) {
  let total = totalStringLength(notes, "text");
  const keep = new Set(notes.map((_, index) => index));
  const oldestFirst = notes.map((note, index) => ({
    index,
    timestamp: Number.isFinite(Date.parse(note.createdAt)) ? Date.parse(note.createdAt) : Number.NEGATIVE_INFINITY
  })).sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

  for (const { index } of oldestFirst) {
    if (total <= limit) {
      break;
    }
    keep.delete(index);
    total -= notes[index].text.length;
  }

  return notes.filter((_, index) => keep.has(index));
}

function buildNotesPrompt(notes) {
  return [
    buildTimelineIndex(notes),
    "All dates and date ranges in the response must be consistent with this index and the notes' createdAt values.",
    "",
    "NOTES",
    JSON.stringify(notes, null, 2)
  ].join("\n");
}

function buildTimelineIndex(notes) {
  const datedNotes = notes
    .map((note) => ({ createdAt: note.createdAt, timestamp: Date.parse(note.createdAt) }))
    .filter((note) => Number.isFinite(note.timestamp));
  const countsByYear = new Map();

  for (const note of datedNotes) {
    const year = new Date(note.timestamp).getUTCFullYear();
    countsByYear.set(year, (countsByYear.get(year) || 0) + 1);
  }

  const invalidDateCount = notes.length - datedNotes.length;
  const sortedYears = [...countsByYear.keys()].sort((a, b) => a - b);
  const yearCounts = sortedYears.map((year) => `${year}: ${countsByYear.get(year)}`);
  if (invalidDateCount > 0) {
    yearCounts.push(`invalid createdAt: ${invalidDateCount}`);
  }

  datedNotes.sort((a, b) => a.timestamp - b.timestamp);
  const overallRange = datedNotes.length > 0
    ? `${datedNotes[0].createdAt} to ${datedNotes[datedNotes.length - 1].createdAt}`
    : "unavailable";

  return [
    "TIMELINE INDEX (server-computed and authoritative)",
    `Overall createdAt range: ${overallRange}`,
    `Notes per year: ${yearCounts.join("; ") || "none"}`
  ].join("\n");
}
