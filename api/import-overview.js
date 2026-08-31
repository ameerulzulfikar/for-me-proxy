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
    nameGroup: 2,
    replace: (_match, relationship) => relationship
  },
  {
    pattern: new RegExp(String.raw`\b(${PERSON_NAME_SOURCE})\s*,?\s+(${PARTNER_POSSESSIVE_SOURCE}\s+${PARTNER_RELATION_SOURCE})\b`, "gu"),
    nameGroup: 1,
    replace: (_match, _name, relationship) => relationship
  },
  {
    pattern: new RegExp(String.raw`\b(${PERSON_NAME_SOURCE})\s+(?:is|was)\s+(${PARTNER_POSSESSIVE_SOURCE}\s+${PARTNER_RELATION_SOURCE})\b`, "gu"),
    nameGroup: 1,
    replace: (_match, _name, relationship) => relationship
  },
  {
    pattern: new RegExp(String.raw`(?<![Bb]usiness )(?<![Ww]ork )(?<![Cc]reative )(?<![Pp]roject )(?<![Vv]enture )(?<![Ii]nvestment )(?<![Cc]o-founder )(?<![Cc]ofounder )\b(${PARTNER_RELATION_SOURCE})(?:\s*,?\s*(?:named\s+)?)(${PERSON_NAME_SOURCE})\b`, "gu"),
    nameGroup: 2,
    replace: (_match, relationship) => relationship
  },
  {
    pattern: new RegExp(String.raw`\b((?:married|marrying)\s+(?:to\s+)?|(?:marriage|wedding)\s+(?:to|with)\s+)(${PERSON_NAME_SOURCE})\b`, "gu"),
    nameGroup: 2,
    replace: (_match, leadIn) => `${leadIn}your partner`
  },
  {
    pattern: new RegExp(String.raw`\b(you\s+and\s+)(${PERSON_NAME_SOURCE})(\s+(?:got\s+married|married))\b`, "gu"),
    nameGroup: 2,
    replace: (_match, leadIn, _name, ending) => `${leadIn}your partner${ending}`
  },
  {
    pattern: new RegExp(String.raw`\b(${PERSON_NAME_SOURCE})(\s+and\s+you\s+(?:got\s+married|married))\b`, "gu"),
    nameGroup: 1,
    replace: (_match, _name, ending) => `your partner${ending}`
  },
  {
    pattern: new RegExp(String.raw`\b(${PERSON_NAME_SOURCE})(\s+and\s+I\s+(?:got\s+married|married))\b`, "gu"),
    nameGroup: 1,
    replace: (_match, _name, ending) => `my partner${ending}`
  }
];
const systemPrompt = `
Someone has just handed you everything they've written down for years — thousands of private notes, kept for themselves, never meant to be read like this. Your job is to tell them what you see.

This is the first thing they'll read after trusting you with all of it. They're deciding, in the next minute, whether that was a good idea. So don't summarise their notes back to them. They know what's in there. Tell them who they seem to be.

HOW TO WRITE
Like a friend who's spent a long night reading and now wants to say what they noticed. Warm, plain, direct. Short sentences. Say things straight rather than building to them. No literary flourishes, no metaphors about the archive, nothing written to sound impressive. If a sentence could describe anyone, cut it. Write in second person.

HOW TO SEE
Be generous and be honest — both, not one softened by the other. Generous means assuming this person is capable and had reasons; where two readings fit the evidence, take the one that credits them with agency rather than the one that makes them a victim of their own patterns. Honest means saying the difficult thing when you see it, without moralising, advising, or softening it into a compliment.

Use their own stated reasons for what they did. Where motive is genuinely unclear, say so, or hold both readings. Never impose a familiar story shape on a life just because it's a shape you recognise. When you describe what someone is working toward, say what they're moving toward, not only what they're escaping. Most people are doing both, and reading only the escape makes them smaller than they are.

Anything you claim should rest on something specific — a line they wrote, a project they named, a number they tracked, a thing they did repeatedly. An observation with evidence beats three without. And somewhere in here, tell them at least two things they probably haven't put into words about themselves: a pattern only visible across years, a contradiction between two parts of their life, something that stayed constant while they thought they were changing.

Where you're unsure, say so plainly. 'I might be reading too much into this.' 'You'd know better than I would.' That honesty makes you trustworthy, not weak.

WHAT NOT TO DO
Don't write calendar years or months — describe time relatively. Don't work out someone's age unless the notes state it. Don't mention health conditions, treatments, therapy or diagnoses, and never suggest someone has one. Don't name people who have died or a partner by name — 'your wife' is fine. Don't use personality types or psychological frameworks. Don't quote at length; if you refer to something they wrote, paraphrase it. Don't tell them what to do.
`.trim();

