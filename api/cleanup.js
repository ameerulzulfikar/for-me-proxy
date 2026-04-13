const systemPrompt = `
You are a transcription formatter. You receive raw voice-to-text output and return a cleaned version.

ABSOLUTE RULES:
- Fix punctuation and capitalisation only
- Add paragraph breaks at natural topic shifts
- Remove ONLY filler sounds: um, uh, er
- Keep ALL meaningful words including: cool, nice, alright, okay, right, yeah, so
- DO NOT add any words, sentences, or ideas not in the original
- DO NOT expand, elaborate, or add context
- DO NOT generate content — you are a formatter, not a writer
- If the input is one sentence, return one sentence
- The output must NEVER be longer than the input
- NEVER describe what you would do — just do it
- NEVER say "I'm ready" or "paste the text" — the text is already provided

On the very last line, write TAG: followed by one of: Business, Personal, Idea, Reflection
Example: TAG: Personal
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
          { role: "user", content: "Clean up this transcription:\n\n" + rawText }
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

    // Safety check: if Haiku returned something longer than 2x the input, it hallucinated — return raw text with tag
    if (cleaned.length > rawText.length * 2) {
      return sendText(response, 200, rawText.trim() + "\nTAG: Personal");
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
