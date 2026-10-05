#!/usr/bin/env python3
"""Backfill ~/.pi/agent/subagent-ledger from saved subagent sessions.

pi-subagents saves each top-level agent's session (rememberAgents) as a normal
pi session file whose header has `parentSession` and whose session_info name is
"<type>#<agent id prefix>". Every assistant message carries its usage, cost and
timestamp, so the ledger line the live extension would have written can be
rebuilt per message.

- Lines get "source": "backfill". Re-running replaces earlier backfill lines and
  never touches live lines.
- Dedupe is per agent: once the live extension has a line for an agent, that
  agent's messages from that time on are skipped, and its earlier lines take the
  live line's full id. Seats reload at different times, so a single global
  cutoff would drop the spend of seats still running the old code. Safe to
  re-run at any time.
- Not recoverable: nested agents (not saved), and the requested thinking level.
  Workflow children are saved but carry no workflow id here.

Usage: subagent-ledger-backfill.py [--dry-run]
"""
import glob, json, os, re, sys
from collections import defaultdict

AGENT = os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent"))
SESSIONS = os.path.join(AGENT, "sessions")
LEDGER = os.path.join(AGENT, "subagent-ledger")
DRY = "--dry-run" in sys.argv

def entries(path):
    with open(path) as fh:
        for raw in fh:
            try:
                yield json.loads(raw)
            except Exception:
                pass

# Per agent-id prefix: the first live line's time and the full live id.
live_first, live_id = {}, {}
existing = defaultdict(list)  # day -> live lines (kept verbatim)
for f in sorted(glob.glob(os.path.join(LEDGER, "*.jsonl"))):
    day = os.path.basename(f)[:10]
    for raw in open(f):
        try:
            l = json.loads(raw)
        except Exception:
            continue
        if l.get("source") == "backfill":
            continue
        existing[day].append(raw if raw.endswith("\n") else raw + "\n")
        aid, ts = str(l.get("id") or ""), l.get("ts")
        if aid and ts:
            k = aid[:8]
            if k not in live_first or ts < live_first[k]:
                live_first[k] = ts
                live_id[k] = aid

parents = {}
def parent_info(path):
    """Session id, latest name, cwd, and {agent-id-prefix: description} for a parent session."""
    if path in parents:
        return parents[path]
    info = {"sessionId": None, "sessionName": None, "cwd": None, "desc": {}}
    if path and os.path.exists(path):
        for e in entries(path):
            t = e.get("type")
            if t == "session":
                info["sessionId"], info["cwd"] = e.get("id"), e.get("cwd")
            elif t == "session_info" and e.get("name"):
                info["sessionName"] = e["name"]
            elif t == "custom" and e.get("customType") == "subagents:record":
                d = e.get("data") or {}
                if d.get("id"):
                    info["desc"][d["id"][:8]] = d.get("description") or ""
    if not info["sessionId"] and path:
        m = re.search(r"_([0-9a-f-]{36})\.jsonl$", path)
        info["sessionId"] = m.group(1) if m else None
    parents[path] = info
    return info

out = defaultdict(list)
stats = {"sessions": 0, "lines": 0, "skipped_live": 0, "cost": 0.0}
for f in glob.glob(os.path.join(SESSIONS, "*", "*.jsonl")):
    it = entries(f)
    hdr = next(it, None)
    if not hdr or hdr.get("type") != "session" or not hdr.get("parentSession"):
        continue
    name = model = None
    thinking = "default"
    msgs = []
    for e in it:
        t = e.get("type")
        if t == "session_info" and e.get("name"):
            name = e["name"]
        elif t == "model_change":
            model = f'{e.get("provider")}/{e.get("modelId")}'
        elif t == "thinking_level_change":
            thinking = e.get("thinkingLevel") or thinking
        elif t == "message" and (e.get("message") or {}).get("role") == "assistant":
            msgs.append((e, thinking, model))
    m = re.match(r"^(.+)#([0-9a-f]+)$", name or "")
    if not m:
        continue
    typ, aid = m.group(1), m.group(2)
    p = parent_info(hdr["parentSession"])
    stats["sessions"] += 1
    for e, th, mdl in msgs:
        msg = e["message"]
        u = msg.get("usage") or {}
        ts = e.get("timestamp")
        if not ts:
            continue
        if aid in live_first and ts >= live_first[aid]:
            stats["skipped_live"] += 1
            continue
        cost = (u.get("cost") or {}).get("total") or 0
        if not (cost or u.get("input") or u.get("output") or u.get("cacheRead") or u.get("cacheWrite")):
            continue
        line = {
            "ts": ts, "sessionId": p["sessionId"], "sessionName": p["sessionName"], "cwd": p["cwd"],
            "id": live_id.get(aid, aid), "type": typ, "description": p["desc"].get(aid, ""),
            "model": mdl or f'{msg.get("provider")}/{msg.get("model")}', "thinking": th, "depth": 1,
            "cost": cost, "input": u.get("input", 0), "output": u.get("output", 0),
            "cacheRead": u.get("cacheRead", 0), "cacheWrite": u.get("cacheWrite", 0), "source": "backfill",
        }
        out[ts[:10]].append(line)
        stats["lines"] += 1
        stats["cost"] += cost

print(f'{stats["sessions"]} agent sessions, {stats["lines"]} message lines, ${stats["cost"]:.2f}, '
      f'{stats["skipped_live"]} messages skipped (already live), {len(live_first)} agents seen live')
if DRY:
    sys.exit(0)
os.makedirs(LEDGER, exist_ok=True)
for day in sorted(set(out) | set(existing)):
    lines = sorted(out.get(day, []), key=lambda l: l["ts"])
    tmp = os.path.join(LEDGER, f".{day}.jsonl.tmp")
    with open(tmp, "w") as fh:
        for l in lines:
            fh.write(json.dumps(l) + "\n")
        fh.writelines(existing.get(day, []))
    os.replace(tmp, os.path.join(LEDGER, f"{day}.jsonl"))
print(f"wrote {len(set(out) | set(existing))} day files to {LEDGER}")
