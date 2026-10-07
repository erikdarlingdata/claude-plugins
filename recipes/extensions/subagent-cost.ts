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
 * Seat spend: the session's own assistant messages and compactions are also
 * written to the ledger, as lines with `kind: "seat"` (type "seat", id = the
 * session id). Only the first instance in a process records them: pi-subagents
 * runs children in-process, and a child that loads this extension must not
 * record its own messages as a seat. The footer chip stays agents-only; the
 * session's own spend is already pi's `$`.
 *
 * Command: /subagent-cost [view] [range] [session:<name|id prefix|this>]
 *   view:  types (default) | agents | sessions | issues | daily
 *   range: session (default) | today (since local midnight) | week | <N>d | <N>h
 *          <N>d and <N>h are rolling windows ending now.
 *   session:<x> limits a ledger range to sessions whose name is <x> (or
 *   contains it), whose id starts with <x>, or this session ("this"); with a
 *   filter the default range is 7d. Any ledger range defaults to the daily
 *   view, one row per local day (<N>d = today and the N-1 whole days before
 *   it); session:<x> splits each day by model, and
 *   session:all splits each day by session (top DAILY_TOP_N rows a day). Add
 *   `types` for one total per type/thinking/model instead. Ledger ranges cover every pi session on this machine,
 *   from the day the ledger started; a note lists sessions whose recent spend
 *   is not in the ledger yet (not reloaded since seat tracking, and not yet
 *   backfilled).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STATUS_KEY = "subagent-usage";
const ENTRY_TYPE = "subagent-cost";
const FOOTER_TOP_N = 4;
const AGENTS_TOP_N = 15;
const DAILY_TOP_N = 10;
const FLUSH_INTERVAL_MS = 2 * 60 * 1000;
const IDLE_CAP_MS = 10 * 60 * 1000;
const SEAT_OWNER_KEY = Symbol.for("subagent-cost:seat-owner");
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const LEDGER_DIR = join(AGENT_DIR, "subagent-ledger");
const SESSIONS_DIR = join(AGENT_DIR, "sessions");
/** A session file written this long after its last ledger line is treated as missing spend. */
const STALE_SLACK_MS = 10 * 60 * 1000;

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
	/** "backfill" for lines rebuilt from saved sessions; absent for live lines. */
	source?: string;
	/** "seat" for the session's own spend; absent for a subagent's. */
	kind?: "seat";
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
	/** Session the agent was spawned from (first seen). */
	sessionName?: string;
};
type SessionRow = Spend & {
	sessionId: string;
	name: string;
	cwd: string;
	agents: Set<string>;
	seatCost: number;
	seatMs: number;
	agentCost: number;
	agentMs: number;
};

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
			sessionName: a.sessionName,
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

	/** Last message time per agent or seat id, to measure the next gap. */
	private last = new Map<string, number>();

	add(l: Line): void {
		const spend = lineSpend(l);
		const ts = Date.parse(l.ts);
		const prev = this.last.get(l.id);
		if (Number.isFinite(ts) && prev !== undefined && ts > prev) spend.activeMs = Math.min(ts - prev, IDLE_CAP_MS);
		if (Number.isFinite(ts)) this.last.set(l.id, Math.max(prev ?? 0, ts));
		const seat = l.kind === "seat";
		const type = seat ? "seat" : l.type;
		addBucket(this.buckets, { type, thinking: l.thinking, asked: l.requestedThinking, model: l.model, agents: seat ? [] : [l.id] }, spend);
		this.addSession(l, spend, seat);
		if (seat) return;
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
				sessionName: l.sessionName,
			},
			spend,
		);
	}

	private addSession(l: Line, spend: Spend, seat: boolean): void {
		const sid = l.sessionId ?? "unknown";
		let s = this.sessions.get(sid);
		if (!s) {
			s = {
				...zeroSpend(),
				sessionId: sid,
				name: l.sessionName ?? "",
				cwd: l.cwd ?? "",
				agents: new Set(),
				seatCost: 0,
				seatMs: 0,
				agentCost: 0,
				agentMs: 0,
			};
			this.sessions.set(sid, s);
		}
		if (l.sessionName) s.name = l.sessionName;
		addSpend(s, spend);
		if (seat) {
			s.seatCost += spend.cost;
			s.seatMs += spend.activeMs;
		} else {
			s.agentCost += spend.cost;
			s.agentMs += spend.activeMs;
			s.agents.add(l.id);
		}
	}

	/** Fold another ledger's buckets and agents in (sessions are not needed where this is used). */
	merge(o: Ledger): void {
		for (const b of o.buckets.values()) addBucket(this.buckets, b, b);
		for (const a of o.agents.values()) addAgent(this.agents, a, a);
	}

	total(): number {
		let t = 0;
		for (const b of this.buckets.values()) t += b.cost;
		return t;
	}

	seatTotal(): number {
		let t = 0;
		for (const b of this.buckets.values()) if (b.type === "seat") t += b.cost;
		return t;
	}
}

