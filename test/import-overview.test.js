import assert from "node:assert/strict";
import test from "node:test";

import handler from "../api/import-overview.js";

test("import overview sends a chronological labelled scaffold and authoritative timeline", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const request = createRequest([
    note("later", "Later", "Latest full text", "2025-05-10T12:00:00.000Z"),
    note("earliest-source-id", "Earliest", "Earliest first line\n\nEarliest third line", "2024-01-02T12:00:00.000Z"),
    note("middle", "Middle", "Middle full text", "2025-03-15T12:00:00.000Z")
  ]);
  const response = createResponse();

  await handler(request, response);

  const upstreamBody = JSON.parse(restore.requests[0].options.body);
  assert.equal(restore.requests.length, 1);
  assert.equal(upstreamBody.model, "claude-sonnet-5");
  assert.equal(upstreamBody.max_tokens, 32000);
  assert.ok(restore.requests[0].options.signal instanceof AbortSignal);
  assert.equal(upstreamBody.system, `Someone has just handed you everything they've written down for years — thousands of private notes, kept for themselves, never meant to be read like this. Your job is to tell them what you see.

This is the first thing they'll read after trusting you with all of it. They're deciding, in the next minute, whether that was a good idea. So don't summarise their notes back to them. They know what's in there. Tell them who they seem to be.

HOW TO WRITE
Like a friend who's spent a long night reading and now wants to say what they noticed. Warm, plain, direct. Short sentences. Say things straight rather than building to them. No literary flourishes, no metaphors about the archive, nothing written to sound impressive. If a sentence could describe anyone, cut it. Write in second person.

HOW TO SEE
Be generous and be honest — both, not one softened by the other. Generous means assuming this person is capable and had reasons; where two readings fit the evidence, take the one that credits them with agency rather than the one that makes them a victim of their own patterns. Honest means saying the difficult thing when you see it, without moralising, advising, or softening it into a compliment.

Use their own stated reasons for what they did. Where motive is genuinely unclear, say so, or hold both readings. Never impose a familiar story shape on a life just because it's a shape you recognise.

Anything you claim should rest on something specific — a line they wrote, a project they named, a number they tracked, a thing they did repeatedly. An observation with evidence beats three without. And somewhere in here, tell them at least two things they probably haven't put into words about themselves: a pattern only visible across years, a contradiction between two parts of their life, something that stayed constant while they thought they were changing.

Where you're unsure, say so plainly. 'I might be reading too much into this.' 'You'd know better than I would.' That honesty makes you trustworthy, not weak.

WHAT NOT TO DO
No personality types, no psychological frameworks, no diagnostic language. Never mention health conditions, treatments, therapy, or diagnoses. Never name or identify someone who died, or refer to them by relationship. Never name a partner or spouse — 'your wife' is fine, a name is not. You can acknowledge grief, love, and strain; do it without exposing the specifics. This holds everywhere, including in what you choose to quote.

Thin archives get shorter honest answers, never invented depth.`);
  assert.doesNotMatch(upstreamBody.system, /\{\{cite|startLine|endLine|calendar date|whenWritten|real estate|MOTIVE:/u);
  const tool = upstreamBody.tools[0];
  assert.match(tool.description, /QUOTE PROTOCOL: Never write or reconstruct quote text/);
  assert.match(tool.description, /\{\{cite:0\}\}.*\{ noteId, startLine, endLine \}/s);
  assert.match(tool.description, /Use at most one token per sentence/);
  assert.match(tool.description, /substantive lines rather than trivial or decorative ones/);
  assert.match(tool.description, /DATE AND SOURCE PROTOCOL: Never write a year, month, calendar date, date range, bare age/);
  assert.match(tool.description, /server computes displayed dates strictly from createdAt metadata/);
  const schema = upstreamBody.tools[0].input_schema;
  assert.deepEqual(Object.keys(schema.properties), [
    "portrait",
    "portraitCitations",
    "read",
    "readCitations",
    "forgottenIdeas",
    "tender",
    "tenderCitations",
    "questions"
  ]);
  for (const field of Object.values(schema.properties)) {
    assert.equal(typeof field.description, "string");
    assert.ok(field.description.length > 0);
  }
  for (const field of Object.values(schema.properties.forgottenIdeas.items.properties)) {
    assert.equal(typeof field.description, "string");
    assert.ok(field.description.length > 0);
  }
  assert.deepEqual(Object.keys(schema.properties.portraitCitations.items.properties), ["noteId", "startLine", "endLine"]);
  for (const field of Object.values(schema.properties.portraitCitations.items.properties)) {
    assert.equal(typeof field.description, "string");
    assert.ok(field.description.length > 0);
  }
  assert.match(schema.properties.portrait.description, /Who this person is, said plainly/);
  assert.match(schema.properties.read.description, /what they're like underneath, what they keep returning to, and what has stayed constant/);
  assert.match(schema.properties.tender.description, /Must stand alone; never open with a transitional word/);
  assert.match(schema.properties.portraitCitations.description, /Token index N refers to locator index N/);
  assert.match(schema.properties.readCitations.description, /server extracts the exact quote; never write quote text yourself/i);
  assert.equal(schema.properties.seasons, undefined);
  assert.equal(schema.properties.language, undefined);
  assert.equal(schema.properties.patterns, undefined);
  assert.ok(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.items.properties.sourceNoteId);
  assert.equal(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.items.properties.whenWritten, undefined);
  assert.deepEqual(schema.required, ["portrait", "portraitCitations", "read", "readCitations", "forgottenIdeas", "tender", "tenderCitations", "questions"]);
  assert.equal(schema.properties.forgottenIdeas.minItems, 4);
  assert.equal(schema.properties.forgottenIdeas.maxItems, 5);
  assert.deepEqual(upstreamBody.tools[0].input_schema.properties.forgottenIdeas.items.required, ["title", "sourceNoteId", "why", "citations"]);
  assert.equal(schema.properties.questions.minItems, 3);
  assert.equal(schema.properties.questions.maxItems, 3);
  assert.equal(schema.properties.questions.items.type, "string");
  assert.equal(typeof schema.properties.questions.items.description, "string");

  const prompt = upstreamBody.messages[0].content[0].text;
  assert.equal(prompt.startsWith("TIMELINE INDEX — SERVER-COMPUTED AND AUTHORITATIVE"), true);
  assert.match(prompt, /\| Overall \| January 2024 – May 2025 \| 3 \|/);
  assert.match(prompt, /\| Year \| 2024 \| 1 \|/);
  assert.match(prompt, /\| Year \| 2025 \| 2 \|/);
  assert.match(prompt, /\[NOTE n1 \| DATE: January 2024 \| TITLE: "Earliest"\]\nn1\|L1\| Earliest first line\nn1\|L2\| \nn1\|L3\| Earliest third line/);
  assert.ok(prompt.indexOf('[NOTE n1 | DATE: January 2024 | TITLE: "Earliest"]') < prompt.indexOf('[NOTE n2 | DATE: March 2025 | TITLE: "Middle"]\nn2|L1| Middle full text'));
  assert.ok(prompt.indexOf('[NOTE n2 | DATE: March 2025 | TITLE: "Middle"]') < prompt.indexOf('[NOTE n3 | DATE: May 2025 | TITLE: "Later"]\nn3|L1| Latest full text'));
  assert.doesNotMatch(prompt, /earliest-source-id/);
  assert.doesNotMatch(prompt, /\{\{cite|startLine|endLine|Do not write dates/u);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.deepEqual(Object.keys(result), [
    "portrait",
    "portraitCitations",
    "read",
    "readCitations",
    "forgottenIdeas",
    "tender",
    "tenderCitations",
    "questions",
    "verification"
  ]);
  assert.deepEqual(result.verification, {
    totalCitations: 0,
    passed: 0,
    failed: 0,
    failures: []
  });
});

test("import overview adds month counts when a year has enough notes", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const notes = Array.from({ length: 12 }, (_, index) => note(
    `source-${index + 1}`,
    `Note ${index + 1}`,
    `Text ${index + 1}`,
    `2025-${String(index + 1).padStart(2, "0")}-01T00:00:00.000Z`
  ));
  const response = createResponse();

  await handler(createRequest(notes), response);

  const prompt = JSON.parse(restore.requests[0].options.body).messages[0].content[0].text;
  assert.match(prompt, /\| Year \| 2025 \| 12 \|/);
  assert.match(prompt, /\| Month \| January 2025 \| 1 \|/);
  assert.match(prompt, /\| Month \| December 2025 \| 1 \|/);
  assert.equal(response.statusCode, 200);
});

test("import overview substitutes exact line locators, computes dates, and removes invalid evidence", async (context) => {
  const providerInput = baseOverviewInput({
    portrait: "In 2020 you were rushing. You wrote {{cite:0}} in a list. This remains.",
    portraitCitations: [{ noteId: "n1", startLine: 1, endLine: 2 }],
    read: "This bad source said {{cite:0}}. This remains. This bad range said {{cite:1}}. Another thought remains. This empty source said {{cite:2}}. The pattern remains.",
    readCitations: [
      { noteId: "n99", startLine: 1, endLine: 1 },
      { noteId: "n1", startLine: 8, endLine: 9 },
      { noteId: "n1", startLine: 3, endLine: 3 }
    ],
    forgottenIdeas: [
      {
        title: "Cedar",
        sourceNoteId: "n2",
        why: "You named {{cite:0}}.",
        citations: [{ noteId: "n2", startLine: 1, endLine: 1 }]
      },
      {
        title: "Unquoted",
        sourceNoteId: "n99",
        why: "No quote.",
        citations: []
      }
    ],
    tender: "This malformed token said {{cite:9}}. You clearly redrafted this more than once. Care remains.",
    tenderCitations: [],
    questions: ["In 2021, what changed?", "What do you still want to build?", "What keeps pulling you back?"]
  });
  const restore = installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([
    note("old", "Old", "exact phrase\r\nsecond exact line\r\n", "2024-01-05T00:00:00.000Z"),
    note("new", "New", "Project Cedar\ncarefully tracked", "2025-03-06T00:00:00.000Z")
  ]), response);

  assert.equal(restore.requests.length, 1);
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "You wrote “exact phrase\r\nsecond exact line” in a list. This remains.");
  assert.deepEqual(result.portraitCitations, [{ noteId: "n1", startLine: 1, endLine: 2 }]);
  assert.equal(result.read, "Another thought remains. This empty source said “second exact line”. The pattern remains.");
  assert.deepEqual(result.readCitations, [{ noteId: "n1", startLine: 2, endLine: 2 }]);
  assert.equal(result.tender, "Care remains.");
  assert.equal(result.forgottenIdeas[0].whenWritten, "Mar 2025");
  assert.equal(result.forgottenIdeas[1].whenWritten, "");
  assert.deepEqual(result.questions, ["", "What do you still want to build?", "What keeps pulling you back?"]);
  assert.deepEqual(result.verification, {
    totalCitations: 10,
    passed: 4,
    failed: 6,
    failures: [
      { noteId: "", startLine: null, endLine: null, reason: "date_in_prose" },
      { noteId: "n99", startLine: 1, endLine: 1, citationIndex: 0, citationsAvailable: 3, reason: "note_not_found" },
      { noteId: "n1", startLine: 8, endLine: 9, citationIndex: 1, citationsAvailable: 3, reason: "invalid_locator" },
      { noteId: null, startLine: null, endLine: null, citationIndex: 9, citationsAvailable: 0, reason: "invalid_locator" },
      { noteId: "n99", startLine: null, endLine: null, reason: "note_not_found" },
      { noteId: "", startLine: null, endLine: null, reason: "date_in_prose" }
    ]
  });
  assert.deepEqual(restore.loggedErrors, [
    ["Import overview verification totalCitations=10 passed=4 failed=6"]
  ]);
});

test("import overview trims a long cited span at its first sentence", async (context) => {
  const longLine = `A short exact sentence. ${"additional source words ".repeat(20)}`;
  const providerInput = baseOverviewInput({
    portrait: "You wrote {{cite:0}}",
    portraitCitations: [{ noteId: "n1", startLine: 1, endLine: 1 }]
  });
  installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([note("one", "One", longLine, "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "You wrote “A short exact sentence”.");
  assert.equal(result.portrait.includes("additional source words"), false);
});

test("import overview wraps extracted text with one balanced quote pair and cleans trailing punctuation", async (context) => {
  const providerInput = baseOverviewInput({
    portrait: "A revealing line was {{cite:0}} in a task list. You repeated {{cite:1}}.",
    portraitCitations: [
      { noteId: "n1", startLine: 1, endLine: 1 },
      { noteId: "n1", startLine: 2, endLine: 2 }
    ]
  });
  installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", '"call the builder asap. )\n“Keep going!””', "2026-08-25T00:00:00.000Z")
  ]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "A revealing line was “call the builder asap” in a task list. You repeated “Keep going”.");
  assert.equal((result.portrait.match(/“/gu) || []).length, 2);
  assert.equal((result.portrait.match(/”/gu) || []).length, 2);
  assert.doesNotMatch(result.portrait, /["„‟″«»]/u);
});

test("import overview removes private health and deceased prose while redacting only partner names", async (context) => {
  const providerInput = baseOverviewInput({
    portrait: "You see a psychologist regularly. Sertraline appears in your routine. You keep building.",
    read: "Your mother died and the loss changed your priorities. A death in the family still matters. Sarah died, and you still carry that grief. Someone close to you is part of your grief. You keep showing up. Your wife Priya supports your work. Ameer keeps his own name. Your child Zara appears in the plans. Your business partner Ravi appears in the launch notes. You married Priya deliberately. Your appetite for risk stayed constant.",
    forgottenIdeas: [{
      title: "A therapy tracker.",
      sourceNoteId: "n1",
      why: "The small tool may still be useful.",
      citations: []
    }],
    questions: ["How did psoriasis change you?", "What do you still want?", "What keeps returning?"]
  });
  const restore = installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "Safe source text", "2026-08-25T00:00:00.000Z")
  ]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "You keep building.");
  assert.equal(result.read, "A death in the family still matters. Someone close to you is part of your grief. You keep showing up. Your wife supports your work. Ameer keeps his own name. Your child Zara appears in the plans. Your business partner Ravi appears in the launch notes. You married your partner deliberately. Your appetite for risk stayed constant.");
  assert.equal(result.forgottenIdeas[0].title, "");
  assert.equal(result.forgottenIdeas[0].whenWritten, "Aug 2026");
  assert.deepEqual(result.questions, ["", "What do you still want?", "What keeps returning?"]);
  assert.deepEqual(result.verification, {
    totalCitations: 9,
    passed: 1,
    failed: 8,
    failures: [
      { noteId: "", startLine: null, endLine: null, reason: "privacy_health" },
      { noteId: "", startLine: null, endLine: null, reason: "privacy_health" },
      { noteId: "", startLine: null, endLine: null, reason: "privacy_deceased" },
      { noteId: "", startLine: null, endLine: null, reason: "privacy_deceased" },
      { noteId: "", startLine: null, endLine: null, reason: "privacy_partner" },
      { noteId: "", startLine: null, endLine: null, reason: "privacy_partner" },
      { noteId: "", startLine: null, endLine: null, reason: "privacy_health" },
      { noteId: "", startLine: null, endLine: null, reason: "privacy_health" }
    ]
  });
  assert.deepEqual(restore.loggedErrors, [
    ["Import overview verification totalCitations=9 passed=1 failed=8"]
  ]);
});

