export const LIMITS = Object.freeze({
  transcribeBytes: 15 * 1024 * 1024,
  cleanupText: 8_000,
  analyseText: 12_000,
  embedText: 30_000,
  askQuestion: 2_000,
  askEntries: 20,
  askEntryText: 30_000,
  askCombinedEntryText: 200_000,
  askHistory: 10,
  askHistoryMessage: 4_000,
  classifyNotes: 40,
  classifyNoteText: 30_000,
  classifyCombinedNoteText: 400_000,
  overviewNotes: 400,
  overviewNoteText: 30_000,
  overviewCombinedNoteText: 600_000,
  reflectEntries: 100,
  reflectEntryText: 30_000,
  reflectCombinedEntryText: 300_000
});

export class PayloadTooLargeError extends Error {}

export function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readJsonBody(request) {
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

export function readRequestBody(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    request.on("data", (chunk) => {
      if (settled) {
        return;
      }

      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        reject(new PayloadTooLargeError("Payload too large"));
        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
    request.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
  });
}

export function getMultipartFileSize(body, contentType) {
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]?.trim();
  if (!boundary) {
    return null;
  }

  const partBoundary = Buffer.from(`\r\n--${boundary}`);
  const headerSeparator = Buffer.from("\r\n\r\n");
  let cursor = body.indexOf(Buffer.from(`--${boundary}`));

  while (cursor >= 0) {
    const headerStart = cursor + boundary.length + 2;
    const headerEnd = body.indexOf(headerSeparator, headerStart);
    if (headerEnd < 0) {
      return null;
    }

    const nextBoundary = body.indexOf(partBoundary, headerEnd + headerSeparator.length);
    if (nextBoundary < 0) {
      return null;
    }

    const headers = body.toString("utf8", headerStart, headerEnd);
    if (/content-disposition:[^\r\n]*(?:name="file"|filename=)/i.test(headers)) {
      return nextBoundary - (headerEnd + headerSeparator.length);
    }

    cursor = nextBoundary + 2;
  }

  return null;
}

export function totalStringLength(items, key) {
  return items.reduce((total, item) => (
    total + (typeof item?.[key] === "string" ? item[key].length : 0)
  ), 0);
}

export function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  return response.end(JSON.stringify(payload));
}

export function sendJsonError(response, statusCode, message) {
  return sendJson(response, statusCode, { error: { message } });
}

export function sendText(response, statusCode, message) {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  return response.end(message);
}
