#!/usr/bin/env python3
"""Backfill ~/.pi/agent/subagent-ledger from saved pi sessions.

Three sources, each rebuilt per message the way the live extension writes it:

1. Subagents. pi-subagents saves each top-level agent's session (rememberAgents)
   with session_info name "<type>#<agent id prefix>" and a parentSession header.
2. Seats. Every other saved session is a seat: its own assistant messages and
   compaction/branch-summary usage, as lines with "kind": "seat", id = the
   session id. A message copied into a fork or clone is counted once.
3. The old `subagent` tool (pi's example extension). Its children ran with
   --no-session, but each tool result carries per-agent usage: one line per
   result, model as reported, thinking unknown.

- Lines get "source": "backfill". Re-running replaces earlier backfill lines and
  never touches live lines.
- Dedupe is per agent or seat: once the live extension has a line for it, its
  messages from that time on are skipped. Seats are keyed on the full session
  id (time-ordered ids share prefixes); agents on the 8-character prefix, the
  only part the session name keeps. Safe to re-run at any time.
- Not recoverable: nested agents (not saved), and the requested thinking level.
- Live sessions keep appending while this runs (about 25 s). Each day file is
  rewritten with whatever was appended after it was first read, and appends
  that land on the old file during the swap are copied over afterwards, so no
  live line is lost. One run at a time (flock on .backfill.lock); a run that
  finds the lock held exits 0. Each completed run touches .last-backfill.

Usage: subagent-ledger-backfill.py [--dry-run]
"""
import fcntl, glob, json, os, re, sys, time
from collections import defaultdict

USAGE = "Usage: subagent-ledger-backfill.py [--dry-run]"
if any(a not in ("--dry-run",) for a in sys.argv[1:]):
    print(USAGE, file=sys.stderr if "-h" not in sys.argv and "--help" not in sys.argv else sys.stdout)
    sys.exit(0 if ("-h" in sys.argv or "--help" in sys.argv) else 2)

