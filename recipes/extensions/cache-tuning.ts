/**
 * Prompt-cache tuning. Fixes 1 and 2 were measured on a week of session files
 * (2026-09-30 to 2026-10-07); each later fix gives its own numbers:
 *
 * 1. Long cache retention by default. pi reads PI_CACHE_RETENTION from
 *    process.env on every request; "long" makes OpenRouter anthropic/* and
 *    direct Anthropic requests use a 1-hour cache instead of 5 minutes. Seats
 *    woken after 5-60 idle minutes were rewriting their whole context (~$2,450
 *    a week). Set here so /reload applies it without restarting pi, and so
 *    in-process subagents and child processes inherit it. An explicit value in
 *    the environment wins. Seats only: pi-subagents runs agents in-process,
 *    where the env is shared, so the first instance in a process is the seat
 *    and later instances (agents) strip the 1-hour TTL from their own requests
 *    in before_provider_request. Agents rarely idle past 5 minutes, so a
 *    1-hour write (2x input instead of 1.25x) would cost them more than it
 *    saves (~$200 vs ~$26 a week). Checked 2026-10-07 on openrouter/anthropic/claude-opus-5.5:
 *    the response reports cacheWrite1h and pi prices those writes at 2x input
 *    ($8/M instead of $5/M), so footer and ledger stay correct.
 *
 * 2. Stop two extension prompt sections from flapping. pi-background-tasks
 *    (`pi_background_shell_policy`) and pi-agent-browser-native
 *    (`agent_browser`) add their section in before_agent_start. pi fires that
 *    only for typed prompts: a run started by sendMessage(triggerTurn) (task,
 *    subagent and intercom notifications) builds the prompt from the base
 *    options, so pi records a system update removing the section, and the next
 *    typed prompt adds it back. With system messages collapsed into one head
 *    (OpenRouter Anthropic), each flip changes the head and the whole message
 *    history is written to cache again (~$860 a week). This drops the removal
 *    from the request only (the transcript is untouched), so the head keeps
 *    the section and stays byte-identical. Remove once pi fixes the cause.
 *
 * 3. Debug log for unexplained cache misses (added 2026-10-09). On every
 *    provider request it hashes the final payload block by block (top-level
 *    params, each tool, each system block, each message header and content
 *    block, with cache_control removed) and compares with the previous request
 *    of the same session. It logs where the first difference is, and logs each
 *    reply's cache usage, to ~/.pi/agent/cache-debug/<UTC day>.jsonl. It never
 *    changes a request. If a full rewrite follows a request whose prefix did
 *    not change, the miss was on the provider side. Report:
 *    ~/.pi/agent/bin/cache-debug-report.py. Set PI_CACHE_DEBUG=0 to turn it off.
 *    It also logs compaction start, success and failure (with pi's error text).
 *
 * 5. Notification runs send the system prompt of the last typed run (added
 *    2026-10-10, reworked 2026-10-11). The same pi bug as fix 2, in its
 *    forced-prompt shape. An extension that RETURNS systemPrompt from
 *    before_agent_start (pi-memory appends its "## Memory" block this way)
 *    makes pi send that text, as a forced prompt, for the whole typed run; the
 *    sections other extensions add after it are not in it. A run started by
 *    sendMessage(triggerTurn) has no forced prompt and sends the transcript's
 *    version instead (with those sections, without the memory block). Seats
 *    swapped between the two (83,750 vs ~60,000 chars) and rewrote the whole
 *    history each time: 12 rewrites, ~4.1M tokens, in 18.7 h. So: on a run that
 *    fired before_agent_start, remember the system text it sends. On a run that
 *    did not, send the remembered text instead (request only; logged as
 *    "system-prompt-reused"). The first version (restore a missing tail) never
 *    matched, because neither prompt is a prefix of the other.
 *
 * 4. Keep-warm for idle seats (added 2026-10-09). pi's own idle warming stops
 *    30 minutes after the last request (a constant in core/cache-warmer.js), so
 *    with the 1-hour cache it never fires. Seats that idle for hours paid a full
 *    rewrite on every wake (~$358 a week, Oct 7-9). After a seat settles, this
 *    re-sends its last request with a one-token output cap every 54 minutes, the
 *    way pi's warmer does, so the cache is read (and its hour restarts) instead
 *    of expiring. Seats only; it stops at the next real request, after
 *    compaction, after PI_CACHE_KEEPWARM_HOURS (default 24; a ping costs 1/40 of
 *    a rewrite), when a timer fires too late (laptop sleep), on any error, and
 *    when a ping finds the cache gone. Each ping goes to the cache-debug log and
 *    to the subagent ledger as a seat line with thinking "(cache warm)".
 *    PI_CACHE_KEEPWARM=0 turns it off.
 *
 * 6. Hold the seat's pi-memory block (added 2026-10-15). pi-memory rebuilds its
 *    "## Memory" block in the system prompt after a long-term memory write and
 *    at the start of a compaction. Each rebuild changed the start of the prompt,
 *    so the seat's whole conversation was written to cache again: 12 rewrites,
 *    4.4M tokens, ~$16 a day (Oct 13-15). The seat already has the entry it
 *    wrote in its conversation. So when the only change is inside the memory
 *    block and its reason is long_term_write, or a compaction is running, this
 *    sends the previous system text (request only; logged as
 *    "memory-block-held"). It accepts the new block on the first request after
 *    a load or a compaction.
 *    Day rollover (added 2026-10-17): pi-memory also rebuilds the block at
 *    local midnight, which still rewrote every seat once a day (0.66M-1.15M
 *    tokens a day, about $5-9, Oct 16-17). Now that refresh is held too, and
 *    the first run of the new day gets a short message appended after the
 *    history that gives the new date and says the memory block is from the
 *    day before. An append keeps the cached prefix. The block itself refreshes
 *    at the next compaction. PI_CACHE_HOLD_ROLLOVER=0 accepts the new block
 *    instead (the old behavior).
 *    Seats only. PI_CACHE_MEMORY_HOLD=0 turns it off. Test (pi -ne, test memory
 *    dir): with the hold, the prompt after a write wrote 13 tokens; without it,
 *    20,929. Rollover test (clock moved to 00:01): with the hold, 139 tokens;
 *    without it, 13,105.
 *
 * 7. Keep-warm during long tool calls (added 2026-10-17). Subagents use the
 *    5-minute cache, and a lane that waits on a long build or test run lost it:
 *    50 waits over 5 minutes in one day rewrote 5.64M tokens (~$14). While a
 *    tool call runs, the subagent re-sends its last request with a one-token
 *    cap every 4.5 minutes, for up to 60 minutes. A longer wait costs more in
 *    pings than one rewrite. The ping swaps max_completion_tokens for
 *    max_tokens: 1 (see capOutput). Each ping's cost goes into the subagent
 *    ledger under the lane's agent id (source "toolwarm"). Test (sleep 300):
 *    with the pings, the next request wrote 89 tokens; without, 12,844.
 *    PI_CACHE_TOOLWARM=0 turns it off.
 *
 * The seat's last real request is also published at
 * globalThis[Symbol.for("cache-tuning:last-seat-request")] for self-compact.ts.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEDGER_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "subagent-ledger");
const KEEPWARM_INTERVAL_MS = Number(process.env.PI_CACHE_KEEPWARM_INTERVAL_MS) || 54 * 60_000;
/** A ping later than this after the last cache use is likely a full rewrite, so it is skipped. */
const KEEPWARM_LATE_MS = 58 * 60_000;
const KEEPWARM_MAX_MS = (Number(process.env.PI_CACHE_KEEPWARM_HOURS) || 24) * 3_600_000;
const TOOLWARM_INTERVAL_MS = Number(process.env.PI_CACHE_TOOLWARM_INTERVAL_MS) || 270_000; // 4.5 min, inside the 5-minute cache
const TOOLWARM_MAX_MS = 60 * 60_000; // past an hour of tool time, let it go
const DEBUG_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "cache-debug");
const SNIPPET = 240;

