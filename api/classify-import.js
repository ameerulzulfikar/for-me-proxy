import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

const CLASSIFICATIONS = new Set([
  "meaningful_thought",
  "admin",
  "checklist",
  "sensitive",
  "empty_or_junk"
]);

const systemPrompt = `
Classify imported notes using these definitions:
- meaningful_thought: reflections, ideas, journal-like writing, opinions, plans with reasoning — anything revealing how the person thinks or feels.
- admin: addresses, bookings, reference info, copied text, receipts.
- checklist: shopping/todo lists, bullet fragments without reflective content.
- sensitive: passwords, PINs, financial account numbers, ID numbers, medical record details.
- empty_or_junk: near-empty, gibberish, bare links.

Return JSON only, with no markdown or commentary. Return an object with a results array. Each result must contain the note id, one exact classification, and a confidence number from 0 to 1. Include every note exactly once.
`.trim();

export default async function handler(request, response) {
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

  if (body.notes.length > LIMITS.classifyNotes) {
    return sendJson(response, 413, { error: { message: "Too many notes" } });
  }

  const notes = sanitizeNotes(body.notes);
  if (!notes) {
    return sendJson(response, 400, { error: { message: "Invalid notes array" } });
  }

  if (notes.some((note) => note.text.length > LIMITS.classifyNoteText)) {
    return sendJson(response, 413, { error: { message: "Note text too large" } });
  }

  if (totalStringLength(notes, "text") > LIMITS.classifyCombinedNoteText) {
    return sendJson(response, 413, { error: { message: "Combined note text too large" } });
  }

  if (notes.length === 0) {
    return sendJson(response, 200, { results: [] });
  }

  const resultsByID = new Map();

  for (let attempt = 0; attempt < 2 && resultsByID.size < notes.length; attempt += 1) {
    const parsedResults = await classifyNotes(apiKey, notes);
    for (const result of parsedResults) {
      if (!resultsByID.has(result.id)) {
        resultsByID.set(result.id, result);
      }
    }
  }

  const results = notes.map((note) => (
    resultsByID.get(note.id) || {
      id: note.id,
      classification: "admin",
      confidence: 0
    }
  ));

  return sendJson(response, 200, { results });
}

async function classifyNotes(apiKey, notes) {
  try {
    const upstreamResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 3000,
        temperature: 0,
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: notes.map((note, index) => [
              `Note ${index + 1}`,
              `id: ${JSON.stringify(note.id)}`,
              `title: ${JSON.stringify(note.title)}`,
              `createdAt: ${JSON.stringify(note.createdAt)}`,
              "text:",
              note.text
            ].join("\n")).join("\n\n")
          }
        ]
      })
    });

    if (!upstreamResponse.ok) {
      return [];
    }

    const responseBody = await upstreamResponse.json();
    const text = responseBody.content?.find((block) => block.type === "text")?.text;
    return parseResults(text, notes);
  } catch {
    return [];
  }
}

function parseResults(value, notes) {
  if (typeof value !== "string") {
    return [];
  }

  let parsed;
  try {
    const normalized = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    parsed = JSON.parse(normalized);
  } catch {
    return [];
  }

  if (!isPlainObject(parsed) || !Array.isArray(parsed.results)) {
    return [];
  }

  const allowedIDs = new Set(notes.map((note) => note.id));
  const seen = new Set();
  const results = [];

  for (const result of parsed.results) {
    if (!isPlainObject(result)) {
      continue;
    }

    const { id, classification, confidence } = result;
    if (typeof id !== "string" || !allowedIDs.has(id) || seen.has(id) || !CLASSIFICATIONS.has(classification) || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      continue;
    }

    seen.add(id);
    results.push({ id, classification, confidence });
  }

  return results;
}

function sanitizeNotes(notes) {
  const sanitized = [];
  const seenIDs = new Set();

  for (const note of notes) {
    if (!isPlainObject(note) || typeof note.id !== "string" || !note.id.trim() || seenIDs.has(note.id.trim()) || typeof note.title !== "string" || typeof note.text !== "string" || typeof note.createdAt !== "string") {
      return null;
    }

    const id = note.id.trim();
    seenIDs.add(id);
    sanitized.push({ id, title: note.title, text: note.text, createdAt: note.createdAt });
  }

  return sanitized;
}
