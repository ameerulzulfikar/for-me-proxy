export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return sendText(response, 405, "Method not allowed");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return sendText(response, 500, "Missing OPENAI_API_KEY");
  }

  const contentType = request.headers["content-type"];
  if (!contentType || !contentType.includes("multipart/form-data")) {
    return sendText(response, 400, "Expected multipart/form-data");
  }

  try {
    const body = await readRequestBody(request);

    const upstreamResponse = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": contentType
      },
      body
    });

    const responseBody = await upstreamResponse.text();
    response.statusCode = upstreamResponse.status;
    response.setHeader("Content-Type", upstreamResponse.headers.get("content-type") || "application/json");
    return response.end(responseBody);
  } catch (error) {
    console.error("Transcription proxy failed", error);
    return sendText(response, 502, "Transcription failed");
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendText(response, statusCode, message) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  return response.end(message);
}
