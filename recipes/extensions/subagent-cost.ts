/**
 * Subagent cost in the footer, broken down by subagent type and thinking level,
 * plus a machine-wide ledger and a /subagent-cost command to query it.
 *
 * Source: the `subagents:usage` event from pi-subagents (erikdarlingdata fork,
 * integration/opus-subagents). It fires once per assistant message for every
 * agent: top-level, nested and workflow children. So the chip is live while
 * agents run, and each message is counted once under the agent that spent it.
 * `requestedThinking` is set when the agent did not get the level it asked for
 * (pi clamped it to the model); those groups show as `low*` in the footer.
 *
 * Footer: setStatus key "subagent-usage". pi-cc-extensions puts keys matching
 * /usage/ on footer line 1, next to the session's own $ figure. The session's
 * own $ excludes this spend unless pi-subagents' `reportUsage` is on.
 *
 * Session persistence: deltas are flushed as custom session entries
 * ("subagent-cost", never sent to the model) at turn end, agent end, agent
 * completion, every 2 minutes while dirty, on shutdown, and on
 * `subagents:disposed` (pi-subagents' end of shutdown, after it has aborted
 * every agent; our own session_shutdown can run before that). On session start
 * the totals are rebuilt from every such entry, the same way the footer sums
 * cost over all entries.
 *
 * Machine-wide ledger: every event is also appended, immediately, as one JSON
 * line to ~/.pi/agent/subagent-ledger/YYYY-MM-DD.jsonl (UTC day), with the
 * session id and name. The subagent watchdog reads it for its daily budget.
 * Line fields: ts, sessionId, sessionName, cwd, id, type, description, model,
 * thinking, requestedThinking, depth, parentAgentId, workflowId, cost, input,
 * output, cacheRead, cacheWrite.
 *
 * Command: /subagent-cost [view] [range]
 *   view:  types (default) | agents | sessions
 *   range: session (default; sessions view defaults to today) | today | week | <N>d
 *   Ranges other than "session" read the ledger, so they cover every pi
 *   session on this machine, from the day the ledger started.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_KEY = "subagent-usage";
const ENTRY_TYPE = "subagent-cost";
const FOOTER_TOP_N = 4;
const AGENTS_TOP_N = 15;
const FLUSH_INTERVAL_MS = 2 * 60 * 1000;
const IDLE_CAP_MS = 10 * 60 * 1000;
const LEDGER_DIR = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "subagent-ledger");

type UsageEvent = {
	id?: string;
	type?: string;
	description?: string;
	model?: string;
	thinking?: string;
	requestedThinking?: string;
	depth?: number;
	parentAgentId?: string;
	workflowId?: string;
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
};

/** One message of spend, normalized. Also the ledger line shape (plus session fields). */
type Line = {
	ts: string;
	sessionId?: string;
	sessionName?: string;
	cwd?: string;
	id: string;
	type: string;
	description: string;
	model: string;
	thinking: string;
	requestedThinking?: string;
	depth: number;
	parentAgentId?: string;
	workflowId?: string;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** "backfill" for lines rebuilt from saved subagent sessions; absent for live lines. */
	source?: string;
};

/**
 * `activeMs`: agent working time, the sum of gaps between an agent's consecutive
 * messages with each gap capped at IDLE_CAP_MS, so a resumed agent's idle hours
 * between runs do not count. It starts at its first message, so the time before
 * the first reply is not included.
 */
type Spend = { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number; messages: number; activeMs: number };

type Bucket = Spend & { type: string; thinking: string; asked?: string; model: string; agents: Set<string> };
type AgentRow = Spend & {
	id: string;
	type: string;
	thinking: string;
	asked?: string;
	model: string;
	description: string;
	depth: number;
	workflowId?: string;
	/** Last message time (ms), to measure the next gap. */
	lastTs?: number;
};
type SessionRow = Spend & { sessionId: string; name: string; cwd: string; agents: Set<string> };

type PersistedBucket = Spend & { type: string; thinking: string; asked?: string; model: string; agents: string[] };
type PersistedDelta = { v: 1 | 2; buckets: PersistedBucket[]; agents?: AgentRow[] };

const zeroSpend = (): Spend => ({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, activeMs: 0 });

const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 0);