const ISSUE_RE = /#(\d{2,6})\b/;

/** The session's own spend, rebuilt from its entries (assistant messages, compactions, branch summaries). */
function seatLinesFromEntries(entries: any[], info: { sessionId?: string; sessionName?: string; cwd?: string }): Line[] {
	const out: Line[] = [];
	let thinking = "default";
	for (const e of entries) {
		if (e.type === "thinking_level_change" && e.thinkingLevel) thinking = e.thinkingLevel;
		let u: any;
		let model: string | undefined;
		if (e.type === "message" && e.message?.role === "assistant") {
			u = e.message.usage;
			model = `${e.message.provider}/${e.message.model}`;
		} else if ((e.type === "compaction" || e.type === "branch_summary") && e.usage) {
			u = e.usage;
			model = e.type === "compaction" ? "(compaction)" : "(branch summary)";
		}
		if (!u) continue;
		out.push(seatLine(info, e.timestamp ?? new Date().toISOString(), model ?? "unknown", thinking, u));
	}
	return out;
}

function seatLine(info: { sessionId?: string; sessionName?: string; cwd?: string }, ts: string, model: string, thinking: string, u: any): Line {
	return {
		ts,
		...info,
		kind: "seat",
		id: info.sessionId ?? "unknown",
		type: "seat",
		description: info.sessionName ?? "",
		model,
		thinking,
		depth: 0,
		cost: num(u?.cost?.total),
		input: num(u?.input),
		output: num(u?.output),
		cacheRead: num(u?.cacheRead),
		cacheWrite: num(u?.cacheWrite),
	};
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
		if (b.type === "seat") continue;
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
	if (rows.length === 0) return `${title}: no spend recorded.`;
	const body = rows.map((b) => [
		b.type,
		thinkingLabel(b.thinking, b.asked),
		b.model,
		b.type === "seat" ? "-" : `${b.agents.size}`,
		b.type === "seat" || b.agents.size === 0 ? "-" : formatUsd(b.cost / b.agents.size),
		`${b.messages}`,
		formatTokens(b.input),
		formatTokens(b.output),
		formatTokens(b.cacheRead),
		formatTokens(b.cacheWrite),
		formatDuration(b.activeMs),
		formatUsd(b.cost),
	]);
	const agents = l.agents.size;
	const seat = l.seatTotal();
	const agentTime = rows.filter((b) => b.type !== "seat").reduce((s, b) => s + b.activeMs, 0);
	return [
		`${title}: ${formatUsd(l.total())} = seats ${formatUsd(seat)} + agents ${formatUsd(l.total() - seat)} (${agents} agent${agents === 1 ? "" : "s"}, ${formatDuration(agentTime)} of agent time)`,
		...table(["type", "thinking", "model", "agents", "avg", "msgs", "in", "out", "cache R", "cache W", "time", "cost"], body, [3, 4, 5, 6, 7, 8, 9, 10, 11]),
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
		`${title}: top ${shown.length} of ${rows.length} agents, ${formatUsd(l.total() - l.seatTotal())} agent total`,
		// Cost first, description last so a long one is all that gets cut.
		...table(["cost", "type/thinking", "model", "msgs", "time", "description"], body, [0, 3, 4]),
		...more,
	].join("\n");
}

