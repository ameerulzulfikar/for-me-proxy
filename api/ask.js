import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

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

const streamingCitationInstruction = 'End your answer with a final line in the exact format CITED: ["id1","id2"] listing only IDs from the provided entries you referenced. If none, output CITED: [].';

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

  if (!isPlainObject(body)) {
    return sendJson(response, 400, { error: { message: "Invalid request body" } });
  }

  const question = typeof body.question === "string" ? body.question.trim() : "";
  const entries = Array.isArray(body.entries) ? body.entries : null;
  const history = body.history === undefined ? [] : body.history;
  const stream = body.stream === undefined ? false : body.stream;

  if (!question) {
    return sendJson(response, 400, { error: { message: "Missing question" } });
  }

  if (!entries) {
    return sendJson(response, 400, { error: { message: "Missing entries array" } });
  }

  if (!Array.isArray(history)) {
    return sendJson(response, 400, { error: { message: "Invalid history array" } });
  }

  if (typeof stream !== "boolean") {
    return sendJson(response, 400, { error: { message: "Invalid stream" } });
  }

  if (question.length > LIMITS.askQuestion) {
    return sendJson(response, 413, { error: { message: "Question too large" } });
  }

  if (entries.length > LIMITS.askEntries) {
    return sendJson(response, 413, { error: { message: "Too many entries" } });
  }

  if (entries.some((entry) => typeof entry?.text === "string" && entry.text.length > LIMITS.askEntryText)) {
    return sendJson(response, 413, { error: { message: "Entry text too large" } });
  }

  if (totalStringLength(entries, "text") > LIMITS.askCombinedEntryText) {
    return sendJson(response, 413, { error: { message: "Combined entry text too large" } });
  }

  if (history.length > LIMITS.askHistory) {
    return sendJson(response, 413, { error: { message: "Too many history messages" } });
  }

  if (history.some((message) => typeof message?.content === "string" && message.content.length > LIMITS.askHistoryMessage)) {
    return sendJson(response, 413, { error: { message: "History message too large" } });
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

  if (stream) {
    return streamAnswer(response, apiKey, sanitizedHistory, sanitizedEntries, question, allowedEntryIDs);
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
        model: "claude-sonnet-4-6",
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
      console.error("Ask provider error", upstreamResponse.status, responseBody);
      return sendAskFailure(response);
    }

    const parsed = JSON.parse(responseBody);
    const toolUse = parsed.content?.find((block) => block.type === "tool_use" && block.name === answerTool.name);
    const answer = toolUse?.input;

    if (!answer || typeof answer !== "object") {
      console.error("Ask response missing tool output", upstreamResponse.status, parsed.stop_reason || "unknown");
      return sendAskFailure(response);
    }

    const validated = validateAnswer(answer, allowedEntryIDs);
    if (!validated) {
      console.error("Ask response failed validation", upstreamResponse.status);
      return sendAskFailure(response);
    }

    return sendJson(response, 200, validated);
  } catch (error) {
    console.error("Ask proxy failed", formatCaughtError(error));
    return sendAskFailure(response);
  }
}

async function streamAnswer(response, apiKey, history, entries, question, allowedEntryIDs) {
  let upstreamResponse;

  try {
    upstreamResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        temperature: 0.2,
        stream: true,
        system: `${systemPrompt}\n${streamingCitationInstruction}`,
        messages: buildStreamingMessages(history, entries, question)
      })
    });
  } catch (error) {
    console.error("Ask streaming request failed", formatCaughtError(error));
    return sendAskFailure(response);
  }

  if (!upstreamResponse.ok) {
    let responseBody = "";
    try {
      responseBody = await upstreamResponse.text();
    } catch (error) {
      console.error("Ask streaming provider error body read failed", upstreamResponse.status, formatCaughtError(error));
    }
    console.error("Ask streaming provider error", upstreamResponse.status, responseBody);
    return sendAskFailure(response);
  }

  if (!upstreamResponse.body) {
    console.error("Ask streaming response body unavailable", upstreamResponse.status);
    return sendAskFailure(response);
  }

  response.statusCode = 200;
  response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  response.setHeader("Cache-Control", "no-cache");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  let pendingText = "";
  let providerBuffer = "";
  let streamFailed = false;

  try {
    const decoder = new TextDecoder();

    for await (const chunk of upstreamResponse.body) {
      providerBuffer += decoder.decode(chunk, { stream: true });
      const lines = providerBuffer.split(/\r?\n/);
      providerBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) {
          continue;
        }

        const data = line.slice(5).trimStart();
        if (!data || data === "[DONE]") {
          continue;
        }

        let event;
        try {
          event = JSON.parse(data);
        } catch (error) {
          console.error("Ask streaming event parse failed", upstreamResponse.status, formatCaughtError(error));
          continue;
        }

        if (event.type === "error") {
          const message = normalizeProviderError(event);
          console.error("Ask streaming provider error", upstreamResponse.status, JSON.stringify(event.error || {}));
          writeSse(response, "error", { message });
          streamFailed = true;
          break;
        }

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
          pendingText += event.delta.text;
          if (pendingText.length > 200) {
            const safeText = pendingText.slice(0, pendingText.length - 200);
            pendingText = pendingText.slice(-200);
            writeSse(response, "token", { text: safeText });
          }
        }
      }

      if (streamFailed) {
        break;
      }
    }
  } catch (error) {
    console.error("Ask streaming proxy failed", formatCaughtError(error));
    writeSse(response, "error", { message: "Ask failed" });
    streamFailed = true;
  }

  if (!streamFailed) {
    const { answerTail, citedEntryIDs } = parseCitationTail(pendingText, allowedEntryIDs);
    if (answerTail) {
      writeSse(response, "token", { text: answerTail });
    }
    writeSse(response, "done", { citedEntryIDs });
  }

  return response.end();
}

function buildStreamingMessages(history, entries, question) {
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
        text: [
          "Journal entries:",
          JSON.stringify(entries, null, 2),
          "",
          `Question: ${question}`,
          "",
          "Answer using only these entries."
        ].join("\n")
      }
    ]
  });

  return messages;
}

function parseCitationTail(value, allowedEntryIDs) {
  const citationStart = value.search(/(?:^|\r?\n)CITED:\s*/);
  if (citationStart < 0) {
    return { answerTail: value, citedEntryIDs: [] };
  }

  const prefixLength = value[citationStart] === "\n" || value[citationStart] === "\r" ? 1 : 0;
  const answerTail = value.slice(0, citationStart);
  const citationLine = value.slice(citationStart + prefixLength).trim();
  const match = /^CITED:\s*(\[[^\r\n]*\])$/.exec(citationLine);

  if (!match) {
    return { answerTail, citedEntryIDs: [] };
  }

  try {
    const parsed = JSON.parse(match[1]);
    if (!Array.isArray(parsed)) {
      return { answerTail, citedEntryIDs: [] };
    }

    const citedEntryIDs = parsed.filter((id) => (
      typeof id === "string" && allowedEntryIDs.has(id)
    ));
    return { answerTail, citedEntryIDs };
  } catch (error) {
    console.error("Ask citation parse failed", formatCaughtError(error));
    return { answerTail, citedEntryIDs: [] };
  }
}

function sendAskFailure(response) {
  return sendJson(response, 502, { error: { message: "Ask failed" } });
}

function formatCaughtError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function normalizeProviderError(event) {
  const message = event.error?.message;
  return typeof message === "string" && message.trim() ? message.trim() : "Ask failed";
}

function writeSse(response, event, payload) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  response.flush?.();
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