test("import overview rejects private extracted quotes before substitution", async (context) => {
  const providerInput = baseOverviewInput({
    portrait: "You wrote {{cite:0}}. You wrote {{cite:1}}. You wrote {{cite:2}}. You also wrote {{cite:3}}.",
    portraitCitations: [
      { noteId: "n1", startLine: 1, endLine: 1 },
      { noteId: "n1", startLine: 2, endLine: 2 },
      { noteId: "n1", startLine: 3, endLine: 3 },
      { noteId: "n1", startLine: 4, endLine: 4 }
    ]
  });
  installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "My therapist told me to rest\nMy sister died when I was young\nMy wife Priya backed the move\nI chose the bigger outcome", "2026-08-25T00:00:00.000Z")
  ]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "You also wrote “I chose the bigger outcome”.");
  assert.deepEqual(result.portraitCitations, [{ noteId: "n1", startLine: 4, endLine: 4 }]);
  assert.deepEqual(result.verification, {
    totalCitations: 4,
    passed: 1,
    failed: 3,
    failures: [
      { noteId: "n1", startLine: 1, endLine: 1, citationIndex: 0, citationsAvailable: 4, reason: "privacy_health" },
      { noteId: "n1", startLine: 2, endLine: 2, citationIndex: 1, citationsAvailable: 4, reason: "privacy_deceased" },
      { noteId: "n1", startLine: 3, endLine: 3, citationIndex: 2, citationsAvailable: 4, reason: "privacy_partner" }
    ]
  });
});

