// Lab-only snapshot of the privacy/cleanup helpers in import-overview.js.
// Kept verbatim because that app endpoint must remain untouched. A parity test
// checks these blocks against the source; reconcile deliberately if it changes.

const SELF_HARM_PRIVACY_PATTERN = new RegExp([
  String.raw`\b(?:suicid(?:es?|al(?:ity)?)|self[\s\p{Dash_Punctuation}]*(?:harm(?:s|ed|ing)?|injur(?:y|ies|ious))`,
  String.raw`|(?:mental[\s\p{Dash_Punctuation}]+health|psychiatric|psychological)[\s\p{Dash_Punctuation}]+(?:cris(?:is|es)|emergenc(?:y|ies))`,
  String.raw`|kill(?:s|ed|ing)?\s+(?:myself|yourself|himself|herself|themselves)`,
  String.raw`|(?:take|takes|taking|took|taken)\s+(?:my|your|his|her|their)\s+own\s+life`,
  String.raw`|(?:end|ends|ending|ended)\s+(?:my|your|his|her|their)\s+(?:own\s+)?life)\b`
].join(""), "iu");
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

function buildKeywordPattern(keywords) {
  const alternatives = [...keywords]
    .sort((first, second) => second.length - first.length)
    .map(escapeRegExp);
  return new RegExp(`\\b(?:${alternatives.join("|")})\\b`, "iu");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}


function verifyProse(text, verification, verificationContext) {
  const withoutNoteReferences = removeNoteIdParentheticals(text);
  const corruptionScreened = screenProseForCorruption(withoutNoteReferences, verification);
  return screenProseForPrivacy(corruptionScreened, verification, verificationContext.partnerNames);
}

function removeNoteIdParentheticals(text) {
  return text
    .replace(/\([^()]*\bn\d+\b[^()]*\)/giu, "")
    .replace(/[ \t]{2,}/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .trim();
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
  if (SELF_HARM_PRIVACY_PATTERN.test(value)) {
    return "privacy_selfharm";
  }
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

export { collectPartnerNames, hasCompleteTenderSection, verifyProse, verifyQuestion };
