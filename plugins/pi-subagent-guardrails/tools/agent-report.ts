#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * agent-report: measure what each pi subagent spent, and where, from its transcript.
 *
 * Reads pi-subagents task transcripts (`<tmp>/pi-subagents-<uid>/<cwd>/<parent-session-id>/tasks/<agent>.output`,
 * one JSON record per line) and pi session files (`~/.pi/agent/sessions/<dir>/<stamp>_<id>.jsonl`). For each agent it
 * reports turns, peak and lifetime context, the cost split, the largest tool results, build/test/git counts, the
 * milestones (first code edit, first commit, first push, the context-wall notices), and violations of the dispatch
 * rules in guardrails.md. With --session <parent session file> it also reads each agent's type, description and
 * status, and the watchdog's audit entries (check-ins, hard stops, model violations).
 *
 * Usage:
 *   agent-report [--session <parent.jsonl>] [--json] [--top N] [--since ISO] [--agent <id-prefix>]
 *                [--forbid-path <regex>]... [paths...]
 * Paths are files or directories (scanned for *.output and *.jsonl). With --session and no paths, the task directory
 * of that session is found under $TMPDIR/pi-subagents-*.
 *
 * Measures (all from the provider's own usage records, none estimated except tool-result tokens = chars / 4):
 *   context   = input + cacheRead + cacheWrite of one call (what that turn re-read)
 *   lifetime  = sum of input + output + cacheWrite over all calls (the watchdog's hard-stop measure)
 *   judged    = max(context, lifetime so far) (the context wall's measure)
 *   base      = the first turn's context: the fixed per-agent overhead (system prompt, tool schemas, brief)
 *   mean      = average context per turn; turns × mean is roughly what the agent re-read, the bulk of its cost
 * Zero dependencies. Node 22.6+ (type stripping).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

type Json = Record<string, any>;
interface Call { id: string; name: string; args: Json; turn: number; t: number }
interface Result { callId: string; name: string; chars: number; text: string; isError: boolean }
interface Violation { rule: string; turn: number; detail: string }
interface Milestone { turn: number; minute: number; judged: number }

const args = process.argv.slice(2);
const opt = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (name: string) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
if (flag("--help") || flag("-h")) { console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0]); process.exit(0); }
const asJson = flag("--json");
const top = Number(opt("--top") ?? 5);
const since = opt("--since");
const agentPrefix = opt("--agent");
const sessionPath = opt("--session");
const forbid: RegExp[] = [];
for (let v = opt("--forbid-path"); v !== undefined; v = opt("--forbid-path")) forbid.push(new RegExp(v));

// ---- thresholds (the numbers guardrails.md and the context wall use) ----
const T = { nudge: 100_000, handoff: 150_000, warn2: 200_000, wall: 250_000, finalWords: 400, testOutChars: 4_000, readChars: 12_000, outChars: 16_000 };

const readJsonl = (p: string): Json[] => readFileSync(p, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const ts = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN);
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${Math.round(n)}`);
const usd = (n: number) => `$${n.toFixed(2)}`;
const textOf = (content: unknown): string => Array.isArray(content) ? content.map((c: Json) => (c?.type === "text" ? c.text ?? "" : "")).join("") : typeof content === "string" ? content : "";

// ---- parent session: agent records and watchdog audit ----
const records = new Map<string, Json>();
const audit = new Map<string, Json[]>();
if (sessionPath) {
  for (const e of readJsonl(sessionPath)) {
    if (e.customType === "subagents:record" && e.data?.id) records.set(e.data.id, { ...records.get(e.data.id), ...e.data });
    if (e.customType === "subagent-watchdog-audit" && e.data?.agentId) (audit.get(e.data.agentId) ?? audit.set(e.data.agentId, []).get(e.data.agentId)!).push(e.data);
  }
}

// ---- inputs ----
let paths = args.slice();
if (paths.length === 0 && sessionPath) {
  const sid = basename(sessionPath).replace(/\.jsonl$/, "").split("_").pop()!;
  for (const root of readdirSync(tmpdir()).filter((d) => d.startsWith("pi-subagents-")).map((d) => join(tmpdir(), d))) {
    for (const cwdDir of readdirSync(root)) { const p = join(root, cwdDir, sid, "tasks"); if (existsSync(p)) paths.push(p); }
  }
}
if (paths.length === 0) { console.error("agent-report: give transcript paths, or --session <parent session .jsonl>. --help for usage."); process.exit(2); }
const files = paths.flatMap((p) => statSync(p).isDirectory() ? readdirSync(p).filter((f) => /\.(output|jsonl)$/.test(f)).map((f) => join(p, f)) : [p]);

// Thinking level and model per agent from its own pi session file, when the harness wrote one.
const sessionsDir = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "sessions");
const childSession = (agentId: string): Json[] => {
  try {
    const dir = readdirSync(sessionsDir).find((d) => d.includes(`pi-agent-${agentId}`));
    if (!dir) return [];
    const f = readdirSync(join(sessionsDir, dir)).find((x) => x.endsWith(".jsonl"));
    return f ? readJsonl(join(sessionsDir, dir, f)).filter((e) => e.type !== "message") : [];
  } catch { return []; }
};

// ---- command classification ----
const segments = (cmd: string) => cmd.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
const piped = (cmd: string) => /\|\s*(grep|tail|head|wc|sed -n|cut|awk|jq|sort|uniq)\b/.test(cmd) || /\s-q\s|--jq\b|>\s*\S+/.test(cmd);
const isTest = (s: string) => /\bdotnet\s+test\b|\bdotnet\s+\S*Tests?\.dll\b|\bvitest\b|\bnpm\s+(run\s+)?test\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b/.test(s);
const isTargeted = (s: string) => /\s-(class|method|namespace)\b|--filter\b|\s-t\s|--testNamePattern|\s-k\s|\bvitest\s+(run\s+)?\S+\.(test|spec)\./.test(s);
const isBuild = (s: string) => /\bdotnet\s+build\b|\bmsbuild\b|\bnpm\s+run\s+build\b|\btsc\b|\bcargo\s+build\b|\bgo\s+build\b/.test(s);
const argSummary = (c: Call) => {
  const a = c.args ?? {};
  if (typeof a.command === "string") return a.command.replace(/\s+/g, " ").slice(0, 110);
  if (typeof a.path === "string") return `${a.path.replace(/^.*\/(pi-agent-[^/]+)\//, "<wt>/")}${a.offset != null || a.limit != null ? ` [${a.offset ?? 1}+${a.limit ?? "∞"}]` : ""}`;
  return JSON.stringify(a).slice(0, 110);
};
const isNote = (p: string) => /\.(md|txt)$/i.test(p);
const tmpish = (p: string) => /^(\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/)/.test(p);

// ---- per-agent analysis ----
function analyze(file: string) {
  const entries = readJsonl(file);
  const msgs = entries.flatMap((e) => {
    if (e.type === "message" && e.message) return [{ ...e.message, _t: ts(e.timestamp ?? e.message.timestamp), _cwd: e.cwd }];
    if ((e.type === "assistant" || e.type === "toolResult" || e.type === "user") && e.message) return [{ ...e.message, role: e.message.role ?? e.type, _t: ts(e.timestamp ?? e.message.timestamp), _cwd: e.cwd, _agent: e.agentId }];
    return [];
  });
  if (msgs.length === 0) return null;
  const agentId: string = msgs.find((m) => m._agent)?._agent ?? basename(file).replace(/\.(output|jsonl)$/, "").split("_").pop()!;
  const cwd: string = msgs.find((m) => m._cwd)?._cwd ?? entries.find((e) => e.type === "session")?.cwd ?? "";
  const meta = [...entries.filter((e) => e.type !== "message"), ...childSession(agentId)];
  const rec = records.get(agentId) ?? {};
  const t0 = msgs[0]._t;
  const minute = (t: number) => (Number.isFinite(t) && Number.isFinite(t0) ? (t - t0) / 60_000 : NaN);

  const calls: Call[] = []; const results = new Map<string, Result>(); const v: Violation[] = [];
  const tok = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }; const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let turn = 0, peak = 0, peakTurn = 0, lifetime = 0, baseContext = 0, contextSum = 0, finalText = "", models = new Set<string>();
  const judgedAt: number[] = []; const ms: Record<string, Milestone | undefined> = {};
  const mark = (name: string, t: number) => { ms[name] ??= { turn, minute: minute(t), judged: judgedAt[turn - 1] ?? 0 }; };
  const wallNotices: Milestone[] = []; let wallBlocks = 0, userMsgs = 0;

  for (const m of msgs) {
    if (m.role === "user") { userMsgs++; continue; }
    if (m.role === "assistant") {
      turn++;
      const u = m.usage ?? {};
      for (const key of Object.keys(tok) as (keyof typeof tok)[]) tok[key] += Number(u[key] ?? 0);
      for (const key of Object.keys(cost) as (keyof typeof cost)[]) cost[key] += Number(u.cost?.[key] ?? 0);
      const ctx = Number(u.input ?? 0) + Number(u.cacheRead ?? 0) + Number(u.cacheWrite ?? 0);
      lifetime += Number(u.input ?? 0) + Number(u.output ?? 0) + Number(u.cacheWrite ?? 0);
      if (turn === 1) baseContext = ctx;
      contextSum += ctx;
      if (ctx > peak) { peak = ctx; peakTurn = turn; }
      const judged = Math.max(ctx, lifetime); judgedAt.push(judged);
      for (const [name, bar] of [["nudge", T.nudge], ["handoff", T.handoff], ["warn2", T.warn2], ["wall", T.wall]] as const) if (judged >= bar) mark(`crossed ${name} ${k(bar)}`, m._t);
      if (m.model) models.add(m.model);
      const text = (m.content ?? []).filter((c: Json) => c.type === "text").map((c: Json) => c.text).join("");
      if (text.trim()) finalText = text;
      for (const c of m.content ?? []) {
        if (c.type !== "toolCall" && c.type !== "tool_use") continue;
        const call: Call = { id: c.id, name: c.name, args: c.arguments ?? c.input ?? {}, turn, t: m._t }; calls.push(call);
        const cmd = typeof call.args.command === "string" ? call.args.command : "";
        const path = typeof call.args.path === "string" ? call.args.path : "";
        if ((call.name === "write" || call.name === "edit") && path) {
          if (!isNote(path)) mark("first code edit", m._t);
          if (path.startsWith("/") && cwd && !path.startsWith(cwd) && !tmpish(path)) v.push({ rule: "edit-outside-worktree", turn, detail: path });
          for (const re of forbid) if (re.test(path)) v.push({ rule: "forbidden-path", turn, detail: path });
        }
        if (cmd) {
          if (/\bgit\b[^|;&]*\bcommit\b/.test(cmd)) mark("first commit", m._t);
          if (/\bgit\b[^|;&]*\bpush\b/.test(cmd)) mark("first push", m._t);
          if (/\bgh\s+pr\s+create\b|gh-pm\.sh\s+pr\s+create\b/.test(cmd)) mark("PR created", m._t);
          if (/push\s+(-f\b|--force\b)|reset\s+--hard|clean\s+-f|checkout\s+\.(\s|$)|branch\s+-D\b|--no-verify/.test(cmd)) v.push({ rule: "destructive-git", turn, detail: cmd.slice(0, 100) });
          if (/\bpkill\b|\bkillall\b/.test(cmd)) v.push({ rule: "kill-by-name", turn, detail: cmd.slice(0, 100) });
          for (const re of forbid) for (const s of segments(cmd)) if (/\b(sed\s+-i|tee|cp|mv)\b|>/.test(s) && re.test(s)) v.push({ rule: "forbidden-path", turn, detail: s.slice(0, 100) });
        }
      }
      continue;
    }
    if (m.role === "toolResult") {
      const text = textOf(m.content); const r: Result = { callId: m.toolCallId, name: m.toolName, chars: text.length, text, isError: !!m.isError };
      results.set(r.callId, r);
      if (/\[context-wall\]/.test(text)) wallNotices.push({ turn, minute: minute(m._t), judged: judgedAt[turn - 1] ?? 0 });
      if (/^context-wall:|context-wall: you (are|have)/.test(text) && r.isError) wallBlocks++;
    }
  }

  // ---- build / test / git counts and output-rule checks, per call ----
  const count = { builds: 0, testsTargeted: 0, testsFull: 0, commits: 0, pushes: 0, prCreates: 0, dockerRuns: 0, reads: 0, readsUnbounded: 0, bashCalls: 0 };
  for (const c of calls) {
    const r = results.get(c.id); const size = r?.chars ?? 0;
    const cmd = typeof c.args.command === "string" ? c.args.command : "";
    if (c.name === "read") {
      count.reads++;
      const unbounded = c.args.limit == null;
      if (unbounded) count.readsUnbounded++;
      if (unbounded && size > T.readChars) v.push({ rule: "read-unbounded", turn: c.turn, detail: `${argSummary(c)} → ${k(size / 4)} tok` });
      else if (size > T.outChars) v.push({ rule: "output-uncapped", turn: c.turn, detail: `${argSummary(c)} → ${k(size / 4)} tok` });
      continue;
    }
    if (!cmd) { if (size > T.outChars) v.push({ rule: "output-uncapped", turn: c.turn, detail: `${c.name} ${argSummary(c)} → ${k(size / 4)} tok` }); continue; }
    count.bashCalls++;
    const segs = segments(cmd);
    let tested = false;
    for (const s of segs) {
      if (isBuild(s)) count.builds++;
      if (isTest(s)) { tested = true; if (isTargeted(s)) count.testsTargeted++; else count.testsFull++; }
      if (/\bgit\b.*\bcommit\b/.test(s)) count.commits++;
      if (/\bgit\b.*\bpush\b/.test(s)) count.pushes++;
      if (/\bpr\s+create\b/.test(s)) count.prCreates++;
      if (/\bdocker\s+run\b/.test(s)) count.dockerRuns++;
    }
    if (tested && !piped(cmd) && size > T.testOutChars) v.push({ rule: "test-output-uncapped", turn: c.turn, detail: `${cmd.slice(0, 90)} → ${k(size / 4)} tok` });
    else if (/^\s*cat\s+[^|]+$/.test(cmd) && size > T.readChars) v.push({ rule: "read-unbounded", turn: c.turn, detail: `${cmd.slice(0, 90)} → ${k(size / 4)} tok` });
    else if (size > T.outChars) v.push({ rule: "output-uncapped", turn: c.turn, detail: `${cmd.slice(0, 90)} → ${k(size / 4)} tok` });
  }
  if (count.testsFull > 1) v.push({ rule: "full-suite-repeated", turn: 0, detail: `${count.testsFull} full test runs (the rule is one, at the end)` });
  const words = finalText.trim() ? finalText.trim().split(/\s+/).length : 0;
  if (words > T.finalWords) v.push({ rule: "final-message-long", turn, detail: `${words} words` });
  if (/\b(wait|waiting)\b[^.]{0,60}\b(notification|notified|background)\b|I'?ll be notified/i.test(finalText)) v.push({ rule: "waits-on-notification", turn, detail: finalText.slice(0, 100).replace(/\s+/g, " ") });
  const lastCodeEdit = Math.max(0, ...calls.filter((c) => (c.name === "write" || c.name === "edit") && !isNote(String(c.args.path ?? ""))).map((c) => c.turn));
  const lastPush = Math.max(0, ...calls.filter((c) => /\bgit\b[^|;&]*\bpush\b/.test(String(c.args.command ?? ""))).map((c) => c.turn));
  if (lastCodeEdit > 0 && lastCodeEdit > lastPush) v.push({ rule: "unpushed-at-end", turn: lastCodeEdit, detail: lastPush ? `code edited at turn ${lastCodeEdit}, last push at turn ${lastPush}` : "code edited, never pushed" });
  const handoff = ms[`crossed handoff ${k(T.handoff)}`];
  if (handoff) {
    const pushedBy = ms["first push"];
    const after = (pushedBy && pushedBy.turn > handoff.turn ? pushedBy.turn : turn) - handoff.turn;
    if (!pushedBy || pushedBy.turn > handoff.turn) v.push({ rule: "past-handoff-unpushed", turn: handoff.turn, detail: `${after} turns past ${k(T.handoff)} before ${pushedBy ? "the first push" : "the end (never pushed)"}` });
  }

  const toolChars = [...results.values()].reduce((a, r) => a + r.chars, 0);
  const byTool: Record<string, { calls: number; tokens: number }> = {};
  for (const c of calls) { const b = (byTool[c.name] ??= { calls: 0, tokens: 0 }); b.calls++; b.tokens += (results.get(c.id)?.chars ?? 0) / 4; }
  const largest = calls.map((c) => ({ turn: c.turn, tool: c.name, tokens: Math.round((results.get(c.id)?.chars ?? 0) / 4), what: argSummary(c) })).sort((a, b) => b.tokens - a.tokens).slice(0, top);
  const thinking = meta.filter((e) => e.type === "thinking_level_change").map((e) => e.thinkingLevel).pop()
    ?? (audit.get(agentId) ?? []).map((a) => String(a.checkIn?.model ?? a.model ?? "").match(/thinking (\w+)/)?.[1]).find(Boolean);
  const firstEdit = ms["first code edit"];
  return {
    agentId, file, type: rec.type, description: rec.description ?? textOf(msgs.find((m) => m.role === "user")?.content).split("\n")[0].slice(0, 80),
    status: rec.status ?? null, models: [...models], thinking: thinking ?? null, startedAt: new Date(t0).toISOString(), minutes: minute(msgs[msgs.length - 1]._t),
    turns: turn, toolCalls: calls.length, followUps: Math.max(0, userMsgs - 1),
    baseContext, meanContext: turn ? Math.round(contextSum / turn) : 0, peakContext: peak, peakTurn, lifetime, tokens: tok, cost, thinkingShareOfOutput: tok.output ? tok.reasoning / tok.output : 0,
    toolResultTokens: Math.round(toolChars / 4), byTool, largest, counts: count, milestones: ms, wallNotices, wallBlocks,
    beforeFirstEdit: firstEdit ? { turns: firstEdit.turn, judged: firstEdit.judged } : { turns: turn, judged: judgedAt[turn - 1] ?? 0, never: true },
    finalWords: words, violations: v, watchdog: (audit.get(agentId) ?? []).map((a) => ({ kind: a.kind, at: a.recordedAt, reason: a.reason ?? a.breaches?.map((b: Json) => `${b.name} ${k(b.value)}`).join(", ") })),
  };
}

const reports = files.map(analyze).filter((r): r is NonNullable<ReturnType<typeof analyze>> => r !== null)
  .filter((r) => !agentPrefix || r.agentId.startsWith(agentPrefix)).filter((r) => !since || Date.parse(r.startedAt) >= Date.parse(since))
  .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

if (asJson) { console.log(JSON.stringify(reports, null, 2)); process.exit(0); }

// ---- markdown ----
const out: string[] = [];
const sum = (f: (r: (typeof reports)[number]) => number) => reports.reduce((a, r) => a + f(r), 0);
out.push(`# agent-report: ${reports.length} agent(s), ${usd(sum((r) => r.cost.total))} total`, "");
out.push("| agent | type | thinking | min | turns | base / mean / peak ctx | lifetime | cost | out+think share | tool-result tok | 1st code edit (turn @ judged) | pushed | full / targeted tests | violations |");
out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const r of reports) {
  const fe = r.milestones["first code edit"]; const fp = r.milestones["first push"];
  out.push(`| ${r.agentId.slice(0, 8)} ${r.description ? `(${r.description.slice(0, 32)})` : ""} | ${r.type ?? "?"} | ${r.thinking ?? "?"} | ${r.minutes.toFixed(0)} | ${r.turns} | ${k(r.baseContext)} / ${k(r.meanContext)} / ${k(r.peakContext)} | ${k(r.lifetime)} | ${usd(r.cost.total)} | ${(r.cost.total ? (r.cost.output / r.cost.total) * 100 : 0).toFixed(0)}% / ${(r.thinkingShareOfOutput * 100).toFixed(0)}% | ${k(r.toolResultTokens)} | ${fe ? `${fe.turn} @ ${k(fe.judged)}` : "never"} | ${fp ? `turn ${fp.turn}` : "no"} | ${r.counts.testsFull} / ${r.counts.testsTargeted} | ${r.violations.length} |`);
}
out.push("", "Cost split, all agents: " + (["input", "output", "cacheRead", "cacheWrite"] as const).map((key) => `${key} ${usd(sum((r) => r.cost[key]))} (${((sum((r) => r.cost[key]) / Math.max(1e-9, sum((r) => r.cost.total))) * 100).toFixed(0)}%)`).join(", "));
const vc: Record<string, number> = {}; for (const r of reports) for (const x of r.violations) vc[x.rule] = (vc[x.rule] ?? 0) + 1;
out.push("Violations by rule: " + (Object.entries(vc).sort((a, b) => b[1] - a[1]).map(([rule, n]) => `${rule} ${n}`).join(", ") || "none"), "");
for (const r of reports) {
  out.push(`## ${r.agentId} — ${r.description ?? ""}`, "");
  out.push(`${r.type ?? "?"} · ${r.models.join(", ")} · thinking ${r.thinking ?? "?"} · ${r.status ?? "?"} · started ${r.startedAt} · ${r.minutes.toFixed(1)} min · ${r.turns} turns · ${r.toolCalls} tool calls · ${r.followUps} follow-up(s)`, "");
  out.push(`- Context: first turn ${k(r.baseContext)} (the fixed cost of the system prompt, tools and brief), mean ${k(r.meanContext)}, peak ${k(r.peakContext)} (turn ${r.peakTurn}); lifetime ${k(r.lifetime)}. Tool results total ≈${k(r.toolResultTokens)} tokens.`);
  out.push(`- Tokens: input ${k(r.tokens.input)}, output ${k(r.tokens.output)} (reasoning ${k(r.tokens.reasoning)}), cacheRead ${k(r.tokens.cacheRead)}, cacheWrite ${k(r.tokens.cacheWrite)}.`);
  out.push(`- Cost ${usd(r.cost.total)}: input ${usd(r.cost.input)}, output ${usd(r.cost.output)}, cacheRead ${usd(r.cost.cacheRead)}, cacheWrite ${usd(r.cost.cacheWrite)}.`);
  out.push(`- Before the first code edit: ${r.beforeFirstEdit.turns} turns, judged ${k(r.beforeFirstEdit.judged)}${"never" in r.beforeFirstEdit ? " (no code edit at all)" : ""}.`);
  const c = r.counts;
  out.push(`- Builds ${c.builds}; test runs ${c.testsFull} full / ${c.testsTargeted} targeted; commits ${c.commits}; pushes ${c.pushes}; PRs created ${c.prCreates}; docker runs ${c.dockerRuns}; reads ${c.reads} (${c.readsUnbounded} without a limit); bash ${c.bashCalls}.`);
  out.push(`- Milestones: ${Object.entries(r.milestones).map(([n, m]) => `${n} turn ${m!.turn} (${m!.minute.toFixed(0)} min, ${k(m!.judged)})`).join("; ") || "none"}.`);
  out.push(`- Context wall: ${r.wallNotices.length} notice(s)${r.wallNotices.length ? ` at turns ${r.wallNotices.map((w) => w.turn).join(", ")}` : ""}; ${r.wallBlocks} blocked call(s). Final message ${r.finalWords} words.`);
  if (r.watchdog.length) out.push(`- Watchdog: ${r.watchdog.map((w) => `${w.kind}${w.reason ? ` (${w.reason})` : ""}`).join("; ")}.`);
  out.push(`- By tool: ${Object.entries(r.byTool).sort((a, b) => b[1].tokens - a[1].tokens).map(([n, b]) => `${n} ${b.calls}× ≈${k(b.tokens)}`).join(", ")}.`, "");
  out.push(`Largest tool results:`, "", "| turn | tool | ≈tokens | call |", "|---|---|---|---|");
  for (const l of r.largest) out.push(`| ${l.turn} | ${l.tool} | ${k(l.tokens)} | \`${l.what.replace(/\|/g, "\\|").replace(/`/g, "'")}\` |`);
  out.push("");
  if (r.violations.length) { out.push("Violations:", ""); for (const x of r.violations) out.push(`- **${x.rule}**${x.turn ? ` (turn ${x.turn})` : ""}: ${x.detail.replace(/\s+/g, " ")}`); out.push(""); }
}
console.log(out.join("\n"));