const overviewTool = {
  name: "submit_import_overview",
  description: "Return the first reading of the supplied personal note archive through this tool. The user message begins with a server-computed timeline index, followed by notes labelled with a structured ID and real date; sourceNoteId lets the server compute whenWritten for forgotten ideas.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    description: "The complete structured reading. All prose is second person.",
    properties: {
      portrait: {
        type: "string",
        description: "Who this person is, said plainly, the way you'd describe a friend to someone who hasn't met them. Place them concretely in the world, then get to their character and the central tension they seem to be living with."
      },
      read: {
        type: "string",
        description: "The deeper look at what they're like underneath, what they keep returning to, and what stayed constant while the surface changed. Ground the reading in specific behaviour, projects, numbers, and repeated choices."
      },
      forgottenIdeas: {
        type: "array",
        description: "Specific ideas from the archive that seem genuinely forgotten or easily overlooked, with the source note and why each one is worth revisiting.",
        items: {
          type: "object",
          additionalProperties: false,
          description: "One overlooked idea and its source.",
          properties: {
            title: {
              type: "string",
              description: "A clear title for the overlooked idea."
            },
            sourceNoteId: {
              type: "string",
              description: "The structured note ID where this idea appears; the server uses its real date to compute whenWritten."
            },
            why: {
              type: "string",
              description: "Why this idea is worth revisiting."
            }
          },
          required: ["title", "sourceNoteId", "why"]
        }
      },
      tender: {
        type: "string",
        description: "Where the notes hold emotional weight — grief, love, worry, or care — say what you noticed in what they did. Include ordinary tenderness and domestic details, not only loss."
      },
      questions: {
        type: "array",
        description: "Questions you'd genuinely want to ask this person that only their own archive could answer.",
        items: {
          type: "string",
          description: "One genuine second-person question."
        }
      }
    },
    required: ["portrait", "read", "forgottenIdeas", "tender", "questions"]
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
      read: normalizeString(value.read),
      forgottenIdeas: normalizeForgottenIdeas(value.forgottenIdeas),
      tender: normalizeString(value.tender),
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
    why: normalizeString(idea.why)
  }));
}

function normalizeQuestions(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((question) => typeof question === "string");
}

function normalizeString(value) {
  return typeof value === "string" ? value : "";
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
  const verificationContext = {
    partnerNames: collectPartnerNames(overview)
  };
  const verification = {
    totalChecks: 0,
    passed: 0,
    failed: 0,
    failures: []
  };

  const portrait = verifyProse(overview.portrait, verification, verificationContext);
  const read = verifyProse(overview.read, verification, verificationContext);
  const forgottenIdeas = overview.forgottenIdeas.flatMap((idea) => {
    const title = verifyProse(idea.title, verification, verificationContext);
    const why = verifyProse(idea.why, verification, verificationContext);
    if (!title || !why) {
      return [];
    }
    return [{
      title,
      whenWritten: computeNoteDate(idea.sourceNoteId, notesById, verification),
      why
    }];
  });
  const verifiedTender = verifyProse(overview.tender, verification, verificationContext);
  const tender = hasCompleteTenderSection(verifiedTender) ? verifiedTender : "";
  const questions = overview.questions
    .map((question) => verifyQuestion(question, verification, verificationContext))
    .filter(Boolean);

  console.error(`Import overview verification totalChecks=${verification.totalChecks} passed=${verification.passed} failed=${verification.failed}`);

  return {
    ...(portrait ? { portrait } : {}),
    ...(read ? { read } : {}),
    forgottenIdeas,
    ...(tender ? { tender } : {}),
    questions,
    verification
  };
}

function verifyProse(text, verification, verificationContext) {
  const corruptionScreened = screenProseForCorruption(text, verification);
  return screenProseForPrivacy(corruptionScreened, verification, verificationContext.partnerNames);
}