/** Tolerates rows persisted before a field existed (absent reads as 0). */
function addSpend(into: Spend, d: Partial<Spend>): void {
	into.cost += num(d.cost);
	into.input += num(d.input);
	into.output += num(d.output);
	into.cacheRead += num(d.cacheRead);
	into.cacheWrite += num(d.cacheWrite);
	into.messages += num(d.messages);
	into.activeMs += num(d.activeMs);
}

function lineSpend(l: Line): Spend {
	return { cost: l.cost, input: l.input, output: l.output, cacheRead: l.cacheRead, cacheWrite: l.cacheWrite, messages: 1, activeMs: 0 };
}

const bucketKey = (type: string, thinking: string, asked: string | undefined, model: string) =>
	[type, thinking, asked ?? "", model].join("\u0000");

function addBucket(
	map: Map<string, Bucket>,
	b: { type: string; thinking: string; asked?: string; model: string; agents: Iterable<string> },
	spend: Partial<Spend>,
): void {
	const key = bucketKey(b.type, b.thinking, b.asked, b.model);
	let into = map.get(key);
	if (!into) {
		into = { ...zeroSpend(), type: b.type, thinking: b.thinking, asked: b.asked, model: b.model, agents: new Set() };
		map.set(key, into);
	}
	addSpend(into, spend);
	for (const id of b.agents) into.agents.add(id);
}

function addAgent(map: Map<string, AgentRow>, a: Omit<AgentRow, keyof Spend>, spend: Partial<Spend>): AgentRow {
	let into = map.get(a.id);
	if (!into) {
		// Metadata only: `a` may be a persisted row that carries spend too, and
		// that spend is added once, below.
		into = {
			...zeroSpend(),
			id: a.id,
			type: a.type,
			thinking: a.thinking,
			asked: a.asked,
			model: a.model,
			description: a.description,
			depth: a.depth,
			workflowId: a.workflowId,
		};
		map.set(a.id, into);
	}
	addSpend(into, spend);
	if (a.lastTs !== undefined) into.lastTs = Math.max(into.lastTs ?? 0, a.lastTs);
	return into;
}

class Ledger {
	buckets = new Map<string, Bucket>();
	agents = new Map<string, AgentRow>();
	sessions = new Map<string, SessionRow>();

	add(l: Line): void {
		const spend = lineSpend(l);
		const ts = Date.parse(l.ts);
		const prev = this.agents.get(l.id)?.lastTs;
		if (Number.isFinite(ts) && prev !== undefined && ts > prev) spend.activeMs = Math.min(ts - prev, IDLE_CAP_MS);
		addBucket(this.buckets, { type: l.type, thinking: l.thinking, asked: l.requestedThinking, model: l.model, agents: [l.id] }, spend);
		addAgent(
			this.agents,
			{
				id: l.id,
				type: l.type,
				thinking: l.thinking,
				asked: l.requestedThinking,
				model: l.model,
				description: l.description,
				depth: l.depth,
				workflowId: l.workflowId,
				lastTs: Number.isFinite(ts) ? ts : undefined,
			},
			spend,
		);
		const sid = l.sessionId ?? "unknown";
		let s = this.sessions.get(sid);
		if (!s) {
			s = { ...zeroSpend(), sessionId: sid, name: l.sessionName ?? "", cwd: l.cwd ?? "", agents: new Set() };
			this.sessions.set(sid, s);
		}
		if (l.sessionName) s.name = l.sessionName;
		addSpend(s, spend);
		s.agents.add(l.id);
	}

	total(): number {
		let t = 0;
		for (const b of this.buckets.values()) t += b.cost;
		return t;
	}
}

// ---------- formatting ----------

export function formatUsd(n: number): string {
	if (n <= 0) return "$0";
	if (n < 0.01) return "<$0.01";
	return `$${n.toFixed(2)}`;
}

export function formatDuration(ms: number): string {
	const m = Math.round(ms / 60_000);
	if (m < 1) return ms > 0 ? "<1m" : "-";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	return h < 24 ? `${h}h${String(m % 60).padStart(2, "0")}` : `${Math.round(m / 60)}h`;
}

