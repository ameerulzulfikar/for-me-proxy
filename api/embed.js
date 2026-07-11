import { LIMITS, isPlainObject, readJsonBody, sendJson } from "./_validation.js";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendJson(response, 405, { error: { message: "Method not allowed" } });
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendJson(response, 500, { error: { message: "Missing OPENAI_API_KEY" } });
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

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return sendJson(response, 400, { error: { message: "Missing text" } });
  }

  if (typeof body.text === "string" && body.text.length > LIMITS.embedText) {
    return sendJson(response, 413, { error: { message: "Text too large" } });
  }

  try {
    const upstreamResponse = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "text-embedding-3-large",
        input: text
      })
    });

    const responseBody = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      return sendJson(response, 502, { error: { message: "Embedding failed" } });
    }

    const parsed = JSON.parse(responseBody);
    const embedding = parsed.data?.[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      return sendJson(response, 502, { error: { message: "Embedding failed" } });
    }

    return sendJson(response, 200, { embedding });
  } catch {
    return sendJson(response, 502, { error: { message: "Embedding failed" } });
  }
}
