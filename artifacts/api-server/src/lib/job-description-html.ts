/**
 * Format job descriptions for Bullhorn rich-text fields.
 *
 * Bullhorn's Job Description / Published Description editors expect well-formed
 * HTML. Models often pass markdown, plain text with "-" bullets, or HTML with
 * unclosed <li> tags — all of which render as one clumped paragraph in the UI.
 */
import { escapeHtml } from "./html.js";

function looksLikeHtml(s: string): boolean {
  // Only treat as HTML when structural JD tags are present — otherwise
  // angle brackets in plain text (e.g. "<script>") must be escaped.
  return /<\/?(?:p|ul|ol|li|h[1-6]|div|br|strong|em|b|i)\b/i.test(s);
}

/** Close common unclosed list items and strip empty tags Bullhorn chokes on. */
export function repairJobDescriptionHtml(html: string): string {
  let out = html.trim();
  if (!out) return out;

  // Insert missing </li> before the next <li> or </ul>/<ol>.
  out = out.replace(/<li(\s[^>]*)?>([\s\S]*?)(?=<(?:li|\/ul|\/ol)\b)/gi, (full, attrs, inner) => {
    const a = attrs ?? "";
    const body = String(inner).replace(/\s+$/, "");
    if (/<\/li\s*>/i.test(body)) return full;
    return `<li${a}>${body}</li>\n`;
  });

  // Orphan trailing <li>…content without a closer before end of string / parent.
  out = out.replace(/<li(\s[^>]*)?>((?:(?!<\/li>).)*)(?=<\/ul>|<\/ol>|$)/gi, (full, attrs, inner) => {
    if (/<\/li\s*>/i.test(full)) return full;
    return `<li${attrs ?? ""}>${String(inner).trim()}</li>`;
  });

  return out;
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (/^#{1,3}\s+\S/.test(t)) return true;
  // Common JD section titles (no markdown hashes).
  if (
    /^(main responsibilities|key responsibilities|role (?:overview|description)|education(?: and experience)?(?: required)?|required skills(?:\s*&\s*experience)?|preferred qualifications|specialized knowledge(?:, skills,? and abilities)?|about (?:the )?(?:role|company)|responsibilities|qualifications)$/i.test(
      t.replace(/:$/, ""),
    )
  ) {
    return true;
  }
  return false;
}

function headingText(line: string): string {
  return line.trim().replace(/^#{1,3}\s+/, "").replace(/:$/, "").trim();
}

function isBullet(line: string): boolean {
  return /^\s*([-*•]|\d+[.)])\s+\S/.test(line);
}

function bulletText(line: string): string {
  return line.trim().replace(/^([-*•]|\d+[.)])\s+/, "").trim();
}

function inlineMarkdown(escaped: string): string {
  // Bold / italic on already-escaped text (no raw HTML injection).
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
}

/**
 * Convert markdown-ish / plain JD text into well-formed Bullhorn HTML.
 * If the input already looks like HTML, repair unclosed tags instead.
 */
export function formatJobDescriptionHtml(input: string): string {
  const raw = input.replace(/^\uFEFF/, "").trim();
  if (!raw) return "";

  if (looksLikeHtml(raw)) {
    return repairJobDescriptionHtml(raw);
  }

  const lines = raw.split(/\r?\n/);
  const parts: string[] = [];
  let para: string[] = [];
  let bullets: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    const text = inlineMarkdown(escapeHtml(para.join(" ").replace(/\s+/g, " ").trim()));
    if (text) parts.push(`<p>${text}</p>`);
    para = [];
  };

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets
      .map((b) => `<li>${inlineMarkdown(escapeHtml(b))}</li>`)
      .join("\n");
    parts.push(`<ul>\n${items}\n</ul>`);
    bullets = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushBullets();
      flushPara();
      continue;
    }
    if (isHeading(trimmed)) {
      flushBullets();
      flushPara();
      parts.push(`<h3>${inlineMarkdown(escapeHtml(headingText(trimmed)))}</h3>`);
      continue;
    }
    if (isBullet(trimmed)) {
      flushPara();
      bullets.push(bulletText(trimmed));
      continue;
    }
    // A non-bullet after bullets ends the list.
    if (bullets.length > 0) flushBullets();
    para.push(trimmed);
  }
  flushBullets();
  flushPara();

  return parts.join("\n\n");
}

/**
 * Apply description formatting for create/update. If only one of description /
 * publicDescription is set, mirror the formatted HTML into the other. If both
 * are set (even identically), format each independently.
 */
export function applyFormattedJobDescriptions(fields: Record<string, unknown>): void {
  const descRaw = typeof fields.description === "string" ? fields.description : null;
  const pubRaw =
    typeof fields.publicDescription === "string" ? fields.publicDescription : null;

  if (descRaw === null && pubRaw === null) return;

  if (descRaw !== null && pubRaw !== null) {
    fields.description = formatJobDescriptionHtml(descRaw);
    fields.publicDescription = formatJobDescriptionHtml(pubRaw);
    return;
  }

  const source = descRaw ?? pubRaw ?? "";
  const html = formatJobDescriptionHtml(source);
  fields.description = html;
  fields.publicDescription = html;
}

/** Map free-text work-arrangement language to this instance's onSite picklist. */
export function normalizeJobOnSite(value: unknown): string | null {
  if (value == null) return null;
  const raw = Array.isArray(value)
    ? String(value[0] ?? "")
    : typeof value === "string"
      ? value
      : "";
  const t = raw.trim().toLowerCase().replace(/[_]+/g, " ");
  if (!t) return null;
  if (/\bhybrid\b/.test(t)) return "Hybrid";
  if (/\bremote\b|\bwfh\b|work from home|off-?site/.test(t)) return "Remote";
  if (/no preference|any|flexible/.test(t)) return "No Preference";
  if (/on-?site|in[- ]office|in[- ]person/.test(t)) return "On-Site";
  return raw.trim();
}

/** Copy company address scalars onto a job address composite (no invented country). */
export function companyAddressForJob(
  companyAddress: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  if (!companyAddress || typeof companyAddress !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const key of ["address1", "address2", "city", "state", "zip", "countryID"] as const) {
    const v = companyAddress[key];
    if (v !== undefined && v !== null && v !== "") out[key] = v;
  }
  const countryName = companyAddress.countryName;
  if (
    out.countryID == null &&
    typeof countryName === "string" &&
    countryName.trim()
  ) {
    out.countryName = countryName.trim();
  }
  if (Object.keys(out).length === 0) return null;
  // Need at least a country or a city to be useful — avoid blank US stubs.
  if (out.countryID == null && out.countryName == null && out.city == null) return null;
  return out;
}