test("import overview rejects date-led quotes and keeps at most one quote per sentence", async (context) => {
  const providerInput = baseOverviewInput({
    portrait: "You marked the change by writing {{cite:1}}. You said {{cite:0}} {{cite:2}}. A clean close remains.",
    portraitCitations: [
      { noteId: "n1", startLine: 1, endLine: 1 },
      { noteId: "n1", startLine: 2, endLine: 2 },
      { noteId: "n1", startLine: 3, endLine: 3 }
    ]
  });
  installProviderMock(context, () => successfulProviderResponse(providerInput));
  const response = createResponse();

  await handler(createRequest([
    note("one", "One", "there's no room for error\nOn 20th December 2025, I quit my job of 6 years\nI chose the bigger outcome", "2026-08-25T00:00:00.000Z")
  ]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "You said “there's no room for error”. A clean close remains.");
  assert.equal((result.portrait.match(/“/gu) || []).length, 1);
  assert.doesNotMatch(result.portrait, /20th|December|2025/u);
  assert.deepEqual(result.portraitCitations, [{ noteId: "n1", startLine: 1, endLine: 1 }]);
  assert.deepEqual(result.verification, {
    totalCitations: 3,
    passed: 1,
    failed: 2,
    failures: [
      { noteId: "n1", startLine: 2, endLine: 2, citationIndex: 1, citationsAvailable: 3, reason: "date_in_quote" },
      { noteId: "n1", startLine: 3, endLine: 3, citationIndex: 2, citationsAvailable: 3, reason: "quote_collision" }
    ]
  });
});

test("import overview makes exactly one provider attempt on failure", async (context) => {
  let attempts = 0;
  const restore = installProviderMock(context, () => {
    attempts += 1;
    return new Response('{"type":"error"}', { status: 529 });
  });
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(attempts, 1);
  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      message: "Import overview failed",
      detail: {
        type: "provider_http_error",
        message: "Provider returned HTTP 529",
        provider_status: 529,
        provider_body: { type: "error" },
        stop_reason: null,
        usage: null
      }
    }
  });
  assert.match(JSON.stringify(restore.loggedErrors), /Import overview provider error.*529/);
});

