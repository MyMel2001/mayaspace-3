/**
 * Automatic link embeds: scans post HTML for URLs and, where a provider has
 * a safe iframe pattern (YouTube, Vimeo, SoundCloud, Bandcamp, Dailymotion),
 * produces a server-generated embed block. All embed HTML is built entirely
 * from allowlisted constants — no remote markup is ever echoed back.
 */
import { appLog } from "../logger.js";
import type { EmbedView } from "../types.js";

const log = appLog("embeds");

function esc(raw: string): string {
  return raw.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

const ENTITIES: Record<string, string> = {
  "\u0026": "\u0026amp;",
  "\u003C": "\u0026lt;",
  "\u003E": "\u0026gt;",
  "\u0022": "\u0026quot;",
  "\u0027": "\u0026#39;",
};

interface EmbedRule {
  provider: string;
  re: RegExp;
  build: (m: RegExpMatchArray) => string | null;
}

const RULES: EmbedRule[] = [
  // youtu.be/<id> — also handles ?t= start time
  {
    provider: "YouTube",
    re: /https?:\/\/(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{6,20})(?:\?|&#0?39;|&|$)/i,
    build: (m) => {
      const t = extractStart("https://youtu.be/" + m[1], m.input ?? "");
      return (
        `<div class="embed embed-youtube"><iframe loading="lazy" ` +
        `src="https://www.youtube-nocookie.com/embed/${esc(m[1])}?rel=0${t}" ` +
        `title="YouTube video" allow="encrypted-media" ` +
        `allowfullscreen></iframe></div>`
      );
    },
  },
  // youtube.com/watch?v=<id>
  {
    provider: "YouTube",
    re: /https?:\/\/(?:www\.|m\.)?youtube\.com\/watch\?(?:[^" ]*&)?v=([A-Za-z0-9_-]{6,20})/i,
    build: (m) => {
      const t = extractStart(m.input ?? "", m.input ?? "");
      return (
        `<div class="embed embed-youtube"><iframe loading="lazy" ` +
        `src="https://www.youtube-nocookie.com/embed/${esc(m[1])}?rel=0${t}" ` +
        `title="YouTube video" allow="encrypted-media" ` +
        `allowfullscreen></iframe></div>`
      );
    },
  },
  // youtube.com/shorts/<id>
  {
    provider: "YouTube",
    re: /https?:\/\/(?:www\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{6,20})/i,
    build: (m) =>
      `<div class="embed embed-youtube"><iframe loading="lazy" ` +
      `src="https://www.youtube-nocookie.com/embed/${esc(m[1])}?rel=0" ` +
      `title="YouTube video" allow="encrypted-media" ` +
      `allowfullscreen></iframe></div>`,
  },
  {
    provider: "Vimeo",
    re: /https?:\/\/(?:www\.)?vimeo\.com\/(\d{4,12})/i,
    build: (m) =>
      `<div class="embed embed-vimeo"><iframe loading="lazy" ` +
      `src="https://player.vimeo.com/video/${esc(m[1])}" title="Vimeo video" ` +
      `allowfullscreen></iframe></div>`,
  },
  {
    provider: "SoundCloud",
    re: /https?:\/\/(?:www\.|m\.)?soundcloud\.com\/([A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)/i,
    build: (m) => {
      const path = esc(m[1]);
      // SoundCloud requires the full URL as the widget query param.
      const src = `https://w.soundcloud.com/player/?url=${encodeURIComponent(
        "https://soundcloud.com/" + m[1],
      )}&visual=true`;
      return (
        `<div class="embed embed-soundcloud"><iframe loading="lazy" ` +
        `src="${esc(src)}" title="SoundCloud audio (${esc(path)})" ` +
        `allow="autoplay"></iframe></div>`
      );
    },
  },
  {
    provider: "Bandcamp",
    re: /https?:\/\/([A-Za-z0-9-]+)\.bandcamp\.com\/track\/([A-Za-z0-9-]+)/i,
    build: (m) =>
      `<div class="embed embed-bandcamp"><iframe loading="lazy" ` +
      `src="https://bandcamp.com/EmbeddedPlayer/size=large/` +
      `tracklist=false/artwork=small/` +
      `url=${encodeURIComponent("https://" + m[1] + ".bandcamp.com/track/" + m[2])}" ` +
      `title="Bandcamp track" allowfullscreen></iframe></div>`,
  },
  {
    provider: "Dailymotion",
    re: /https?:\/\/(?:www\.)?dailymotion\.com\/video\/([A-Za-z0-9]+)/i,
    build: (m) =>
      `<div class="embed embed-dailymotion"><iframe loading="lazy" ` +
      `src="https://www.dailymotion.com/embed/video/${esc(m[1])}" ` +
      `title="Dailymotion video" allowfullscreen></iframe></div>`,
  },
];

function extractStart(_url: string, raw: string): string {
  const m = raw.match(/[?&](?:t|start)=(\d+)/);
  return m ? `&start=${encodeURIComponent(m[1])}` : "";
}

/**
 * Finds embeddable links in post HTML (only inside <a href> and plain text —
 * sanitized HTML guarantees no stray attributes) and returns embed blocks.
 * At most one embed per provider per post, 5 embeds max.
 */
export function findEmbeds(postHtml: string): EmbedView[] {
  const out: EmbedView[] = [];
  const seen = new Set<string>();
  try {
    for (const rule of RULES) {
      const m = postHtml.match(rule.re);
      if (!m) continue;
      if (seen.has(rule.provider)) continue;
      const html = rule.build(m);
      if (!html) continue;
      seen.add(rule.provider);
      out.push({ provider: rule.provider, html });
      if (out.length >= 5) break;
    }
  } catch (err) {
    log.warn`Embed extraction failed: ${err}`;
  }
  return out;
}