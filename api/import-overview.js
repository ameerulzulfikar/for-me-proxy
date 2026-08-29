import { LIMITS, isPlainObject, readJsonBody, sendJson, totalStringLength } from "./_validation.js";

const MAX_NOTES = 3_000;
const MAX_COMBINED_NOTE_TEXT = 2_100_000; // Approximately 700,000 tokens at 3 characters per token.
const MONTH_BREAKDOWN_MIN_NOTES = 12;
const MAX_OUTPUT_TOKENS = 32_000;
const PROVIDER_TIMEOUT_MS = 270_000;
const HEALTH_PRIVACY_PATTERN = buildKeywordPattern([
  "psychologist", "psychologists", "psychiatrist", "psychiatrists", "psychotherapy",
  "therapy", "therapist", "therapists", "counselling", "counseling", "counsellor",
  "counselor", "mental health care plan", "mental-health care plan", "psychology appointment",
  "psychology appointments", "psychiatry appointment", "psychiatry appointments", "depression",
  "anxiety disorder", "panic disorder", "bipolar disorder", "schizophrenia", "ocd", "adhd",
  "ptsd", "autism", "eating disorder", "diagnosis", "diagnosed", "medical treatment",
  "medical treatments", "treatment plan", "health condition", "medical condition", "chronic condition",
  "chronic illness", "medical appointment", "medical appointments", "doctor appointment",
  "doctor's appointment", "specialist appointment", "hospital treatment", "chemotherapy", "radiotherapy",
  "surgery", "surgical", "medication", "medications", "prescription",
  "antidepressant", "antidepressants", "antipsychotic", "antipsychotics", "sertraline",
  "zoloft", "fluoxetine", "prozac", "escitalopram", "lexapro", "citalopram", "paroxetine",
  "venlafaxine", "effexor", "duloxetine", "bupropion", "wellbutrin", "mirtazapine",
  "amitriptyline", "nortriptyline", "diazepam", "valium", "lorazepam", "alprazolam",
  "xanax", "clonazepam", "quetiapine", "olanzapine", "risperidone", "lithium",
  "lamotrigine", "valproate", "ritalin", "concerta", "vyvanse", "dexamphetamine",
  "dextroamphetamine", "adderall", "propranolol", "insulin", "metformin", "methotrexate",
  "prednisone", "prednisolone", "hydrocortisone", "dupixent", "humira", "psoriasis", "eczema", "dermatitis",
  "rosacea", "asthma", "diabetes", "cancer", "arthritis", "endometriosis", "pcos",
  "epilepsy", "migraine", "migraines", "lupus", "multiple sclerosis", "crohn's disease",
  "coeliac disease", "celiac disease", "irritable bowel syndrome", "ibs", "hypertension",
  "high blood pressure", "heart disease", "kidney disease"
]);
const DEATH_CONTEXT_PATTERN = /\b(?:death|died|dead|deceased|late|passed away|passing away|funeral|eulogy|eulogies|obituary|obituaries|memorial|grief|grieve|grieved|grieving|mourn|mourned|mourning|bereavement|loss|lost)\b/iu;
const PERSON_NAME_SOURCE = String.raw`[\p{Lu}][\p{L}\p{M}'’.-]{1,}`;
const SPECIFIC_NAME_SOURCE = String.raw`(?!(?:You|Your|My|His|Her|Their|Our|The|This|That|These|Those|There|When|While|After|Before|Since|During|Early|Later|Years|Months|Someone|Grief|Death|Loss|Family|Sister|Brother|Sibling|Mother|Mum|Mom|Father|Dad|Parent|Daughter|Son|Child|Grandmother|Grandma|Grandfather|Grandpa|Aunt|Uncle|Cousin|Niece|Nephew|Wife|Husband|Spouse|Partner|Fiancé|Fiancée|Girlfriend|Boyfriend)\b)${PERSON_NAME_SOURCE}`;
const NAMED_DECEASED_PATTERNS = [
  new RegExp(String.raw`\b${SPECIFIC_NAME_SOURCE}(?:'s|’s)?\s+(?:death|funeral|eulogy|obituary|memorial|passing|grief|loss)\b`, "u"),
  new RegExp(String.raw`\b${SPECIFIC_NAME_SOURCE}\b[^.!?\n]{0,40}\b(?:died|passed away|is dead|was deceased|was late|grief|grieving|mourning)\b`, "u"),
  new RegExp(String.raw`\b(?:death|funeral|eulogy|obituary|memorial|late|grief|grieving|mourning|loss|lost)\b[^.!?\n]{0,24}\b(?:of|for|over)?\s*${SPECIFIC_NAME_SOURCE}\b`, "u")
];
const PARTNER_RELATION_SOURCE = String.raw`(?:[Ww]ife|[Hh]usband|[Ss]pouse|[Pp]artner|[Ff]iancé|[Ff]iancée|[Gg]irlfriend|[Bb]oyfriend)`;
const PARTNER_POSSESSIVE_SOURCE = String.raw`(?:[Yy]our|[Mm]y|[Hh]is|[Hh]er|[Tt]heir|[Tt]he)`;
const PARTNER_NAME_PATTERNS = [
  {
    pattern: new RegExp(String.raw`\b(${PARTNER_POSSESSIVE_SOURCE}\s+${PARTNER_RELATION_SOURCE})(?:\s*,?\s*(?:named\s+)?)(${PERSON_NAME_SOURCE})\b`, "gu"),
    replace: (_match, relationship) => relationship
  },
  {
    pattern: new RegExp(String.raw`\b(${PERSON_NAME_SOURCE})\s*,?\s+(${PARTNER_POSSESSIVE_SOURCE}\s+${PARTNER_RELATION_SOURCE})\b`, "gu"),
    replace: (_match, _name, relationship) => relationship
  },
  {
    pattern: new RegExp(String.raw`\b(${PERSON_NAME_SOURCE})\s+(?:is|was)\s+(${PARTNER_POSSESSIVE_SOURCE}\s+${PARTNER_RELATION_SOURCE})\b`, "gu"),
    replace: (_match, _name, relationship) => relationship
  },
  {
    pattern: new RegExp(String.raw`(?<![Bb]usiness )(?<![Ww]ork )(?<![Cc]reative )(?<![Pp]roject )(?<![Vv]enture )(?<![Ii]nvestment )(?<![Cc]o-founder )(?<![Cc]ofounder )\b(${PARTNER_RELATION_SOURCE})(?:\s*,?\s*(?:named\s+)?)(${PERSON_NAME_SOURCE})\b`, "gu"),
    replace: (_match, relationship) => relationship
  },
  {
    pattern: new RegExp(String.raw`\b((?:married|marrying)\s+(?:to\s+)?|(?:marriage|wedding)\s+(?:to|with)\s+)(${PERSON_NAME_SOURCE})\b`, "gu"),
    replace: (_match, leadIn) => `${leadIn}your partner`
  },
  {
    pattern: new RegExp(String.raw`\b(you\s+and\s+)(${PERSON_NAME_SOURCE})(\s+(?:got\s+married|married))\b`, "gu"),
    replace: (_match, leadIn, _name, ending) => `${leadIn}your partner${ending}`
  },
  {
    pattern: new RegExp(String.raw`\b(${PERSON_NAME_SOURCE})(\s+and\s+you\s+(?:got\s+married|married))\b`, "gu"),
    replace: (_match, _name, ending) => `your partner${ending}`
  },
  {
    pattern: new RegExp(String.raw`\b(${PERSON_NAME_SOURCE})(\s+and\s+I\s+(?:got\s+married|married))\b`, "gu"),
    replace: (_match, _name, ending) => `my partner${ending}`
  }
];
const QUOTE_DATE_PATTERN = /\b(?:\d{4}-\d{1,2}(?:-\d{1,2})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:18|19|20|21)\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(?:18|19|20|21)\d{2})?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+(?:18|19|20|21)\d{2})?)\b/iu;
const LEADING_QUOTE_DATE_PATTERN = /^(?:on|in|at|by|from|since|until|as\s+of)?\s*(?:\d{4}-\d{1,2}(?:-\d{1,2})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|(?:18|19|20|21)\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+(?:18|19|20|21)\d{2})?|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)(?:\s+\d{1,2}(?:st|nd|rd|th)?)?(?:,?\s+(?:18|19|20|21)\d{2})?)\b/iu;

