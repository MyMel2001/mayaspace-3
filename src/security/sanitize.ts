/**
 * Output/input hardening.
 *
 * Every string a user can enter passes through sanitize*() before storage or
 * render. Posts/comments keep a small rich-text subset (like MySpace's old
 * editor); profile "About me" keeps the same subset. Custom profile CSS is
 * parsed with a strict grammar and rebuilt token-by-token so stylesheets can
 * never escape their box or carry payloads — the "Samy is my hero" defense.
 */
import sanitizeHtml from "sanitize-html";

const TEXT_TAGS = ["b", "strong", "i", "em", "u", "s", "br", "p", "span", "blockquote"];

const TEXT_ALLOWED_TAGS = [...TEXT_TAGS];
const POST_ALLOWED_TAGS = [...TEXT_TAGS, "a", "img"];
const POST_ALLOWED_ATTR = ["href", "src", "alt", "title"];

const URI_ALLOWLIST = ["http", "https", "mailto", "mailto"];

export function sanitizeTextHtml(raw: string): string {
  return sanitizeHtml(raw, {
    allowedTags: TEXT_ALLOWED_TAGS,
    allowedAttributes: {},
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      span: "span",
    },
    disallowedTagsMode: "discard",
    allowProtocolRelative: false,
  });
}

/**
 * Post/comment HTML: keeps line breaks, links and inline images only.
 * Link/image URLs are scheme-restricted; `javascript:`, `data:` etc. are
 * stripped by sanitize-html's allowedSchemes. Relative-protocol URLs are
 * dropped via allowProtocolRelative: false.
 */
export function sanitizePostHtml(raw: string): string {
  return sanitizeHtml(raw, {
    allowedTags: POST_ALLOWED_TAGS,
    allowedAttributes: {
      a: ["href", "title", "rel"],
      img: ["src", "alt", "title", "width", "height"],
    },
    allowedSchemes: URI_ALLOWLIST.filter((v, i, a) => a.indexOf(v) === i) as string[],
    allowProtocolRelative: false,
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "nofollow noopener noreferrer" }),
    },
    exclusiveFilter: (frame) => {
      if (frame.tag === "img") {
        const src = frame.attribs.src ?? "";
        if (!/^https?:\/\//i.test(src)) return true; // block relative + data:
      }
      return false;
    },
  });
}

/** Plain text: escape everything, strip nothing — used for names, titles, etc. */
export function sanitizePlain(raw: string): string {
  return sanitizeHtml(raw, { allowedTags: [], allowedAttributes: {} }).trim();
}

// ── Profile CSS sanitizer ────────────────────────────────────────────────────

const SAFE_CSS_LENGTH = 10_000;

const SAFE_URL_RE = /^https?:\/\//i;
const CSS_COLOR_RE =
  /^#[0-9a-f]{3,8}$|^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)$|^hsla?\(\s*\d{1,3}\s*,\s*\d{1,3}%\s*,\s*\d{1,3}%\s*(,\s*(0|1|0?\.\d+)\s*)?\)$/i;