type Block = { path: string; hash: string; chars: number; snippet: string; json?: string };

// A ping needs one output token. Subagent payloads carry max_completion_tokens, and
// OpenRouter ignores a cap of 1 in that field (tested 2026-10-17: 79 to 794 output
// tokens). It honors max_tokens: 1, so swap the field. Thinking and tool_choice stay
// as sent, so the cached prefix still matches.
function capOutput(p: any): any {
	const q = structuredClone(p);
	delete q.max_completion_tokens;
	q.max_tokens = 1;
	return q;
}

function withoutCacheControl(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(withoutCacheControl);
	if (v && typeof v === "object") {
		const o: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) if (k !== "cache_control") o[k] = withoutCacheControl(x);
		return o;
	}
	return v;
}

function block(path: string, v: unknown): Block {
	const json = JSON.stringify(withoutCacheControl(v)) ?? "";
	const b: Block = { path, hash: createHash("sha1").update(json).digest("hex").slice(0, 16), chars: json.length, snippet: json.slice(0, SNIPPET) };
	if (path.startsWith("system")) b.json = json; // kept so a change can be located inside the (large) system prompt
	return b;
}

/** Flatten a provider payload into ordered blocks, in the order the provider caches them. */
export function payloadBlocks(payload: any): Block[] {
	const out: Block[] = [];
	if (!payload || typeof payload !== "object") return out;
	const { tools, system, messages, max_tokens, stream, metadata, ...params } = payload;
	out.push(block("params", params));
	if (Array.isArray(tools)) tools.forEach((t, i) => out.push(block(`tools[${i}]`, t)));
	if (Array.isArray(system)) system.forEach((b, i) => out.push(block(`system[${i}]`, b)));
	else if (system !== undefined) out.push(block("system", system));
	if (Array.isArray(messages))
		messages.forEach((m, i) => {
			const { content, ...head } = m ?? {};
			out.push(block(`messages[${i}] ${m?.role ?? "?"}`, head));
			if (Array.isArray(content)) content.forEach((c, j) => out.push(block(`messages[${i}].content[${j}] ${c?.type ?? ""}`, c)));
			else if (content !== undefined) out.push(block(`messages[${i}].content`, content));
		});
	return out;
}