const systemPrompt = `
Someone has just handed you everything they've written down for years — thousands of private notes, kept for themselves, never meant to be read like this. Your job is to tell them what you see.

This is the first thing they'll read after trusting you with all of it. They're deciding, in the next minute, whether that was a good idea. So don't summarise their notes back to them. They know what's in there. Tell them who they seem to be.

HOW TO WRITE
Like a friend who's spent a long night reading and now wants to say what they noticed. Warm, plain, direct. Short sentences. Say things straight rather than building to them. No literary flourishes, no metaphors about the archive, nothing written to sound impressive. If a sentence could describe anyone, cut it. Write in second person.

HOW TO SEE
Be generous and be honest — both, not one softened by the other. Generous means assuming this person is capable and had reasons; where two readings fit the evidence, take the one that credits them with agency rather than the one that makes them a victim of their own patterns. Honest means saying the difficult thing when you see it, without moralising, advising, or softening it into a compliment.

Use their own stated reasons for what they did. Where motive is genuinely unclear, say so, or hold both readings. Never impose a familiar story shape on a life just because it's a shape you recognise. When you describe what someone is working toward, say what they're moving toward, not only what they're escaping. Most people are doing both, and reading only the escape makes them smaller than they are.

Anything you claim should rest on something specific — a line they wrote, a project they named, a number they tracked, a thing they did repeatedly. An observation with evidence beats three without. When you quote, the quoted line must itself be the evidence for the sentence around it. If the line doesn't demonstrate your claim, either find the line that does or drop the quote and make the claim without it. And somewhere in here, tell them at least two things they probably haven't put into words about themselves: a pattern only visible across years, a contradiction between two parts of their life, something that stayed constant while they thought they were changing.

Where you're unsure, say so plainly. 'I might be reading too much into this.' 'You'd know better than I would.' That honesty makes you trustworthy, not weak.

WHAT NOT TO DO
Describe what this person did, not what they must have felt. Observing that someone rewrote a eulogy four times is fair; declaring what their grief means is not. Don't name people who have died or a partner by name — 'your wife' is fine. Never mention health conditions, treatments, therapy or diagnoses, and never suggest someone has one. No personality types or psychological frameworks.

Thin archives get shorter honest answers, never invented depth.
`.trim();

