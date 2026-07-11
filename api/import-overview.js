import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

const systemPrompt = `
You create an overview of a person's imported notes. Be a neutral observer in insight and a kind friend in delivery. Never be therapeutic and never say "you should". Never fabricate: ground every observation in the supplied content. When notes are thin, produce shorter, honest fields rather than generic filler.

The opening must be 1-3 warm, specific sentences personalised from actual content and never templated. Return the top 5-8 themes when the content supports that many. Return 3-5 genuinely forgotten or easily overlooked ideas when supported. Evolution must be 2-4 sentences, or an empty string when the date range cannot support it. Emotional landscape must be 2-3 observational, non-clinical sentences, or an empty string when the notes are not personal enough. Always use the provided tool.
`.trim();

const overviewTool = {
  name: "submit_import_overview",
  description: "Return a grounded overview of imported notes.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      opening: { type: "string" },
      themes: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            name: { type: "string" },
            count: { type: "integer", minimum: 1 },
            description: { type: "string" }
          },
          required: ["name", "count", "description"]
        }
      },
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
      evolution: { type: "string" },
      emotionalLandscape: { type: "string" }
    },
    required: ["opening", "themes", "forgottenIdeas", "evolution", "emotionalLandscape"]
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

  if (body.notes.length > LIMITS.overviewNotes) {
    return sendJson(response, 413, { error: { message: "Too many notes" } });
  }

  const notes = sanitizeNotes(body.notes);
  if (!notes) {
    return sendJson(response, 400, { error: { message: "Invalid notes array" } });
  }

  if (notes.some((note) => note.text.length > LIMITS.overviewNoteText)) {
    return sendJson(response, 413, { error: { message: "Note text too large" } });
  }

  const boundedNotes = totalStringLength(notes, "text") > LIMITS.overviewCombinedNoteText
    ? dropOldestNotes(notes, LIMITS.overviewCombinedNoteText)
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
        model: "claude-sonnet-4-20250514",
        max_tokens: 2200,
        temperature: 0.2,
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

    if (!upstreamResponse.ok) {
      return sendJson(response, 502, { error: { message: "Import overview failed" } });
    }

    const responseBody = await upstreamResponse.json();
    const toolUse = responseBody.content?.find((block) => block.type === "tool_use" && block.name === overviewTool.name);
    const overview = validateOverview(toolUse?.input);

    if (!overview) {
      return sendJson(response, 502, { error: { message: "Import overview failed" } });
    }

    return sendJson(response, 200, overview);
  } catch {
    return sendJson(response, 502, { error: { message: "Import overview failed" } });
  }
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
  if (!isPlainObject(value) || typeof value.opening !== "string" || typeof value.evolution !== "string" || typeof value.emotionalLandscape !== "string" || !Array.isArray(value.themes) || value.themes.length > 8 || !Array.isArray(value.forgottenIdeas) || value.forgottenIdeas.length > 5) {
    return null;
  }

  const themes = [];
  for (const theme of value.themes) {
    if (!isPlainObject(theme) || typeof theme.name !== "string" || typeof theme.description !== "string" || !Number.isInteger(theme.count) || theme.count < 1) {
      return null;
    }
    themes.push({ name: theme.name, count: theme.count, description: theme.description });
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
    themes,
    forgottenIdeas,
    evolution: value.evolution,
    emotionalLandscape: value.emotionalLandscape
  };
}
