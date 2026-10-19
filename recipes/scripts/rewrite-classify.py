#!/usr/bin/env python3
"""Name a cause for every cache rewrite, using pi session logs only.

Usage:
  rewrite-classify.py [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--min-write N]
                      [--csv FILE] [--validate] [--list] [SESSION.jsonl ...]

With no files, it reads every session under ~/.pi/agent/sessions that was
modified on or after --since. It needs no request logging, so it also works
on sessions from before cache-tuning.ts logged requests (2026-10-14).

The idea comes from a session-log cost tool in another project. This version
adds the causes that long-running pi sessions have: a 1-hour cache, pi-memory's block, and
day rollover.

A reply is a rewrite when it wrote at least --min-write tokens (default 20000)
to cache and read less than half of the previous request's prompt (or it is
the session's first reply). Causes, first match wins:
  sessionStart       first reply in the session file
  compaction         a compaction entry since the previous reply
  modelOrThinking    a model or thinking-level change since the previous reply
  idleGap            gap since the previous reply >= the cache TTL in use
                     (60 min once the session has written 1-hour cache,
                     else 5 min). Seats keep-warm past 60 min, so a seat
                     rewrite after a long gap can also mean the keep-warm
                     stopped or the process restarted.
  memoryWrite        a memory write (memory_write, memory_forget, scratchpad)
                     before this run: pi-memory rebuilds its block in the
                     system prompt at the next run's start
  dayRollover        the local date changed since the previous reply
                     (pi-memory rebuilds its block at local midnight)
  systemPromptChange a system-prompt section changed (a message/system entry)
  unexplained        none of the above: a reload or restart, an extension
                     that changed a message, or a provider-side miss

--validate compares each rewrite with the cause cache-debug-report.py gives
for the same reply (cache-debug log, 2026-10-14 on).
--list prints one line per rewrite.
"""
import csv, glob, json, os, sys
from collections import Counter, defaultdict
from datetime import datetime

AGENT_DIR = os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent"))
# Tools that make pi-memory rebuild its snapshot (index.ts sets snapshotDirty).
MEMORY_TOOLS = {"memory_write", "memory_forget", "memory_restore", "scratchpad"}
CAUSES = ("sessionStart", "compaction", "modelOrThinking", "idleGap", "memoryWrite",
          "dayRollover", "systemPromptChange", "unexplained")


def arg(name, default=None):
    if name in sys.argv:
        i = sys.argv.index(name)
        return sys.argv[i + 1]
    return default


def ts(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))


def tok(u, k):
    v = u.get(k)
    return v if isinstance(v, int) else 0


def classify_file(path, since, until, min_write):
    """Yield one dict per rewrite in the file, plus a per-file summary."""
    sid = os.path.basename(path).rsplit("_", 1)[-1][:-6]
    cwd, name = "", ""
    prev_time = prev_prompt = None
    long_ttl = False
    memory_dirty = run_started = False
    events = set()
    rewrites, totals = [], Counter()
    for line in open(path, errors="replace"):
        try:
            e = json.loads(line)
        except Exception:
            continue
        kind = e.get("type")
        if kind == "session":
            cwd = e.get("cwd") or ""
            continue
        if kind == "session_info":
            name = e.get("name") or name
            continue
        if kind == "compaction":
            events.add("compaction")
            continue
        if kind in ("model_change", "thinking_level_change"):
            events.add("modelOrThinking")
            continue
        m = e.get("message") or {}
        role = m.get("role")
        if kind == "message" and role == "system":
            events.add("systemPromptChange")
            continue
        # pi-memory rebuilds its block at the start of the next run after a
        # long-term write, so the rewrite lands on that run's first reply.
        if kind == "message" and role == "user" or kind == "custom_message":
            run_started = True
        if kind == "message" and role == "assistant":
            for b in m.get("content") or []:
                if isinstance(b, dict) and b.get("type") == "toolCall" and b.get("name") in MEMORY_TOOLS:
                    if b.get("name") != "scratchpad" or (b.get("arguments") or {}).get("action") != "list":
                        memory_dirty, run_started = True, False
        u = m.get("usage")
        if kind != "message" or role != "assistant" or not u or not e.get("timestamp"):
            continue
        t = ts(e["timestamp"])
        prompt = tok(u, "input") + tok(u, "cacheRead") + tok(u, "cacheWrite")
        if prompt == 0:  # aborted or errored reply
            continue
        in_range = t >= since and (until is None or t < until)
        cw, cr = tok(u, "cacheWrite"), tok(u, "cacheRead")
        cost = (u.get("cost") or {}).get("cacheWrite")
        if in_range:
            totals["replies"] += 1
            totals["write"] += cw
            totals["writeCost"] += cost or 0
        gap = None if prev_time is None else (t - prev_time).total_seconds() / 60
        if memory_dirty and run_started:
            events.add("memoryWrite")
            memory_dirty = False
        if in_range and cw >= min_write and (prev_prompt is None or cr < prev_prompt / 2):
            ttl = 60 if long_ttl else 5
            if gap is None:
                cause = "sessionStart"
            elif "compaction" in events:
                cause = "compaction"
            elif "modelOrThinking" in events:
                cause = "modelOrThinking"
            elif gap >= ttl:
                cause = "idleGap"
            elif "memoryWrite" in events:
                cause = "memoryWrite"
            elif prev_time is not None and prev_time.astimezone().date() != t.astimezone().date():
                cause = "dayRollover"
            elif "systemPromptChange" in events:
                cause = "systemPromptChange"
            else:
                cause = "unexplained"
            rewrites.append({"sid": sid, "name": name, "cwd": cwd, "ts": e["timestamp"], "cause": cause,
                             "gapMin": None if gap is None else round(gap, 1), "ttlMin": ttl,
                             "prompt": prompt, "cacheRead": cr, "cacheWrite": cw,
                             "writeCost": round(cost, 6) if isinstance(cost, (int, float)) else None})
        if tok(u, "cacheWrite1h") > 0:
            long_ttl = True
        prev_time, prev_prompt, events = t, prompt, set()
    return sid, name, cwd, rewrites, totals


