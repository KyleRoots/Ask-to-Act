import { str } from "./record-utils.js";

/**
 * Per-recipient merge fields for outbound email. Values come only from the
 * Bullhorn record the server fetched; templates are written by the caller.
 */
export const EMAIL_MERGE_FIELDS = [
  "firstName",
  "lastName",
  "fullName",
] as const;
export type EmailMergeField = (typeof EMAIL_MERGE_FIELDS)[number];

export const MERGE_VALUE_MAX_CHARS = 100;
export const MERGE_FALLBACK_MAX_CHARS = 60;

export type EmailMergeValues = Record<EmailMergeField, string | null>;

type TemplatePart =
  | { kind: "text"; text: string }
  | {
      kind: "field";
      field: EmailMergeField;
      fallback: string | null;
      raw: string;
    };

export type ParsedEmailTemplate = {
  parts: TemplatePart[];
  fields: EmailMergeField[];
};

export type TemplateError = {
  ok: false;
  error: "unknown_merge_field" | "invalid_merge_field";
  message: string;
  tags: string[];
};

const ALLOWED_TAGS_TEXT = "{{firstName}}, {{lastName}}, {{fullName}}";
const FIELD_PATTERN = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*(?:\|([^|]*))?$/;

function isMergeField(name: string): name is EmailMergeField {
  return (EMAIL_MERGE_FIELDS as readonly string[]).includes(name);
}

function truncateChars(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : value;
}

/**
 * Strips control characters (including CR/LF and Unicode line separators) and
 * curly braces, collapses whitespace, and caps the length. Braces are removed
 * so a Bullhorn value can never emit a literal `{{...}}`.
 */
export function sanitizeMergeValue(
  value: string,
  max = MERGE_VALUE_MAX_CHARS,
): string {
  const cleaned = value
    .replace(/[\u0000-\u001F\u007F\u2028\u2029]/g, " ")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return truncateChars(cleaned, max);
}

function describeTemplateLabel(label: string, tag: string): string {
  return label ? `${tag} in the ${label}` : tag;
}

function parseOne(
  template: string,
  label: string,
): { ok: true; parsed: ParsedEmailTemplate } | TemplateError {
  const parts: TemplatePart[] = [];
  const fields = new Set<EmailMergeField>();
  const unknown: string[] = [];
  const invalid: string[] = [];
  let cursor = 0;

  const pushText = (text: string) => {
    if (!text) return;
    if (text.includes("}}")) invalid.push("}}");
    parts.push({ kind: "text", text });
  };

  while (cursor < template.length) {
    const open = template.indexOf("{{", cursor);
    if (open === -1) {
      pushText(template.slice(cursor));
      break;
    }
    pushText(template.slice(cursor, open));
    const close = template.indexOf("}}", open + 2);
    if (close === -1) {
      invalid.push(template.slice(open, open + 20));
      break;
    }
    const raw = template.slice(open, close + 2);
    const inner = template.slice(open + 2, close);
    cursor = close + 2;

    if (/[{}\r\n]/.test(inner)) {
      invalid.push(raw);
      continue;
    }
    const match = FIELD_PATTERN.exec(inner);
    if (!match) {
      invalid.push(raw);
      continue;
    }
    const name = match[1]!;
    if (!isMergeField(name)) {
      unknown.push(raw);
      continue;
    }
    let fallback: string | null = null;
    if (match[2] !== undefined) {
      const cleaned = sanitizeMergeValue(match[2], MERGE_FALLBACK_MAX_CHARS);
      if (
        !cleaned ||
        Array.from(match[2].trim()).length > MERGE_FALLBACK_MAX_CHARS
      ) {
        invalid.push(raw);
        continue;
      }
      fallback = cleaned;
    }
    fields.add(name);
    parts.push({ kind: "field", field: name, fallback, raw });
  }

  if (unknown.length > 0) {
    const hints = unknown.map((tag) => {
      const name = tag.slice(2, -2).split("|")[0]!.trim();
      const suggestion = EMAIL_MERGE_FIELDS.find(
        (f) => f.toLowerCase() === name.toLowerCase(),
      );
      return suggestion
        ? `${describeTemplateLabel(label, tag)} (did you mean {{${suggestion}}}?)`
        : describeTemplateLabel(label, tag);
    });
    return {
      ok: false,
      error: "unknown_merge_field",
      tags: unknown,
      message: `Unknown merge field: ${hints.join(", ")}. Supported merge fields are ${ALLOWED_TAGS_TEXT}, each with an optional fallback such as {{firstName|there}}. Fix the template and preview again.`,
    };
  }
  if (invalid.length > 0) {
    return {
      ok: false,
      error: "invalid_merge_field",
      tags: invalid,
      message: `Malformed merge field: ${invalid
        .map((tag) => describeTemplateLabel(label, tag))
        .join(
          ", ",
        )}. Use ${ALLOWED_TAGS_TEXT}. A fallback goes after a single "|" and must be 1-${MERGE_FALLBACK_MAX_CHARS} characters, for example {{firstName|there}}. Unmatched "{{" or "}}" is not allowed.`,
    };
  }
  return { ok: true, parsed: { parts, fields: [...fields] } };
}

