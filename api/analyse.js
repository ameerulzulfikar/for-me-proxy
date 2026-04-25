const JOURNAL_MOODS = [
  "Calm",
  "Happy",
  "Excited",
  "Motivated",
  "Grateful",
  "Reflective",
  "Curious",
  "Hopeful",
  "Proud",
  "Anxious",
  "Stressed",
  "Frustrated",
  "Sad",
  "Overwhelmed",
  "Confused",
  "Lonely",
  "Nostalgic"
];

const systemPrompt = `
You analyse cleaned journal text and return structured metadata only.

Rules:
- Summary must be exactly one concise sentence.
- For journal entries, include mood and moodIntensity.
- For journal entries, include secondaryMoods as an array with zero to two items.
- Each secondary mood must have a confidence of at least 0.75.
- If there are no clear secondary moods, return an empty array.
- Secondary moods may be inferred from tone and context, but do not over-interpret weak signals.
- For note entries, do not include mood or moodIntensity.
- For journal mood, choose exactly one allowed mood from the provided schema.
- For moodIntensity, use an integer from 1 to 5.
- Never add explanation, commentary, markdown, or extra keys.
- Always use the provided tool.
`.trim();

const journalTool = {
  name: "submit_journal_analysis",
  description: "Return structured metadata for a journal entry.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mood: {
        type: "string",
        enum: JOURNAL_MOODS
      },
      moodIntensity: {
        type: "integer",
        minimum: 1,
        maximum: 5
      },
      secondaryMoods: {
        type: "array",
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            mood: {
              type: "string",
              enum: JOURNAL_MOODS
            },
            confidence: {
              type: "number",
              minimum: 0.75,
              maximum: 1
            }
          },
          required: ["mood", "confidence"]
        }
      },
      summary: {
        type: "string",
        minLength: 1
      }
    },
    required: ["mood", "moodIntensity", "secondaryMoods", "summary"]
  }
};

const noteTool = {
  name: "submit_note_analysis",
  description: "Return structured metadata for a note entry.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      summary: {
        type: "string",
        minLength: 1
      }
    },
    required: ["summary"]
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

  const text = typeof body.text === "string" ? body.text.trim() : "";
  const entryType = typeof body.entryType === "string" ? body.entryType.trim() : "";

  if (!text) {
    return sendJson(response, 400, { error: { message: "Missing text" } });
  }

  if (entryType !== "journal" && entryType !== "note") {
    return sendJson(response, 400, { error: { message: "Invalid entryType" } });
  }

  const tool = entryType === "journal" ? journalTool : noteTool;

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
        max_tokens: 700,
        temperature: 0,
        system: systemPrompt,
        tools: [tool],
        tool_choice: {
          type: "tool",
          name: tool.name
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildUserPrompt(text, entryType)
              }
            ]
          }
        ]
      })
    });

    const responseBody = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      console.error("Analyse provider error", upstreamResponse.status, responseBody);
      return sendJson(response, 502, { error: { message: "Analysis failed" } });
    }

    const parsed = JSON.parse(responseBody);
    const toolUse = parsed.content?.find((block) => block.type === "tool_use" && block.name === tool.name);
    const analysis = toolUse?.input;

    if (!analysis || typeof analysis !== "object") {
      console.error("Analyse response missing tool output", responseBody);
      return sendJson(response, 502, { error: { message: "Analysis failed" } });
    }

    const validated = entryType === "journal"
      ? validateJournalAnalysis(analysis)
      : validateNoteAnalysis(analysis);

    if (!validated) {
      console.error("Analyse response failed validation", analysis);
      return sendJson(response, 502, { error: { message: "Analysis failed" } });
    }

    return sendJson(response, 200, validated);
  } catch (error) {
    console.error("Analyse proxy failed", error);
    return sendJson(response, 502, { error: { message: "Analysis failed" } });
  }
}

function buildUserPrompt(text, entryType) {
  return [
    `Entry type: ${entryType}`,
    "",
    "Analyse this cleaned entry and return only structured metadata through the required tool.",
    "",
    "Text:",
    text
  ].join("\n");
}

function validateJournalAnalysis(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  const mood = typeof value.mood === "string" ? value.mood.trim() : "";
  const moodIntensity = value.moodIntensity;
  const secondaryMoods = normalizeSecondaryMoods(value.secondaryMoods);
  const summary = normalizeSummary(value.summary);

  if (!JOURNAL_MOODS.includes(mood) || !Number.isInteger(moodIntensity) || moodIntensity < 1 || moodIntensity > 5 || !secondaryMoods || !summary) {
    return null;
  }

  return {
    mood,
    moodIntensity,
    secondaryMoods,
    summary
  };
}

function validateNoteAnalysis(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  const summary = normalizeSummary(value.summary);

  if (!summary) {
    return null;
  }

  return {
    summary
  };
}

function normalizeSummary(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeSecondaryMoods(value) {
  if (!Array.isArray(value) || value.length > 2) {
    return null;
  }

  const normalized = [];

  for (const item of value) {
    if (!isPlainObject(item)) {
      return null;
    }

    const mood = typeof item.mood === "string" ? item.mood.trim() : "";
    const confidence = item.confidence;

    if (!JOURNAL_MOODS.includes(mood) || typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0.75 || confidence > 1) {
      return null;
    }

    normalized.push({ mood, confidence });
  }

  return normalized;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";

    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.end(JSON.stringify(payload));
}
