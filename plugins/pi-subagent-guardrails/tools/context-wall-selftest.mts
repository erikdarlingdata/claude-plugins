// Self-test for context-wall.ts protectedWriteTarget: node --experimental-strip-types tools/context-wall-selftest.mts
import { protectedWriteTarget as t } from "../subagent-extensions/context-wall.ts";
const H = "/home/u", P = H + "/src/main-repo", dirs = [P];
const wt = H + "/src/wt-base";
const cases: [string, string, unknown, string, boolean][] = [
  ["scout incident", "bash", { command: "cd ~/src/main-repo\ngit checkout some-branch -- . 2>&1 | tail -5" }, wt, true],
  ["git -C checkout", "bash", { command: "git -C ~/src/main-repo checkout dev -- ." }, wt, true],
  ["$HOME stash", "bash", { command: "cd $HOME/src/main-repo && git stash" }, wt, true],
  ["abs reset", "bash", { command: `cd ${P} && git reset --hard` }, wt, true],
  ["../ sibling add", "bash", { command: "cd ../main-repo && git add -A" }, wt, true],
  ["cwd inside", "bash", { command: "git restore ." }, P + "/Darling", true],
  ["read show", "bash", { command: "git -C ~/src/main-repo show origin/dev:README.md | head" }, wt, false],
  ["read fetch+diff", "bash", { command: "cd ~/src/main-repo && git fetch -q origin x && git diff origin/dev...origin/x --stat" }, wt, false],
  ["worktree add", "bash", { command: "cd ~/src/main-repo && git worktree add -q --detach ~/src/wt-v origin/x" }, wt, false],
  ["other checkout", "bash", { command: "cd ~/src/main-repo-old && git checkout dev" }, wt, false],
  ["own wt checkout", "bash", { command: "git checkout -q --detach origin/dev" }, wt, false],
  ["log --oneline checkout word", "bash", { command: "git -C ~/src/main-repo log --oneline -3 | grep checkout" }, wt, false],
  ["write inside", "write", { path: P + "/x.cs" }, wt, true],
  ["edit ~ inside", "edit", { path: "~/src/main-repo/README.md" }, wt, true],
  ["write own wt", "write", { path: wt + "/x.cs" }, wt, false],
  ["write relative in cwd-inside", "write", { path: "a.md" }, P, true],
];
let bad = 0;
for (const [name, tool, input, cwd, want] of cases) {
  const got = t(tool, input, cwd, dirs, H) != null;
  if (got !== want) { bad++; console.log("FAIL", name, "got", got); }
}
console.log(bad === 0 ? `all ${cases.length} pass` : `${bad} failed`);
if (bad) process.exit(1);
