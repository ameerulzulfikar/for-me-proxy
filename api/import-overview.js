import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

const MAX_NOTES = 3_000;
const MAX_COMBINED_NOTE_TEXT = 2_100_000; // Approximately 700,000 tokens at 3 characters per token.
const MONTH_BREAKDOWN_MIN_NOTES = 12;
const MAX_OUTPUT_TOKENS = 32_000;
const PROVIDER_TIMEOUT_MS = 270_000;

const systemPrompt = `
You are reading someone's complete personal note archive across many years: every word they have supplied. Do not summarize it. Describe who this person is, what keeps occupying them, and what has quietly endured. Write every section in the second person. Always return the result through the provided tool.

WRITING RULES — PROMINENT AND OVERRIDING
These rules override any instinct toward literary style.

VOICE — APPLIES EVERYWHERE: Write like a perceptive friend describing someone they have come to know. Be warm, plain, and direct. Use short declarative sentences. Contractions are fine. Use second person throughout. Do not write in a literary style. Do not use metaphors about the archive. Do not add dramatic flourishes or rhetorical questions. Never sound therapeutic or clinical, and never say "you should". If a sentence sounds like it was written to impress, cut it.

EVIDENCE: Every substantial claim must be anchored — a quote-by-reference locator or a concrete artifact (a named project, a tracked number, a recurring object or list). Claims without anchors are not worth making. One anchored observation beats three graceful generalisations. Structured source IDs anchor chronology; never use a written date as prose evidence.

UNCERTAINTY: Do not hedge in portrait. Put only well-supported claims there and state them directly. In later sections, where a reading is genuinely uncertain, say so in plain words ("I might be reading too much into this", "you'd know better than I would"). Where two readings both fit the evidence, name both.

INSIGHT REQUIREMENT: At least two observations across the whole response must be things the person likely has NOT articulated about themselves — a pattern only visible across years, a contradiction between two areas of their notes, or a continuity they wouldn't have named. Offer these as observations, never as verdicts, and always with their evidence attached. Do not moralise or advise.

DEPTH OVER COVERAGE: Your job is depth, not coverage. It is better to say three things with real evidence and real thought than to list ten things briefly. Develop each observation: name the evidence, explain what it may reveal, and connect it to another concrete part of the notes where the connection is real. Do not write summary sentences that could describe many people.

Do not add personality typing, psychological frameworks, or diagnostic language of any kind.

HARD PRIVACY RULE — APPLIES TO THE ENTIRE RESPONSE
Never name or reference health conditions, diagnoses, medical treatments, therapy or psychology appointments, deceased people by name or relationship detail, or romantic partners by name. This rule applies to every field, including portrait, forgotten-idea titles and explanations, tender, and questions. It also applies to quotes. Before choosing a locator, screen the entire cited line or line range. Never cite a line containing any of those specifics. Gesture without exposing private detail. No other instruction overrides this rule.

SOURCE LOCATORS AND SERVER-COMPUTED DATES — ABSOLUTE
The user message begins with a server-computed timeline index, followed by notes labelled n1, n2, and so on in chronological order. Every line of note text is prefixed with its note ID and line number, such as "n412|L7|".
1. NEVER WRITE QUOTE TEXT YOURSELF. To quote the person, insert a token such as {{cite:0}} at the exact position where the quote belongs in the prose. Then put { noteId, startLine, endLine } at index 0 of that section's citations array. The server, not you, will extract and insert the exact words from those lines.
2. Treat each citation token as a quoted phrase so the surrounding prose is grammatical after substitution. Example: You wrote {{cite:0}} in the middle of a grocery list. Choose quotes for emotional or revealing weight, not as decoration. Prefer a short striking line over a bland factual one. The sentence around a quote must say what the line reveals; do not merely introduce it.
3. Citation indexes start at 0 and refer only to the citations array beside that section. Use an inclusive line range. Never put quote text in a citation object or anywhere else in your response.
4. For portrait, character, preoccupations, throughLine, and tender, use the correspondingly named top-level citations array. Each forgotten idea has its own citations array. Questions have no citations and must not contain citation tokens. Every {{cite:N}} token must have a locator at index N in that section's citations array; a token without its matching locator is invalid. Include only locators used by tokens in that section. If there are no tokens, return an empty citations array.
5. NEVER WRITE A YEAR, MONTH, CALENDAR DATE, DATE RANGE, OR BARE AGE IN PROSE. Do not write phrases such as "at 19"; describe the life stage instead. Use relative language that cannot be mistaken for a date: "early on", "years later", "in the last stretch", "at the start of the real estate years", or "shortly after". For example, write "early in your working life" instead of an age, and "years later, the project returned" instead of naming a year. Do not produce period or whenWritten fields. The server computes every displayed date from real createdAt metadata.
6. For each forgotten idea, provide the single sourceNoteId where the idea appears. This source ID is for server-side date computation, not prose.

PORTRAIT — THE HEADLINE
Write 6-10 sentences answering "who is this person?" plainly and confidently, as you would describe a friend to someone who has not met them. Include the concrete, ordinary facts that place them in the world when the notes establish them: where they live and work, what they do for a living, their family situation, and what they build. State these facts flatly and without commentary. Respect the hard privacy rule while doing so. Then make a few direct character claims that the evidence supports. End with exactly one sentence naming the central tension of their life as these notes show it: what they are chasing and what it seems to cost or compete with. Make that closing sentence the single most quotable line in the response. Do not hedge anywhere in portrait.

CHARACTER — THE DEEPER READ
Write 8-12 sentences. Every high-level claim must immediately descend into the concrete behaviour, quoted line, repeated artifact, named project, tracked number, object, or list that produced the claim. Abstraction alone is worthless. The point is the claim plus its dissection. Include at least one observation the person probably has not articulated about themselves. You may hedge here when the evidence genuinely leaves room for another reading.

PREOCCUPATIONS
Write 5-8 sentences about what they cannot stop returning to. Identify the underlying concerns, not merely the subjects they mention. Explain why those concerns keep returning, with evidence. Do not turn this into a list of topics.

THROUGHLINE
Write 5-8 sentences about what stayed constant while the surface changed. Support the throughline with evidence from both early and recent material. Trace transformation rather than disappearance. Derive every connection only from this archive.

FORGOTTEN IDEAS
Return 4-5 specific ideas that are genuinely forgotten or easily overlooked, with the sourceNoteId where each idea appears and a concise explanation of why each is worth revisiting. Do not write a date; the server will add whenWritten from that note's metadata.

TENDER
Write 4-6 sentences and no more. Acknowledge emotional depth with care when it is present. Recognize that it matters without exposing private specifics. Keep this restrained.

QUESTIONS
Return exactly three questions with no citations. Ask what you would genuinely want to ask this person and what only their own archive could answer. Write each in second person. Keep each short and curious. They must be genuine questions, never rhetorical ones.

LENGTH
Leave the reader wanting more, not feeling finished. Cut anything that merely restates another section.

INTEGRITY RULES — ABSOLUTE
1. Every date in the response, including every whenWritten value, must be copied from or derived strictly from the notes' createdAt fields. Never infer a date from note content or estimate one from memory. When precision is uncertain, use only the createdAt year. The server alone adds these dates.
2. Never state or imply a count greater than the number of notes actually supplied.
3. You may observe correlation, but never declare causation without evidence. Outside portrait, mark uncertain interpretation explicitly in plain language. Where the notes do not establish a cause, say less. In portrait, include only claims supported strongly enough to state directly.
4. Never fabricate or alter a quote. Verbatim means exact text from the notes.
5. For thin or sparse archives, write shorter, honest sections rather than inventing depth.
`.trim();

const citationSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    noteId: { type: "string" },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 }
  },
  required: ["noteId", "startLine", "endLine"]
};

const citationsSchema = {
  type: "array",
  items: citationSchema
};

const overviewTool = {
  name: "submit_import_overview",
  description: "Return a perceptive, grounded reading of a personal note archive.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      portrait: { type: "string" },
      portraitCitations: citationsSchema,
      character: { type: "string" },
      characterCitations: citationsSchema,
      preoccupations: { type: "string" },
      preoccupationsCitations: citationsSchema,
      throughLine: { type: "string" },
      throughLineCitations: citationsSchema,
      forgottenIdeas: {
        type: "array",
        minItems: 4,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            sourceNoteId: { type: "string" },
            why: { type: "string" },
            citations: citationsSchema
          },
          required: ["title", "sourceNoteId", "why", "citations"]
        }
      },
      tender: { type: "string" },
      tenderCitations: citationsSchema,
      questions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        items: { type: "string" }
      }
    },
    required: ["portrait", "portraitCitations", "character", "characterCitations", "preoccupations", "preoccupationsCitations", "throughLine", "throughLineCitations", "forgottenIdeas", "tender", "tenderCitations", "questions"]
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

  if (!Array.isArray(body.notes)) {
    return sendJson(response, 400, { error: { message: "Missing notes array" } });
  }

  if (body.notes.length > MAX_NOTES) {
    return sendJson(response, 413, { error: { message: "Too many notes" } });
  }

  const notes = sanitizeNotes(body.notes);
  if (!notes) {
    return sendJson(response, 400, { error: { message: "Invalid notes array" } });
  }

  if (notes.some((note) => note.text.length > LIMITS.overviewNoteText)) {
    return sendJson(response, 413, { error: { message: "Note text too large" } });
  }

  const boundedNotes = totalStringLength(notes, "text") > MAX_COMBINED_NOTE_TEXT
    ? dropOldestNotes(notes, MAX_COMBINED_NOTE_TEXT)
    : notes;
  const scaffoldedNotes = scaffoldNotes(boundedNotes);

  try {
    const upstreamResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        tools: [overviewTool],
        tool_choice: { type: "tool", name: overviewTool.name },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: buildOverviewPrompt(scaffoldedNotes)
              }
            ]
          }
        ]
      })
    });

    const responseText = await upstreamResponse.text();
    if (!upstreamResponse.ok) {
      console.error("Import overview provider error", upstreamResponse.status, responseText);
      return sendImportOverviewFailure(response, {
        type: "provider_http_error",
        message: `Provider returned HTTP ${upstreamResponse.status}`,
        provider_status: upstreamResponse.status,
        provider_body: parseProviderErrorBody(responseText),
        stop_reason: null,
        usage: null
      });
    }

    let responseBody;
    try {
      responseBody = JSON.parse(responseText);
    } catch (error) {
      console.error("Import overview provider response parse failed", formatCaughtError(error));
      return sendImportOverviewFailure(response, {
        type: "parse_error",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack || null : null,
        stop_reason: null,
        usage: null
      });
    }

    const providerDiagnostics = getProviderDiagnostics(responseBody);
    if (["max_tokens", "model_context_window_exceeded"].includes(providerDiagnostics.stop_reason)) {
      console.error(`Import overview provider stopped before completing tool output stop_reason=${providerDiagnostics.stop_reason} output_tokens=${providerDiagnostics.usage?.output_tokens ?? "unknown"}`);
      return sendImportOverviewFailure(response, {
        type: "stop_reason",
        message: `Provider stopped with ${providerDiagnostics.stop_reason} before completing the overview`,
        ...providerDiagnostics
      });
    }

    const responseContent = Array.isArray(responseBody?.content) ? responseBody.content : [];
    const toolUse = responseContent.find((block) => isPlainObject(block) && block.type === "tool_use" && block.name === overviewTool.name);
    const validation = validateOverview(toolUse?.input);

    if (!validation.overview) {
      console.error(`Import overview response failed validation stop_reason=${providerDiagnostics.stop_reason ?? "unknown"} output_tokens=${providerDiagnostics.usage?.output_tokens ?? "unknown"}`);
      return sendImportOverviewFailure(response, {
        type: toolUse ? "tool_input_validation_error" : "missing_tool_output",
        message: toolUse ? "Provider tool input failed overview validation" : "Provider response did not contain the required overview tool output",
        failed_fields: validation.diagnostics.failedFields,
        top_level_keys: validation.diagnostics.topLevelKeys,
        first_forgotten_idea_keys: validation.diagnostics.firstForgottenIdeaKeys,
        ...providerDiagnostics
      });
    }

    try {
      return sendJson(response, 200, verifyOverview(validation.overview, scaffoldedNotes));
    } catch (error) {
      console.error("Import overview verification crashed", formatCaughtError(error));
      return sendImportOverviewFailure(response, {
        type: "verification_crash",
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack || null : null,
        ...providerDiagnostics
      });
    }
  } catch (error) {
    console.error("Import overview proxy failed", formatCaughtError(error));
    return sendImportOverviewFailure(response, {
      type: isTimeoutError(error) ? "timeout" : "caught_exception",
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack || null : null,
      stop_reason: null,
      usage: null
    });
  }
}

