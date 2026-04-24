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

  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) {
    return sendJson(response, 400, { error: { message: "Missing text" } });
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
      console.error("Embedding provider error", upstreamResponse.status, responseBody);
      return sendJson(response, 502, { error: { message: "Embedding failed" } });
    }

    const parsed = JSON.parse(responseBody);
    const embedding = parsed.data?.[0]?.embedding;

    if (!Array.isArray(embedding) || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
      console.error("Embedding response was invalid", responseBody);
      return sendJson(response, 502, { error: { message: "Embedding failed" } });
    }

    return sendJson(response, 200, { embedding });
  } catch (error) {
    console.error("Embedding proxy failed", error);
    return sendJson(response, 502, { error: { message: "Embedding failed" } });
  }
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