function sessionsView(l: Ledger, title: string, topN = 25): string {
	const all = [...l.sessions.values()].sort((a, b) => b.cost - a.cost);
	if (all.length === 0) return `${title}: no spend recorded.`;
	const rows = all.slice(0, topN);
	const rest = all.slice(topN);
	const body = rows.map((s) => [
		formatUsd(s.cost),
		formatUsd(s.seatCost),
		formatDuration(s.seatMs),
		formatUsd(s.agentCost),
		`${s.agents.size}`,
		formatDuration(s.agentMs),
		s.name || `(unnamed ${s.sessionId.slice(0, 8)})`,
		s.cwd.replace(homedir(), "~"),
	]);
	const seat = l.seatTotal();
	return [
		`${title}: ${formatUsd(l.total())} = seats ${formatUsd(seat)} + agents ${formatUsd(l.total() - seat)}, across ${all.length} session${all.length === 1 ? "" : "s"}`,
		...table(["total", "seat", "seat time", "agents", "#", "agent time", "session", "cwd"], body, [0, 1, 2, 3, 4, 5]),
		...(rest.length ? [`… ${rest.length} more sessions, ${formatUsd(rest.reduce((t, s) => t + s.cost, 0))}`] : []),
	].join("\n");
}

/**
 * Agent spend per issue or PR number, taken from the first `#123` in each
 * agent's description. Numbers from different repos are not told apart; the
 * session column says where the work came from.
 */
function issuesView(l: Ledger, title: string, topN = AGENTS_TOP_N): string {
	const issues = new Map<string, { cost: number; ms: number; agents: number; sessions: Map<string, number> }>();
	let unattributed = 0;
	for (const a of l.agents.values()) {
		const m = ISSUE_RE.exec(a.description);
		if (!m) {
			unattributed += a.cost;
			continue;
		}
		const i = issues.get(m[1]) ?? { cost: 0, ms: 0, agents: 0, sessions: new Map() };
		i.cost += a.cost;
		i.ms += a.activeMs;
		i.agents++;
		const sn = a.sessionName || "?";
		i.sessions.set(sn, (i.sessions.get(sn) ?? 0) + a.cost);
		issues.set(m[1], i);
	}
	if (issues.size === 0) return `${title}: no agent description names an issue (#123).`;
	const rows = [...issues.entries()].sort((a, b) => b[1].cost - a[1].cost);
	const shown = rows.slice(0, topN);
	const body = shown.map(([n, i]) => [
		formatUsd(i.cost),
		`#${n}`,
		`${i.agents}`,
		formatUsd(i.cost / i.agents),
		formatDuration(i.ms),
		[...i.sessions.entries()].sort((a, b) => b[1] - a[1]).map(([s]) => s).slice(0, 2).join(", "),
	]);
	const attributed = rows.reduce((s, [, i]) => s + i.cost, 0);
	return [
		`${title}: ${formatUsd(attributed)} of agent spend names ${rows.length} issue${rows.length === 1 ? "" : "s"}; ${formatUsd(unattributed)} names none`,
		...table(["cost", "issue", "agents", "avg", "time", "sessions"], body, [0, 2, 3, 4]),
		...(rows.length > topN ? [`… ${rows.length - topN} more issues`] : []),
	].join("\n");
}