test("import overview reports max_tokens with provider usage instead of flattening it", async (context) => {
  const restore = installProviderMock(context, () => providerResponse({
    content: [{ type: "text", text: "incomplete" }],
    stopReason: "max_tokens",
    usage: {
      input_tokens: 700000,
      output_tokens: 32000,
      output_tokens_details: { thinking_tokens: 28000 }
    }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body), {
    error: {
      message: "Import overview failed",
      detail: {
        type: "stop_reason",
        message: "Provider stopped with max_tokens before completing the overview",
        stop_reason: "max_tokens",
        usage: {
          input_tokens: 700000,
          output_tokens: 32000,
          output_tokens_details: { thinking_tokens: 28000 }
        }
      }
    }
  });
  assert.match(JSON.stringify(restore.loggedErrors), /stop_reason=max_tokens.*output_tokens=32000/);
});

test("import overview tolerates missing metadata, wrong optional types, and unexpected fields", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{
      type: "tool_use",
      name: "submit_import_overview",
      input: {
        portrait: "Partial output",
        read: 42,
        forgottenIdeas: [{ title: "An idea", why: "It may matter", unexpected: true }],
        questions: ["One?", 42, "Two?", "Three?", "Four?"],
        unexpectedTopLevel: true
      }
    }],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body);
  assert.equal(result.portrait, "Partial output");
  assert.deepEqual(result.portraitCitations, []);
  assert.equal(result.read, "");
  assert.deepEqual(result.readCitations, []);
  assert.equal(result.tender, "");
  assert.deepEqual(result.questions, ["One?", "Two?", "Three?"]);
  assert.deepEqual(result.forgottenIdeas, [{
    title: "An idea",
    whenWritten: "",
    why: "It may matter",
    citations: []
  }]);
  assert.deepEqual(result.verification, {
    totalCitations: 1,
    passed: 0,
    failed: 1,
    failures: [{ noteId: "", startLine: null, endLine: null, reason: "note_not_found" }]
  });
});

