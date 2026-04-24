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
- Topic tags must be 1 to 5 items.
- Topic tags must be specific and concrete, never generic.
- Good tags: "matcha", "work stress", "Parrot", "sleep".
- Bad tags: "life", "thoughts".
- Summary must be exactly one concise sentence.
- For journal entries, include mood and moodIntensity.
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
      topicTags: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "string",
          minLength: 1
        }
      },
      mood: {
        type: "string",
        enum: JOURNAL_MOODS
      },
      moodIntensity: {
        type: "integer",
        minimum: 1,
        maximum: 5
      },
      summary: {
        type: "string",
        minLength: 1
      }
    },
    required: ["topicTags", "mood", "moodIntensity", "summary"]
  }
};

const noteTool = {
  name: "submit_note_analysis",
  description: "Return structured metadata for a note entry.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      topicTags: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "string",
          minLength: 1
        }
      },
      summary: {
        type: "string",
        minLength: 1
      }
    },
    required: ["topicTags", "summary"]
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

  const topicTags = normalizeTopicTags(value.topicTags);
  const mood = typeof value.mood === "string" ? value.mood.trim() : "";
  const moodIntensity = value.moodIntensity;
  const summary = normalizeSummary(value.summary);

  if (!topicTags || !JOURNAL_MOODS.includes(mood) || !Number.isInteger(moodIntensity) || moodIntensity < 1 || moodIntensity > 5 || !summary) {
    return null;
  }

  return {
    topicTags,
    mood,
    moodIntensity,
    summary
  };
}

function validateNoteAnalysis(value) {
  if (!isPlainObject(value)) {
    return null;
  }

  const topicTags = normalizeTopicTags(value.topicTags);
  const summary = normalizeSummary(value.summary);

  if (!topicTags || !summary) {
    return null;
  }

  return {
    topicTags,
    summary
  };
}

function normalizeTopicTags(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 5) {
    return null;
  }

  const normalized = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);

  if (normalized.length !== value.length) {
    return null;
  }

  return normalized;
}

function normalizeSummary(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
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