/** Local calendar day, YYYY-MM-DD. */
function localDay(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function tzName(): string {
	try {
		return new Intl.DateTimeFormat("en-US", { timeZoneName: "short" }).formatToParts(new Date()).find((p) => p.type === "timeZoneName")?.value ?? "local";
	} catch {
		return "local";
	}
}

type DailyBy = "day" | "model" | "session";

/**
 * Spend per local day, newest first, every day in the range listed.
 * by "day": one row per day. "model": rows per type/thinking/model.
 * "session": rows per session.
 */
function dailyView(lines: Line[], title: string, since: number, by: DailyBy, now = Date.now()): string {
	const days = new Map<string, Ledger>();
	for (const l of lines) {
		const day = localDay(Date.parse(l.ts));
		let d = days.get(day);
		if (!d) days.set(day, (d = new Ledger()));
		d.add(l);
	}
	if (days.size === 0) return `${title}: no spend recorded.`;
	const allDays: string[] = [];
	for (let t = now; ; t -= 86_400_000) {
		const day = localDay(t);
		if (allDays.at(-1) !== day) allDays.push(day);
		if (day <= localDay(since)) break;
	}
	let total = 0;
	let seat = 0;
	for (const d of days.values()) {
		total += d.total();
		seat += d.seatTotal();
	}
	const head = `${title}: ${formatUsd(total)} = seats ${formatUsd(seat)} + agents ${formatUsd(total - seat)}`;

	if (by === "day") {
		const body = allDays.map((day) => {
			const d = days.get(day);
			if (!d) return [day, "$0", "$0", "0", "0", "0", "$0"];
			let msgs = 0;
			for (const b of d.buckets.values()) msgs += b.messages;
			return [day, formatUsd(d.seatTotal()), formatUsd(d.total() - d.seatTotal()), `${d.agents.size}`, `${d.sessions.size}`, `${msgs}`, formatUsd(d.total())];
		});
		return [head, ...table(["day", "seats", "agents", "# agents", "sessions", "msgs", "total"], body, [1, 2, 3, 4, 5, 6])].join("\n");
	}

	const body: string[][] = [];
	const cols = by === "model" ? 8 : 7;
	const blank = (day: string) => [day, "-", ...Array(cols - 3).fill(""), "$0"];
	for (const day of allDays) {
		const d = days.get(day);
		if (!d) {
			body.push(blank(day));
			continue;
		}
		let rows: string[][];
		let restCount = 0;
		let restCost = 0;
		if (by === "model") {
			const sorted = [...d.buckets.values()].sort((a, b) => b.cost - a.cost);
			rows = sorted.slice(0, DAILY_TOP_N).map((b) => [
				b.type,
				thinkingLabel(b.thinking, b.asked),
				b.model.replace(/^openrouter\/~?/, ""),
				b.type === "seat" ? "-" : `${b.agents.size}`,
				`${b.messages}`,
				formatDuration(b.activeMs),
				formatUsd(b.cost),
			]);
			restCount = Math.max(0, sorted.length - DAILY_TOP_N);
			for (const b of sorted.slice(DAILY_TOP_N)) restCost += b.cost;
		} else {
			const sorted = [...d.sessions.values()].sort((a, b) => b.cost - a.cost);
			rows = sorted.slice(0, DAILY_TOP_N).map((x) => [
				x.name || `(unnamed ${x.sessionId.slice(0, 8)})`,
				formatUsd(x.seatCost),
				formatUsd(x.agentCost),
				`${x.agents.size}`,
				formatDuration(x.seatMs + x.agentMs),
				formatUsd(x.cost),
			]);
			restCount = Math.max(0, sorted.length - DAILY_TOP_N);
			for (const x of sorted.slice(DAILY_TOP_N)) restCost += x.cost;
		}
		rows.forEach((r, i) => body.push([i === 0 ? day : "", ...r]));
		if (restCount) body.push(["", `+${restCount} more`, ...Array(cols - 3).fill(""), formatUsd(restCost)]);
		if (rows.length > 1) body.push(["", "day total", ...Array(cols - 3).fill(""), formatUsd(d.total())]);
	}
	const header =
		by === "model"
			? ["day", "type", "thinking", "model", "agents", "msgs", "time", "cost"]
			: ["day", "session", "seat", "agents", "#", "time", "total"];
	const right = by === "model" ? [4, 5, 6, 7] : [2, 3, 4, 5, 6];
	return [head, ...table(header, body, right)].join("\n");
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

/** Ledger lines with ts >= since. Day files are UTC; lines are filtered by their own time. */
function readLedgerLines(since: number, now = Date.now()): { lines: Line[]; files: number; bad: number } {
	const lines: Line[] = [];
	let files = 0;
	let bad = 0;
	const lastDay = utcDay(new Date(now));
	for (let t = Date.parse(`${utcDay(new Date(since))}T00:00:00Z`); utcDay(new Date(t)) <= lastDay; t += 86_400_000) {
		const file = join(LEDGER_DIR, `${utcDay(new Date(t))}.jsonl`);
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
				const ts = Date.parse(l.ts);
				if (ts >= since && ts <= now) lines.push(l);
			} catch {
				bad++;
			}
		}
	}
	lines.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
	return { lines, files, bad };
}

/**
 * Seat sessions written to after `since` whose last write is well after their
 * last ledger line: their recent spend is not in the ledger yet. Agent sessions
 * (header has parentSession) are skipped; their parent stands for them.
 */