const CSS_NUMBER_RE = /^-?\d+(\.\d+)?(px|em|rem|%|pt|vw|vh|vmin|vmax|deg|s|ms|fr|)?$/i;
const CSS_KEYWORD_RE = /^[a-zA-Z-]{1,40}$/;
const CSS_FONT_RE = /^[a-zA-Z0-9 ,.'"-]{1,120}$/;

const CSS_PROP_ALLOWLIST = new Set([
  "background",
  "background-color",
  "background-image",
  "background-position",
  "background-repeat",
  "background-size",
  "border",
  "border-bottom",
  "border-bottom-color",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-bottom-style",
  "border-bottom-width",
  "border-color",
  "border-left",
  "border-left-color",
  "border-left-style",
  "border-left-width",
  "border-radius",
  "border-right",
  "border-right-color",
  "border-right-style",
  "border-right-width",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "box-shadow",
  "color",
  "display",
  "float",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "opacity",
  "outline",
  "overflow",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration",
  "text-shadow",
  "text-transform",
  "width",
]);

const CSS_VALUE_SAFE_KEYWORDS = new Set([
  "auto", "none", "hidden", "scroll", "visible", "solid", "dashed", "dotted", "double",
  "inherit", "initial", "unset", "transparent", "left", "right", "center", "justify",
  "top", "bottom", "block", "inline", "inline-block", "flex", "nowrap", "bold",
  "italic", "normal", "underline", "overline", "line-through", "uppercase",
  "lowercase", "capitalize", "absolute", "relative", "static", "no-repeat",
  "repeat", "repeat-x", "repeat-y", "cover", "contain", "serif", "sans-serif",
  "monospace", "cursive", "fantasy",
]);

/** Validates one CSS value token-by-token; returns null if anything is unsafe. */
function validateCssValue(prop: string, rawValue: string): string | null {
  const value = rawValue.trim();
  if (value.length === 0 || value.length > 512) return null;
  if (/[[\]{}();@\\<>"'*%]/.test(value)) return null; // structural chars: no url(), @rules, strings, comments, etc.
  if (prop === "background-image") {
    // only plain url(https://...) or linear-gradient with safe parts
    const urlMatch = value.match(/^url\(\s*(["']?)(https?:\/\/[^)"']+)\1\s*\)$/i);
    if (urlMatch) return `url("${urlMatch[2]}")`;
    const gradMatch = value.match(/^(linear|radial)-gradient\((.+)\)$/i);
    if (gradMatch) {
      const inner = gradMatch[2]
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length < 64 && !/[{};()<>@\\"]/.test(t));
      if (inner.length > 0) return `${gradMatch[1].toLowerCase()}-gradient(${inner.join(", ")})`;
    }
    return null;
  }
  if (prop === "font-family") {
    if (!CSS_FONT_RE.test(value)) return null;
    return value;
  }
  // Split on whitespace and commas; every token must be number+unit, keyword, or color.
  const tokens = value.split(/[\s,]+/).filter((t) => t !== "");
  for (const token of tokens) {
    const t = token.replace(/,$/, "");
    if (CSS_KEYWORD_RE.test(t) && CSS_VALUE_SAFE_KEYWORDS.has(t.toLowerCase())) continue;
    if (CSS_NUMBER_RE.test(t)) continue;
    if (CSS_COLOR_RE.test(t)) continue;
    // e.g. "rgb(255, 0, 0)" arrives as "rgb(255," etc. — validate the paren group as a whole
    if (/^(rgb|rgba|hsl|hsla)\(/i.test(value)) {
      if (CSS_COLOR_RE.test(value.replace(/\s+/g, " "))) break;
    }
    return null;
  }
  if (prop === "background" || prop === "background-image") {
    if (SAFE_URL_RE.test(value) === false && value.includes("url(") === true) return null;
  }
  return value;
}

/**
 * Sanitizes user-supplied profile CSS. Only allowlisted properties with
 * token-validated values survive; every declaration is re-serialized, so
 * anything that could break out of a <style> context (braces, at-rules,
 * url(javascript:…), expressions, comments, @import, HTML) is dropped.
 * Returns the sanitized stylesheet text (possibly "").
 */
export function sanitizeProfileCss(raw: string): string {
  if (typeof raw !== "string" || raw.length > 20_000) return "";
  // Strip CSS comments first (they may contain braces/at-rules as text).
  const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, " ");
  const out: string[] = [];
  // Walk rule-by-rule: selector { declarations }
  const ruleRe = /([^{}]*)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(stripped)) !== null) {
    const selector = m[1].trim();
    const body = m[2];
    // Selector sanity: no backslashes, angle brackets or at-rules.
    if (selector === "" || /[@<>\\]/.test(selector) || selector.length > 200) continue;
    // Keep only allowlisted, token-validated declarations, re-serialized.
    const decls: string[] = [];
    for (const statement of body.split(";")) {
      const colon = statement.indexOf(":");
      if (colon <= 0) continue;
      const prop = statement.slice(0, colon).trim().toLowerCase();
      const value = statement.slice(colon + 1).trim();
      if (!CSS_PROP_ALLOWLIST.has(prop)) continue;
      if (/[{}@<>\\]/.test(prop) || /[{}@<>\\]/.test(value)) continue;
      const safe = validateCssValue(prop, value);
      if (safe === null) continue;
      decls.push(`${prop}: ${safe}`);
    }
    if (decls.length > 0) out.push(`${selector} {\n  ${decls.join(";\n  ")};\n}`);
  }
  return out.join("\n\n");
}

/**
 * Theme color: strict 6-digit hex or "".
 */
export function sanitizeHexColor(raw: string): string {
  const v = (raw ?? "").trim();
  return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : "";
}