test("import overview reports failed fields and key shapes for an unusable tool payload", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{
      type: "tool_use",
      name: "submit_import_overview",
      input: {
        forgottenIdeas: [{ title: "An idea", unexpected: true }],
        unexpectedTopLevel: true
      }
    }],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body).error.detail, {
    type: "tool_input_validation_error",
    message: "Provider tool input failed overview validation",
    failed_fields: [
      { field: "portrait", reason: "missing", expected: "non-empty string" }
    ],
    top_level_keys: ["forgottenIdeas", "unexpectedTopLevel"],
    first_forgotten_idea_keys: ["title", "unexpected"],
    stop_reason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  });
});

test("import overview distinguishes empty core fields as failed constraints", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: [{
      type: "tool_use",
      name: "submit_import_overview",
      input: { portrait: "", forgottenIdeas: [] }
    }],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body).error.detail.failed_fields, [
    { field: "portrait", reason: "failed_constraint", constraint: "must not be empty" }
  ]);
});

test("import overview handles malformed partial content without entering verification", async (context) => {
  installProviderMock(context, () => providerResponse({
    content: { partial: true },
    stopReason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 }
  }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  assert.deepEqual(JSON.parse(response.body).error.detail, {
    type: "missing_tool_output",
    message: "Provider response did not contain the required overview tool output",
    failed_fields: [{ field: "$", reason: "wrong_type", expected: "object", actual: "undefined" }],
    top_level_keys: [],
    first_forgotten_idea_keys: [],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 }
  });
});

