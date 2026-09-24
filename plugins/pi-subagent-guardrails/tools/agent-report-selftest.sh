#!/bin/bash
# Self-test for agent-report.ts: builds a synthetic transcript that breaks nine rules and checks every one is reported,
# with the right test/push counts. Exit 0 = pass.
set -eu
here=$(cd "$(dirname "$0")" && pwd); dir=$(mktemp -d); trap 'rm -rf "$dir"' EXIT
python3 - "$dir/fixture-01.output" <<'PY'
import json, sys
L = []; cwd = "/tmp/wt-x"; t = [0]
def rec(typ, msg):
    t[0] += 60000; L.append({"agentId": "fixture-01", "type": typ, "cwd": cwd, "timestamp": t[0] + 1790000000000, "message": msg})
def asst(calls, text="", cr=0, cw=0):
    rec("assistant", {"role": "assistant", "model": "m", "content": ([{"type": "text", "text": text}] if text else []) +
        [{"type": "toolCall", "id": c[0], "name": c[1], "arguments": c[2]} for c in calls],
        "usage": {"input": 10, "output": 100, "reasoning": 50, "cacheRead": cr, "cacheWrite": cw,
                  "cost": {"input": 0.001, "output": 0.01, "cacheRead": 0.02, "cacheWrite": 0.005, "total": 0.036}}})
def res(i, name, chars):
    rec("toolResult", {"role": "toolResult", "toolCallId": i, "toolName": name, "content": [{"type": "text", "text": "x" * chars}], "isError": False})
rec("user", {"role": "user", "content": "Fix the thing."})
asst([("c1", "read", {"path": "/tmp/wt-x/big.cs"})], cw=30000); res("c1", "read", 20000)
asst([("c2", "bash", {"command": "dotnet test Foo.sln"})], cr=30000, cw=5000); res("c2", "bash", 9000)
asst([("c3", "bash", {"command": "dotnet Foo.Tests.dll -class X | grep -E 'FAIL|Total:'"})], cr=160000, cw=2000); res("c3", "bash", 200)
asst([("c4", "edit", {"path": "/Users/someone/shared/src/A.cs"})], cr=40000); res("c4", "edit", 50)
asst([("c5", "bash", {"command": "git commit -qam x && git push -q"})], cr=40000); res("c5", "bash", 10)
asst([("c6", "edit", {"path": "/tmp/wt-x/global.json"})], cr=40000); res("c6", "edit", 10)
asst([("c7", "bash", {"command": "dotnet test Foo.sln | tail -3"})], cr=40000); res("c7", "bash", 100)
asst([], text=" ".join(["word"] * 450) + " I will wait for the background notification.")
open(sys.argv[1], "w").write("\n".join(json.dumps(x) for x in L) + "\n")
PY
node --experimental-strip-types --no-warnings "$here/agent-report.ts" --json --forbid-path 'global\.json$' "$dir/fixture-01.output" | python3 -c '
import json, sys
r = json.load(sys.stdin)[0]; rules = sorted(v["rule"] for v in r["violations"])
exp = sorted(["read-unbounded", "test-output-uncapped", "edit-outside-worktree", "forbidden-path", "unpushed-at-end",
              "final-message-long", "waits-on-notification", "full-suite-repeated", "past-handoff-unpushed"])
c = r["counts"]
ok = rules == exp and c["testsFull"] == 2 and c["testsTargeted"] == 1 and c["pushes"] == 1 and r["turns"] == 8 and r["baseContext"] == 30010
print("agent-report selftest:", "PASS" if ok else "FAIL rules=%s counts=%s turns=%s" % (rules, c, r["turns"])); sys.exit(0 if ok else 1)'
