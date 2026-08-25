import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

const MAX_NOTES = 3_000;
const MAX_COMBINED_NOTE_TEXT = 2_100_000; // Approximately 700,000 tokens at 3 characters per token.
const MONTH_BREAKDOWN_MIN_NOTES = 12;

const systemPrompt = `
You are reading someone's complete personal note archive across many years: every word they have supplied. Do not summarize it. Read it as an unusually perceptive friend would, attending to who this person is, how they have changed, and what has quietly endured. Write every section in the second person, with warmth, specificity, and restraint. Never sound therapeutic or clinical, and never say "you should". Prefer a few deeply seen observations to broad coverage. Always return the result through the provided tool.

WRITING RULES — PROMINENT AND OVERRIDING
These rules override any instinct toward literary style.

VOICE: Write plainly and directly, like a perceptive friend talking, not like an essayist. No metaphors about the archive itself (no "field notes of...", no "reads like..."). No elegant summarising phrases that sound wise but say little. Short sentences are fine. If a sentence sounds impressive but could describe many people, delete it.

EVIDENCE: Every substantial claim must be anchored — a short verbatim quote from their notes, a specific date, or a concrete artifact (a named project, a tracked number). Claims without anchors are not worth making. One anchored observation beats three graceful generalisations.

UNCERTAINTY IS PERMITTED AND VALUED: Where a reading is genuinely uncertain, say so in plain words ("this is one way to read it", "you'd know better than these notes do"). Where two readings both fit the evidence, name both. This honesty is more convincing than confidence.

INSIGHT REQUIREMENT: At least two observations across the whole response must be things the person likely has NOT articulated about themselves — a pattern only visible across years, a contradiction between two areas of their notes, or a continuity they wouldn't have named. Offer these as observations, never as verdicts, and always with their evidence attached. Do not moralise or advise.

Do not add personality typing, psychological frameworks, or diagnostic language of any kind.

SOURCE LABELS AND CITATIONS — ABSOLUTE
The user message begins with a server-computed timeline index, followed by notes labelled n1, n2, and so on in chronological order. Treat those labels as the only authority for dates and quotes.
1. Every date you write must be copied verbatim from a note label or from the timeline index. Never infer, estimate, reconstruct, reformat, or compute a date yourself. A season period spanning multiple notes must be consistent with the timeline index.
2. Every free-text section has a parallel citations array. For opening, language, unchanged, patterns, and tenderThread, use the correspondingly named top-level citations array. Each season and forgotten idea has its own citations array.
3. Any words presented as the person's own must have a citation entry with the source noteId and the exact contiguous quote copied character-for-character from that note. Never reconstruct a quote from memory, combine fragments, correct spelling, or change punctuation.
4. Include only citations for quotes actually used in that section's prose. If a section contains no quoted words, return an empty citations array.

OPENING
Write 2-4 sentences that interpret the person rather than inventorying the archive. Use at most two named specifics. It should feel like the opening of a letter from someone who knows them, never a table of contents.

SEASONS
Identify 3-6 emotional and identity chapters that genuinely emerge from the writing rather than dividing time into arbitrary calendar buckets. Give each season a title, a human-readable period such as "2016 – 2019" derived strictly from the notes' createdAt values, and a full narrative paragraph of 4-8 sentences. Describe who they were, what they were reaching toward, and the register of their writing in that season. Only when the notes provide evidence, describe what appears to have prompted the transition into the next season; otherwise leave the cause unstated. Ground every season with 1-2 short, exact phrases quoted verbatim from their notes, never a paragraph.

LANGUAGE
Write one substantial paragraph about what the writing style itself reveals beyond subject matter. Notice movements between terse and expansive writing, stretches dominated by lists or by feeling, runs of motivational self-talk and what came before them, and meaningful gaps when writing stopped. Surface patterns the person is unlikely to have recognized alone.

UNCHANGED
Write one substantial paragraph on 2-3 important threads that may look abandoned but continue in a changed form: early passions wearing new clothes. Support each connection with evidence from both eras, ideally placing an old phrase beside a recent artifact. Trace transformation rather than disappearance, and derive every connection only from this archive.

PATTERNS
Write one paragraph about identity-level behavioral fingerprints, not recurring topics. Attend to how setbacks are processed, how ambition appears on the page compared with feeling, cycles of returning to abandoned things, and what courage looks like in these notes.

FORGOTTEN IDEAS
Return 3-5 specific, dated ideas that are genuinely forgotten or easily overlooked, with a concise explanation of why each is worth revisiting.

TENDER THREAD
Write one paragraph that plainly recognizes emotional depth—grief, love, strain, faith—when it is present, and acknowledges that it matters. Exercise deliberate discretion across this entire first-impression output: never name deceased people, romantic partners, health conditions, or diagnoses. Gesture carefully, as in "there is grief here you have redrafted across years," without identifying who or what it concerns. Earn trust by combining real perception with privacy; deeper detail can wait for a later private setting.

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
    quote: { type: "string", minLength: 1 }
  },
  required: ["noteId", "quote"]
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
            period: { type: "string" },
            narrative: { type: "string" },
            citations: citationsSchema
          },
          required: ["title", "period", "narrative", "citations"]
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
            whenWritten: { type: "string" },
            why: { type: "string" },
            citations: citationsSchema
          },
          required: ["title", "whenWritten", "why", "citations"]
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
    .map((note, index) => ({
      noteId: `n${index + 1}`,
      title: note.title,
      text: note.text,
      createdAt: note.createdAt,
      timestamp: note.timestamp,
      dateLabel: formatDateLabel(note.timestamp)
    }));
}

function buildOverviewPrompt(notes) {
  const noteBlocks = notes.map((note) => [
    `[NOTE ${note.noteId} | DATE: ${note.dateLabel} | TITLE: ${JSON.stringify(note.title)}]`,
    note.text,
    `[END NOTE ${note.noteId}]`
  ].join("\n"));

  return [
    buildTimelineIndex(notes),
    "",
    "Use only the dates printed above and in the note labels below. Copy dates verbatim; do not calculate or reformat them.",
    "Use the note IDs in citation entries. Citation quotes must be exact contiguous substrings of the labelled note text.",
    "",
    "NOTES — CHRONOLOGICAL, FULL TEXT",
    noteBlocks.join("\n\n")
  ].join("\n");
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
    if (!isPlainObject(season) || typeof season.title !== "string" || typeof season.period !== "string" || typeof season.narrative !== "string") {
      return null;
    }
    const citations = validateCitations(season.citations);
    if (!citations) {
      return null;
    }
    seasons.push({ title: season.title, period: season.period, narrative: season.narrative, citations });
  }

  const forgottenIdeas = [];
  for (const idea of value.forgottenIdeas) {
    if (!isPlainObject(idea) || typeof idea.title !== "string" || typeof idea.whenWritten !== "string" || typeof idea.why !== "string") {
      return null;
    }
    const citations = validateCitations(idea.citations);
    if (!citations) {
      return null;
    }
    forgottenIdeas.push({ title: idea.title, whenWritten: idea.whenWritten, why: idea.why, citations });
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

function validateCitations(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  const citations = [];
  for (const citation of value) {
    if (!isPlainObject(citation) || typeof citation.noteId !== "string" || !citation.noteId.trim() || typeof citation.quote !== "string" || !citation.quote.trim()) {
      return null;
    }
    citations.push({ noteId: citation.noteId.trim(), quote: citation.quote });
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

  const opening = verifyTextCitations(overview.opening, overview.openingCitations, notesById, verification);
  const language = verifyTextCitations(overview.language, overview.languageCitations, notesById, verification);
  const unchanged = verifyTextCitations(overview.unchanged, overview.unchangedCitations, notesById, verification);
  const patterns = verifyTextCitations(overview.patterns, overview.patternsCitations, notesById, verification);
  const tenderThread = verifyTextCitations(overview.tenderThread, overview.tenderThreadCitations, notesById, verification);

  const seasons = overview.seasons.map((season) => {
    const narrative = verifyTextCitations(season.narrative, season.citations, notesById, verification);
    return {
      title: season.title,
      period: verifyDateField(season.period, narrative.citations, notesById, verification, true),
      narrative: narrative.text,
      citations: narrative.citations
    };
  });

  const forgottenIdeas = overview.forgottenIdeas.map((idea) => {
    const why = verifyTextCitations(idea.why, idea.citations, notesById, verification);
    return {
      title: idea.title,
      whenWritten: verifyDateField(idea.whenWritten, why.citations, notesById, verification, false),
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

function verifyTextCitations(text, citations, notesById, verification) {
  let verifiedText = text;
  const passedCitations = [];

  for (const citation of citations) {
    verification.totalCitations += 1;
    const note = notesById.get(citation.noteId);

    if (!note) {
      recordVerificationFailure(verification, citation.noteId, citation.quote, "note_not_found");
      verifiedText = removeSentenceContainingQuote(verifiedText, citation.quote);
      continue;
    }

    if (!normalizedIncludes(note.text, citation.quote)) {
      recordVerificationFailure(verification, citation.noteId, citation.quote, "quote_not_in_note");
      verifiedText = removeSentenceContainingQuote(verifiedText, citation.quote);
      continue;
    }

    verification.passed += 1;
    passedCitations.push(citation);
  }

  return {
    text: verifiedText,
    citations: passedCitations.filter((citation) => normalizedIncludes(verifiedText, citation.quote))
  };
}

function verifyDateField(value, citations, notesById, verification, isRange) {
  const referencedNotes = [...new Map(citations
    .map((citation) => notesById.get(citation.noteId))
    .filter(Boolean)
    .map((note) => [note.noteId, note])).values()]
    .sort((a, b) => a.timestamp - b.timestamp);

  if (referencedNotes.length === 0) {
    if (value.trim()) {
      verification.totalCitations += 1;
      recordVerificationFailure(verification, "", value, "date_mismatch");
    }
    return "";
  }

  const expectedValue = isRange
    ? formatDateRange(referencedNotes[0].dateLabel, referencedNotes[referencedNotes.length - 1].dateLabel)
    : referencedNotes[0].dateLabel;
  verification.totalCitations += 1;

  if (value.trim() === expectedValue) {
    verification.passed += 1;
  } else {
    recordVerificationFailure(verification, referencedNotes[0].noteId, value, "date_mismatch");
  }

  return expectedValue;
}

function recordVerificationFailure(verification, noteId, quote, reason) {
  verification.failed += 1;
  verification.failures.push({ noteId, quote, reason });
}

function normalizedIncludes(text, quote) {
  const normalizedQuote = normalizeComparableText(quote).trim();
  return Boolean(normalizedQuote) && normalizeComparableText(text).includes(normalizedQuote);
}

function normalizeComparableText(value) {
  let normalized = "";
  let previousWasWhitespace = false;

  for (const character of value) {
    if (/\s/u.test(character)) {
      if (!previousWasWhitespace) {
        normalized += " ";
        previousWasWhitespace = true;
      }
      continue;
    }

    normalized += normalizeQuoteCharacter(character);
    previousWasWhitespace = false;
  }

  return normalized;
}

function normalizeQuoteCharacter(character) {
  if (["‘", "’", "‚", "‛", "′"].includes(character)) {
    return "'";
  }
  if (["“", "”", "„", "‟", "″"].includes(character)) {
    return '"';
  }
  return character;
}

function removeSentenceContainingQuote(text, quote) {
  let verifiedText = text;

  while (true) {
    const match = findNormalizedMatch(verifiedText, quote);
    if (!match) {
      return verifiedText;
    }

    const nextText = removeMatchedSentence(verifiedText, match);
    if (nextText === verifiedText) {
      return verifiedText;
    }
    verifiedText = nextText;
  }
}

function removeMatchedSentence(text, match) {
  let sentenceStart = match.start;
  while (sentenceStart > 0 && !/[.!?\n]/u.test(text[sentenceStart - 1])) {
    sentenceStart -= 1;
  }
  while (sentenceStart < text.length && /\s/u.test(text[sentenceStart])) {
    sentenceStart += 1;
  }

  let sentenceEnd = Math.max(match.end, sentenceStart);
  const matchEndsWithTerminator = sentenceEnd > sentenceStart && /[.!?\n]/u.test(text[sentenceEnd - 1]);
  if (!matchEndsWithTerminator) {
    while (sentenceEnd < text.length && !/[.!?\n]/u.test(text[sentenceEnd])) {
      sentenceEnd += 1;
    }
    if (sentenceEnd < text.length) {
      sentenceEnd += 1;
    }
  }
  while (sentenceEnd < text.length && /["'”’)]/u.test(text[sentenceEnd])) {
    sentenceEnd += 1;
  }

  const before = text.slice(0, sentenceStart).trimEnd();
  const after = text.slice(sentenceEnd).trimStart();
  if (!before) {
    return after;
  }
  if (!after) {
    return before;
  }

  const removedText = text.slice(sentenceStart, sentenceEnd);
  const separator = removedText.includes("\n\n") ? "\n\n" : removedText.includes("\n") ? "\n" : " ";
  return `${before}${separator}${after}`;
}

function findNormalizedMatch(text, quote) {
  const normalizedText = normalizeTextWithOffsets(text);
  const normalizedQuote = normalizeComparableText(quote).trim();
  if (!normalizedQuote) {
    return null;
  }

  const matchIndex = normalizedText.text.indexOf(normalizedQuote);
  if (matchIndex < 0) {
    return null;
  }

  const lastMatchIndex = matchIndex + normalizedQuote.length - 1;
  return {
    start: normalizedText.starts[matchIndex],
    end: normalizedText.ends[lastMatchIndex]
  };
}

function normalizeTextWithOffsets(value) {
  let text = "";
  const starts = [];
  const ends = [];

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (/\s/u.test(character)) {
      if (text.endsWith(" ")) {
        ends[ends.length - 1] = index + 1;
      } else {
        text += " ";
        starts.push(index);
        ends.push(index + 1);
      }
      continue;
    }

    text += normalizeQuoteCharacter(character);
    starts.push(index);
    ends.push(index + 1);
  }

  return { text, starts, ends };
}