// TODO remove after debugging: temporarily expose provider-safe failure metadata in 502 responses.
function sendImportOverviewFailure(response, detail) {
  return sendJson(response, 502, { error: { message: "Import overview failed", detail } });
}

function getProviderDiagnostics(responseBody) {
  return {
    stop_reason: typeof responseBody?.stop_reason === "string" ? responseBody.stop_reason : null,
    usage: isPlainObject(responseBody?.usage) ? responseBody.usage : null
  };
}

function parseProviderErrorBody(responseText) {
  try {
    return JSON.parse(responseText);
  } catch {
    return responseText.slice(0, 4_000);
  }
}

function isTimeoutError(error) {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError" || error.cause?.name === "TimeoutError" || error.cause?.name === "AbortError");
}

function formatCaughtError(error) {
  return error instanceof Error ? error.stack || error.message : String(error);
}

function scaffoldNotes(notes) {
  return notes
    .map((note, originalIndex) => ({
      ...note,
      originalIndex,
      timestamp: Date.parse(note.createdAt)
    }))
    .sort((a, b) => a.timestamp - b.timestamp || compareStrings(a.id, b.id) || a.originalIndex - b.originalIndex)
    .map((note, index) => {
      const { lines, lineEndings } = splitNoteText(note.text);
      return {
        noteId: `n${index + 1}`,
        title: note.title,
        text: note.text,
        lines,
        lineEndings,
        createdAt: note.createdAt,
        timestamp: note.timestamp,
        dateLabel: formatDateLabel(note.timestamp)
      };
    });
}