/** Index of the first block that differs from prev, or -1 if cur only appends to prev. */
export function firstDiff(prev: Block[], cur: Block[]): number {
	const n = Math.min(prev.length, cur.length);
	for (let i = 0; i < n; i++) if (prev[i].hash !== cur[i].hash) return i;
	return cur.length < prev.length ? n : -1;
}

/** Sections that come only from before_agent_start, so a removal is the flap, not intent. */
const FLAPPING_SECTIONS = ["pi_background_shell_policy", "agent_browser"];

export function dropFlappingRemovals(messages: any[]): { messages: any[]; dropped: number } {
	let dropped = 0;
	const out: any[] = [];
	messages.forEach((m, i) => {
		const sections = m?.role === "system" ? m.sections : undefined;
		if (!sections || i === 0) {
			out.push(m);
			return;
		}
		const keys = FLAPPING_SECTIONS.filter((k) => k in sections && sections[k] === null);
		if (!keys.length) {
			out.push(m);
			return;
		}
		dropped += keys.length;
		const rest = { ...sections };
		for (const k of keys) delete rest[k];
		const empty = Object.keys(rest).length === 0 && !m.toolsAdded?.length && !m.toolsRemoved?.length && !m.content;
		if (!empty) out.push({ ...m, sections: rest });
	});
	return { messages: out, dropped };
}

const SEAT_OWNER_KEY = Symbol.for("cache-tuning:seat-owner");

/** Remove ttl "1h" from every cache_control in a provider payload; returns how many. */
export function stripLongTtl(node: any): number {
	let n = 0;
	if (Array.isArray(node)) for (const x of node) n += stripLongTtl(x);
	else if (node && typeof node === "object") {
		const cc = node.cache_control;
		if (cc && typeof cc === "object" && cc.ttl === "1h") {
			delete cc.ttl;
			n++;
		}
		for (const [k, v] of Object.entries(node)) if (k !== "cache_control" && v && typeof v === "object") n += stripLongTtl(v);
	}
	return n;
}

