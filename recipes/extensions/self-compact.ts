/**
 * Self-compaction for long-running sessions (added 2026-10-17).
 *
 * Seats run for days, and their work arrives from several places (the user,
 * intercom, subagents, timers), so the user is often not there to run
 * /compact between tasks. A seat that is not compacted carries its whole
 * history on every request: one busy session averaged 517k tokens a request
 * for 24 hours (Oct 16-17), and cache reads were $80 of its $110. Compacting while
 * busy is also expensive: pi compacts at the context limit in the middle of a
 * run, and requests sent during the compaction rewrite the old context.
 *
 * Two parts, both for the main session only (the first instance in the
 * process; in-process subagents do not get the tool):
 *
 * 1. Tool `self_compact`. The agent calls it at a task boundary. It does
 *    nothing below PI_SELF_COMPACT_MIN_TOKENS (default 150k). Otherwise it
 *    schedules a compaction for when the run has ended and the session is idle
 *    (agent_settled, no queued messages), so nothing is sent while the
 *    compaction runs. ctx.compact() aborts a running turn, which is why the
 *    tool itself never compacts.
 *
 * 2. Idle backstop. When the session settles above
 *    PI_SELF_COMPACT_AUTO_TOKENS (default 400k, 0 turns it off) and stays idle
 *    for PI_SELF_COMPACT_IDLE_MIN minutes (default 15), it compacts. This
 *    catches a seat that forgets to call the tool.
 *
 * 3. File lists. pi appends <read-files> and <modified-files> to every
 *    summary and carries the previous compaction's lists forward, so they
 *    only grow. One session's lists reached 291 + 352 paths (about 17k tokens,
 *    on every request) after 39 compactions since Sep 25. This keeps only the
 *    files touched in the span being summarized. PI_SELF_COMPACT_FILE_LISTS=all
 *    restores pi's behavior. Applies to every compaction in the main session.
 *
 * 4. Cached summary (trial, off by default). Turn it on with
 *    PI_SELF_COMPACT_CACHED_SUMMARY=1, or per session: put the first 13
 *    characters of the session id (or "*" for all) on a line of
 *    ~/.pi/agent/self-compact-cached-summary. The file is read at each
 *    compaction. pi summarizes by turning the conversation into one new text
 *    message, so the summary call reads nothing from cache: nine compactions
 *    on Oct 17 sent 57k-203k uncached input tokens each, about 55% of their
 *    $0.51-1.23. This sends the seat's last real request unchanged (published
 *    by cache-tuning.ts) with the summary instructions appended as a new user
 *    message, so the conversation is a cache read. Thinking, tools and
 *    tool_choice stay as sent, because changing them can break the cache.
 *    Any problem (no recent request, another model, a tool call, an error)
 *    falls back to pi's own summary.
 *
 * Each compaction keeps the facts a long-running seat needs (see BASE_KEEP),
 * plus the agent's own `keep` text. Events are logged to
 * ~/.pi/agent/cache-debug/<UTC day>.jsonl as self-compact-* records.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";

const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const MIN_TOKENS = num(process.env.PI_SELF_COMPACT_MIN_TOKENS, 150_000);
const AUTO_TOKENS = num(process.env.PI_SELF_COMPACT_AUTO_TOKENS, 400_000);
const IDLE_MS = num(process.env.PI_SELF_COMPACT_IDLE_MIN, 15) * 60_000;
const DEBUG_DIR = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "cache-debug");
const OWNER_KEY = Symbol.for("self-compact:seat-owner");

const BASE_KEEP =
	"This session runs for days and continues after this summary. Keep, with exact numbers, ids and paths: " +
	"open PRs and issues and their state; background tasks, timers and scheduled jobs that are still armed " +
	"(they keep running after compaction); subagents still running; pending asks from other sessions; " +
	"standing rules and preferences from the user; and the next steps in order.";

// pi's SUMMARIZATION_PROMPT (compaction.js, pi 1.3.0), which is not exported.
const SUMMARY_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const Params = Type.Object({
	reason: Type.String({ description: "One line: what you just finished, or why compacting now helps." }),
	keep: Type.Optional(Type.String({ description: "Facts the summary must keep beyond the defaults: open work, ids, decisions, next steps." })),
});

export default function (pi: ExtensionAPI) {
	const me = Symbol("self-compact");
	const g = globalThis as Record<symbol, unknown>;
	if (g[OWNER_KEY] === undefined) g[OWNER_KEY] = me;
	if (g[OWNER_KEY] !== me) return; // an in-process subagent: no tool, no backstop

	let sid = "";
	const log = (rec: Record<string, unknown>) => {
		try {
			mkdirSync(DEBUG_DIR, { recursive: true });
			const ts = new Date().toISOString();
			appendFileSync(join(DEBUG_DIR, `${ts.slice(0, 10)}.jsonl`), JSON.stringify({ ts, sid, ...rec }) + "\n");
		} catch {
			/* logging must never break the session */
		}
	};
	const tokensOf = (ctx: ExtensionContext) => ctx.getContextUsage?.()?.tokens ?? null;

	// ---- part 3: stop the file lists from growing forever ----
	// ---- part 4: summary call that reuses the cached conversation ----
	const pruneLists = process.env.PI_SELF_COMPACT_FILE_LISTS !== "all";
	// On when PI_SELF_COMPACT_CACHED_SUMMARY=1, or when this session id's first 13 characters
	// (or "*") is a line in ~/.pi/agent/self-compact-cached-summary. The file is read at each
	// compaction, so a seat can be switched on or off without a reload.
	const cachedSummaryOn = () => {
		if (process.env.PI_SELF_COMPACT_CACHED_SUMMARY === "1") return true;
		if (process.env.PI_SELF_COMPACT_CACHED_SUMMARY === "0") return false;
		try {
			const dir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
			const lines = readFileSync(join(dir, "self-compact-cached-summary"), "utf8").split("\n").map((l) => l.trim());
			return lines.includes("*") || (sid !== "" && lines.some((l) => l.length >= 13 && sid.startsWith(l)));
		} catch {
			return false;
		}
	};
	{
		pi.on("session_before_compact", async (event: any, ctx: ExtensionContext) => {
			const prep = event?.preparation;
			const ops = prep?.fileOps;
			if (pruneLists && ops?.read && ops?.edited && ops?.written) pruneFileOps(prep, ops);
			if (!prep || !cachedSummaryOn()) return undefined;
			try {
				return await summarizeFromCache(event, prep, ctx);
			} catch (e: any) {
				log({ type: "cached-summary-fallback", why: String(e?.message ?? e).slice(0, 300) });
				return undefined;
			}
		});
	}
	async function summarizeFromCache(event: any, prep: any, ctx: ExtensionContext) {
		const last = (globalThis as any)[Symbol.for("cache-tuning:last-seat-request")];
		if (!last?.payload) throw new Error("no recent seat request (cache-tuning.ts not loaded?)");
		const ageMin = (Date.now() - last.at) / 60_000;
		if (ageMin > 50) throw new Error(`last request is ${Math.round(ageMin)} min old; the cache may be gone`);
		const model: any = (ctx as any).model;
		if (model && last.model && (model.id !== last.model.id || model.provider !== last.model.provider)) throw new Error("model changed since the last request");
		const payload = structuredClone(last.payload);
		if (!Array.isArray(payload.messages)) throw new Error("payload has no messages array (unsupported API shape)");
		const instructions =
			"STOP. Do not continue the work and do not call any tools. Reply with text only.\n\n" +
			(prep.previousSummary ? "The conversation above starts with an earlier summary. Fold it in: keep what still holds, update what changed.\n\n" : "") +
			SUMMARY_PROMPT +
			(event.customInstructions ? `\n\nAdditional focus: ${event.customInstructions}` : "");
		payload.messages.push({ role: "user", content: [{ type: "text", text: instructions }] });
		const t0 = Date.now();
		// A dropped stream ("terminated", seen 2026-10-19 after 77 s) gets one more try,
		// as pi's own summary call does. The retry still reads the cache.
		let msg: any;
		for (let attempt = 1; ; attempt++) {
			msg = await last.registry
				.streamSimple(last.model, { messages: [] }, { maxRetries: 1, signal: event.signal, onPayload: () => payload })
				.result();
			const err = msg?.stopReason === "error" || msg?.errorMessage ? String(msg?.errorMessage ?? msg?.stopReason) : "";
			if (!err) break;
			if (attempt >= 2 || event.signal?.aborted || !/terminated|socket|ECONNRESET|network|timed? ?out|overloaded|\b5\d\d\b/i.test(err))
				throw new Error(`summary call failed (attempt ${attempt}): ${err}`);
			log({ type: "cached-summary-retry", why: err.slice(0, 200), secs: Math.round((Date.now() - t0) / 1000) });
		}
		if ((msg?.content ?? []).some((b: any) => b?.type === "toolCall")) throw new Error("summary call tried to call a tool");
		let summary = (msg?.content ?? []).filter((b: any) => b?.type === "text").map((b: any) => b.text).join("\n").trim();
		if (summary.length < 500) throw new Error(`summary too short (${summary.length} chars)`);
		const readFiles = [...(prep.fileOps?.read ?? [])].filter((f: string) => !prep.fileOps.edited.has(f) && !prep.fileOps.written.has(f)).sort();
		const modifiedFiles = [...new Set([...(prep.fileOps?.edited ?? []), ...(prep.fileOps?.written ?? [])])].sort();
		const sections = [];
		if (readFiles.length) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
		if (modifiedFiles.length) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
		if (sections.length) summary += `\n\n${sections.join("\n\n")}`;
		const u = msg?.usage ?? {};
		log({ type: "cached-summary", secs: Math.round((Date.now() - t0) / 1000), chars: summary.length, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, input: u.input, output: u.output, cost: u.cost?.total });
		return { compaction: { summary, firstKeptEntryId: prep.firstKeptEntryId, tokensBefore: prep.tokensBefore, details: { readFiles, modifiedFiles }, usage: msg?.usage } };
	}
	function pruneFileOps(prep: any, ops: any) {
		{
			const before = ops.read.size + ops.edited.size + ops.written.size;
			const fresh = { read: new Set<string>(), edited: new Set<string>(), written: new Set<string>() };
			const add = (name: unknown, args: any) => {
				const path = typeof args?.path === "string" ? args.path : undefined;
				if (!path) return;
				if (name === "read") fresh.read.add(path);
				else if (name === "edit") fresh.edited.add(path);
				else if (name === "write") fresh.written.add(path);
			};
			// Same rules as pi's extractFileOpsFromMessage, minus the inherited lists.
			for (const m of [...(prep.messagesToSummarize ?? []), ...(prep.turnPrefixMessages ?? [])]) {
				if (m?.role === "toolResult") for (const c of m.nestedCalls?.calls ?? []) add(c?.name, c?.arguments);
				else if (m?.role === "assistant" && Array.isArray(m.content))
					for (const b of m.content) if (b?.type === "toolCall") add(b.name, b.arguments);
			}
			for (const k of ["read", "edited", "written"] as const) {
				ops[k].clear();
				for (const f of fresh[k]) ops[k].add(f);
			}
			log({ type: "self-compact-filelists", before, after: ops.read.size + ops.edited.size + ops.written.size });
		}
	}

	let pending: { reason: string; keep?: string } | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let running = false;
	let failedAt = 0; // context size at the last failed compaction; the backstop waits for 50k more
	const clearIdle = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	};

	const run = (ctx: ExtensionContext, trigger: string, reason: string, keep?: string) => {
		if (running || !ctx.isIdle() || ctx.hasPendingMessages()) {
			log({ type: "self-compact-skip", trigger, why: running ? "already compacting" : "session busy" });
			return false;
		}
		const before = tokensOf(ctx);
		running = true;
		log({ type: "self-compact-start", trigger, reason, tokens: before });
		try {
			ctx.ui?.notify?.(`self-compact (${trigger}): compacting ${before ? Math.round(before / 1000) + "k tokens" : ""}`, "info");
		} catch {
			/* no UI in this mode */
		}
		ctx.compact({
			customInstructions: keep ? `${BASE_KEEP}\n\nAlso keep: ${keep}` : BASE_KEEP,
			onComplete: (r: any) => {
				running = false;
				failedAt = 0;
				log({ type: "self-compact-done", trigger, tokensBefore: r?.tokensBefore ?? before });
			},
			onError: (e: Error) => {
				running = false;
				failedAt = before ?? 0;
				log({ type: "self-compact-failed", trigger, error: String(e?.message ?? e).slice(0, 300) });
			},
		});
		return true;
	};

	pi.on("session_start", async (_e, ctx) => {
		sid = ctx.sessionManager?.getSessionId?.() ?? sid;
		pending = undefined;
		clearIdle();
	});
	pi.on("session_shutdown", async () => {
		clearIdle();
		if (g[OWNER_KEY] === me) delete g[OWNER_KEY];
	});
	pi.on("agent_start", async () => {
		clearIdle();
	});

	pi.on("agent_settled", async (_e, ctx) => {
		sid = ctx.sessionManager?.getSessionId?.() ?? sid;
		clearIdle();
		if (pending) {
			const p = pending;
			pending = undefined;
			// let the settle finish before compacting
			setTimeout(() => void run(ctx, "tool", p.reason, p.keep), 1000).unref?.();
			return;
		}
		const t = tokensOf(ctx);
		if (AUTO_TOKENS > 0 && t !== null && t >= AUTO_TOKENS && t >= failedAt + 50_000) {
			idleTimer = setTimeout(() => {
				idleTimer = undefined;
				const now = tokensOf(ctx);
				if (now !== null && now >= AUTO_TOKENS) run(ctx, "idle", `idle ${IDLE_MS / 60_000} min at ${Math.round(now / 1000)}k tokens`);
			}, IDLE_MS);
			idleTimer.unref?.();
		}
	});

	pi.registerTool({
		name: "self_compact",
		label: "Self compact",
		description:
			"Compact this session's context after the current run ends, while the session is idle. " +
			"Call it when you finish a task and the next work is unrelated, or after you wrap up a wave and report. " +
			"Later requests then carry a summary instead of the whole history, which costs much less. " +
			`It does nothing when the context is under ${Math.round(MIN_TOKENS / 1000)}k tokens, so it is safe to call at any task boundary. ` +
			"Do not call it in the middle of a task. After calling it, end your reply: do not start other work in the same run. " +
			"Running background tasks, timers and subagents are not affected.",
		promptSnippet: "self_compact: compact your own context at a task boundary, when the session goes idle",
		parameters: Params,
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const t = tokensOf(ctx);
			const k = t === null ? "unknown" : `${Math.round(t / 1000)}k`;
			if (t !== null && t < MIN_TOKENS) {
				log({ type: "self-compact-declined", tokens: t, reason: params.reason });
				return { content: [{ type: "text", text: `Not compacted: the context is ${k} tokens, under the ${Math.round(MIN_TOKENS / 1000)}k minimum. Nothing to do.` }], details: { scheduled: false, tokens: t } };
			}
			pending = { reason: params.reason, keep: params.keep };
			log({ type: "self-compact-scheduled", tokens: t, reason: params.reason });
			return {
				content: [{ type: "text", text: `Compaction scheduled for when this run ends and the session is idle. Context now: ${k} tokens. End your reply now.` }],
				details: { scheduled: true, tokens: t },
			};
		},
	});
}