AGENT = os.environ.get("PI_CODING_AGENT_DIR", os.path.expanduser("~/.pi/agent"))
SESSIONS = os.path.join(AGENT, "sessions")
LEDGER = os.path.join(AGENT, "subagent-ledger")
DRY = "--dry-run" in sys.argv
os.makedirs(LEDGER, exist_ok=True)
_lock = open(os.path.join(LEDGER, ".backfill.lock"), "w")
try:
    fcntl.flock(_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    print("another backfill is running; skipped")
    sys.exit(0)
AGENT_NAME = re.compile(r"^([A-Za-z][\w-]*)#([0-9a-f]{6,})$")

def entries(path):
    with open(path) as fh:
        for raw in fh:
            try:
                yield json.loads(raw)
            except Exception:
                pass

def live_key(l):
    return ("seat", l["id"]) if l.get("kind") == "seat" else ("agent", str(l["id"])[:8])

live_first, live_id = {}, {}
existing = defaultdict(list)
read_upto = {}  # day -> byte offset read so far
for f in sorted(glob.glob(os.path.join(LEDGER, "*.jsonl"))):
    day = os.path.basename(f)[:10]
    with open(f, "rb") as fh:
        data = fh.read()
    data = data[: data.rfind(b"\n") + 1]  # a line mid-append is picked up at write time
    read_upto[day] = len(data)
    for raw in data.decode("utf-8", "replace").splitlines(keepends=True):
        try:
            l = json.loads(raw)
        except Exception:
            continue
        if l.get("source") == "backfill":
            continue
        existing[day].append(raw if raw.endswith("\n") else raw + "\n")
        if l.get("id") and l.get("ts"):
            k = live_key(l)
            if k not in live_first or l["ts"] < live_first[k]:
                live_first[k], live_id[k] = l["ts"], l["id"]

def is_live(key, ts):
    return key in live_first and ts >= live_first[key]

def spent(u):
    return bool(((u.get("cost") or {}).get("total") if isinstance(u.get("cost"), dict) else u.get("cost"))
                or u.get("input") or u.get("output") or u.get("cacheRead") or u.get("cacheWrite"))

def tokens(u):
    return {k: u.get(k, 0) or 0 for k in ("input", "output", "cacheRead", "cacheWrite")}

# Pass 1: read every session once.
files = []
for f in glob.glob(os.path.join(SESSIONS, "*", "*.jsonl")):
    it = entries(f)
    hdr = next(it, None)
    if not hdr or hdr.get("type") != "session":
        continue
    files.append((f, hdr, list(it)))

parents = {}
for f, hdr, es in files:
    info = {"sessionId": hdr.get("id"), "sessionName": None, "cwd": hdr.get("cwd"), "desc": {}}
    for e in es:
        if e.get("type") == "session_info" and e.get("name"):
            info["sessionName"] = e["name"]
        elif e.get("type") == "custom" and e.get("customType") == "subagents:record":
            d = e.get("data") or {}
            if d.get("id"):
                info["desc"][d["id"][:8]] = d.get("description") or ""
    parents[f] = info

def parent_of(path):
    if path in parents:
        return parents[path]
    m = re.search(r"_([0-9a-f-]{36})\.jsonl$", path or "")
    return {"sessionId": m.group(1) if m else None, "sessionName": None, "cwd": None, "desc": {}}

out = defaultdict(list)
stats = defaultdict(lambda: [0, 0, 0.0])  # source -> sessions, lines, cost
skipped = 0
seen_seat_msgs = set()

def emit(kind_label, line):
    out[line["ts"][:10]].append(line)
    stats[kind_label][1] += 1
    stats[kind_label][2] += line["cost"]

for f, hdr, es in files:
    name = parents[f]["sessionName"]
    m = AGENT_NAME.match(name or "")
    thinking, model = "default", None
    if m:  # --- subagent session
        typ, aid = m.group(1), m.group(2)
        p = parent_of(hdr.get("parentSession"))
        key = ("agent", aid)
        stats["agents"][0] += 1
        for e in es:
            t = e.get("type")
            if t == "model_change":
                model = f'{e.get("provider")}/{e.get("modelId")}'
            elif t == "thinking_level_change":
                thinking = e.get("thinkingLevel") or thinking
            elif t == "message" and (e.get("message") or {}).get("role") == "assistant":
                msg = e["message"]; u = msg.get("usage") or {}; ts = e.get("timestamp")
                if not ts or not spent(u):
                    continue
                d = ("a", aid, msg.get("timestamp"), (u.get("cost") or {}).get("total"), u.get("output"))
                if d in seen_seat_msgs:
                    continue
                seen_seat_msgs.add(d)
                if is_live(key, ts):
                    skipped += 1
                    continue
                emit("agents", {"ts": ts, "sessionId": p["sessionId"], "sessionName": p["sessionName"], "cwd": p["cwd"],
                    "id": live_id.get(key, aid), "type": typ, "description": p["desc"].get(aid, ""),
                    "model": model or f'{msg.get("provider")}/{msg.get("model")}', "thinking": thinking, "depth": 1,
                    "cost": (u.get("cost") or {}).get("total") or 0, **tokens(u), "source": "backfill"})
        continue
    # --- seat session
    sid = hdr.get("id")
    key = ("seat", sid)
    info = {"sessionId": sid, "sessionName": name, "cwd": hdr.get("cwd")}
    stats["seats"][0] += 1
    for e in es:
        t = e.get("type")
        if t == "thinking_level_change":
            thinking = e.get("thinkingLevel") or thinking
        u = mdl = None
        if t == "message" and (e.get("message") or {}).get("role") == "assistant":
            msg = e["message"]; u = msg.get("usage") or {}
            mdl = f'{msg.get("provider")}/{msg.get("model")}'
            dedupe = ("m", msg.get("timestamp"), (u.get("cost") or {}).get("total"), u.get("output"))
        elif t in ("compaction", "branch_summary") and e.get("usage"):
            u = e["usage"]; mdl = "(compaction)" if t == "compaction" else "(branch summary)"
            dedupe = ("c", e.get("id"), e.get("timestamp"))
        if u is None or not spent(u) or not e.get("timestamp"):
            continue
        if dedupe in seen_seat_msgs:
            continue
        seen_seat_msgs.add(dedupe)
        if is_live(key, e["timestamp"]):
            skipped += 1
            continue
        emit("seats", {"ts": e["timestamp"], **info, "kind": "seat", "id": sid, "type": "seat",
            "description": name or "", "model": mdl, "thinking": thinking, "depth": 0,
            "cost": (u.get("cost") or {}).get("total") or 0, **tokens(u), "source": "backfill"})
    # --- old `subagent` tool results inside this seat
    for e in es:
        msg = e.get("message") or {}
        if e.get("type") != "message" or msg.get("role") != "toolResult" or msg.get("toolName") != "subagent":
            continue
        for i, r in enumerate((msg.get("details") or {}).get("results") or []):
            u = r.get("usage") or {}
            if not isinstance(u.get("cost"), (int, float)) or not e.get("timestamp"):
                continue
            emit("subagent tool", {"ts": e["timestamp"], **info, "id": f'{msg.get("toolCallId")}:{i}',
                "type": r.get("agent") or "unknown", "description": "(subagent tool) " + (r.get("task") or "")[:80],
                "model": r.get("model") or "unknown", "thinking": "default", "depth": 1,
                "cost": u["cost"], **tokens(u), "source": "backfill"})

for k, (n, lines, cost) in stats.items():
    print(f"{k}: {n or '-'} sessions, {lines} lines, ${cost:.2f}")
print(f"{skipped} messages skipped (already live); {len(live_first)} agents/seats seen live")
if DRY:
    sys.exit(0)
def tail(fd, offset):
    """Whole lines appended at or after offset; returns (bytes, new offset)."""
    os.lseek(fd, offset, os.SEEK_SET)
    chunks = []
    while True:
        b = os.read(fd, 1 << 20)
        if not b:
            break
        chunks.append(b)
    data = b"".join(chunks)
    data = data[: data.rfind(b"\n") + 1]
    return data, offset + len(data)

days = set(out) | set(existing)
caught_up = 0
for day in sorted(days):
    path = os.path.join(LEDGER, f"{day}.jsonl")
    tmp = os.path.join(LEDGER, f".{day}.jsonl.tmp")
    old = os.open(path, os.O_RDONLY | os.O_CREAT, 0o644)
    try:
        # Live appends since the first read; never backfill lines (only this script writes those).
        new_live, offset = tail(old, read_upto.get(day, 0))
        with open(tmp, "wb") as fh:
            for l in sorted(out.get(day, []), key=lambda l: l["ts"]):
                fh.write((json.dumps(l) + "\n").encode())
            fh.write("".join(existing.get(day, [])).encode())
            fh.write(new_live)
        os.replace(tmp, path)
        # A writer that opened the old path just before the swap writes into the
        # old inode; give it a moment, then copy anything it wrote.
        time.sleep(0.05)
        late, _ = tail(old, offset)
        if late:
            with open(path, "ab") as fh:
                fh.write(late)
        caught_up += new_live.count(b"\n") + late.count(b"\n")
    finally:
        os.close(old)
with open(os.path.join(LEDGER, ".last-backfill"), "w") as fh:
    fh.write(time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + "\n")
print(f"wrote {len(days)} day files to {LEDGER}; {caught_up} live lines appended during the run were kept")
