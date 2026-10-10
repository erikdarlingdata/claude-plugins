/**
 * Prompt-cache tuning. Two fixes, both measured on a week of session files
 * (2026-09-30 to 2026-10-07):
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
 * 5. Keep a system-prompt tail that pi drops on notification runs (added
 *    2026-10-10). The same pi bug as fix 2, in its other shape: an extension
 *    that RETURNS systemPrompt from before_agent_start (pi-memory appends its
 *    "## Memory" snapshot this way) gets its text only on typed-prompt runs. A
 *    run started by sendMessage(triggerTurn) sends the base prompt, so the
 *    system prompt shrinks, the whole history is rewritten, and the next typed
 *    prompt grows it back (repro 2026-10-10: system 46,403 -> 33,094 chars, read
 *    3,136 / wrote 12,503; 29 such rewrites in the seats' first 27 debug-log
 *    hours, ~6.4M tokens). In before_provider_request, if the system text is a
 *    strict prefix of the last full system text this instance sent, the full
 *    text is put back (request only; logged as "system-tail-restored"). A typed
 *    run that sends a new, different prompt simply becomes the new reference.
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
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LEDGER_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "subagent-ledger");
const KEEPWARM_INTERVAL_MS = Number(process.env.PI_CACHE_KEEPWARM_INTERVAL_MS) || 54 * 60_000;
/** A ping later than this after the last cache use is likely a full rewrite, so it is skipped. */
const KEEPWARM_LATE_MS = 58 * 60_000;
const KEEPWARM_MAX_MS = (Number(process.env.PI_CACHE_KEEPWARM_HOURS) || 24) * 3_600_000;
const DEBUG_DIR = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "cache-debug");
const SNIPPET = 240;

type Block = { path: string; hash: string; chars: number; snippet: string; json?: string };

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

/** Returns the text to send: the remembered full text when cur is a strict prefix of it. */
export function restoreSystemTail(cur: string, remembered: string | undefined): string {
	return remembered !== undefined && remembered.length > cur.length && remembered.startsWith(cur) ? remembered : cur;
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
			const payload = { ...structuredClone(w.payload), max_tokens: 1 };
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
	pi.on("session_before_compact", async (event: any) => {
		if (debug) log({ type: "compact-start", reason: event?.reason });
		return undefined;
	});
	pi.on("session_compact", async (event: any) => {
		if (debug) log({ type: "compact-done", reason: event?.reason, tokensBefore: event?.compactionEntry?.tokensBefore });
		return undefined;
	});
	pi.on("session_compact_failed", async (event: any) => {
		if (debug) log({ type: "compact-failed", reason: event?.reason, aborted: event?.aborted, error: event?.errorMessage });
		return undefined;
	});
	pi.on("session_shutdown", async () => {
		stopWarm();
	});

	let fullSystem: string | undefined;
	pi.on("before_provider_request", async (event, ctx) => {
		let tailRestored = false;
		if (!pinging) {
			const ref = systemTextRef(event.payload);
			if (ref) {
				const cur = ref.get();
				const out = restoreSystemTail(cur, fullSystem);
				if (out !== cur) {
					ref.set(out);
					tailRestored = true;
					if (debug) log({ type: "system-tail-restored", seq: seq + 1, addedChars: out.length - cur.length, added: out.slice(cur.length, cur.length + 120) });
				} else fullSystem = cur;
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
		if (debug) debugRequest(event.payload, ctx);
		return changed || tailRestored ? event.payload : undefined;
	});

	pi.on("context_with_system", async (event) => {
		const r = dropFlappingRemovals(event.messages as any[]);
		return r.dropped ? { messages: r.messages } : undefined;
	});
}
