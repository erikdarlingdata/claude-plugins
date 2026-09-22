/**
 * clickable-links — make URLs in agent output genuinely clickable (OSC 8).
 *
 * What pi already does:
 *   - Its markdown renderer styles link text (`mdLink`) and the URL
 *     (`mdLinkUrl`) separately, so `[label](url)` puts the raw URL on screen.
 *     Modern terminals (Ghostty, iTerm2, WezTerm, kitty) auto-detect bare URLs,
 *     so those are already Cmd+clickable without any extension.
 *   - It emits real OSC 8 hyperlinks in the login dialog, exports
 *     `hyperlink(text, url)` from @earendil-works/pi-tui, and its line
 *     compositor is OSC-8 aware (it tracks open links across overlays).
 *
 * The gap: assistant markdown never gets OSC 8, so the *label* of a link is not
 * clickable — only the visible URL is, and only via terminal auto-detection.
 * This extension closes that with a display-only markdown transformer, so
 * `[the PR](https://…)` becomes clickable on the words "the PR".
 *
 * Display-only by construction: registerMarkdownTransformer never alters the
 * stored message or what the model sees, so no escape codes enter context.
 *
 * Safety rails:
 *   - No-ops when the terminal can't do OSC 8 (getCapabilities().hyperlinks),
 *     so dumb terminals/pipes never get escape soup. `PI_HYPERLINKS=1` forces
 *     detection on (needed for tmux passthrough); config can force it too.
 *   - Skips fenced code blocks and inline code, so anything you might copy
 *     stays byte-exact.
 *   - Skips streaming updates: a partial link would be mangled mid-flight.
 *     Links become clickable when the message finalizes.
 *
 * `/linktest` renders known-good OSC 8 through the entry-renderer path (the
 * same path the login dialog uses) so you can tell "my terminal can't do OSC 8"
 * apart from "the markdown path didn't apply it".
 *
 * Config (optional): ~/.pi/agent/clickable-links.json
 *   {
 *     "enabled": true,
 *     "force": false,            // emit OSC 8 even if capability detection says no
 *     "linkBareUrls": true,      // wrap bare https://… too (not just [label](url))
 *     "includeThinking": false,  // also linkify thinking blocks
 *     "skipCode": true           // leave fenced/inline code untouched
 *   }
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const TEST_ENTRY = "clickable-links-test";
const OSC8_MARKER = "\x1b]8;;";

interface Config {
  enabled: boolean;
  force: boolean;
  linkBareUrls: boolean;
  includeThinking: boolean;
  skipCode: boolean;
}

function loadConfig(): Config {
  const defaults: Config = {
    enabled: true,
    force: false,
    linkBareUrls: true,
    includeThinking: false,
    skipCode: true,
  };
  try {
    const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const raw = JSON.parse(readFileSync(join(dir, "clickable-links.json"), "utf8"));
    return {
      enabled: raw.enabled !== false,
      force: raw.force === true,
      linkBareUrls: raw.linkBareUrls !== false,
      includeThinking: raw.includeThinking === true,
      skipCode: raw.skipCode !== false,
    };
  } catch {
    return defaults;
  }
}

/** Trailing characters that are almost always sentence punctuation, not URL. */
function splitTrailingPunctuation(url: string): [string, string] {
  const m = /[.,;:!?)\]}'"]+$/.exec(url);
  if (!m) return [url, ""];
  // Keep a balanced closing paren that belongs to the URL (wiki-style links).
  let cut = m.index;
  const trailer = url.slice(cut);
  if (trailer.startsWith(")")) {
    const opens = (url.slice(0, cut).match(/\(/g) ?? []).length;
    const closes = (url.slice(0, cut).match(/\)/g) ?? []).length;
    if (opens > closes) cut += 1;
  }
  return [url.slice(0, cut), url.slice(cut)];
}

/**
 * One pass over a plain-text segment, handling (in precedence order):
 *   [label](url) -> label is clickable
 *   <url>        -> url is clickable
 *   bare url     -> url is clickable
 */