function staleSessions(lines: Line[], since: number, only?: Set<string>): { id: string; name: string; mtime: number }[] {
	const latest = new Map<string, number>();
	const names = new Map<string, string>();
	for (const l of lines) {
		if (!l.sessionId) continue;
		latest.set(l.sessionId, Math.max(latest.get(l.sessionId) ?? 0, Date.parse(l.ts)));
		if (l.sessionName) names.set(l.sessionId, l.sessionName);
	}
	const out: { id: string; name: string; mtime: number }[] = [];
	let dirs: string[] = [];
	try {
		dirs = readdirSync(SESSIONS_DIR);
	} catch {
		return out;
	}
	for (const dir of dirs) {
		let files: string[] = [];
		try {
			files = readdirSync(join(SESSIONS_DIR, dir)).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const f of files) {
			const m = /_([0-9a-f-]{36})\.jsonl$/.exec(f);
			if (!m || (only && !only.has(m[1]))) continue;
			const path = join(SESSIONS_DIR, dir, f);
			let mtime = 0;
			try {
				mtime = statSync(path).mtimeMs;
			} catch {
				continue;
			}
			if (mtime < since || mtime <= (latest.get(m[1]) ?? 0) + STALE_SLACK_MS) continue;
			let head = "";
			try {
				const fd = openSync(path, "r");
				const buf = Buffer.alloc(4096);
				head = buf.subarray(0, readSync(fd, buf, 0, 4096, 0)).toString("utf8");
				closeSync(fd);
			} catch {
				continue;
			}
			if (head.split("\n", 1)[0].includes('"parentSession"')) continue;
			out.push({ id: m[1], name: names.get(m[1]) ?? /"type":"session_info"[^\n]*?"name":"([^"]*)"/.exec(head)?.[1] ?? `(unnamed ${m[1].slice(0, 8)})`, mtime });
		}
	}
	return out.sort((a, b) => b.mtime - a.mtime);
}

function lastBackfill(): number | undefined {
	try {
		return statSync(join(LEDGER_DIR, ".last-backfill")).mtimeMs;
	} catch {
		return undefined;
	}
}

// ---------- command parsing ----------

type View = "types" | "agents" | "sessions" | "issues" | "daily";
type Range = { kind: "session" } | { kind: "since"; since: number; label: string };

const USAGE = "Usage: /subagent-cost [types|agents|sessions|issues|daily] [session|today|week|<N>d|<N>h] [session:<name|id|this|all>]";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function parseArgs(args: string, now = Date.now()): { view: View; range: Range; filter?: string } | { error: string } {
	let view: View | undefined;
	let range: Range | undefined;
	let filter: string | undefined;
	let wholeDays: number | undefined;
	const midnight = new Date(now);
	midnight.setHours(0, 0, 0, 0);
	for (const tok of args.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
		if (tok === "types" || tok === "agents" || tok === "sessions" || tok === "issues" || tok === "daily") view = tok;
		else if (tok === "session") range = { kind: "session" };
		else if (tok.startsWith("session:") && tok.length > 8) filter = tok.slice(8);
		else if (tok === "today") range = { kind: "since", since: midnight.getTime(), label: `today (since local midnight, ${tzName()})` };
		else if (tok === "week") {
			range = { kind: "since", since: now - 7 * 86_400_000, label: "last 7 days" };
			wholeDays = 7;
		}
		else if (/^\d+[dh]$/.test(tok)) {
			const n = Math.max(1, Math.min(tok.endsWith("d") ? 366 : 24 * 366, Number.parseInt(tok, 10)));
			const hours = tok.endsWith("d") ? n * 24 : n;
			range = { kind: "since", since: now - hours * 3_600_000, label: tok.endsWith("d") ? `last ${plural(n, "day")}` : `last ${plural(n, "hour")}` };
			wholeDays = tok.endsWith("d") ? n : undefined;
		} else return { error: `Unknown argument "${tok}". ${USAGE}` };
	}
	if (!range) {
		if (filter || view === "daily") {
			range = { kind: "since", since: now - 7 * 86_400_000, label: "last 7 days" };
			wholeDays = 7;
		}
		else if (view === "sessions") range = { kind: "since", since: midnight.getTime(), label: `today (since local midnight, ${tzName()})` };
		else range = { kind: "session" };
	}
	// A ledger range reads as days; this session alone stays one table.
	view ??= range.kind === "since" ? "daily" : "types";
	// Per-day tables use whole local days: <N>d = today and the N-1 days before.
	if (view === "daily" && range.kind === "since" && wholeDays) {
		const start = new Date(midnight);
		start.setDate(start.getDate() - (wholeDays - 1));
		range = { kind: "since", since: start.getTime(), label: `last ${plural(wholeDays, "day")}, today included` };
	}
	if (range.kind === "session" && (view === "sessions" || view === "daily" || filter))
		return { error: `That needs a ledger range (today, week, <N>d or <N>h), not "session". ${USAGE}` };
	return { view, range, filter };
}

