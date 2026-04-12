const systemPrompt = `
You are cleaning up a voice journal transcription. Your job:
1) Add paragraph breaks at natural topic shifts.
2) Fix obvious speech-to-text errors.
3) Remove filler words (um, uh, like) unless they add character.
4) Fix punctuation and capitalisation.
5) DO NOT change meaning, add content, or rewrite.
6) DO NOT add headers or bullet points — just clean paragraphs.
7) Preserve the person's natural voice.
8) Return ONLY the cleaned text.
After cleaning up the text, on the very last line of your response, write TAG: followed by one of these categories that best fits the content: Business, Personal, Idea, Reflection. For example: TAG: Business
`.trim();

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendText(response, 405, "Method not allowed");
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return sendText(response, 500, "Missing ANTHROPIC_API_KEY");
  }

  let rawText;
  try {
    const body = await readJsonBody(request);
    rawText = typeof body.text === "string" ? body.text : "";
  } catch {
    return sendText(response, 400, "Invalid JSON");
  }

  if (!rawText.trim()) {
    return sendText(response, 400, "Missing text");
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
        model: "claude-haiku-4-5-20251001",
        max_tokens: 4096,
        system: systemPrompt,
        messages: [
          { role: "user", content: rawText }
        ]
      })
    });

    const responseBody = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      console.error("Cleanup provider error", upstreamResponse.status, responseBody);
      return sendText(response, upstreamResponse.status, "Cleanup failed");
    }

    const parsed = JSON.parse(responseBody);
    const cleaned = parsed.content?.find((block) => block.type === "text")?.text;
    if (typeof cleaned !== "string" || !cleaned.trim()) {
      return sendText(response, 502, "Cleanup response was empty");
    }

    return sendText(response, 200, cleaned.trim());
  } catch (error) {
    console.error("Cleanup proxy failed", error);
    return sendText(response, 502, "Cleanup failed");
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

function sendText(response, statusCode, message) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  return response.end(message);
}