function linkifySegment(text: string, linkBareUrls: boolean): string {
  const pattern = linkBareUrls
    ? /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>|(https?:\/\/[^\s<>"'`]+)/g
    : /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)|<(https?:\/\/[^\s>]+)>/g;
  return text.replace(pattern, (match, label, mdUrl, angleUrl, bareUrl) => {
    if (typeof mdUrl === "string") {
      // Keep the markdown shape so pi still styles and shows the URL; only
      // the label becomes clickable.
      return `[${hyperlink(String(label), mdUrl)}](${mdUrl})`;
    }
    if (typeof angleUrl === "string") return `<${hyperlink(angleUrl, angleUrl)}>`;
    if (typeof bareUrl === "string") {
      const [url, trailer] = splitTrailingPunctuation(bareUrl);
      if (!url) return match;
      return hyperlink(url, url) + trailer;
    }
    return match;
  });
}

/** Apply `fn` only outside fenced code blocks and inline code spans. */
function outsideCode(markdown: string, fn: (segment: string) => string): string {
  // Fences first: ``` or ~~~ blocks, kept verbatim.
  const fenceSplit = markdown.split(/(^```[\s\S]*?^```|^~~~[\s\S]*?^~~~)/m);
  return fenceSplit
    .map((chunk, i) => {
      if (i % 2 === 1) return chunk; // a fenced block
      // Then inline code spans within prose.
      return chunk
        .split(/(`+[^`\n]*`+)/)
        .map((piece, j) => (j % 2 === 1 ? piece : fn(piece)))
        .join("");
    })
    .join("");
}

export default function (pi: ExtensionAPI) {
  let cfg = loadConfig();

  const hyperlinksUsable = (): boolean => {
    if (cfg.force) return true;
    try {
      return getCapabilities().hyperlinks === true;
    } catch {
      return false;
    }
  };

  pi.on("session_start", async () => {
    cfg = loadConfig();
  });

  pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
    if (!cfg.enabled) return markdown;
    // A partial link cut mid-token would be rewritten wrong; wait for the
    // finalized message (this hook runs again on finalize and on restore).
    if (isStreaming) return markdown;
    if (messageType === "assistant-thinking" && !cfg.includeThinking) return markdown;
    if (markdown.includes(OSC8_MARKER)) return markdown; // already linked
    if (!markdown.includes("http")) return markdown; // cheap bail
    if (!hyperlinksUsable()) return markdown;
    const linkify = (segment: string) => linkifySegment(segment, cfg.linkBareUrls);
    return cfg.skipCode ? outsideCode(markdown, linkify) : linkify(markdown);
  });

  // ---- Self-test surface -------------------------------------------------
  // Renders raw OSC 8 through the entry-renderer path, which is exactly how
  // pi's own login dialog emits clickable URLs. If these are clickable but
  // links in replies are not, the markdown path is the problem; if neither is,
  // the terminal (or tmux passthrough) is.
  pi.registerEntryRenderer(TEST_ENTRY, (_entry, _opts, theme) => {
    const url = "https://github.com/erikdarlingdata/claude-plugins";
    const caps = (() => {
      try {
        return String(getCapabilities().hyperlinks);
      } catch {
        return "unknown";
      }
    })();
    const modifier = process.platform === "darwin" ? "Cmd+click" : "Ctrl+click";
    const lines = [
      theme.fg("accent", "clickable-links self-test"),
      theme.fg("dim", `  capability: hyperlinks=${caps} · PI_HYPERLINKS=${process.env.PI_HYPERLINKS ?? "(unset)"}`),
      `  1. OSC 8 on text:  ${theme.fg("mdLink", hyperlink("click these words", url))}`,
      `  2. OSC 8 on URL:   ${theme.fg("mdLink", hyperlink(url, url))}`,
      `  3. Bare URL (terminal auto-detect): ${theme.fg("mdLinkUrl", url)}`,
      theme.fg("dim", `  ${modifier} each one. 1+2 clickable = OSC 8 works. Only 3 = terminal auto-detect only.`),
    ];
    return new Text(lines.join("\n"), 0, 0);
  });

  pi.registerCommand("linktest", {
    description: "Render OSC 8 hyperlink samples to check what your terminal supports",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;
      pi.appendEntry(TEST_ENTRY, { at: Date.now() });
    },
  });
}
