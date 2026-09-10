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

const CSS_NUMBER_RE = /^-?(\d+(\.\d+)?|\.\d+)(px|em|rem|%|pt|vw|vh|vmin|vmax|deg|rad|turn|s|ms|fr)?$/i;
const CSS_HEX_COLOR_RE = /^#[0-9a-f]{3,8}$/i;
const CSS_KEYWORD_RE = /^[a-zA-Z-]{1,40}$/;
const CSS_FONT_RE = /^[a-zA-Z0-9 ,.'"-]{1,120}$/;
const SAFE_FUNC_RE = /^(rgba?|hsla?|linear-gradient|radial-gradient|repeating-linear-gradient|repeating-radial-gradient|url|var|calc|rotate|scale|scale[xy]|translate|translate[xy]|skew[xy]?|blur|brightness|contrast|grayscale|hue-rotate|invert|opacity|saturate|sepia)$/i;

const CSS_NAMED_COLORS = new Set([
  "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure", "beige", "bisque", "black", "blanchedalmond",
  "blue", "blueviolet", "brown", "burlywood", "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
  "cornsilk", "crimson", "cyan", "darkblue", "darkcyan", "darkgoldenrod", "darkgray", "darkgreen", "darkgrey",
  "darkkhaki", "darkmagenta", "darkolivegreen", "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
  "darkslateblue", "darkslategray", "darkslategrey", "darkturquoise", "darkviolet", "deeppink", "deepskyblue",
  "dimgray", "dimgrey", "dodgerblue", "firebrick", "floralwhite", "forestgreen", "fuchsia", "gainsboro",
  "ghostwhite", "gold", "goldenrod", "gray", "green", "greenyellow", "grey", "honeydew", "hotpink", "indianred",
  "indigo", "ivory", "khaki", "lavender", "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
  "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightgrey", "lightpink", "lightsalmon",
  "lightseagreen", "lightskyblue", "lightslategray", "lightslategrey", "lightsteelblue", "lightyellow", "lime",
  "limegreen", "linen", "magenta", "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple",
  "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise", "mediumvioletred", "midnightblue",
  "mintcream", "mistyrose", "moccasin", "navajowhite", "navy", "oldlace", "olive", "olivedrab", "orange",
  "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise", "palevioletred", "papayawhip", "peachpuff",
  "peru", "pink", "plum", "powderblue", "purple", "rebeccapurple", "red", "rosybrown", "royalblue", "saddlebrown",
  "salmon", "sandybrown", "seagreen", "seashell", "sienna", "silver", "skyblue", "slateblue", "slategray",
  "slategrey", "snow", "springgreen", "steelblue", "tan", "teal", "thistle", "tomato", "transparent", "turquoise",
  "violet", "wheat", "white", "whitesmoke", "yellow", "yellowgreen",
]);

const CSS_PROP_ALLOWLIST = new Set([
  "align-content",
  "align-items",
  "align-self",
  "backdrop-filter",
  "background",
  "background-attachment",
  "background-clip",
  "background-color",
  "background-image",
  "background-origin",
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
  "border-collapse",
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
  "border-spacing",
  "border-style",
  "border-top",
  "border-top-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-top-style",
  "border-top-width",
  "border-width",
  "bottom",
  "box-shadow",
  "box-sizing",
  "clip-path",
  "color",
  "column-gap",
  "cursor",
  "display",
  "filter",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-flow",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "float",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "gap",
  "grid",
  "grid-area",
  "grid-auto-columns",
  "grid-auto-flow",
  "grid-auto-rows",
  "grid-column",
  "grid-column-end",
  "grid-column-gap",
  "grid-column-start",
  "grid-gap",
  "grid-row",
  "grid-row-end",
  "grid-row-gap",
  "grid-row-start",
  "grid-template",
  "grid-template-areas",
  "grid-template-columns",
  "grid-template-rows",
  "height",
  "justify-content",
  "justify-items",
  "justify-self",
  "left",
  "letter-spacing",
  "line-height",
  "list-style",
  "list-style-image",
  "list-style-position",
  "list-style-type",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-height",
  "max-width",
  "min-height",
  "min-width",
  "object-fit",
  "object-position",
  "opacity",
  "outline",
  "overflow",
  "overflow-wrap",
  "overflow-x",
  "overflow-y",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "pointer-events",
  "position",
  "right",
  "row-gap",
  "table-layout",
  "text-align",
  "text-decoration",
  "text-overflow",
  "text-shadow",
  "text-transform",
  "top",
  "transform",
  "transform-origin",
  "transition",
  "user-select",
  "vertical-align",
  "white-space",
  "width",
  "word-break",
  "word-spacing",
  "word-wrap",
  "z-index",
]);

const CSS_VALUE_SAFE_KEYWORDS = new Set([
  ...CSS_NAMED_COLORS,
  "all", "auto", "none", "hidden", "scroll", "visible", "solid", "dashed", "dotted", "double", "groove", "ridge", "inset", "outset",
  "inherit", "initial", "unset", "left", "right", "center", "justify", "start", "end",
  "top", "bottom", "block", "inline", "inline-block", "flex", "inline-flex", "grid", "inline-grid", "nowrap", "bold", "bolder", "lighter",
  "italic", "oblique", "normal", "underline", "overline", "line-through", "uppercase",
  "lowercase", "capitalize", "absolute", "relative", "static", "sticky", "fixed", "no-repeat",
  "repeat", "repeat-x", "repeat-y", "round", "space", "cover", "contain", "fill", "scale-down", "serif", "sans-serif",
  "monospace", "cursive", "fantasy", "system-ui", "border-box", "content-box", "padding-box",
  "small", "medium", "large", "smaller", "larger", "x-small", "xx-small", "x-large", "xx-large",
  "pointer", "default", "crosshair", "move", "text", "wait", "help", "not-allowed", "zoom-in", "zoom-out", "grab", "grabbing",
  "to", "from", "at", "circle", "ellipse", "closest-side", "closest-corner", "farthest-side", "farthest-corner",
  "row", "row-reverse", "column", "column-reverse", "wrap", "wrap-reverse", "space-between", "space-around", "space-evenly", "stretch", "baseline",
  "collapse", "separate", "break-word", "break-all", "keep-all", "pre", "pre-wrap", "pre-line", "ellipsis", "clip",
  "ease", "ease-in", "ease-out", "ease-in-out", "linear", "step-start", "step-end",
]);

function validateFunctionCall(funcName: string, inside: string): string | null {
  const fn = funcName.toLowerCase();
  if (!SAFE_FUNC_RE.test(fn)) return null;

  if (fn === "url") {
    const m = inside.trim().match(/^(['"]?)(https?:\/\/[^\s'")]+)\1$/i);
    return m ? `url("${m[2]}")` : null;
  }

  if (fn === "var") {
    const m = inside.trim().match(/^--[a-zA-Z0-9_-]+$/);
    return m ? `var(${m[0]})` : null;
  }

  if (fn === "rgb" || fn === "rgba" || fn === "hsl" || fn === "hsla") {
    const parts = inside.split(/[,/\s]+/).filter(Boolean);
    for (const p of parts) {
      if (p === "__SAFE__") continue;
      if (!CSS_NUMBER_RE.test(p) && !CSS_HEX_COLOR_RE.test(p) && !CSS_VALUE_SAFE_KEYWORDS.has(p.toLowerCase())) {
        return null;
      }
    }
    return `${fn}(${inside.trim()})`;
  }

  if (fn.includes("gradient")) {
    const stops = inside.split(",").map((s) => s.trim()).filter(Boolean);
    if (stops.length === 0) return null;
    for (const stop of stops) {
      const tokens = stop.split(/\s+/).filter(Boolean);
      for (const t of tokens) {
        if (t === "__SAFE__") continue;
        if (CSS_NUMBER_RE.test(t)) continue;
        if (CSS_HEX_COLOR_RE.test(t)) continue;
        if (CSS_VALUE_SAFE_KEYWORDS.has(t.toLowerCase())) continue;
        return null;
      }
    }
    return `${fn}(${inside.trim()})`;
  }

  const parts = inside.split(/[,/\s+*-]+/).filter(Boolean);
  for (const p of parts) {
    if (p === "__SAFE__") continue;
    if (!CSS_NUMBER_RE.test(p) && !CSS_HEX_COLOR_RE.test(p) && !CSS_VALUE_SAFE_KEYWORDS.has(p.toLowerCase())) {
      return null;
    }
  }
  return `${fn}(${inside.trim()})`;
}

// ponytail: safe allowlist + regex token parser; replace with full CSS AST parser if complex modern syntax (calc/grid-template) needed.
function validateCssValue(prop: string, rawValue: string): string | null {
  let value = rawValue.replace(/\s+/g, " ").trim();
  if (value.length === 0 || value.length > 512) return null;
  if (/[<>{};@\\]/.test(value)) return null;
  if (/expression\s*\(|-moz-binding|behavior\s*:/i.test(value)) return null;

  const isImportant = /\s*!\s*important\s*$/i.test(value);
  if (isImportant) {
    value = value.replace(/\s*!\s*important\s*$/i, "").trim();
  }

  if (prop === "font-family") {
    if (!CSS_FONT_RE.test(value)) return null;
    return isImportant ? `${value} !important` : value;
  }

  let processed = value;
  for (let i = 0; i < 8; i++) {
    const fnMatch = /([a-zA-Z-]+)\(([^()]*)\)/.exec(processed);
    if (!fnMatch) break;
    const [full, fnName, fnArgs] = fnMatch;
    const validated = validateFunctionCall(fnName, fnArgs);
    if (validated === null) return null;
    processed = processed.replace(full, "__SAFE__");
  }
  if (/[()"'`]/.test(processed)) return null;

  const tokens = processed.split(/[\s,]+/).filter(Boolean);
  for (const token of tokens) {
    if (token === "__SAFE__") continue;
    const t = token.replace(/,$/, "");
    if (CSS_KEYWORD_RE.test(t) && CSS_VALUE_SAFE_KEYWORDS.has(t.toLowerCase())) continue;
    if (CSS_NUMBER_RE.test(t)) continue;
    if (CSS_HEX_COLOR_RE.test(t)) continue;
    return null;
  }
  return isImportant ? `${value} !important` : value;
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
    const selector = m[1].replace(/\s+/g, " ").trim();
    const body = m[2];
    // Selector sanity: no backslashes, angle brackets or at-rules.
    if (selector === "" || /[@<\\]/.test(selector) || selector.length > 200) continue;
    // Keep only allowlisted, token-validated declarations, re-serialized.
    const decls: string[] = [];
    for (const statement of body.split(";")) {
      const colon = statement.indexOf(":");
      if (colon <= 0) continue;
      const prop = statement.slice(0, colon).trim().toLowerCase();
      const value = statement.slice(colon + 1).trim();
      if (!CSS_PROP_ALLOWLIST.has(prop)) continue;
      if (/[{}@<\\]/.test(prop) || /[{}@<\\]/.test(value)) continue;
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