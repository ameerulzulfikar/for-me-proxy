import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

const MAX_NOTES = 3_000;
const MAX_COMBINED_NOTE_TEXT = 2_100_000; // Approximately 700,000 tokens at 3 characters per token.

const systemPrompt = `
You are reading someone's complete personal note archive across many years: every word they have supplied. Do not summarize it. Read it as an unusually perceptive friend would, attending to who this person is, how they have changed, and what has quietly endured. Write every section in the second person, with warmth, specificity, and restraint. Never sound therapeutic or clinical, and never say "you should". Prefer a few deeply seen observations to broad coverage. Always return the result through the provided tool.

OPENING
Write 2-4 sentences that interpret the person rather than inventorying the archive. Use at most two named specifics. It should feel like the opening of a letter from someone who knows them, never a table of contents.

SEASONS
Identify 3-6 emotional and identity chapters that genuinely emerge from the writing rather than dividing time into arbitrary calendar buckets. Give each season a title, a human-readable period such as "2016 – 2019" derived strictly from the notes' createdAt values, and a full narrative paragraph of 4-8 sentences. Describe who they were, what they were reaching toward, and the register of their writing in that season. Only when the notes provide evidence, describe what appears to have prompted the transition into the next season; otherwise leave the cause unstated. Ground every season with 1-2 short, exact phrases quoted verbatim from their notes, never a paragraph.

LANGUAGE
Write one substantial paragraph about what the writing style itself reveals beyond subject matter. Notice movements between terse and expansive writing, stretches dominated by lists or by feeling, runs of motivational self-talk and what came before them, and meaningful gaps when writing stopped. Surface patterns the person is unlikely to have recognized alone.

UNCHANGED
Write one substantial paragraph on 2-3 important threads that may look abandoned but continue in a changed form: early passions wearing new clothes. Support each connection with evidence from both eras, ideally placing an old phrase beside a recent artifact. Trace transformation rather than disappearance, and derive every connection only from this archive.

PATTERNS
Write one paragraph about identity-level behavioral fingerprints, not recurring topics. Attend to how setbacks are processed, how ambition appears on the page compared with feeling, cycles of returning to abandoned things, and what courage looks like in these notes.

FORGOTTEN IDEAS
Return 3-5 specific, dated ideas that are genuinely forgotten or easily overlooked, with a concise explanation of why each is worth revisiting.

TENDER THREAD
Write one paragraph that plainly recognizes emotional depth—grief, love, strain, faith—when it is present, and acknowledges that it matters. Exercise deliberate discretion across this entire first-impression output: never name deceased people, romantic partners, health conditions, or diagnoses. Gesture carefully, as in "there is grief here you have redrafted across years," without identifying who or what it concerns. Earn trust by combining real perception with privacy; deeper detail can wait for a later private setting.

INTEGRITY RULES — ABSOLUTE
1. Every date you write, including every whenWritten value and season period, must be copied from or derived strictly from the notes' createdAt fields. Never infer a date from note content or estimate one from memory. When precision is uncertain, use only the createdAt year.
2. Never state or imply a count greater than the number of notes actually supplied.
3. You may observe correlation, but never declare causation without evidence. Mark interpretation explicitly with language such as "one way to see this...", or return the question with "you would know why". Where the notes do not establish a cause, say less.
4. Never fabricate or alter a quote. Verbatim means exact text from the notes.
5. For thin or sparse archives, write shorter, honest sections rather than inventing depth.
`.trim();

const overviewTool = {
  name: "submit_import_overview",
  description: "Return a perceptive, grounded reading of a personal note archive.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      opening: { type: "string" },
      seasons: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            period: { type: "string" },
            narrative: { type: "string" }
          },
          required: ["title", "period", "narrative"]
        }
      },
      language: { type: "string" },
      unchanged: { type: "string" },
      patterns: { type: "string" },
      forgottenIdeas: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            whenWritten: { type: "string" },
            why: { type: "string" }
          },
          required: ["title", "whenWritten", "why"]
        }
      },
      tenderThread: { type: "string" }
    },
    required: ["opening", "seasons", "language", "unchanged", "patterns", "forgottenIdeas", "tenderThread"]
  }
};

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
        system: systemPrompt,
        tools: [overviewTool],
        tool_choice: { type: "tool", name: overviewTool.name },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Create the import overview from these notes:\n\n${JSON.stringify(boundedNotes, null, 2)}`
              }
            ]
          }
        ]
      })
    });

    const responseText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      console.error("Import overview provider error", upstreamResponse.status, responseText);
      return sendJson(response, 502, { error: { message: "Import overview failed" } });
    }

    const responseBody = JSON.parse(responseText);
    const toolUse = responseBody.content?.find((block) => block.type === "tool_use" && block.name === overviewTool.name);
    const overview = validateOverview(toolUse?.input);

    if (!overview) {
      console.error("Import overview response failed validation", upstreamResponse.status);
      return sendJson(response, 502, { error: { message: "Import overview failed" } });
    }

    return sendJson(response, 200, overview);
  } catch (error) {
    console.error("Import overview proxy failed", formatCaughtError(error));
    return sendJson(response, 502, { error: { message: "Import overview failed" } });
  }
}

function formatCaughtError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
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

function validateOverview(value) {
  if (!isPlainObject(value) || typeof value.opening !== "string" || typeof value.language !== "string" || typeof value.unchanged !== "string" || typeof value.patterns !== "string" || typeof value.tenderThread !== "string" || !Array.isArray(value.seasons) || value.seasons.length < 3 || value.seasons.length > 6 || !Array.isArray(value.forgottenIdeas) || value.forgottenIdeas.length > 5) {
    return null;
  }

  const seasons = [];
  for (const season of value.seasons) {
    if (!isPlainObject(season) || typeof season.title !== "string" || typeof season.period !== "string" || typeof season.narrative !== "string") {
      return null;
    }
    seasons.push({ title: season.title, period: season.period, narrative: season.narrative });
  }

  const forgottenIdeas = [];
  for (const idea of value.forgottenIdeas) {
    if (!isPlainObject(idea) || typeof idea.title !== "string" || typeof idea.whenWritten !== "string" || typeof idea.why !== "string") {
      return null;
    }
    forgottenIdeas.push({ title: idea.title, whenWritten: idea.whenWritten, why: idea.why });
  }

  return {
    opening: value.opening,
    seasons,
    language: value.language,
    unchanged: value.unchanged,
    patterns: value.patterns,
    forgottenIdeas,
    tenderThread: value.tenderThread
  };
}