const citationSchema = {
  type: "object",
  additionalProperties: false,
  description: "An inclusive line locator used by the server to extract an exact quote from the supplied note scaffold. Never include quote text in a locator.",
  properties: {
    noteId: {
      type: "string",
      description: "The structured note ID from the supplied chronological scaffold, such as n412."
    },
    startLine: {
      type: "integer",
      minimum: 1,
      description: "The first prefixed line to quote, using its 1-based line number."
    },
    endLine: {
      type: "integer",
      minimum: 1,
      description: "The last prefixed line to quote, inclusive, using its 1-based line number."
    }
  },
  required: ["noteId", "startLine", "endLine"]
};

function createCitationsSchema(sectionName) {
  return {
    type: "array",
    description: `Locators for {{cite:N}} tokens in ${sectionName} only. Token index N refers to locator index N in this array, starting at 0. Every token must have a matching locator. Include only locators used by tokens in this section; return an empty array when there are no tokens. Each locator is { noteId, startLine, endLine } with an inclusive line range. The server extracts the exact quote; never write quote text yourself.`,
    items: citationSchema
  };
}

const overviewTool = {
  name: "submit_import_overview",
  description: `Return the first reading of the supplied personal note archive through this tool. The user message begins with a server-computed timeline index, followed by notes labelled n1, n2, and so on in chronological order. Every note-text line is prefixed with its structured note ID and 1-based line number, such as n412|L7|.

QUOTE PROTOCOL: Never write or reconstruct quote text. Put a token such as {{cite:0}} at the grammatically natural position where the quote belongs, then put { noteId, startLine, endLine } at index 0 of that section's citations array. Line ranges are inclusive. Citation indexes start at 0 and are local to the adjacent section or forgotten idea. Every token must have a matching locator, and every locator must be used by a token. Use at most one token per sentence. Never place tokens next to each other or append one after a complete sentence; lead into it naturally with words such as "writing that" or "you called it". Choose short, revealing, substantive lines rather than trivial or decorative ones. Do not choose a span whose main content is a date. The server extracts, verifies, privacy-screens, and inserts the exact words.

DATE AND SOURCE PROTOCOL: Never write a year, month, calendar date, date range, bare age, period field, or whenWritten field in any prose, title, explanation, or question. Use relative language such as "early on", "years later", or "in the last stretch". Structured source IDs establish chronology; dates written inside note text do not. The server computes displayed dates strictly from createdAt metadata. For each forgotten idea, return its single sourceNoteId so the server can compute whenWritten. Never state or imply a note count greater than the number supplied.`,
  input_schema: {
    type: "object",
    additionalProperties: false,
    description: "The complete structured reading. All prose is second person. Quote tokens and locators must follow the tool protocol.",
    properties: {
      portrait: {
        type: "string",
        description: "Who this person is, said plainly, the way you'd describe a friend to someone who hasn't met them. Place them concretely in a sentence or two — where they live, what they do, family situation where the notes establish it — then say what they're like. Keep achievements and venture names compressed. End with one sentence naming the central tension of their life as they themselves seem to understand it; make it the most quotable line in the response. Don't hedge here. If quoting, insert only a {{cite:N}} token in a grammatically natural position; never write quote text or dates."
      },
      portraitCitations: createCitationsSchema("portrait"),
      read: {
        type: "string",
        description: "The deeper look: what they're like underneath, what they keep returning to, and what has stayed constant while the surface changed. Connect these rather than treating them as separate topics. Every claim descends into the specific behaviour, quoted line, named project or tracked number behind it. Hedge here where the evidence genuinely leaves room for another reading. If quoting, insert only a {{cite:N}} token in a grammatically natural position; never write quote text or dates."
      },
      readCitations: createCitationsSchema("read"),
      forgottenIdeas: {
        type: "array",
        minItems: 4,
        maxItems: 5,
        description: "4-5 specific ideas from the archive that are genuinely forgotten or easily overlooked, each with the sourceNoteId where it appears and a concise reason it's worth revisiting. Never write dates; the server derives whenWritten from sourceNoteId metadata.",
        items: {
          type: "object",
          additionalProperties: false,
          description: "One overlooked idea and its single source reference.",
          properties: {
            title: {
              type: "string",
              description: "A short, specific title for the overlooked idea. Do not include a date or citation token."
            },
            sourceNoteId: {
              type: "string",
              description: "The single structured note ID, such as n412, where this idea appears. The server uses that note's createdAt metadata to compute whenWritten."
            },
            why: {
              type: "string",
              description: "A concise reason this idea is worth revisiting. If quoting, insert only a {{cite:N}} token referring to this idea's citations array; never write quote text or dates."
            },
            citations: createCitationsSchema("this forgotten idea's why field")
          },
          required: ["title", "sourceNoteId", "why", "citations"]
        }
      },
      tender: {
        type: "string",
        description: "Where the notes hold emotional weight — grief, love, worry, care — say what you noticed in what they did. Be specific about the behaviour; don't interpret the feeling for them. This covers ordinary tenderness too, not only loss: care for a child, small domestic details threaded through work notes, moments where they're being a person rather than a professional. Must stand alone and never open with a transitional word."
      },
      tenderCitations: createCitationsSchema("tender"),
      questions: {
        type: "array",
        minItems: 3,
        maxItems: 3,
        description: "Exactly three questions you'd genuinely want to ask this person, that only their own archive could answer. Second person, short, curious, never rhetorical. Questions have no citations: never include citation tokens, quote text, dates, or bare ages.",
        items: {
          type: "string",
          description: "One short, genuine second-person question with no citation token, quote, date, or bare age."
        }
      }
    },
    required: ["portrait", "portraitCitations", "read", "readCitations", "forgottenIdeas", "tender", "tenderCitations", "questions"]
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

function buildKeywordPattern(keywords) {
  const alternatives = [...keywords]
    .sort((first, second) => second.length - first.length)
    .map(escapeRegExp);
  return new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "iu");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
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
      read: normalizeString(value.read),
      readCitations: normalizeCitations(value.readCitations),
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
  const read = verifyProse(overview.read, overview.readCitations, notesById, verification);
  const verifiedTender = verifyProse(overview.tender, overview.tenderCitations, notesById, verification);
  const tender = hasCompleteTenderSection(verifiedTender.text)
    ? verifiedTender
    : { text: "", citations: [] };

  const forgottenIdeas = overview.forgottenIdeas.map((idea) => {
    const title = verifyProse(idea.title, [], notesById, verification);
    const why = verifyProse(idea.why, idea.citations, notesById, verification);
    return {
      title: title.text,
      whenWritten: computeNoteDate(idea.sourceNoteId, notesById, verification),
      why: why.text,
      citations: why.citations
    };
  });
  const questions = overview.questions
    .map((question) => verifyQuestion(question, notesById, verification))
    .filter(Boolean);

  console.error(`Import overview verification totalCitations=${verification.totalCitations} passed=${verification.passed} failed=${verification.failed}`);

  return {
    portrait: portrait.text,
    portraitCitations: portrait.citations,
    read: read.text,
    readCitations: read.citations,
    forgottenIdeas,
    tender: tender.text,
    tenderCitations: tender.citations,
    questions,
    verification
  };
}

function verifyProse(text, citations, notesById, verification) {
  const privacyScreened = screenProseForPrivacy(text, verification);
  const withoutDates = stripDatesFromProse(privacyScreened, verification);
  return substituteCitationTokens(withoutDates, citations, notesById, verification);
}

function verifyQuestion(question, notesById, verification) {
  const firstFailureIndex = verification.failures.length;
  const verified = verifyProse(question, [], notesById, verification);
  const hadBlockingFailure = verification.failures
    .slice(firstFailureIndex)
    .some((failure) => failure.reason !== "privacy_partner");
  return hadBlockingFailure ? "" : verified.text;
}

function screenProseForPrivacy(text, verification) {
  const removalRanges = [];
  const redactions = [];

  for (const range of findAllSentenceRanges(text)) {
    const sentence = text.slice(range.start, range.end);
    const removalReason = detectRemovalPrivacyReason(sentence);
    if (removalReason) {
      recordProsePrivacyFailure(verification, removalReason);
      removalRanges.push(expandRangeThroughDanglingSentences(text, range));
      continue;
    }

    const partnerRedaction = redactPartnerNames(sentence);
    if (partnerRedaction.redacted) {
      recordProsePrivacyFailure(verification, "privacy_partner");
      redactions.push({ ...range, replacement: partnerRedaction.text });
    }
  }

  const mergedRemovalRanges = mergeRanges(removalRanges);
  const usableRedactions = redactions.filter((redaction) => !mergedRemovalRanges.some((range) => rangesOverlap(redaction, range)));
  const operations = [
    ...mergedRemovalRanges.map((range) => ({ ...range, kind: "removal" })),
    ...usableRedactions.map((redaction) => ({ ...redaction, kind: "redaction" }))
  ].sort((first, second) => second.start - first.start);
  let screenedText = text;

  for (const operation of operations) {
    if (operation.kind === "redaction") {
      screenedText = `${screenedText.slice(0, operation.start)}${operation.replacement}${screenedText.slice(operation.end)}`;
    } else {
      screenedText = removeTextRange(screenedText, operation);
    }
  }

  return mergedRemovalRanges.length > 0 ? removeLeadingFragments(screenedText).trim() : screenedText.trim();
}

function findAllSentenceRanges(text) {
  const ranges = [];
  let cursor = 0;

  while (cursor < text.length) {
    while (cursor < text.length && /\s/u.test(text[cursor])) {
      cursor += 1;
    }
    if (cursor >= text.length) {
      break;
    }

    const range = findSentenceRange(text, cursor, cursor + 1);
    ranges.push(range);
    cursor = Math.max(range.end, cursor + 1);
  }

  return ranges;
}

function detectRemovalPrivacyReason(value) {
  if (HEALTH_PRIVACY_PATTERN.test(value)) {
    return "privacy_health";
  }
  if (containsPrivateDeceasedReference(value)) {
    return "privacy_deceased";
  }
  return null;
}

function detectQuotePrivacyReason(value) {
  const removalReason = detectRemovalPrivacyReason(value);
  if (removalReason) {
    return removalReason;
  }
  return redactPartnerNames(value).redacted ? "privacy_partner" : null;
}

function containsPrivateDeceasedReference(value) {
  if (!DEATH_CONTEXT_PATTERN.test(value)) {
    return false;
  }
  return NAMED_DECEASED_PATTERNS.some((pattern) => pattern.test(value));
}

function hasCompleteTenderSection(value) {
  const text = value.trim();
  if (!/[.!?](?:["'”’)}\]]+)?$/u.test(text)) {
    return false;
  }
  return (text.match(/[.!?](?:["'”’)}\]]+)?(?=\s|$)/gu) || []).length >= 2;
}

function redactPartnerNames(value) {
  let text = value;
  let redacted = false;

  for (const { pattern, replace } of PARTNER_NAME_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (...args) => {
      redacted = true;
      return replace(...args);
    });
  }

  return { text, redacted };
}

function recordProsePrivacyFailure(verification, reason) {
  verification.totalCitations += 1;
  recordVerificationFailure(verification, {
    noteId: "",
    startLine: null,
    endLine: null,
    reason
  });
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
  const citationTokenRemovalRanges = [];
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

    const privacyReason = detectQuotePrivacyReason(resolved.span);
    if (privacyReason) {
      recordCitationFailure(verification, citation, citationIndex, citations.length, privacyReason);
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    if (isDateDominatedQuote(resolved.span)) {
      recordCitationFailure(verification, citation, citationIndex, citations.length, "date_in_quote");
      invalidRanges.push(findSentenceRange(text, token.start, token.end));
      continue;
    }

    const sentenceRange = findSentenceRange(text, token.start, token.end);
    const previousReplacement = replacements[replacements.length - 1];
    const hasQuoteInSentence = replacements.some((replacement) => rangesOverlap(replacement.sentenceRange, sentenceRange));
    const hasNoInterveningProse = previousReplacement
      && !/[\p{L}\p{N}]/u.test(text.slice(previousReplacement.end, token.start));
    if (hasQuoteInSentence || hasNoInterveningProse) {
      recordCitationFailure(verification, citation, citationIndex, citations.length, "quote_collision");
      if (hasQuoteInSentence && hasNoInterveningProse) {
        citationTokenRemovalRanges.push(findCitationTokenRemovalRange(text, token));
      } else {
        invalidRanges.push(sentenceRange);
      }
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
      sentenceRange,
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
  const usableCitationTokenRemovals = citationTokenRemovalRanges.filter((removal) => !mergedInvalidRanges.some((range) => rangesOverlap(removal, range)));
  const operations = [
    ...mergedInvalidRanges.map((range) => ({ ...range, kind: "sentence_removal" })),
    ...usableCitationTokenRemovals.map((range) => ({ ...range, kind: "token_removal" })),
    ...usableReplacements.map((replacement) => ({ ...replacement, kind: "replacement" }))
  ].sort((a, b) => b.start - a.start);
  let verifiedText = text;

  for (const operation of operations) {
    if (operation.kind === "replacement") {
      verifiedText = `${verifiedText.slice(0, operation.start)}${operation.replacement}${verifiedText.slice(operation.end)}`;
    } else if (operation.kind === "token_removal") {
      verifiedText = `${verifiedText.slice(0, operation.start)}${verifiedText.slice(operation.end)}`;
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

function isDateDominatedQuote(value) {
  const trimmed = value.trim();
  if (!QUOTE_DATE_PATTERN.test(trimmed)) {
    return false;
  }
  if (LEADING_QUOTE_DATE_PATTERN.test(trimmed)) {
    return true;
  }

  const withoutDate = trimmed.replace(QUOTE_DATE_PATTERN, " ");
  const remainingWords = withoutDate.match(/[\p{L}\p{N}]+/gu) || [];
  return remainingWords.length <= 4;
}

function findCitationTokenRemovalRange(text, token) {
  let start = token.start;
  while (start > 0 && /[ \t]/u.test(text[start - 1])) {
    start -= 1;
  }
  return { start, end: token.end };
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

function rangesOverlap(first, second) {
  return first.start < second.end && second.start < first.end;
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
