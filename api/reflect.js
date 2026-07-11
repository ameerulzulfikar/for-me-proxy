import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

const systemPrompt = `
You are this person's journal reflecting on their week. Be a neutral observer in insight and a kind friend in delivery. Reference specific days naturally, such as "On Tuesday you…". Weigh the evidence honestly and never fabricate. Never be therapeutic. Never say "you should" or "have you considered".

Write a 150-250 word narrative grounded only in the entries. Return 3-5 themes when the evidence supports them. The mood summary must be 1-2 sentences, or an empty string when no moods are present. With fewer than 3 entries, say honestly that the week was quiet and reflect only on what exists. Always use the provided tool.
`.trim();

const reflectionTool = {
  name: "submit_weekly_reflection",
  description: "Return a grounded weekly journal reflection.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      narrative: { type: "string", minLength: 1 },
      themes: {
        type: "array",
        minItems: 3,
        maxItems: 5,
        items: { type: "string", minLength: 1 }
      },
      moodSummary: { type: "string" }
    },
    required: ["narrative", "themes", "moodSummary"]
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

  if (!Array.isArray(body.entries)) {
    return sendJson(response, 400, { error: { message: "Missing entries array" } });
  }

  if (body.entries.length > LIMITS.reflectEntries) {
    return sendJson(response, 413, { error: { message: "Too many entries" } });
  }

  const entries = sanitizeEntries(body.entries);
  if (!entries) {
    return sendJson(response, 400, { error: { message: "Invalid entries array" } });
  }

  if (entries.some((entry) => entry.text.length > LIMITS.reflectEntryText)) {
    return sendJson(response, 413, { error: { message: "Entry text too large" } });
  }

  if (totalStringLength(entries, "text") > LIMITS.reflectCombinedEntryText) {
    return sendJson(response, 413, { error: { message: "Combined entry text too large" } });
  }

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
        max_tokens: 1400,
        temperature: 0.2,
        system: systemPrompt,
        tools: [reflectionTool],
        tool_choice: {
          type: "tool",
          name: reflectionTool.name
        },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: `Reflect on this week using these journal entries:\n\n${JSON.stringify(entries, null, 2)}`
              }
            ]
          }
        ]
      })
    });

    const responseText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      console.error("Reflection provider error", upstreamResponse.status, responseText);
      return sendReflectionFailure(response, providerErrorDetail(upstreamResponse.status, responseText));
    }

    const responseBody = JSON.parse(responseText);
    const toolUse = responseBody.content?.find((block) => block.type === "tool_use" && block.name === reflectionTool.name);
    const reflection = validateReflection(toolUse?.input);

    if (!reflection) {
      const detail = `Anthropic ${upstreamResponse.status}: ${reflectionTool.name} output missing or failed validation (stop_reason: ${responseBody.stop_reason || "unknown"})`;
      console.error("Reflection response missing or failed tool validation", upstreamResponse.status, responseBody.stop_reason || "unknown");
      return sendReflectionFailure(response, detail);
    }

    return sendJson(response, 200, reflection);
  } catch (error) {
    console.error("Reflection proxy failed", formatCaughtError(error));
    return sendReflectionFailure(response, exceptionDetail(error));
  }
}

// TODO: remove after debugging
function sendReflectionFailure(response, detail) {
  return sendJson(response, 502, { error: { message: "Reflection failed", detail } });
}

function providerErrorDetail(status, responseBody) {
  let message = responseBody.trim();

  try {
    const parsed = JSON.parse(responseBody);
    if (typeof parsed.error?.message === "string" && parsed.error.message.trim()) {
      message = parsed.error.message.trim();
    }
  } catch {
    // The raw provider body is the most useful fallback detail.
  }

  return `Anthropic ${status}: ${message || "Unknown provider error"}`;
}

function exceptionDetail(error) {
  return `Exception: ${error instanceof Error ? error.message : String(error)}`;
}

function formatCaughtError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function sanitizeEntries(entries) {
  const sanitized = [];

  for (const entry of entries) {
    if (!isPlainObject(entry) || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.date !== "string" || typeof entry.text !== "string" || (entry.mood != null && typeof entry.mood !== "string") || (entry.tag != null && typeof entry.tag !== "string")) {
      return null;
    }

    sanitized.push({
      id: entry.id.trim(),
      date: entry.date,
      text: entry.text,
      mood: typeof entry.mood === "string" ? entry.mood : "",
      tag: typeof entry.tag === "string" ? entry.tag : ""
    });
  }

  return sanitized;
}

function validateReflection(value) {
  if (!isPlainObject(value) || typeof value.narrative !== "string" || !value.narrative.trim() || !Array.isArray(value.themes) || value.themes.length < 3 || value.themes.length > 5 || value.themes.some((theme) => typeof theme !== "string" || !theme.trim()) || typeof value.moodSummary !== "string") {
    return null;
  }

  return {
    narrative: value.narrative,
    themes: value.themes,
    moodSummary: value.moodSummary
  };
}