function verifyQuestion(question, verification, verificationContext) {
  const firstFailureIndex = verification.failures.length;
  const verified = verifyProse(question, verification, verificationContext);
  const hadBlockingFailure = verification.failures
    .slice(firstFailureIndex)
    .some((failure) => failure.reason !== "privacy_partner");
  return hadBlockingFailure ? "" : verified;
}

function collectPartnerNames(overview) {
  const texts = [overview.portrait, overview.read, overview.tender, ...overview.questions];
  for (const idea of overview.forgottenIdeas) {
    texts.push(idea.title, idea.why);
  }
  const names = new Set();

  for (const text of texts) {
    for (const { pattern, nameGroup } of PARTNER_NAME_PATTERNS) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        if (match[nameGroup]) {
          names.add(match[nameGroup]);
        }
      }
    }
  }
  return names;
}

function screenProseForCorruption(text, verification) {
  const removalRanges = [];
  const replacements = [];

  for (const range of findAllSentenceRanges(text)) {
    const sentence = text.slice(range.start, range.end);
    const cleaned = cleanCorruptEnglishSentence(sentence);
    if (!cleaned.corrupt) {
      continue;
    }

    recordProseScreenFailure(verification, "corrupt_text");
    if (!cleaned.text) {
      removalRanges.push(expandRangeThroughDanglingSentences(text, range));
    } else {
      replacements.push({ ...range, replacement: cleaned.text });
    }
  }

  const mergedRemovalRanges = mergeRanges(removalRanges);
  const usableReplacements = replacements.filter((replacement) => !mergedRemovalRanges.some((range) => rangesOverlap(replacement, range)));
  const operations = [
    ...mergedRemovalRanges.map((range) => ({ ...range, kind: "removal" })),
    ...usableReplacements.map((replacement) => ({ ...replacement, kind: "replacement" }))
  ].sort((first, second) => second.start - first.start);
  let screenedText = text;

  for (const operation of operations) {
    if (operation.kind === "replacement") {
      screenedText = `${screenedText.slice(0, operation.start)}${operation.replacement}${screenedText.slice(operation.end)}`;
    } else {
      screenedText = removeTextRange(screenedText, operation);
    }
  }

  return mergedRemovalRanges.length > 0 ? cleanTextAfterRemovals(screenedText) : screenedText.trim();
}

