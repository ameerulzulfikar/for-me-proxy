import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

const MAX_NOTES = 3_000;
const MAX_COMBINED_NOTE_TEXT = 2_100_000; // Approximately 700,000 tokens at 3 characters per token.
const MONTH_BREAKDOWN_MIN_NOTES = 12;

const systemPrompt = `
You are reading someone's complete personal note archive across many years: every word they have supplied. Do not summarize it. Read it as an unusually perceptive friend would, attending to who this person is, how they have changed, and what has quietly endured. Write every section in the second person, with warmth, specificity, and restraint. Never sound therapeutic or clinical, and never say "you should". Prefer a few deeply seen observations to broad coverage. Always return the result through the provided tool.

WRITING RULES — PROMINENT AND OVERRIDING
These rules override any instinct toward literary style.

VOICE: Write plainly and directly, like a perceptive friend talking, not like an essayist. No metaphors about the archive itself (no "field notes of...", no "reads like..."). No elegant summarising phrases that sound wise but say little. Short sentences are fine. If a sentence sounds impressive but could describe many people, delete it.

EVIDENCE: Every substantial claim must be anchored — a quote-by-reference locator or a concrete artifact (a named project, a tracked number, a recurring object or list). Claims without anchors are not worth making. One anchored observation beats three graceful generalisations. Structured source IDs anchor chronology; never use a written date as prose evidence.

UNCERTAINTY IS PERMITTED AND VALUED: Where a reading is genuinely uncertain, say so in plain words ("this is one way to read it", "you'd know better than these notes do"). Where two readings both fit the evidence, name both. This honesty is more convincing than confidence.

INSIGHT REQUIREMENT: At least two observations across the whole response must be things the person likely has NOT articulated about themselves — a pattern only visible across years, a contradiction between two areas of their notes, or a continuity they wouldn't have named. Offer these as observations, never as verdicts, and always with their evidence attached. Do not moralise or advise.

DEPTH OVER COVERAGE: Your job is depth, not coverage. It is better to say three things with real evidence and real thought than to list ten things briefly. Develop each observation: name the evidence, explain what it may reveal, and connect it to another concrete part of the notes where the connection is real. Do not write summary sentences that could describe many people.

Do not add personality typing, psychological frameworks, or diagnostic language of any kind.

SOURCE LOCATORS AND SERVER-COMPUTED DATES — ABSOLUTE
The user message begins with a server-computed timeline index, followed by notes labelled n1, n2, and so on in chronological order. Every line of note text is prefixed with its note ID and line number, such as "n412|L7|".
1. NEVER WRITE QUOTE TEXT YOURSELF. To quote the person, insert a token such as {{cite:0}} at the exact position where the quote belongs in the prose. Then put { noteId, startLine, endLine } at index 0 of that section's citations array. The server, not you, will extract and insert the exact words from those lines.
2. Treat each citation token as a quoted phrase so the surrounding prose is grammatical after substitution. Example: You wrote {{cite:0}} in the middle of a grocery list. Choose quotes for emotional or revealing weight, not as decoration. Prefer a short striking line over a bland factual one. The sentence around a quote must say what the line reveals; do not merely introduce it.
3. Citation indexes start at 0 and refer only to the citations array beside that section. Use an inclusive line range. Never put quote text in a citation object or anywhere else in your response.
4. For opening, language, unchanged, patterns, and tenderThread, use the correspondingly named top-level citations array. Each season and forgotten idea has its own citations array. Include only locators used by tokens in that section. If there are no tokens, return an empty citations array.
5. NEVER WRITE A YEAR, MONTH, CALENDAR DATE, DATE RANGE, OR BARE AGE IN PROSE. Do not write phrases such as "at 19"; describe the life stage instead. Use relative language that cannot be mistaken for a date: "early on", "years later", "in the last stretch", "at the start of the real estate years", or "shortly after". For example, write "early in your working life" instead of an age, and "years later, the project returned" instead of naming a year. Do not produce period or whenWritten fields. The server computes every displayed date from real createdAt metadata.
6. For each season, provide noteIds containing the earliest and latest notes in that chapter, plus any other notes you drew on. For each forgotten idea, provide the single sourceNoteId where the idea appears. These source IDs are for server-side date computation, not prose.

OPENING
Write 2-4 sentences that interpret the person rather than inventorying the archive. Use at most two named specifics. It should feel like the opening of a letter from someone who knows them, never a table of contents.

SEASONS
Identify emotional and identity chapters that genuinely emerge from the writing rather than dividing time into arbitrary calendar buckets. Aim for 4-6 seasons total, not more. Every season narrative must contain 5-9 sentences. A two-sentence season is a failure. If a period genuinely lacks enough material for that depth, merge it into an adjacent season rather than producing a thin one. Give each season a title, noteIds containing the earliest and latest notes belonging to that chapter plus any others you drew on, and a full narrative paragraph. Describe who they were, what they were reaching toward, and the register of their writing in that season. Only when the notes provide evidence, describe what appears to have prompted the transition into the next season; otherwise leave the cause unstated. Every season must include at least one citation token pointing to an exact note line and at least one concrete non-quoted specific, such as a named project, a tracked number, or a recurring artifact.

LANGUAGE
Write one substantial paragraph of 6-10 sentences about what the writing style itself reveals beyond subject matter. Notice movements between terse and expansive writing, stretches dominated by lists or by feeling, runs of motivational self-talk and what came before them, and meaningful gaps when writing stopped. Surface patterns the person is unlikely to have recognized alone.

UNCHANGED
Write one substantial paragraph of 6-10 sentences on 2-3 important threads that may look abandoned but continue in a changed form: early passions wearing new clothes. Support each connection with evidence from both eras, ideally placing an old phrase beside a recent artifact. Trace transformation rather than disappearance, and derive every connection only from this archive.

PATTERNS
Write one substantial paragraph of 6-10 sentences about identity-level behavioral fingerprints, not recurring topics. Attend to how setbacks are processed, how ambition appears on the page compared with feeling, cycles of returning to abandoned things, and what courage looks like in these notes.

FORGOTTEN IDEAS
Return 3-5 specific ideas that are genuinely forgotten or easily overlooked, with the sourceNoteId where each idea appears and a concise explanation of why each is worth revisiting. Do not write a date; the server will add whenWritten from that note's metadata.

TENDER THREAD
Write one substantial paragraph of 6-10 sentences that plainly recognizes emotional depth—grief, love, strain, faith—when it is present, and acknowledges that it matters. Exercise deliberate discretion across this entire first-impression output: never name deceased people, romantic partners, health conditions, or diagnoses. Gesture carefully, as in "there is grief here you have redrafted across years," without identifying who or what it concerns. Earn trust by combining real perception with privacy; deeper detail can wait for a later private setting.

INTEGRITY RULES — ABSOLUTE
1. Every date you write, including every whenWritten value and season period, must be copied from or derived strictly from the notes' createdAt fields. Never infer a date from note content or estimate one from memory. When precision is uncertain, use only the createdAt year.
2. Never state or imply a count greater than the number of notes actually supplied.
3. You may observe correlation, but never declare causation without evidence. Mark interpretation explicitly with language such as "one way to see this...", or return the question with "you would know why". Where the notes do not establish a cause, say less.
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
      opening: { type: "string" },
      openingCitations: citationsSchema,
      seasons: {
        type: "array",
        minItems: 3,
        maxItems: 6,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            title: { type: "string" },
            noteIds: {
              type: "array",
              minItems: 1,
              items: { type: "string" }
            },
            narrative: { type: "string" },
            citations: citationsSchema
          },
          required: ["title", "noteIds", "narrative", "citations"]
        }
      },
      language: { type: "string" },
      languageCitations: citationsSchema,
      unchanged: { type: "string" },
      unchangedCitations: citationsSchema,
      patterns: { type: "string" },
      patternsCitations: citationsSchema,
      forgottenIdeas: {
        type: "array",
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
      tenderThread: { type: "string" },
      tenderThreadCitations: citationsSchema
    },
    required: ["opening", "openingCitations", "seasons", "language", "languageCitations", "unchanged", "unchangedCitations", "patterns", "patternsCitations", "forgottenIdeas", "tenderThread", "tenderThreadCitations"]
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
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 16000,
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
      return sendJson(response, 502, { error: { message: "Import overview failed" } });
    }

    const responseBody = JSON.parse(responseText);
    const toolUse = responseBody.content?.find((block) => block.type === "tool_use" && block.name === overviewTool.name);
    const overview = validateOverview(toolUse?.input);

    if (!overview) {
      console.error("Import overview response failed validation", upstreamResponse.status);
      return sendJson(response, 502, { error: { message: "Import overview failed" } });
    }

    return sendJson(response, 200, verifyOverview(overview, scaffoldedNotes));
  } catch (error) {
    console.error("Import overview proxy failed", formatCaughtError(error));
    return sendJson(response, 502, { error: { message: "Import overview failed" } });
  }
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
  if (!isPlainObject(value) || typeof value.opening !== "string" || typeof value.language !== "string" || typeof value.unchanged !== "string" || typeof value.patterns !== "string" || typeof value.tenderThread !== "string" || !Array.isArray(value.seasons) || value.seasons.length < 3 || value.seasons.length > 6 || !Array.isArray(value.forgottenIdeas) || value.forgottenIdeas.length > 5) {
    return null;
  }

  const openingCitations = validateCitations(value.openingCitations);
  const languageCitations = validateCitations(value.languageCitations);
  const unchangedCitations = validateCitations(value.unchangedCitations);
  const patternsCitations = validateCitations(value.patternsCitations);
  const tenderThreadCitations = validateCitations(value.tenderThreadCitations);
  if ([openingCitations, languageCitations, unchangedCitations, patternsCitations, tenderThreadCitations].some((citations) => citations === null)) {
    return null;
  }

  const seasons = [];
  for (const season of value.seasons) {
    if (!isPlainObject(season) || typeof season.title !== "string" || typeof season.narrative !== "string") {
      return null;
    }
    const noteIds = validateNoteIds(season.noteIds);
    const citations = validateCitations(season.citations);
    if (!noteIds || !citations) {
      return null;
    }
    seasons.push({ title: season.title, noteIds, narrative: season.narrative, citations });
  }

  const forgottenIdeas = [];
  for (const idea of value.forgottenIdeas) {
    if (!isPlainObject(idea) || typeof idea.title !== "string" || typeof idea.sourceNoteId !== "string" || !idea.sourceNoteId.trim() || typeof idea.why !== "string") {
      return null;
    }
    const citations = validateCitations(idea.citations);
    if (!citations) {
      return null;
    }
    forgottenIdeas.push({ title: idea.title, sourceNoteId: idea.sourceNoteId.trim(), why: idea.why, citations });
  }

  return {
    opening: value.opening,
    openingCitations,
    seasons,
    language: value.language,
    languageCitations,
    unchanged: value.unchanged,
    unchangedCitations,
    patterns: value.patterns,
    patternsCitations,
    forgottenIdeas,
    tenderThread: value.tenderThread,
    tenderThreadCitations
  };
}

function validateNoteIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }

  const noteIds = [];
  for (const noteId of value) {
    if (typeof noteId !== "string" || !noteId.trim()) {
      return null;
    }
    noteIds.push(noteId.trim());
  }
  return noteIds;
}

function validateCitations(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const citations = [];
  for (const citation of value) {
    if (!isPlainObject(citation) || typeof citation.noteId !== "string" || !Number.isInteger(citation.startLine) || !Number.isInteger(citation.endLine)) {
      return null;
    }
    citations.push({
      noteId: citation.noteId.trim(),
      startLine: citation.startLine,
      endLine: citation.endLine
    });
  }

  return citations;
}

function verifyOverview(overview, notes) {
  const notesById = new Map(notes.map((note) => [note.noteId, note]));
  const verification = {
    totalCitations: 0,
    passed: 0,
    failed: 0,
    failures: []
  };

  const opening = verifyProse(overview.opening, overview.openingCitations, notesById, verification);
  const language = verifyProse(overview.language, overview.languageCitations, notesById, verification);
  const unchanged = verifyProse(overview.unchanged, overview.unchangedCitations, notesById, verification);
  const patterns = verifyProse(overview.patterns, overview.patternsCitations, notesById, verification);
  const tenderThread = verifyProse(overview.tenderThread, overview.tenderThreadCitations, notesById, verification);

  const seasons = overview.seasons.map((season) => {
    const narrative = verifyProse(season.narrative, season.citations, notesById, verification);
    return {
      title: season.title,
      period: computeSeasonPeriod(season.noteIds, notesById, verification),
      narrative: narrative.text,
      citations: narrative.citations
    };
  });

  const forgottenIdeas = overview.forgottenIdeas.map((idea) => {
    const why = verifyProse(idea.why, idea.citations, notesById, verification);
    return {
      title: idea.title,
      whenWritten: computeNoteDate(idea.sourceNoteId, notesById, verification),
      why: why.text,
      citations: why.citations
    };
  });

  console.error(`Import overview verification totalCitations=${verification.totalCitations} passed=${verification.passed} failed=${verification.failed}`);

  return {
    opening: opening.text,
    openingCitations: opening.citations,
    seasons,
    language: language.text,
    languageCitations: language.citations,
    unchanged: unchanged.text,
    unchangedCitations: unchanged.citations,
    patterns: patterns.text,
    patternsCitations: patterns.citations,
    forgottenIdeas,
    tenderThread: tenderThread.text,
    tenderThreadCitations: tenderThread.citations,
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
      recordVerificationFailure(verification, {
        noteId: "",
        startLine: null,
        endLine: null,
        reason: "invalid_locator"
      });
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    const note = notesById.get(citation.noteId);
    if (!note) {
      recordVerificationFailure(verification, { ...citation, reason: "note_not_found" });
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    if (citation.startLine < 1 || citation.endLine < citation.startLine || citation.endLine > note.lines.length) {
      recordVerificationFailure(verification, { ...citation, reason: "invalid_locator" });
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    const span = extractLineSpan(note, citation.startLine, citation.endLine).trim();
    if (!span) {
      recordVerificationFailure(verification, { ...citation, reason: "empty_span" });
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    const formattedQuote = formatExtractedQuote(span, text.slice(token.end));
    if (!formattedQuote) {
      recordVerificationFailure(verification, { ...citation, reason: "empty_span" });
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    verification.passed += 1;
    replacements.push({
      ...token,
      citationIndex,
      replacement: formattedQuote
    });
  }

  const mergedInvalidRanges = mergeRanges(invalidRanges);
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

  const usedIndexes = new Set(usableReplacements.map((replacement) => replacement.citationIndex));
  return {
    text: verifiedText.trim(),
    citations: citations.filter((_, index) => usedIndexes.has(index))
  };
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

function computeSeasonPeriod(noteIds, notesById, verification) {
  const notes = verifyNoteReferences(noteIds, notesById, verification)
    .sort((a, b) => a.timestamp - b.timestamp);
  if (notes.length === 0) {
    return "";
  }
  return formatShortDateRange(notes[0].timestamp, notes[notes.length - 1].timestamp);
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

function formatShortDateRange(firstTimestamp, lastTimestamp) {
  const first = formatShortDateLabel(firstTimestamp);
  const last = formatShortDateLabel(lastTimestamp);
  return first === last ? first : `${first} – ${last}`;
}

function recordVerificationFailure(verification, failure) {
  verification.failed += 1;
  verification.failures.push(failure);
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
