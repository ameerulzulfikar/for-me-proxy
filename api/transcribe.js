import { LIMITS, PayloadTooLargeError, getMultipartFileSize, readRequestBody, sendText } from "./_validation.js";

const MAX_MULTIPART_OVERHEAD = 1024 * 1024;

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

  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > LIMITS.transcribeBytes + MAX_MULTIPART_OVERHEAD) {
    return sendText(response, 413, "Audio too large");
  }

  try {
    const body = await readRequestBody(request, LIMITS.transcribeBytes + MAX_MULTIPART_OVERHEAD);
    const audioSize = getMultipartFileSize(body, contentType);

    if (audioSize === null) {
      return sendText(response, 400, "Missing audio file");
    }

    if (audioSize > LIMITS.transcribeBytes) {
      return sendText(response, 413, "Audio too large");
    }

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
    if (error instanceof PayloadTooLargeError) {
      return sendText(response, 413, "Audio too large");
    }

    return sendText(response, 502, "Transcription failed");
  }
}