export type ParsedEmail = {
  subject: ParsedEmailTemplate;
  body: ParsedEmailTemplate;
  fields: EmailMergeField[];
};

export function parseEmailTemplates(args: {
  subject: string;
  body: string;
}): { ok: true; parsed: ParsedEmail } | TemplateError {
  const subject = parseOne(args.subject, "subject");
  if (!subject.ok) return subject;
  const body = parseOne(args.body, "body");
  if (!body.ok) return body;
  const fields = EMAIL_MERGE_FIELDS.filter(
    (f) => subject.parsed.fields.includes(f) || body.parsed.fields.includes(f),
  );
  return {
    ok: true,
    parsed: { subject: subject.parsed, body: body.parsed, fields },
  };
}

/** Merge values from a fetched Bullhorn Candidate/ClientContact record. */
export function mergeValuesFromRecord(
  entity: Record<string, unknown>,
): EmailMergeValues {
  const firstName = sanitizeMergeValue(str(entity.firstName));
  const lastName = sanitizeMergeValue(str(entity.lastName));
  const explicitName = sanitizeMergeValue(str(entity.name));
  const fullName =
    explicitName || sanitizeMergeValue(`${firstName} ${lastName}`);
  return {
    firstName: firstName || null,
    lastName: lastName || null,
    fullName: fullName || null,
  };
}

/** Only the values a template actually uses, so previews and tokens stay small. */
export function usedMergeValues(
  values: EmailMergeValues,
  fields: readonly EmailMergeField[],
): Partial<EmailMergeValues> {
  const out: Partial<EmailMergeValues> = {};
  for (const f of fields) out[f] = values[f];
  return out;
}

function renderParts(
  template: ParsedEmailTemplate,
  values: EmailMergeValues,
  missing: Set<EmailMergeField>,
): string {
  let out = "";
  for (const part of template.parts) {
    if (part.kind === "text") {
      out += part.text;
      continue;
    }
    const value = values[part.field] ?? part.fallback;
    if (!value) {
      missing.add(part.field);
      continue;
    }
    out += value;
  }
  return out;
}

export type RenderedEmail =
  | { ok: true; subject: string; body: string; usedFallback: boolean }
  | { ok: false; missingFields: EmailMergeField[] };

export function renderEmail(
  parsed: ParsedEmail,
  values: EmailMergeValues,
): RenderedEmail {
  const missing = new Set<EmailMergeField>();
  const subject = renderParts(parsed.subject, values, missing);
  const body = renderParts(parsed.body, values, missing);
  if (missing.size > 0) {
    return {
      ok: false,
      missingFields: EMAIL_MERGE_FIELDS.filter((f) => missing.has(f)),
    };
  }
  const usedFallback = [...parsed.subject.parts, ...parsed.body.parts].some(
    (p) => p.kind === "field" && !values[p.field] && p.fallback !== null,
  );
  return { ok: true, subject, body, usedFallback };
}