function buildOverviewPrompt(notes) {
  const noteBlocks = notes.map((note) => [
    `[NOTE ${note.noteId} | DATE: ${note.dateLabel} | TITLE: ${JSON.stringify(note.title)}]`,
    note.lines.map((line, index) => `${note.noteId}|L${index + 1}| ${line}`).join("\n"),
    `[END NOTE ${note.noteId}]`
  ].join("\n"));

  return [
    buildTimelineIndex(notes),
    "",
    "The timeline is reference material only. Do not write dates in prose or return date fields.",
    "To quote, write only a {{cite:N}} token and a { noteId, startLine, endLine } locator in that section's citations array. Never write the quote text.",
    "",
    "NOTES — CHRONOLOGICAL, FULL TEXT",
    noteBlocks.join("\n\n")
  ].join("\n");
}

function splitNoteText(text) {
  const lines = [];
  const lineEndings = [];
  let lineStart = 0;

  for (const match of text.matchAll(/\r\n|\n|\r/gu)) {
    lines.push(text.slice(lineStart, match.index));
    lineEndings.push(match[0]);
    lineStart = match.index + match[0].length;
  }
  lines.push(text.slice(lineStart));
  lineEndings.push("");
  return { lines, lineEndings };
}

function buildTimelineIndex(notes) {
  const countsByYear = new Map();

  for (const note of notes) {
    const date = new Date(note.timestamp);
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth();
    const yearCounts = countsByYear.get(year) || { total: 0, months: new Map() };
    yearCounts.total += 1;
    yearCounts.months.set(month, (yearCounts.months.get(month) || 0) + 1);
    countsByYear.set(year, yearCounts);
  }

  const overallRange = notes.length === 0
    ? "none"
    : formatDateRange(notes[0].dateLabel, notes[notes.length - 1].dateLabel);
  const rows = [
    "TIMELINE INDEX — SERVER-COMPUTED AND AUTHORITATIVE",
    "| Scope | Date or range | Note count |",
    "| --- | --- | ---: |",
    `| Overall | ${overallRange} | ${notes.length} |`
  ];

  for (const [year, yearCounts] of [...countsByYear.entries()].sort((a, b) => a[0] - b[0])) {
    rows.push(`| Year | ${year} | ${yearCounts.total} |`);

    if (yearCounts.total >= MONTH_BREAKDOWN_MIN_NOTES) {
      for (const [month, count] of [...yearCounts.months.entries()].sort((a, b) => a[0] - b[0])) {
        rows.push(`| Month | ${formatDateLabel(Date.UTC(year, month, 1))} | ${count} |`);
      }
    }
  }

  return rows.join("\n");
}