/** Where the system prompt text lives in a provider payload (Anthropic system[0], or an OpenAI-style system message). */
function systemTextRef(payload: any): { get(): string; set(v: string): void } | undefined {
	const s0 = Array.isArray(payload?.system) ? payload.system[0] : undefined;
	if (s0 && typeof s0.text === "string") return { get: () => s0.text, set: (v) => (s0.text = v) };
	const m0 = Array.isArray(payload?.messages) ? payload.messages[0] : undefined;
	if (m0 && (m0.role === "system" || m0.role === "developer")) {
		if (typeof m0.content === "string") return { get: () => m0.content, set: (v) => (m0.content = v) };
		const c0 = Array.isArray(m0.content) ? m0.content[0] : undefined;
		if (c0 && typeof c0.text === "string") return { get: () => c0.text, set: (v) => (c0.text = v) };
	}
	return undefined;
}

/** The system text to send: on a typed run, cur (and remember it); otherwise the remembered text. */
export function chooseSystemText(cur: string, typedRun: boolean, remembered: string | undefined): { text: string; remember?: string } {
	if (typedRun) return { text: cur, remember: cur };
	return remembered !== undefined && remembered !== cur ? { text: remembered } : { text: cur };
}

const MEMORY_HEADER = "\n\n## Memory\n";

/**
 * Fix 6: keep the seat's pi-memory block unchanged when the only change is a
 * refresh the seat does not need in its prompt. Returns the text to send and
 * the text to hold for the next request.
 * - acceptAll (first request after load or after a compaction): send cur.
 * - The change must start inside the memory block (everything before the
 *   "## Memory" header identical); otherwise it is a real change: send cur.
 * - During a compaction (pi-memory refreshes at its start), or when the new
 *   snapshot reason is long_term_write: send the held text.
 * - day_rollover: send the held text too, unless opts.holdRollover is false.
 *   The caller appends a date note so the seat knows the block is a day old.
 * - Any other reason: send cur.
 */