function cleanCorruptEnglishSentence(sentence) {
  const tokens = sentence.match(/\S+/gu) || [];
  const corruptTokens = tokens.filter(hasUnexpectedNonLatinLetter);
  if (corruptTokens.length === 0 || !isOtherwiseEnglish(sentence)) {
    return { text: sentence, corrupt: false };
  }

  if (corruptTokens.some((token) => /\p{Script=Latin}/u.test(token))) {
    return { text: "", corrupt: true };
  }

  const text = sentence
    .replace(/\S+/gu, (token) => hasUnexpectedNonLatinLetter(token) ? "" : token)
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .trim();
  const isBroken = !text
    || !/[.!?](?:["'”’)}\]]+)?$/u.test(text)
    || /^[a-z]/u.test(text)
    || /^(?:and|but|because|so|which|while|whereas|with|without|although|though)\b/iu.test(text)
    || (text.match(/\b[\p{Script=Latin}\p{N}][\p{Script=Latin}\p{N}'’.-]*\b/gu) || []).length < 3;
  return { text: isBroken ? "" : text, corrupt: true };
}

function hasUnexpectedNonLatinLetter(value) {
  return [...value].some((character) => (
    /[\p{L}\p{M}]/u.test(character)
    && !/[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(character)
  ));
}

function isOtherwiseEnglish(value) {
  const latinLetters = (value.match(/\p{Script=Latin}/gu) || []).length;
  const unexpectedLetters = [...value].filter((character) => (
    /[\p{L}\p{M}]/u.test(character)
    && !/[\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(character)
  )).length;
  return latinLetters >= 4 && latinLetters > unexpectedLetters * 2;
}

function screenProseForPrivacy(text, verification, partnerNames) {
  const removalRanges = [];
  const redactions = [];

  for (const range of findAllSentenceRanges(text)) {
    const sentence = text.slice(range.start, range.end);
    const removalReason = detectRemovalPrivacyReason(sentence);
    if (removalReason) {
      recordProseScreenFailure(verification, removalReason);
      removalRanges.push(expandRangeThroughDanglingSentences(text, range));
      continue;
    }

    const partnerRedaction = redactPartnerNames(sentence, partnerNames);
    if (partnerRedaction.redacted) {
      recordProseScreenFailure(verification, "privacy_partner");
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

  return mergedRemovalRanges.length > 0 ? cleanTextAfterRemovals(screenedText) : screenedText.trim();
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

function redactPartnerNames(value, partnerNames = new Set()) {
  let text = value;
  let redacted = false;

  for (const { pattern, replace } of PARTNER_NAME_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, (...args) => {
      redacted = true;
      return replace(...args);
    });
  }

  for (const name of partnerNames) {
    const escapedName = escapeRegExp(name);
    const namePattern = new RegExp(String.raw`(?<![\p{L}\p{M}'’.-])${escapedName}('s|’s)?(?![\p{L}\p{M}'’.-])`, "giu");
    text = text.replace(namePattern, (_match, possessive, offset) => {
      redacted = true;
      const prefix = text.slice(0, offset);
      const replacement = /[\p{L}\p{N}]/u.test(prefix) ? "your partner" : "Your partner";
      return `${replacement}${possessive ? "'s" : ""}`;
    });
  }

  return { text, redacted };
}

function recordProseScreenFailure(verification, reason) {
  verification.totalChecks += 1;
  recordVerificationFailure(verification, { reason });
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
    verification.totalChecks += 1;
    const note = notesById.get(noteId);
    if (!note) {
      recordVerificationFailure(verification, {
        noteId,
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

function expandRangeThroughDanglingSentences(text, range) {
  const expanded = { ...range };

  while (expanded.end < text.length) {
    const remainingText = text.slice(expanded.end);
    const leadingWhitespace = /^\s*/u.exec(remainingText)?.[0] || "";
    const nextStart = expanded.end + leadingWhitespace.length;
    if (nextStart >= text.length) {
      break;
    }
    const nextRange = findSentenceRange(text, nextStart, nextStart + 1);
    const nextSentence = text.slice(nextRange.start, nextRange.end).trim();
    if (!looksDanglingAfterRemoval(nextSentence)) {
      break;
    }
    expanded.end = nextRange.end;
  }

  return expanded;
}

function looksDanglingAfterRemoval(sentence) {
  const value = sentence.replace(/^["'“‘(\[]+/u, "").trimStart();
  return /^(?:this|that|these|those|it|they|both|such)\b/iu.test(value)
    || /^(?:(?:i(?:'d| would)\s+(?:guess|say|suspect|bet)\s+)?(?:the\s+)?(?:former|latter))\b/iu.test(value)
    || /^(?:doing so|in doing so|because of this|for that reason|as a result|which means|that means|this means)\b/iu.test(value)
    || /^(?:and|but|because|so|which|while|whereas|with|without|although|though)\b/iu.test(value)
    || /^you(?:'ve| have)\s+always\b/iu.test(value)
    || /^(?:you|we)\b[^.!?]*\b(?:this|that|these|those|again|more than once|the same)\b/iu.test(value);
}

function cleanTextAfterRemovals(text) {
  return removeTrailingFragments(removeLeadingFragments(text).trim()).trim();
}

function removeTrailingFragments(text) {
  let result = text.trim();

  while (result) {
    const ranges = findAllSentenceRanges(result);
    const lastRange = ranges[ranges.length - 1];
    if (!lastRange) {
      return "";
    }
    const lastSentence = result.slice(lastRange.start, lastRange.end).trim();
    if (!looksLikeTrailingFragment(lastSentence)) {
      break;
    }
    result = removeTextRange(result, lastRange).trim();
  }

  return result;
}

function looksLikeTrailingFragment(sentence) {
  if (!/[.!?](?:["'”’)}\]]+)?$/u.test(sentence)) {
    return true;
  }
  const value = sentence.replace(/^["'“‘(\[]+/u, "").trimStart();
  const withoutTerminalPunctuation = value.replace(/[.!?…]+(?:["'”’)}\]]+)?$/u, "").trimEnd();
  return /^(?:(?:i(?:'d| would)\s+(?:guess|say|suspect|bet)\s+)?(?:the\s+)?(?:former|latter))\b/iu.test(value)
    || /\b(?:and|but|because|since|although|though|which|that|than|as|to|with|without|of|for)$/iu.test(withoutTerminalPunctuation);
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
    const isLoneDanglingSentence = completeSentenceCount < 2 && looksDanglingAfterRemoval(firstSentence);
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