def session_kind(cwd, path):
    p = cwd + " " + path
    if "pi-agent-" in p or "pi-lanes" in p or "/private/tmp" in p or "--private-tmp" in p or "--tmp-" in p:
        return "agent"
    return "seat"


def debug_causes(since):
    """cache-debug-report.py's cause for each rewrite, keyed by (sid, usage ts)."""
    reqs, out = {}, {}
    for f in sorted(glob.glob(os.path.join(AGENT_DIR, "cache-debug", "*.jsonl"))):
        day = os.path.basename(f)[:10]
        if day < since.strftime("%Y-%m-%d"):
            continue
        for line in open(f):
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r["type"] == "request":
                reqs[(r["sid"], r.get("seq"))] = r
            elif r["type"] == "usage":
                cw, cr = r.get("cacheWrite") or 0, r.get("cacheRead") or 0
                if cw > 50000 and cr < 0.2 * cw:
                    q = reqs.get((r["sid"], r.get("seq")))
                    if q is None:
                        why = "no request logged"
                    elif "prevBlocks" not in q:
                        why = "first request after load/reload"
                    elif "firstDiff" not in q:
                        why = "prefix unchanged"
                    else:
                        why = "changed at " + q["path"].split(" ")[0].split("[")[0]
                    out[(r["sid"], r["ts"][:19])] = (why, cw)
    return out


def main():
    since = ts(arg("--since", "2026-10-14") + "T00:00:00+00:00")
    until_s = arg("--until")
    until = ts(until_s + "T00:00:00+00:00") if until_s else None
    min_write = int(arg("--min-write", "20000"))
    flagged = {a for a in ("--since", "--until", "--min-write", "--csv") if a in sys.argv}
    skip = {sys.argv.index(a) + 1 for a in flagged}
    files = [a for i, a in enumerate(sys.argv[1:], 1) if i not in skip and not a.startswith("--")]
    if not files:
        cut = since.timestamp()
        files = [f for f in glob.glob(os.path.join(AGENT_DIR, "sessions", "*", "*.jsonl")) if os.path.getmtime(f) >= cut]
    allrw, tot = [], defaultdict(Counter)
    for f in files:
        sid, name, cwd, rws, totals = classify_file(f, since, until, min_write)
        k = session_kind(cwd, f)
        for r in rws:
            r["kind"] = k
        tot[k].update(totals)
        allrw += rws
    allrw.sort(key=lambda r: r["ts"])
    window = f"{since:%Y-%m-%d} to {until_s or 'now'}"
    print(f"Cache rewrites by cause, {window} ({len(files)} session files, rewrite = wrote >= {min_write} and read < half the previous prompt)\n")
    for k in ("seat", "agent"):
        rs = [r for r in allrw if r["kind"] == k]
        if not rs and not tot[k]["replies"]:
            continue
        c, w, d = Counter(), Counter(), Counter()
        for r in rs:
            c[r["cause"]] += 1
            w[r["cause"]] += r["cacheWrite"]
            d[r["cause"]] += r["writeCost"] or 0
        print(f"{k}s: {tot[k]['replies']} replies, cache writes {tot[k]['write']/1e6:.2f}M tokens ${tot[k]['writeCost']:.2f}; "
              f"rewrites {len(rs)}, {sum(w.values())/1e6:.2f}M tokens ${sum(d.values()):.2f}")
        for cause in CAUSES:
            if c[cause]:
                print(f"  {cause:19} {c[cause]:5}  {w[cause]/1e6:7.2f}M  ${d[cause]:8.2f}")
        print()
    if "--list" in sys.argv:
        for r in allrw:
            print(f"{r['ts'][5:19]} {r['kind']:5} {(r['name'] or r['sid'][:13])[:22]:22} {r['cause']:18} gap {r['gapMin']} wrote {r['cacheWrite']} read {r['cacheRead']}")
    csv_path = arg("--csv")
    if csv_path:
        with open(csv_path, "w", newline="") as fh:
            wr = csv.DictWriter(fh, fieldnames=["ts", "kind", "name", "sid", "cause", "gapMin", "ttlMin", "prompt", "cacheRead", "cacheWrite", "writeCost", "cwd"])
            wr.writeheader()
            wr.writerows(allrw)
        print(f"wrote {len(allrw)} rows to {csv_path}")
    if "--validate" in sys.argv:
        dbg = debug_causes(since)
        by_key = {(r["sid"], r["ts"][:19]): r for r in allrw}
        m, miss = Counter(), Counter()
        for key, (why, cw) in dbg.items():
            r = by_key.get(key)
            if r is None:
                # timestamps can differ by a second or two
                cands = [x for x in allrw if x["sid"] == key[0] and abs((ts(x["ts"]) - ts(key[1] + "Z")).total_seconds()) < 5]
                r = cands[0] if cands else None
            if r is None:
                miss[why] += 1
            else:
                m[(why, r["cause"])] += 1
        print(f"\nValidation against cache-debug ({len(dbg)} rewrites there with write > 50k and read < 20%):")
        for (why, cause), n in sorted(m.items(), key=lambda kv: -kv[1]):
            print(f"  {n:4}  debug: {why:40} classifier: {cause}")
        for why, n in miss.most_common():
            print(f"  {n:4}  debug: {why:40} classifier: (not found as a rewrite)")


if __name__ == "__main__":
    main()