/** Session ids a filter matches: "this", exact name, id prefix, then name substring. */
function matchSessions(lines: Line[], filter: string, currentId?: string): Map<string, string> {
	const names = new Map<string, string>();
	for (const l of lines) if (l.sessionId) names.set(l.sessionId, l.sessionName ?? names.get(l.sessionId) ?? "");
	if (filter === "all") return names;
	if (filter === "this") return new Map(currentId ? [[currentId, names.get(currentId) ?? "this session"]] : []);
	const pick = (f: (id: string, name: string) => boolean) => new Map([...names].filter(([id, n]) => f(id, n.toLowerCase())));
	for (const m of [pick((_, n) => n === filter), pick((id) => id.startsWith(filter)), pick((_, n) => n.includes(filter))]) if (m.size) return m;
	return new Map();
}

const COMPLETIONS = [
	["", "This session, by type and thinking"],
	["agents", "This session's most expensive agents"],
	["today", "All sessions today"],
	["week", "All sessions, total per day, last 7 days"],
	["types week", "All sessions, last 7 days, one total per type and thinking"],
	["agents today", "Most expensive agents today, all sessions"],
	["agents week", "Most expensive agents, last 7 days"],
	["sessions", "Spend per session today"],
	["sessions week", "Spend per session, last 7 days"],
	["issues week", "Agent spend per issue/PR number, last 7 days"],
	["issues 30d", "Agent spend per issue/PR number, last 30 days"],
	["30d", "All sessions, total per day, last 30 days"],
	["types 30d", "All sessions, last 30 days, one total per type and thinking"],
	["24h", "All sessions, last 24 hours"],
	["session:this", "This session per day per model, last 7 days"],
	["session:this 30d", "This session per day per model, last 30 days"],
	["session:all week", "Every session's spend per day, last 7 days"],
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

	// Seat owner: the first instance in this process. At startup and after
	// /reload the root session's factories run before any in-process child
	// exists, so claiming here wins; a child finds the slot taken.
	const instanceId = randomUUID();
	const g = globalThis as Record<symbol, unknown>;
	if (g[SEAT_OWNER_KEY] === undefined) g[SEAT_OWNER_KEY] = instanceId;
	const isSeatOwner = () => g[SEAT_OWNER_KEY] === instanceId;

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
			const headless = !sm?.getSessionFile?.();
			return { sessionId: sm?.getSessionId(), sessionName: sm?.getSessionName() ?? (headless ? "(no session file)" : undefined), cwd: ctxRef?.cwd };
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

	const recordSeat = (model: string, u: any) => {
		if (!isSeatOwner() || !u) return;
		let thinking = "default";
		try {
			thinking = pi.getThinkingLevel() || "default";
		} catch {}
		const line = seatLine(sessionInfo(), new Date().toISOString(), model, thinking, u);
		if (!line.cost && !line.input && !line.output && !line.cacheRead && !line.cacheWrite) return;
		if (!appendLedger(line)) ledgerFailures++;
	};

	pi.on("message_end", async (event) => {
		const m = event.message as any;
		if (m?.role === "assistant") recordSeat(`${m.provider}/${m.model}`, m.usage);
	});
	pi.on("session_compact", async (event) => recordSeat("(compaction)", (event.compactionEntry as any)?.usage));
	pi.on("session_tree", async (event) => recordSeat("(branch summary)", (event.summaryEntry as any)?.usage));

	// Natural points to persist. `disposed` is pi-subagents' end of shutdown,
	// after the agents it aborted have reported their last messages.
	pi.events.on("subagents:completed", () => flush());
	pi.events.on("subagents:failed", () => flush());
	pi.events.on("subagents:disposed", () => flush());

	pi.on("session_start", async (_event, ctx) => {
		ctxRef = ctx;
		if (g[SEAT_OWNER_KEY] === undefined) g[SEAT_OWNER_KEY] = instanceId;
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
		if (isSeatOwner()) delete g[SEAT_OWNER_KEY];
	});

	pi.registerCommand("subagent-cost", {
		description: "Seat and subagent spend: [types|agents|sessions|issues|daily] [session|today|week|<N>d|<N>h] [session:<name|id|this|all>]",
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
			let lines: Line[] = [];
			let title: string;
			const notes: string[] = [];
			if (parsed.range.kind === "session") {
				// The seat's own spend comes straight from this session's entries;
				// the agents' from the running totals.
				ledger = new Ledger();
				let info = {};
				try {
					info = { sessionId: ctx.sessionManager.getSessionId(), sessionName: ctx.sessionManager.getSessionName(), cwd: ctx.cwd };
				} catch {}
				for (const line of seatLinesFromEntries(ctx.sessionManager.getEntries() as any[], info)) ledger.add(line);
				ledger.merge(session);
				title = "This session";
			} else {
				const r = readLedgerLines(parsed.range.since);
				lines = r.lines;
				title = `All sessions, ${parsed.range.label}`;
				let only: Set<string> | undefined;
				if (parsed.filter) {
					let currentId: string | undefined;
					try {
						currentId = ctx.sessionManager.getSessionId();
					} catch {}
					const matched = matchSessions(lines, parsed.filter, currentId);
					only = new Set(matched.keys());
					lines = lines.filter((l) => l.sessionId && only!.has(l.sessionId));
					const who = parsed.filter === "all" ? [] : [...matched].map(([id, n]) => `${n || "(unnamed)"} ${id.slice(0, 13)}`);
					title = parsed.filter === "all"
						? `All sessions, ${parsed.range.label}`
						: matched.size
						? `${matched.size === 1 ? "Session" : `${matched.size} sessions`} ${who.slice(0, 4).join(", ")}${who.length > 4 ? ", …" : ""}, ${parsed.range.label}`
						: `No session matching "${parsed.filter}" has spend in the ledger, ${parsed.range.label}`;
					if (!matched.size) notes.push("A session that has not reloaded since seat tracking is in the ledger only after a backfill run.");
				}
				if (parsed.view === "daily") title += `, per local day (${tzName()})`;
				ledger = new Ledger();
				for (const l of lines) ledger.add(l);
				if (r.files === 0) notes.push(`No ledger files in ${LEDGER_DIR.replace(homedir(), "~")} for this range.`);
				if (r.bad > 0) notes.push(`${r.bad} malformed ledger line(s) skipped.`);
				if (!parsed.filter || only?.size) {
					const stale = staleSessions(r.lines, parsed.range.since, only);
					if (stale.length) {
						const lb = lastBackfill();
						const names = stale.map((x) => x.name);
						notes.push(
							`Incomplete: ${plural(stale.length, "session")} spent after ${lb ? `the last backfill (${new Date(lb).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})` : "their last ledger line"} and ${stale.length === 1 ? "has" : "have"} not reloaded, so that spend is not counted yet: ${names.slice(0, 6).join(", ")}${names.length > 6 ? `, +${names.length - 6} more` : ""}. /reload there, or wait for the hourly backfill.`,
						);
					}
				}
			}
			if (ledgerFailures > 0) notes.push(`${ledgerFailures} ledger write(s) failed in this session.`);
			const text =
				parsed.view === "daily"
					? dailyView(
							lines,
							title,
							parsed.range.kind === "since" ? parsed.range.since : 0,
							!parsed.filter ? "day" : parsed.filter === "all" ? "session" : "model",
						)
					: { types: typesView, agents: agentsView, sessions: sessionsView, issues: issuesView }[parsed.view](ledger, title);
			ctx.ui.notify([text, ...notes].join("\n"), "info");
		},
	});
}
