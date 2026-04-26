const systemPrompt = `
You are the user's personal journal assistant. You answer questions about their life based ONLY on the journal entries provided.
- NEVER fabricate, invent, or assume information not present in the entries.
- If the entries don't contain enough information to answer, say so honestly. Do not guess.
- Reference specific dates when mentioning entries, e.g. "On April 21 you mentioned..."
- Be warm and conversational but NOT therapeutic.
- Do not psychoanalyse.
- Do not give advice unless explicitly asked.
- Do not start responses with "Based on your entries" or similar meta-language.
- Just answer naturally.
- Treat secondary moods as background context only — never state them as facts about how the user felt.
- Keep answers concise. Do not over-explain or pad responses.
- If the question is unrelated to the journal entries, e.g. weather/general facts, politely redirect: "I can only help with questions about your journal entries."
- Always use the provided tool.
`.trim();

const answerTool = {
  name: "submit_journal_answer",
  description: "Return a concise answer to the user's journal question with cited entry IDs.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      answer: {
        type: "string",
        minLength: 1
      },
      citedEntryIDs: {
        type: "array",
        items: {
          type: "string",
          minLength: 1
        }
      }
    },
    required: ["answer", "citedEntryIDs"]
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

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const entries = Array.isArray(body.entries) ? body.entries : null;
  const history = body.history === undefined ? [] : body.history;

  if (!question) {
    return sendJson(response, 400, { error: { message: "Missing question" } });
  }

  if (!entries) {
    return sendJson(response, 400, { error: { message: "Missing entries array" } });
  }

  if (!Array.isArray(history)) {
    return sendJson(response, 400, { error: { message: "Invalid history array" } });
  }

  const sanitizedEntries = sanitizeEntries(entries);
  if (!sanitizedEntries) {
    return sendJson(response, 400, { error: { message: "Invalid entries array" } });
  }

  const sanitizedHistory = sanitizeHistory(history);
  if (!sanitizedHistory) {
    return sendJson(response, 400, { error: { message: "Invalid history array" } });
  }

  const allowedEntryIDs = new Set(
    sanitizedEntries
      .map((entry) => entry.id)
      .filter(Boolean)
  );

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
        max_tokens: 1024,
        temperature: 0.2,
        system: systemPrompt,
        tools: [answerTool],
        tool_choice: {
          type: "tool",
          name: answerTool.name
        },
        messages: buildMessages(sanitizedHistory, sanitizedEntries, question)
      })
    });

    const responseBody = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      console.error("Ask provider error", upstreamResponse.status);
      return sendJson(response, 502, { error: { message: "Ask failed" } });
    }

    const parsed = JSON.parse(responseBody);
    const toolUse = parsed.content?.find((block) => block.type === "tool_use" && block.name === answerTool.name);
    const answer = toolUse?.input;

    if (!answer || typeof answer !== "object") {
      console.error("Ask response missing tool output");
      return sendJson(response, 502, { error: { message: "Ask failed" } });
    }

    const validated = validateAnswer(answer, allowedEntryIDs);
    if (!validated) {
      console.error("Ask response failed validation");
      return sendJson(response, 502, { error: { message: "Ask failed" } });
    }

    return sendJson(response, 200, validated);
  } catch (error) {
    console.error("Ask proxy failed", error instanceof Error ? error.message : error);
    return sendJson(response, 502, { error: { message: "Ask failed" } });
  }
}

function buildMessages(history, entries, question) {
  const messages = history.map((message) => ({
    role: message.role,
    content: [
      {
        type: "text",
        text: message.content
      }
    ]
  }));

  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: buildQuestionPrompt(entries, question)
      }
    ]
  });

  return messages;
}

function buildQuestionPrompt(entries, question) {
  return [
    "Journal entries:",
    JSON.stringify(entries, null, 2),
    "",
    `Question: ${question}`,
    "",
    "Answer using only these entries and return the answer through the required tool."
  ].join("\n");
}

function sanitizeEntries(entries) {
  const sanitized = [];

  for (const entry of entries) {
    if (!isPlainObject(entry)) {
      return null;
    }

    const id = normalizeOptionalString(entry.id);
    const createdAt = normalizeOptionalString(entry.createdAt);
    const text = normalizeOptionalString(entry.text);
    const mood = normalizeOptionalString(entry.mood);
    const moodIntensity = normalizeOptionalInteger(entry.moodIntensity);
    const categoryTag = normalizeOptionalString(entry.categoryTag);
    const secondaryMoods = normalizeSecondaryMoods(entry.secondaryMoods);

    sanitized.push({
      ...(id ? { id } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(text ? { text } : {}),
      ...(mood ? { mood } : {}),
      ...(moodIntensity !== null ? { moodIntensity } : {}),
      ...(secondaryMoods ? { secondaryMoods } : {}),
      ...(categoryTag ? { categoryTag } : {})
    });
  }

  return sanitized;
}

function sanitizeHistory(history) {
  const sanitized = [];

  for (const message of history) {
    if (!isPlainObject(message)) {
      return null;
    }

    const role = message.role === "user" || message.role === "assistant" ? message.role : null;
    const content = normalizeOptionalString(message.content);

    if (!role || !content) {
      return null;
    }

    sanitized.push({ role, content });
  }

  return sanitized;
}

function validateAnswer(value, allowedEntryIDs) {
  if (!isPlainObject(value)) {
    return null;
  }

  const answer = normalizeOptionalString(value.answer);
  if (!answer) {
    return null;
  }

  if (!Array.isArray(value.citedEntryIDs)) {
    return null;
  }

  const citedEntryIDs = [];
  for (const id of value.citedEntryIDs) {
    const normalizedID = normalizeOptionalString(id);
    if (!normalizedID) {
      return null;
    }

    if (allowedEntryIDs.size > 0 && !allowedEntryIDs.has(normalizedID)) {
      return null;
    }

    citedEntryIDs.push(normalizedID);
  }

  return {
    answer,
    citedEntryIDs
  };
}

function normalizeSecondaryMoods(value) {
  if (value == null) {
    return null;
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const sanitized = [];

  for (const item of value) {
    if (!isPlainObject(item)) {
      return null;
    }

    const mood = normalizeOptionalString(item.mood);
    const confidence = typeof item.confidence === "number" && Number.isFinite(item.confidence)
      ? item.confidence
      : null;

    if (!mood || confidence === null) {
      return null;
    }

    sanitized.push({ mood, confidence });
  }

  return sanitized;
}

function normalizeOptionalString(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

function normalizeOptionalInteger(value) {
  return Number.isInteger(value) ? value : null;
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