test("import overview identifies malformed provider JSON as a parse error", async (context) => {
  installProviderMock(context, () => new Response("{not-json", { status: 200 }));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  const detail = JSON.parse(response.body).error.detail;
  assert.equal(detail.type, "parse_error");
  assert.match(detail.message, /JSON/u);
  assert.equal(typeof detail.stack, "string");
  assert.equal(detail.stop_reason, null);
  assert.equal(detail.usage, null);
});

test("import overview identifies a provider timeout", async (context) => {
  installProviderMock(context, () => {
    const error = new Error("The operation timed out");
    error.name = "TimeoutError";
    throw error;
  });
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "2026-08-25T00:00:00.000Z")]), response);

  assert.equal(response.statusCode, 502);
  const detail = JSON.parse(response.body).error.detail;
  assert.equal(detail.type, "timeout");
  assert.equal(detail.message, "The operation timed out");
  assert.equal(detail.stop_reason, null);
  assert.equal(detail.usage, null);
});

test("import overview rejects invalid createdAt values before calling the provider", async (context) => {
  const restore = installProviderMock(context, () => successfulProviderResponse(baseOverviewInput()));
  const response = createResponse();

  await handler(createRequest([note("one", "One", "Text", "not-a-date")]), response);

  assert.equal(restore.requests.length, 0);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(JSON.parse(response.body), { error: { message: "Invalid notes array" } });
});

function baseOverviewInput(overrides = {}) {
  return {
    portrait: "Portrait",
    portraitCitations: [],
    read: "Read",
    readCitations: [],
    forgottenIdeas: [],
    tender: "Tender",
    tenderCitations: [],
    questions: ["What do you want?", "What keeps returning?", "What changed you?"],
    ...overrides
  };
}

function successfulProviderResponse(input) {
  return providerResponse({
    content: [
      {
        type: "tool_use",
        name: "submit_import_overview",
        input
      }
    ],
    stopReason: "tool_use",
    usage: { input_tokens: 100, output_tokens: 200 }
  });
}

function providerResponse({ content, stopReason, usage }) {
  return new Response(JSON.stringify({
    content,
    stop_reason: stopReason,
    usage
  }), { status: 200 });
}

function installProviderMock(context, fetchImplementation) {
  const previousApiKey = process.env.ANTHROPIC_API_KEY;
  const previousFetch = globalThis.fetch;
  const previousConsoleError = console.error;
  const requests = [];
  const loggedErrors = [];

  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return fetchImplementation(url, options);
  };
  console.error = (...args) => loggedErrors.push(args);

  context.after(() => {
    restoreEnvironment("ANTHROPIC_API_KEY", previousApiKey);
    globalThis.fetch = previousFetch;
    console.error = previousConsoleError;
  });

  return { requests, loggedErrors };
}

function createRequest(notes) {
  return { method: "POST", body: { notes } };
}

function note(id, title, text, createdAt) {
  return { id, title, text, createdAt };
}

function restoreEnvironment(name, previousValue) {
  if (previousValue === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = previousValue;
  }
}

function createResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(body) {
      this.body = body;
    }
  };
}
