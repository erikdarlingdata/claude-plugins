// Self-test for the context-wall notices: node --experimental-strip-types tools/context-wall-notices-selftest.mts
// Checks that the no-code-yet nudge reaches lanes only, and that read-only agents are never told to push a PR.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "cw-"));
writeFileSync(join(dir, "context-wall.json"), JSON.stringify({ nudge: 100, warn1: 200, warn2: 300, wall: 400 }));
process.env.PI_CODING_AGENT_DIR = dir;
const { default: contextWall, agentTypeOf, nudgeApplies } = await import("../subagent-extensions/context-wall.ts");

let bad = 0;
const check = (name: string, got: unknown, want: unknown) => {
  if (got !== want) { bad++; console.log("FAIL", name, "got", JSON.stringify(got), "want", JSON.stringify(want)); }
};

check("type from session name", agentTypeOf("worker-opus#92b044e6"), "worker-opus");
check("no session name", agentTypeOf(undefined), null);
check("lane gets nudge", nudgeApplies("lane", ["lane"]), true);
check("lane-opus gets nudge", nudgeApplies("lane-opus", ["lane"]), true);
check("worker-opus no nudge", nudgeApplies("worker-opus", ["lane"]), false);
check("reviewer no nudge", nudgeApplies("reviewer", ["lane"]), false);
check("laneway is not lane", nudgeApplies("laneway", ["lane"]), false);
check("unknown type keeps nudge", nudgeApplies(null, ["lane"]), true);

// Drive the extension's handlers with a fake pi and a fake context.
function agent(sessionName: string) {
  const handlers: Record<string, (e: any, c: any) => any> = {};
  contextWall({ on: (ev: string, fn: any) => { handlers[ev] = fn; } } as any);
  let tokens = 0;
  const ctx = {
    cwd: "/tmp",
    getContextUsage: () => ({ tokens }),
    sessionManager: { getEntries: () => [], getSessionName: () => sessionName },
  };
  return {
    at(n: number) { tokens = n; return this; },
    note(): string {
      const r = handlers.tool_result({ content: [{ type: "text", text: "x" }] }, ctx);
      return r ? r.content.map((c: any) => c.text).join("").replace(/^x/, "") : "";
    },
    call(toolName: string, input: unknown) { return handlers.tool_call({ toolName, input }, ctx); },
  };
}

const lane = agent("lane#aaaa1111").at(150);
check("lane nudge text", lane.note().includes("Stop investigating"), true);

const reader = agent("worker-opus#bbbb2222").at(150);
check("read-only worker gets no nudge", reader.note(), "");
const w1 = reader.at(250).note();
check("read-only warn1 says final message", w1.includes("put your report in your final message"), true);
check("read-only warn1 does not say push", /push a draft PR|nothing is pushed/.test(w1), false);
const wallMsg = String(reader.at(450).call("read", { path: "/tmp/x" })?.reason ?? "");
check("read-only wall blocks read", wallMsg.startsWith("context-wall:"), true);
check("read-only wall says final message", wallMsg.includes("Put your report in your final message"), true);
check("read-only wall does not say commit", wallMsg.includes("Commit and push"), false);

const coder = agent("lane#cccc3333").at(50);
coder.call("edit", { path: "/tmp/src/a.cs" });
const c1 = coder.at(250).note();
check("coder warn1 says push first", c1.includes("nothing is pushed yet"), true);
check("coder warn1 says PR body", c1.includes("PR body"), true);
const cw = String(coder.at(450).call("read", { path: "/tmp/x" })?.reason ?? "");
check("coder wall says commit and push", cw.includes("Commit and push what you have"), true);

console.log(bad === 0 ? "all notice checks pass" : `${bad} failed`);
if (bad) process.exit(1);