function formatTokens(n: number): string {
	if (n < 1000) return `${n}`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

const thinkingLabel = (thinking: string, asked?: string) => (asked && asked !== thinking ? `${thinking} (asked ${asked})` : thinking);

/** `right` lists the column indexes to right-align (numbers); the rest align left. */
function table(header: string[], rows: string[][], right: number[]): string[] {
	const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
	const fmt = (r: string[]) =>
		r
			.map((c, i) => (right.includes(i) ? c.padStart(widths[i]) : c.padEnd(widths[i])))
			.join("  ")
			.trimEnd();
	return [fmt(header), ...rows.map(fmt)];
}

/** Footer groups by type and thinking only; the model goes in the tables. */
export function footerText(buckets: Iterable<Bucket>, topN = FOOTER_TOP_N): string | undefined {
	const groups = new Map<string, { label: string; cost: number }>();
	let total = 0;
	for (const b of buckets) {
		total += b.cost;
		const clamped = b.asked && b.asked !== b.thinking ? "*" : "";
		const label = `${b.type}/${b.thinking}${clamped}`;
		const g = groups.get(label) ?? { label, cost: 0 };
		g.cost += b.cost;
		groups.set(label, g);
	}
	if (groups.size === 0) return undefined;
	const sorted = [...groups.values()].sort((a, b) => b.cost - a.cost);
	const shown = sorted.slice(0, topN).map((g) => `${g.label} ${formatUsd(g.cost)}`);
	if (sorted.length > topN) shown.push(`+${sorted.length - topN} more`);
	return `agents ${formatUsd(total)} (${shown.join(", ")})`;
}

function typesView(l: Ledger, title: string): string {
	const rows = [...l.buckets.values()].sort((a, b) => b.cost - a.cost);
	if (rows.length === 0) return `${title}: no subagent spend recorded.`;
	const body = rows.map((b) => [
		b.type,
		thinkingLabel(b.thinking, b.asked),
		b.model,
		`${b.agents.size}`,
		`${b.messages}`,
		formatTokens(b.input),
		formatTokens(b.output),
		formatTokens(b.cacheRead),
		formatTokens(b.cacheWrite),
		formatDuration(b.activeMs),
		formatUsd(b.cost),
	]);
	const agents = l.agents.size;
	const time = [...l.buckets.values()].reduce((s, b) => s + b.activeMs, 0);
	return [
		`${title}: ${formatUsd(l.total())} and ${formatDuration(time)} of agent time across ${agents} agent${agents === 1 ? "" : "s"}`,
		...table(["type", "thinking", "model", "agents", "msgs", "in", "out", "cache R", "cache W", "time", "cost"], body, [3, 4, 5, 6, 7, 8, 9, 10]),
	].join("\n");
}

function agentsView(l: Ledger, title: string, topN = AGENTS_TOP_N): string {
	const rows = [...l.agents.values()].sort((a, b) => b.cost - a.cost);
	if (rows.length === 0) return `${title}: no subagent spend recorded.`;
	const shown = rows.slice(0, topN);
	const body = shown.map((a) => [
		formatUsd(a.cost),
		`${a.type}/${thinkingLabel(a.thinking, a.asked)}`,
		a.model.replace(/^openrouter\/~?/, ""),
		`${a.messages}`,
		formatDuration(a.activeMs),
		`${a.workflowId ? "wf " : ""}${a.depth > 1 ? `d${a.depth} ` : ""}${a.description}`.slice(0, 60),
	]);
	const more = rows.length > topN ? [`… ${rows.length - topN} more agents, ${formatUsd(rows.slice(topN).reduce((s, a) => s + a.cost, 0))}`] : [];
	return [
		`${title}: top ${shown.length} of ${rows.length} agents, ${formatUsd(l.total())} total`,
		// Cost first, description last so a long one is all that gets cut.
		...table(["cost", "type/thinking", "model", "msgs", "time", "description"], body, [0, 3, 4]),
		...more,
	].join("\n");
}

function sessionsView(l: Ledger, title: string): string {
	const rows = [...l.sessions.values()].sort((a, b) => b.cost - a.cost);
	if (rows.length === 0) return `${title}: no subagent spend recorded.`;
	const body = rows.map((s) => [
		formatUsd(s.cost),
		`${s.agents.size}`,
		`${s.messages}`,
		formatDuration(s.activeMs),
		s.name || `(unnamed ${s.sessionId.slice(0, 8)})`,
		s.cwd.replace(homedir(), "~"),
	]);
	return [
		`${title}: ${formatUsd(l.total())} across ${rows.length} session${rows.length === 1 ? "" : "s"}`,
		...table(["cost", "agents", "msgs", "time", "session", "cwd"], body, [0, 1, 2, 3]),
	].join("\n");
}

// ---------- ledger file ----------

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

function appendLedger(line: Line): boolean {
	try {
		mkdirSync(LEDGER_DIR, { recursive: true });
		appendFileSync(join(LEDGER_DIR, `${line.ts.slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`);
		return true;
	} catch {
		return false;
	}
}

/** Read the last `days` UTC days of ledger, today included. */
function readLedger(days: number): { ledger: Ledger; files: number; bad: number } {
	const ledger = new Ledger();
	let files = 0;
	let bad = 0;
	const now = Date.now();
	for (let i = 0; i < days; i++) {
		const file = join(LEDGER_DIR, `${utcDay(new Date(now - i * 86_400_000))}.jsonl`);
		if (!existsSync(file)) continue;
		files++;
		for (const raw of readFileSync(file, "utf8").split("\n")) {
			if (!raw.trim()) continue;
			try {
				const l = JSON.parse(raw) as Line;
				if (typeof l.cost !== "number" || !l.id) {
					bad++;
					continue;
				}
				ledger.add(l);
			} catch {
				bad++;
			}
		}
	}
	return { ledger, files, bad };
}

// ---------- command parsing ----------

type View = "types" | "agents" | "sessions";
type Range = { kind: "session" } | { kind: "days"; days: number; label: string };

export function parseArgs(args: string): { view: View; range: Range } | { error: string } {
	let view: View = "types";
	let range: Range | undefined;
	for (const tok of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
		if (tok === "types" || tok === "agents" || tok === "sessions") view = tok;
		else if (tok === "session") range = { kind: "session" };
		else if (tok === "today") range = { kind: "days", days: 1, label: "today (UTC)" };
		else if (tok === "week") range = { kind: "days", days: 7, label: "last 7 days (UTC)" };
		else if (/^\d+d$/.test(tok)) {
			const days = Math.max(1, Math.min(366, Number.parseInt(tok, 10)));
			range = { kind: "days", days, label: `last ${days} days (UTC)` };
		} else return { error: `Unknown argument "${tok}". Usage: /subagent-cost [types|agents|sessions] [session|today|week|<N>d]` };
	}
	if (!range) range = view === "sessions" ? { kind: "days", days: 1, label: "today (UTC)" } : { kind: "session" };
	if (view === "sessions" && range.kind === "session") return { error: "The sessions view needs a ledger range: today, week or <N>d." };
	return { view, range };
}

const COMPLETIONS = [
	["", "This session, by type and thinking"],
	["agents", "This session's most expensive agents"],
	["today", "All sessions today (UTC), by type and thinking"],
	["week", "All sessions, last 7 days, by type and thinking"],
	["agents today", "Most expensive agents today, all sessions"],
	["agents week", "Most expensive agents, last 7 days"],
	["sessions", "Spend per session today"],
	["sessions week", "Spend per session, last 7 days"],
	["30d", "All sessions, last 30 days"],
] as const;

// ---------- extension ----------

export default function (pi: ExtensionAPI) {
	/** This session: rebuilt from entries plus live events. */
	let session = new Ledger();
	/** Spent since the last flush to a session entry. */
	let pending = new Ledger();
	let ctxRef: ExtensionContext | undefined;
	let flushTimer: ReturnType<typeof setInterval> | undefined;
	let ledgerFailures = 0;

	const render = () => {
		if (!ctxRef?.hasUI) return;
		try {
			ctxRef.ui.setStatus(STATUS_KEY, footerText(session.buckets.values()));
		} catch {
			// Stale ctx after session replacement; the next session_start rebinds.
		}
	};

	const flush = () => {
		if (pending.buckets.size === 0) return;
		const data: PersistedDelta = {
			v: 2,
			buckets: [...pending.buckets.values()].map((b) => ({ ...b, agents: [...b.agents] })),
			agents: [...pending.agents.values()],
		};
		try {
			pi.appendEntry(ENTRY_TYPE, data);
			pending = new Ledger();
		} catch {
			// Runtime is stale (session replaced). This instance is dead, so the
			// session-entry delta is lost; the ledger file already has every line.
		}
	};

	const sessionInfo = () => {
		try {
			const sm = ctxRef?.sessionManager;
			return { sessionId: sm?.getSessionId(), sessionName: sm?.getSessionName(), cwd: ctxRef?.cwd };
		} catch {
			return {};
		}
	};

	pi.events.on("subagents:usage", (raw: unknown) => {
		const e = raw as UsageEvent;
		const u = e?.usage;
		if (!u) return;
		const line: Line = {
			ts: new Date().toISOString(),
			...sessionInfo(),
			id: e.id || "unknown",
			type: e.type || "unknown",
			description: e.description || "",
			model: e.model || "unknown",
			thinking: e.thinking || "default",
			requestedThinking: e.requestedThinking && e.requestedThinking !== e.thinking ? e.requestedThinking : undefined,
			depth: num(e.depth) || 1,
			parentAgentId: e.parentAgentId,
			workflowId: e.workflowId,
			cost: num(u.cost?.total),
			input: num(u.input),
			output: num(u.output),
			cacheRead: num(u.cacheRead),
			cacheWrite: num(u.cacheWrite),
		};
		session.add(line);
		pending.add(line);
		if (!appendLedger(line)) ledgerFailures++;
		render();
	});

	// Natural points to persist. `disposed` is pi-subagents' end of shutdown,
	// after the agents it aborted have reported their last messages.
	pi.events.on("subagents:completed", () => flush());
	pi.events.on("subagents:failed", () => flush());
	pi.events.on("subagents:disposed", () => flush());

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		session = new Ledger();
		pending = new Ledger();
		for (const entry of ctx.sessionManager.getEntries() as any[]) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as PersistedDelta | undefined;
			if ((data?.v !== 1 && data?.v !== 2) || !Array.isArray(data.buckets)) continue;
			for (const b of data.buckets) addBucket(session.buckets, b, b);
			for (const a of data.agents ?? []) addAgent(session.agents, a, a);
			// v1 entries carry no agent rows; count their agents from the buckets
			// so the "N agents" figure stays right.
			if (!data.agents) {
				for (const b of data.buckets) {
					for (const id of b.agents) {
						if (!session.agents.has(id)) {
							session.agents.set(id, { ...zeroSpend(), id, type: b.type, thinking: b.thinking, model: b.model, description: "(before per-agent tracking)", depth: 1 });
						}
					}
				}
			}
		}
		render();
		if (flushTimer) clearInterval(flushTimer);
		flushTimer = setInterval(flush, FLUSH_INTERVAL_MS);
		flushTimer.unref?.();
	});

	pi.on("turn_end", async () => flush());
	pi.on("agent_end", async () => flush());

	pi.on("session_shutdown", async () => {
		flush();
		if (flushTimer) clearInterval(flushTimer);
		flushTimer = undefined;
		ctxRef = undefined;
	});

	pi.registerCommand("subagent-cost", {
		description: "Subagent spend: [types|agents|sessions] [session|today|week|<N>d]",
		getArgumentCompletions: (prefix: string) => {
			const p = prefix.trim().toLowerCase();
			const items = COMPLETIONS.filter(([v]) => v && v.startsWith(p)).map(([value, description]) => ({ value, label: value, description }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const parsed = parseArgs(args ?? "");
			if ("error" in parsed) {
				ctx.ui.notify(parsed.error, "warning");
				return;
			}
			let ledger: Ledger;
			let title: string;
			const notes: string[] = [];
			if (parsed.range.kind === "session") {
				ledger = session;
				title = "This session";
			} else {
				const r = readLedger(parsed.range.days);
				ledger = r.ledger;
				title = `All sessions, ${parsed.range.label}`;
				if (r.files === 0) notes.push(`No ledger files in ${LEDGER_DIR.replace(homedir(), "~")} for this range.`);
				if (r.bad > 0) notes.push(`${r.bad} malformed ledger line(s) skipped.`);
			}
			if (ledgerFailures > 0) notes.push(`${ledgerFailures} ledger write(s) failed in this session.`);
			const text =
				parsed.view === "agents" ? agentsView(ledger, title) : parsed.view === "sessions" ? sessionsView(ledger, title) : typesView(ledger, title);
			ctx.ui.notify([text, ...notes].join("\n"), "info");
		},
	});
}