export function chooseMemoryHold(cur: string, held: string | undefined, opts: { acceptAll: boolean; compacting: boolean; holdRollover?: boolean }): { text: string; held: string; action?: string; reason?: string } {
	if (opts.acceptAll || held === undefined || held === cur) return { text: cur, held: cur };
	const hdr = cur.indexOf(MEMORY_HEADER);
	if (hdr < 0 || held.indexOf(MEMORY_HEADER) !== hdr || held.slice(0, hdr) !== cur.slice(0, hdr)) return { text: cur, held: cur, action: "accepted", reason: "change outside memory" };
	const reason = /\(Snapshot (\w+) at /.exec(cur.slice(hdr, hdr + 200))?.[1] ?? "unknown";
	if (opts.compacting || reason === "long_term_write" || reason === "session_before_compact") return { text: held, held, action: "held", reason };
	if (reason === "day_rollover" && opts.holdRollover !== false) return { text: held, held, action: "held", reason };
	return { text: cur, held: cur, action: "accepted", reason };
}

export default function (pi: ExtensionAPI) {
	if (!process.env.PI_CACHE_RETENTION) process.env.PI_CACHE_RETENTION = "long";

	// First instance in the process is the seat; it keeps the long cache.
	const instanceId = Symbol("cache-tuning");
	const g = globalThis as Record<symbol, unknown>;
	if (g[SEAT_OWNER_KEY] === undefined) g[SEAT_OWNER_KEY] = instanceId;
	pi.on("session_start", async () => {
		if (g[SEAT_OWNER_KEY] === undefined) g[SEAT_OWNER_KEY] = instanceId;
	});
	pi.on("session_shutdown", async () => {
		if (g[SEAT_OWNER_KEY] === instanceId) delete g[SEAT_OWNER_KEY];
	});
	const debug = process.env.PI_CACHE_DEBUG !== "0";
	let prevBlocks: Block[] | undefined;
	let seq = 0;
	let sid = "";
	const log = (rec: Record<string, unknown>) => {
		try {
			mkdirSync(DEBUG_DIR, { recursive: true });
			const ts = new Date().toISOString();
			appendFileSync(join(DEBUG_DIR, `${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, sid, ...rec }) + "\n");
		} catch {
			/* debug logging must never break a request */
		}
	};
	const debugRequest = (payload: unknown, ctx: any) => {
		try {
			sid = ctx?.sessionManager?.getSessionId?.() ?? sid;
			const cur = payloadBlocks(payload);
			const kind = g[SEAT_OWNER_KEY] === instanceId ? "seat" : "agent";
			const rec: Record<string, unknown> = { type: "request", seq: ++seq, kind, model: (payload as any)?.model, blocks: cur.length };
			if (prevBlocks) {
				const d = firstDiff(prevBlocks, cur);
				rec.prevBlocks = prevBlocks.length;
				if (d >= 0) {
					rec.firstDiff = d;
					rec.path = cur[d]?.path ?? "(blocks removed)";
					rec.charsBefore = cur.slice(0, d).reduce((a, b) => a + b.chars, 0);
					rec.prevSnippet = prevBlocks[d]?.snippet;
					rec.newSnippet = cur[d]?.snippet;
					if (d === 0) rec.prevParams = prevBlocks[0]?.snippet;
					const a = prevBlocks[d]?.json, b = cur[d]?.json;
					if (a !== undefined && b !== undefined) {
						let i = 0;
						while (i < a.length && i < b.length && a[i] === b[i]) i++;
						rec.diffAt = i;
						rec.prevAround = a.slice(Math.max(0, i - 120), i + 400);
						rec.newAround = b.slice(Math.max(0, i - 120), i + 400);
						rec.prevChars = a.length;
						rec.newChars = b.length;
					}
				}
			}
			log(rec);
			prevBlocks = cur;
		} catch {
			/* ignore */
		}
	};
	if (debug)
		pi.on("message_end", async (event) => {
			const m: any = event.message;
			if (m?.role !== "assistant" || !m.usage) return undefined;
			const u = m.usage;
			log({ type: "usage", seq, model: m.model, stop: m.stopReason, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cacheWrite1h: u.cacheWrite1h, input: u.input, responseId: m.responseId });
			return undefined;
		});

	// ---- keep-warm (seat only) ----
	const keepWarm = process.env.PI_CACHE_KEEPWARM !== "0";
	let warm: { payload: any; model: any; registry: any; cached: number } | undefined;
	let lastUseAt = 0; // last time the cache entry was read or written
	let lastRealAt = 0; // last real (non-ping) request
	let warmTimer: ReturnType<typeof setTimeout> | undefined;
	let pinging = false;
	let sessionInfo: { sessionId?: string; sessionName?: string; cwd?: string } = {};
	const isSeat = () => g[SEAT_OWNER_KEY] === instanceId;
	const stopWarm = (reason?: string) => {
		if (warmTimer) clearTimeout(warmTimer);
		warmTimer = undefined;
		if (reason && warm) log({ type: "keepwarm-stop", reason });
		if (reason) warm = undefined;
	};
	const scheduleWarm = () => {
		if (!keepWarm || !warm || !isSeat()) return;
		if (warmTimer) clearTimeout(warmTimer);
		const at = lastUseAt + KEEPWARM_INTERVAL_MS;
		warmTimer = setTimeout(() => void ping(), Math.max(1000, at - Date.now()));
		warmTimer.unref?.();
	};
	const ping = async () => {
		warmTimer = undefined;
		const w = warm;
		if (!w) return;
		const now = Date.now();
		if (now - lastRealAt > KEEPWARM_MAX_MS) return stopWarm(`idle limit (${KEEPWARM_MAX_MS / 3_600_000} h)`);
		if (now - lastUseAt > KEEPWARM_LATE_MS) return stopWarm(`timer late by ${Math.round((now - lastUseAt) / 60_000)} min (sleep?); cache likely expired`);
		pinging = true;
		try {
			const payload = capOutput(w.payload);
			const msg: any = await w.registry
				.streamSimple(w.model, { messages: [] }, { maxTokens: 1, maxRetries: 0, onPayload: () => payload })
				.result();
			if (warm !== w) return; // a real request arrived meanwhile
			const u = msg?.usage ?? {};
			const rec = { type: "keepwarm", stop: msg?.stopReason, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cacheWrite1h: u.cacheWrite1h, input: u.input, output: u.output, cost: u.cost?.total, error: msg?.errorMessage?.slice(0, 300), idleMin: Math.round((now - lastRealAt) / 60_000) };
			log(rec);
			if (u.cost?.total) {
				try {
					const ts = new Date().toISOString();
					mkdirSync(LEDGER_DIR, { recursive: true });
					appendFileSync(join(LEDGER_DIR, `${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, ...sessionInfo, kind: "seat", id: sessionInfo.sessionId ?? "unknown", type: "seat", description: sessionInfo.sessionName ?? "", model: `${msg.provider}/${msg.model}`, thinking: "(cache warm)", depth: 0, cost: u.cost.total, input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 }) + "\n");
				} catch {
					/* ledger is best-effort */
				}
			}
			if (msg?.stopReason === "error" || msg?.stopReason === "aborted") return stopWarm("ping failed");
			if ((u.cacheRead ?? 0) < 0.5 * w.cached) return stopWarm(`cache was gone (read ${u.cacheRead}, expected ~${w.cached})`);
			lastUseAt = Date.now();
			scheduleWarm();
		} catch (err) {
			if (warm === w) stopWarm(`ping threw: ${String(err).slice(0, 200)}`);
		} finally {
			pinging = false;
		}
	};
	if (keepWarm) {
		pi.on("agent_settled", async (_e, ctx) => {
			if (!isSeat() || !warm) return undefined;
			sessionInfo = { sessionId: ctx.sessionManager?.getSessionId?.(), sessionName: ctx.sessionManager?.getSessionName?.(), cwd: ctx.cwd };
			scheduleWarm();
			return undefined;
		});
		pi.on("message_end", async (event) => {
			const m: any = event.message;
			if (!isSeat() || m?.role !== "assistant" || !m.usage || !warm) return undefined;
			const u = m.usage;
			const total = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.input ?? 0);
			if (m.stopReason === "error" || m.stopReason === "aborted" || !(u.cacheWrite1h > 0 || u.cacheRead > 0)) {
				warm.cached = 0;
				return undefined;
			}
			warm.cached = total;
			lastUseAt = Date.now();
			return undefined;
		});
		pi.on("session_before_compact", async () => {
			stopWarm("compaction");
			return undefined;
		});
	}
	// fix 6 state: the system text last sent (seat only)
	const memoryHold = process.env.PI_CACHE_MEMORY_HOLD !== "0";
	let heldSystem: string | undefined;
	let lastHoldLogged: string | undefined;
	const holdRollover = process.env.PI_CACHE_HOLD_ROLLOVER !== "0";
	const localDay = () => {
		const d = new Date();
		return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
	};
	let heldDay: string | undefined; // local day of the memory block the seat is being sent
	let notedDay: string | undefined; // local day the date note was last appended for
	const toolWarm = process.env.PI_CACHE_TOOLWARM !== "0";
	let compacting = false;
	let acceptNext = true;
	pi.on("session_start", async () => {
		acceptNext = true;
		compacting = false;
	});
	pi.on("session_before_compact", async (event: any) => {
		compacting = true;
		if (debug) log({ type: "compact-start", reason: event?.reason });
		return undefined;
	});
	pi.on("session_compact", async (event: any) => {
		compacting = false;
		acceptNext = true;
		if (debug) log({ type: "compact-done", reason: event?.reason, tokensBefore: event?.compactionEntry?.tokensBefore });
		return undefined;
	});
	pi.on("session_compact_failed", async (event: any) => {
		compacting = false;
		if (debug) log({ type: "compact-failed", reason: event?.reason, aborted: event?.aborted, error: event?.errorMessage });
		return undefined;
	});
	pi.on("session_shutdown", async () => {
		stopWarm();
	});

	let typedSystem: string | undefined;
	let typedRun = false;
	pi.on("before_agent_start", async () => {
		typedRun = true;
		// Day rollover: the held memory block is from an earlier day. Say so at the end
		// of the history (an append keeps the cache) instead of rebuilding the prompt.
		const today = localDay();
		if (memoryHold && holdRollover && isSeat() && heldSystem && heldDay && heldDay !== today && notedDay !== today) {
			notedDay = today;
			if (debug) log({ type: "date-note", day: today, heldDay });
			return {
				message: {
					customType: "cache-tuning-date",
					content:
						`[date] The local date is now ${today}. The memory block in your system prompt is a snapshot from ${heldDay}, ` +
						`kept unchanged to save the prompt cache, so the daily log it calls "today" is ${heldDay}'s. ` +
						`Use memory_read (target "daily") for today's log. The block refreshes at the next compaction.`,
					display: false,
				},
			};
		}
		return undefined;
	});
	pi.on("agent_end", async () => {
		typedRun = false;
		return undefined;
	});
	pi.on("before_provider_request", async (event, ctx) => {
		let tailRestored = false;
		if (!pinging) {
			const ref = systemTextRef(event.payload);
			if (ref) {
				const cur = ref.get();
				const r = chooseSystemText(cur, typedRun, typedSystem);
				if (r.remember !== undefined) typedSystem = r.remember;
				if (r.text !== cur) {
					ref.set(r.text);
					tailRestored = true;
					if (debug) log({ type: "system-prompt-reused", seq: seq + 1, sentChars: cur.length, reusedChars: r.text.length });
				}
				if (memoryHold && isSeat()) {
					const sent = ref.get();
					const h = chooseMemoryHold(sent, heldSystem, { acceptAll: acceptNext, compacting, holdRollover });
					acceptNext = false;
					if (h.held !== heldSystem || heldDay === undefined) {
						if (h.text === sent) heldDay = localDay(); // a fresh block was accepted
					}
					heldSystem = h.held;
					if (h.text !== sent) {
						ref.set(h.text);
						tailRestored = true;
					}
					// log once per new block, not on every request that keeps holding it
					if (debug && h.action && sent !== lastHoldLogged) log({ type: `memory-block-${h.action}`, seq: seq + 1, reason: h.reason, sentChars: sent.length, heldChars: h.text.length });
					lastHoldLogged = sent;
				}
			}
		}
		if (keepWarm && !pinging && isSeat()) {
			stopWarm();
			lastRealAt = Date.now();
			const p: any = event.payload;
			const json = JSON.stringify(p?.system ?? "") + JSON.stringify(p?.tools ?? "");
			const longCached = json.includes('"ttl":"1h"') || JSON.stringify(p?.messages?.slice?.(-2) ?? "").includes('"ttl":"1h"');
			warm = longCached && ctx?.model ? { payload: structuredClone(p), model: ctx.model, registry: ctx.modelRegistry, cached: 0 } : undefined;
		}
		let changed = false;
		if (g[SEAT_OWNER_KEY] !== instanceId) changed = stripLongTtl(event.payload) > 0;
		if (toolWarm) {
			stopToolWarm();
			const p: any = event.payload;
			const short = !JSON.stringify(p).includes('"ttl":"1h"') && JSON.stringify(p).includes('"cache_control"');
			tw = short && ctx?.model ? { payload: structuredClone(p), model: ctx.model, registry: ctx.modelRegistry, cached: 0, since: Date.now() } : undefined;
			twLastUse = Date.now();
			if (tw && toolsRunning > 0) scheduleToolWarm();
		}
		// Publish the seat's last real request for self-compact's cached summary (fix 8 there).
		if (isSeat() && !pinging && ctx?.model) (globalThis as any)[Symbol.for("cache-tuning:last-seat-request")] = { payload: event.payload, model: ctx.model, registry: ctx.modelRegistry, at: Date.now() };
		if (debug) debugRequest(event.payload, ctx);
		return changed || tailRestored ? event.payload : undefined;
	});

	// ---- fix 7: keep a 5-minute cache warm while a long tool call runs ----
	let tw: { payload: any; model: any; registry: any; cached: number; since: number } | undefined;
	let twLastUse = 0;
	let twTimer: ReturnType<typeof setTimeout> | undefined;
	let toolsRunning = 0;
	function stopToolWarm(reason?: string) {
		if (twTimer) clearTimeout(twTimer);
		twTimer = undefined;
		if (reason && tw && debug) log({ type: "toolwarm-stop", reason });
	}
	function scheduleToolWarm() {
		if (!tw || twTimer) return;
		twTimer = setTimeout(() => void toolPing(), Math.max(1000, twLastUse + TOOLWARM_INTERVAL_MS - Date.now()));
		twTimer.unref?.();
	}
	// Ping spend goes into the subagent ledger under the lane's own agent id, so
	// per-lane and per-seat costs include it (added 2026-10-19). The lane's cwd is
	// pi-subagents' temp dir "pi-agent-<agent id>-<random>"; the other fields are
	// copied from the lane's first ledger line, which its parent wrote live.
	let pingMeta: Record<string, unknown> | null | undefined;
	function ledgerPing(u: any, model: any) {
		try {
			if (!(u?.cost?.total > 0)) return;
			const id = /pi-agent-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{3})/.exec(process.cwd())?.[1];
			if (!id) return; // not a pi-subagents agent
			const dir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "subagent-ledger");
			const now = new Date();
			if (pingMeta === undefined || pingMeta === null) {
				pingMeta = null;
				for (const d of [now, new Date(now.getTime() - 86_400_000)]) {
					let text = "";
					try { text = readFileSync(join(dir, `${d.toISOString().slice(0, 10)}.jsonl`), "utf8"); } catch { continue; }
					const at = text.indexOf(`"id":"${id}`);
					if (at < 0) continue;
					const line = JSON.parse(text.slice(text.lastIndexOf("\n", at) + 1, text.indexOf("\n", at)));
					const { sessionId, sessionName, cwd, type, description, model: m, thinking, depth, parentAgentId, workflowId } = line;
					pingMeta = { sessionId, sessionName, cwd, id: line.id, type, description, model: m, thinking, depth, parentAgentId, workflowId };
					break;
				}
			}
			const line = {
				ts: now.toISOString(),
				...(pingMeta ?? { id, type: "unknown", description: "(toolwarm ping, lane not in ledger)", model: `${model?.provider}/${model?.id}`, thinking: "default", depth: 1 }),
				cost: u.cost.total, input: u.input ?? 0, output: u.output ?? 0, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0,
				source: "toolwarm",
			};
			mkdirSync(dir, { recursive: true });
			appendFileSync(join(dir, `${line.ts.slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`);
		} catch {
			// the ledger is best effort; never break a ping over it
		}
	}
	async function toolPing() {
		twTimer = undefined;
		const w = tw;
		if (!w || toolsRunning === 0) return;
		const now = Date.now();
		if (now - w.since > TOOLWARM_MAX_MS) return stopToolWarm("tool wait limit");
		if (now - twLastUse > 295_000) return stopToolWarm(`timer late by ${Math.round((now - twLastUse) / 1000)} s; cache likely expired`);
		try {
			const payload = capOutput(w.payload);
			const msg: any = await w.registry.streamSimple(w.model, { messages: [] }, { maxTokens: 1, maxRetries: 0, onPayload: () => payload }).result();
			if (tw !== w) return;
			const u = msg?.usage ?? {};
			ledgerPing(u, w.model);
			if (debug) log({ type: "toolwarm", stop: msg?.stopReason, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, input: u.input, output: u.output, cost: u.cost?.total, error: msg?.errorMessage?.slice(0, 300), waitMin: Math.round((now - w.since) / 6000) / 10, tools: toolsRunning });
			if (msg?.stopReason === "error" || msg?.stopReason === "aborted") return stopToolWarm("ping failed");
			if (w.cached > 0 && (u.cacheRead ?? 0) < 0.5 * w.cached) return stopToolWarm(`cache was gone (read ${u.cacheRead}, expected ~${w.cached})`);
			w.cached = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.input ?? 0);
			twLastUse = Date.now();
			if (toolsRunning > 0) scheduleToolWarm();
		} catch (err) {
			if (tw === w) stopToolWarm(`ping threw: ${String(err).slice(0, 200)}`);
		}
	}
	if (toolWarm) {
		pi.on("tool_execution_start", async (e: any) => {
			if (e?.parentToolCallId) return; // nested calls run inside a tool already counted
			toolsRunning++;
			scheduleToolWarm();
		});
		pi.on("tool_execution_end", async (e: any) => {
			if (e?.parentToolCallId) return;
			toolsRunning = Math.max(0, toolsRunning - 1);
			if (toolsRunning === 0) stopToolWarm();
		});
		pi.on("message_end", async (event) => {
			const m: any = event.message;
			if (m?.role !== "assistant" || !m.usage || !tw) return undefined;
			const u = m.usage;
			tw.cached = (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.input ?? 0);
			twLastUse = Date.now();
			return undefined;
		});
		pi.on("agent_end", async () => {
			toolsRunning = 0;
			stopToolWarm();
			tw = undefined;
		});
		pi.on("session_shutdown", async () => {
			stopToolWarm();
			tw = undefined;
		});
	}

	pi.on("context_with_system", async (event) => {
		const r = dropFlappingRemovals(event.messages as any[]);
		return r.dropped ? { messages: r.messages } : undefined;
	});
}