function formatDateLabel(timestamp) {
  const date = new Date(timestamp);
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  return `${monthNames[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function formatDateRange(firstDateLabel, lastDateLabel) {
  return firstDateLabel === lastDateLabel
    ? firstDateLabel
    : `${firstDateLabel} – ${lastDateLabel}`;
}

function compareStrings(a, b) {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function sanitizeNotes(notes) {
  const sanitized = [];

  for (const note of notes) {
    if (!isPlainObject(note) || typeof note.id !== "string" || !note.id.trim() || typeof note.title !== "string" || typeof note.text !== "string" || typeof note.createdAt !== "string" || !Number.isFinite(Date.parse(note.createdAt))) {
      return null;
    }
    sanitized.push({ id: note.id.trim(), title: note.title, text: note.text, createdAt: note.createdAt });
  }

  return sanitized;
}

function dropOldestNotes(notes, limit) {
  let total = totalStringLength(notes, "text");
  const keep = new Set(notes.map((_, index) => index));
  const oldestFirst = notes.map((note, index) => ({
    index,
    timestamp: Number.isFinite(Date.parse(note.createdAt)) ? Date.parse(note.createdAt) : Number.NEGATIVE_INFINITY
  })).sort((a, b) => a.timestamp - b.timestamp || a.index - b.index);

  for (const { index } of oldestFirst) {
    if (total <= limit) {
      break;
    }
    keep.delete(index);
    total -= notes[index].text.length;
  }

  return notes.filter((_, index) => keep.has(index));
}

function validateOverview(value) {
  const shape = describeOverviewShape(value);
  if (!isPlainObject(value)) {
    return {
      overview: null,
      diagnostics: {
        ...shape,
        failedFields: [{ field: "$", reason: "wrong_type", expected: "object", actual: describeValueType(value) }]
      }
    };
  }

  const portrait = normalizeString(value.portrait);
  if (!portrait.trim()) {
    return {
      overview: null,
      diagnostics: {
        ...shape,
        failedFields: describeUnusableOverviewFields(value)
      }
    };
  }

  return {
    overview: {
      portrait,
      portraitCitations: normalizeCitations(value.portraitCitations),
      character: normalizeString(value.character),
      characterCitations: normalizeCitations(value.characterCitations),
      preoccupations: normalizeString(value.preoccupations),
      preoccupationsCitations: normalizeCitations(value.preoccupationsCitations),
      throughLine: normalizeString(value.throughLine),
      throughLineCitations: normalizeCitations(value.throughLineCitations),
      forgottenIdeas: normalizeForgottenIdeas(value.forgottenIdeas),
      tender: normalizeString(value.tender),
      tenderCitations: normalizeCitations(value.tenderCitations),
      questions: normalizeQuestions(value.questions)
    },
    diagnostics: { ...shape, failedFields: [] }
  };
}

function normalizeForgottenIdeas(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isPlainObject).map((idea) => ({
    title: normalizeString(idea.title),
    sourceNoteId: normalizeString(idea.sourceNoteId).trim(),
    why: normalizeString(idea.why),
    citations: normalizeCitations(idea.citations)
  }));
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((question) => typeof question === "string").slice(0, 3);
}

function normalizeCitations(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((citation) => ({
    noteId: isPlainObject(citation) ? normalizeString(citation.noteId).trim() : "",
    startLine: isPlainObject(citation) ? normalizeLineNumber(citation.startLine) : 0,
    endLine: isPlainObject(citation) ? normalizeLineNumber(citation.endLine) : 0
  }));
}

function normalizeString(value) {
  return typeof value === "string" ? value : "";
}

function normalizeLineNumber(value) {
  if (Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^\d+$/u.test(value)) {
    return Number(value);
  }
  return 0;
}

function describeOverviewShape(value) {
  const topLevelKeys = isPlainObject(value) ? Object.keys(value) : [];
  const firstForgottenIdea = isPlainObject(value) && Array.isArray(value.forgottenIdeas) ? value.forgottenIdeas[0] : null;
  return {
    topLevelKeys,
    firstForgottenIdeaKeys: isPlainObject(firstForgottenIdea) ? Object.keys(firstForgottenIdea) : []
  };
}

function describeUnusableOverviewFields(value) {
  const failedFields = [];

  if (!Object.hasOwn(value, "portrait")) {
    failedFields.push({ field: "portrait", reason: "missing", expected: "non-empty string" });
  } else if (typeof value.portrait !== "string") {
    failedFields.push({ field: "portrait", reason: "wrong_type", expected: "string", actual: describeValueType(value.portrait) });
  } else if (!value.portrait.trim()) {
    failedFields.push({ field: "portrait", reason: "failed_constraint", constraint: "must not be empty" });
  }

  return failedFields;
}

function describeValueType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function verifyOverview(overview, notes) {
  const notesById = new Map(notes.map((note) => [note.noteId, note]));
  const verification = {
    totalCitations: 0,
    passed: 0,
    failed: 0,
    failures: []
  };

  const portrait = verifyProse(overview.portrait, overview.portraitCitations, notesById, verification);
  const character = verifyProse(overview.character, overview.characterCitations, notesById, verification);
  const preoccupations = verifyProse(overview.preoccupations, overview.preoccupationsCitations, notesById, verification);
  const throughLine = verifyProse(overview.throughLine, overview.throughLineCitations, notesById, verification);
  const tender = verifyProse(overview.tender, overview.tenderCitations, notesById, verification);

  const forgottenIdeas = overview.forgottenIdeas.map((idea) => {
    const why = verifyProse(idea.why, idea.citations, notesById, verification);
    return {
      title: idea.title,
      whenWritten: computeNoteDate(idea.sourceNoteId, notesById, verification),
      why: why.text,
      citations: why.citations
    };
  });
  const questions = overview.questions.map((question) => verifyProse(question, [], notesById, verification).text);

  console.error(`Import overview verification totalCitations=${verification.totalCitations} passed=${verification.passed} failed=${verification.failed}`);

  return {
    portrait: portrait.text,
    portraitCitations: portrait.citations,
    character: character.text,
    characterCitations: character.citations,
    preoccupations: preoccupations.text,
    preoccupationsCitations: preoccupations.citations,
    throughLine: throughLine.text,
    throughLineCitations: throughLine.citations,
    forgottenIdeas,
    tender: tender.text,
    tenderCitations: tender.citations,
    questions,
    verification
  };
}

function verifyProse(text, citations, notesById, verification) {
  const withoutDates = stripDatesFromProse(text, verification);
  return substituteCitationTokens(withoutDates, citations, notesById, verification);
}

function stripDatesFromProse(text, verification) {
  const maskedText = text.replace(/\{\{\s*cite\s*:[^{}]*\}\}/giu, (token) => " ".repeat(token.length));
  const datePattern = /\b\d{4}-\d{1,2}(?:-\d{1,2})?\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b|\b(?:18|19|20|21)\d{2}\b|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\.?\s+(?:\d{1,2}(?:st|nd|rd|th)?(?:,?\s+(?:18|19|20|21)\d{2})?|(?:18|19|20|21)\d{2}))?\b/gu;
  const removalRanges = [];

  for (const match of maskedText.matchAll(datePattern)) {
    verification.totalCitations += 1;
    recordVerificationFailure(verification, {
      noteId: "",
      startLine: null,
      endLine: null,
      reason: "date_in_prose"
    });
    removalRanges.push(findSentenceRange(text, match.index, match.index + match[0].length));
  }

  return removeTextRanges(text, removalRanges);
}

function substituteCitationTokens(text, citations, notesById, verification) {
  const tokenPattern = /\{\{\s*cite\s*:\s*([^{}]*?)\s*\}\}/giu;
  const tokens = [...text.matchAll(tokenPattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    rawIndex: match[1].trim()
  }));
  const invalidRanges = [];
  const replacements = [];

  for (const token of tokens) {
    verification.totalCitations += 1;
    const citationIndex = /^\d+$/u.test(token.rawIndex) ? Number(token.rawIndex) : -1;
    const citation = citations[citationIndex];

    if (!citation) {
      recordCitationFailure(verification, citation, citationIndex, citations.length, "invalid_locator");
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    const note = notesById.get(citation.noteId);
    if (!note) {
      recordCitationFailure(verification, citation, citationIndex, citations.length, "note_not_found");
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    const resolved = resolveCitationSpan(note, citation);
    if (!resolved.span) {
      recordCitationFailure(verification, citation, citationIndex, citations.length, resolved.reason);
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    const formattedQuote = formatExtractedQuote(resolved.span, text.slice(token.end));
    if (!formattedQuote) {
      recordCitationFailure(verification, citation, citationIndex, citations.length, "empty_span");
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    verification.passed += 1;
    replacements.push({
      ...token,
      citationIndex,
      replacement: formattedQuote,
      resolvedCitation: {
        noteId: citation.noteId,
        startLine: resolved.startLine,
        endLine: resolved.endLine
      }
    });
  }

  const mergedInvalidRanges = mergeRanges(invalidRanges.map((range) => expandRangeThroughDanglingSentences(text, range)));
  const usableReplacements = replacements.filter((replacement) => !mergedInvalidRanges.some((range) => range.start <= replacement.start && replacement.end <= range.end));
  const operations = [
    ...mergedInvalidRanges.map((range) => ({ ...range, replacement: "" })),
    ...usableReplacements
  ].sort((a, b) => b.start - a.start);
  let verifiedText = text;

  for (const operation of operations) {
    if (operation.replacement) {
      verifiedText = `${verifiedText.slice(0, operation.start)}${operation.replacement}${verifiedText.slice(operation.end)}`;
    } else {
      verifiedText = removeTextRange(verifiedText, operation);
    }
  }

  if (mergedInvalidRanges.length > 0) {
    verifiedText = removeLeadingFragments(verifiedText);
  }

  const resolvedCitations = new Map(usableReplacements.map((replacement) => [replacement.citationIndex, replacement.resolvedCitation]));
  return {
    text: verifiedText.trim(),
    citations: [...resolvedCitations.entries()]
      .sort(([firstIndex], [secondIndex]) => firstIndex - secondIndex)
      .map(([, citation]) => citation)
  };
}

function resolveCitationSpan(note, citation) {
  const { startLine, endLine } = citation;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine || endLine > note.lines.length) {
    return { span: "", reason: "invalid_locator" };
  }

  const exactSpan = extractLineSpan(note, startLine, endLine).trim();
  if (exactSpan) {
    return { span: exactSpan, startLine, endLine };
  }

  const nearbyLine = findNearestNonEmptyLine(note.lines, startLine, endLine, 2);
  if (nearbyLine !== null) {
    return {
      span: note.lines[nearbyLine - 1].trim(),
      startLine: nearbyLine,
      endLine: nearbyLine
    };
  }

  return { span: "", reason: "empty_span" };
}

function findNearestNonEmptyLine(lines, startLine, endLine, radius) {
  const firstCandidate = Math.max(1, startLine - radius);
  const lastCandidate = Math.min(lines.length, endLine + radius);
  const candidates = [];

  for (let lineNumber = firstCandidate; lineNumber <= lastCandidate; lineNumber += 1) {
    if (!lines[lineNumber - 1].trim()) {
      continue;
    }
    const distance = lineNumber < startLine
      ? startLine - lineNumber
      : lineNumber > endLine
        ? lineNumber - endLine
        : 0;
    candidates.push({ lineNumber, distance, followsRequestedSpan: lineNumber > endLine });
  }

  candidates.sort((first, second) => (
    first.distance - second.distance
    || Number(second.followsRequestedSpan) - Number(first.followsRequestedSpan)
    || first.lineNumber - second.lineNumber
  ));
  return candidates[0]?.lineNumber ?? null;
}

function extractLineSpan(note, startLine, endLine) {
  let span = "";
  for (let index = startLine - 1; index < endLine; index += 1) {
    span += note.lines[index];
    if (index < endLine - 1) {
      span += note.lineEndings[index];
    }
  }
  return span;
}

function trimQuotedSpan(span) {
  if (span.length <= 200) {
    return span;
  }

  const firstTwoHundred = span.slice(0, 200);
  const firstSentence = /[.!?]["'”’)]?(?=\s|$)/u.exec(firstTwoHundred);
  if (firstSentence) {
    return firstTwoHundred.slice(0, firstSentence.index + firstSentence[0].length).trimEnd();
  }

  const lastWhitespace = firstTwoHundred.search(/\s+\S*$/u);
  return (lastWhitespace > 0 ? firstTwoHundred.slice(0, lastWhitespace) : firstTwoHundred).trimEnd();
}

function formatExtractedQuote(span, followingText) {
  let quotedText = trimQuotedSpan(span)
    .replace(/["“”„‟″«»]/gu, "")
    .trim();
  quotedText = removeUnmatchedTrailingClosers(quotedText);

  let terminalPunctuation = "";
  const trailingPunctuation = /([.!?,;:]+)([)\]}]*)$/u.exec(quotedText);
  if (trailingPunctuation) {
    terminalPunctuation = [...trailingPunctuation[1]].reverse().find((character) => /[.!?]/u.test(character)) || "";
    quotedText = `${quotedText.slice(0, trailingPunctuation.index)}${trailingPunctuation[2]}`.trimEnd();
  }

  if (!quotedText) {
    return null;
  }

  const tokenEndsSentence = !followingText.trim() || /^[ \t]*(?:\r\n|\n|\r)/u.test(followingText);
  return `“${quotedText}”${tokenEndsSentence ? terminalPunctuation : ""}`;
}

function removeUnmatchedTrailingClosers(value) {
  const openingFor = { ")": "(", "]": "[", "}": "{" };
  let result = value.trimEnd();

  while (true) {
    const match = /([)\]}])\s*$/u.exec(result);
    if (!match) {
      return result;
    }

    const closing = match[1];
    const opening = openingFor[closing];
    const openingCount = [...result].filter((character) => character === opening).length;
    const closingCount = [...result].filter((character) => character === closing).length;
    if (closingCount <= openingCount) {
      return result;
    }
    result = result.slice(0, match.index).trimEnd();
  }
}

function computeNoteDate(noteId, notesById, verification) {
  const [note] = verifyNoteReferences([noteId], notesById, verification);
  return note ? formatShortDateLabel(note.timestamp) : "";
}

function verifyNoteReferences(noteIds, notesById, verification) {
  const notes = [];
  const seen = new Set();

  for (const noteId of noteIds) {
    if (seen.has(noteId)) {
      continue;
    }
    seen.add(noteId);
    verification.totalCitations += 1;
    const note = notesById.get(noteId);
    if (!note) {
      recordVerificationFailure(verification, {
        noteId,
        startLine: null,
        endLine: null,
        reason: "note_not_found"
      });
      continue;
    }
    verification.passed += 1;
    notes.push(note);
  }

  return notes;
}

function formatShortDateLabel(timestamp) {
  const date = new Date(timestamp);
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${monthNames[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function recordVerificationFailure(verification, failure) {
  verification.failed += 1;
  verification.failures.push(failure);
}

function recordCitationFailure(verification, citation, citationIndex, citationsAvailable, reason) {
  recordVerificationFailure(verification, {
    noteId: typeof citation?.noteId === "string" && citation.noteId ? citation.noteId : null,
    startLine: Number.isInteger(citation?.startLine) ? citation.startLine : null,
    endLine: Number.isInteger(citation?.endLine) ? citation.endLine : null,
    citationIndex: citationIndex >= 0 ? citationIndex : null,
    citationsAvailable,
    reason
  });
}

function expandRangeThroughDanglingSentences(text, range) {
  const expanded = { ...range };

  while (expanded.end < text.length) {
    const remainingText = text.slice(expanded.end);
    const leadingWhitespace = /^\s*/u.exec(remainingText)?.[0] || "";
    if (/\r?\n\s*\r?\n/u.test(leadingWhitespace)) {
      break;
    }

    const nextStart = expanded.end + leadingWhitespace.length;
    if (nextStart >= text.length) {
      break;
    }
    const nextRange = findSentenceRange(text, nextStart, nextStart + 1);
    const nextSentence = text.slice(nextRange.start, nextRange.end).trim();
    if (!looksDanglingAfterRemovedCitation(nextSentence)) {
      break;
    }
    expanded.end = nextRange.end;
  }

  return expanded;
}

function looksDanglingAfterRemovedCitation(sentence) {
  const value = sentence.replace(/^["'“‘(\[]+/u, "").trimStart();
  return /^(?:this|that|these|those|it|they|both|such)\b/iu.test(value)
    || /^(?:and|but|because|so|which|while|whereas|with|without|although|though)\b/iu.test(value)
    || /^(?:you|we)\b[^.!?]*\b(?:this|that|these|those|again|more than once|the same)\b/iu.test(value);
}

function removeLeadingFragments(text) {
  return text
    .split(/\r?\n\s*\r?\n/u)
    .map((paragraph) => removeLeadingFragmentFromParagraph(paragraph.trim()))
    .filter(Boolean)
    .join("\n\n");
}

function removeLeadingFragmentFromParagraph(paragraph) {
  let result = paragraph.replace(/^[,;:—–-]+\s*/u, "");

  while (result) {
    const firstRange = findSentenceRange(result, 0, 1);
    const firstSentence = result.slice(firstRange.start, firstRange.end).trim();
    const completeSentenceCount = (result.match(/[.!?](?:["'”’)}\]]+)?(?=\s|$)/gu) || []).length;
    const startsAsFragment = /^[a-z]/u.test(firstSentence)
      || /^(?:and|but|because|so|which|while|whereas|with|without|although|though)\b/iu.test(firstSentence);
    const isLoneDanglingSentence = completeSentenceCount < 2 && looksDanglingAfterRemovedCitation(firstSentence);
    if (!startsAsFragment && !isLoneDanglingSentence) {
      break;
    }
    result = removeTextRange(result, firstRange).trim();
  }

  return result;
}

function findSentenceRange(text, matchStart, matchEnd) {
  let start = matchStart;
  while (start > 0 && !/[.!?\n]/u.test(text[start - 1])) {
    start -= 1;
  }
  while (start < text.length && /\s/u.test(text[start])) {
    start += 1;
  }

  let end = Math.max(matchEnd, start);
  while (end < text.length && !/[.!?\n]/u.test(text[end])) {
    end += 1;
  }
  if (end < text.length) {
    end += 1;
  }
  while (end < text.length && /["'”’)]/u.test(text[end])) {
    end += 1;
  }
  return { start, end };
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];

  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function removeTextRanges(text, ranges) {
  let result = text;
  for (const range of mergeRanges(ranges).sort((a, b) => b.start - a.start)) {
    result = removeTextRange(result, range);
  }
  return result.trim();
}

function removeTextRange(text, range) {
  const before = text.slice(0, range.start).trimEnd();
  const after = text.slice(range.end).trimStart();
  if (!before) {
    return after;
  }
  if (!after) {
    return before;
  }

  const removedText = text.slice(range.start, range.end);
  const separator = removedText.includes("\n\n") ? "\n\n" : removedText.includes("\n") ? "\n" : " ";
  return `${before}${separator}${after}`;
}
