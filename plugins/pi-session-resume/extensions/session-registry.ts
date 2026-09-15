/**
 * session-registry — track open interactive pi sessions so they can be
 * resumed en masse after a reboot.
 *
 * Companion script: ../bin/pi-resume-sessions (put it on your PATH).
 *
 * Behavior:
 * - session_start (tui mode only): writes ~/.pi/agent/session-registry/<sessionId>.json
 *   with { sessionId, name, cwd, sessionFile, pid, updatedAt }.
 * - session_info_changed: refreshes the stored name (so /name updates the registry).
 * - session_shutdown:
 *     - reason "new" | "resume" | "fork" | "reload": entry removed; the follow-up
 *       session_start re-registers whatever session is now active.
 *     - reason "quit" via Ctrl+D / /quit / double Ctrl+C: entry removed — the user
 *       deliberately ended the session, don't resurrect it.
 *     - reason "quit" caused by SIGTERM/SIGHUP (OS reboot, terminal window closed,
 *       kill): entry KEPT so pi-resume-sessions brings it back.
 *
 * The SIGTERM/SIGHUP distinction works because extensions run in-process: we
 * prepend our own signal listener, which sets a flag before/while pi's graceful
 * shutdown (which emits session_shutdown) runs. Crashes and SIGKILL never emit
 * session_shutdown at all, so those entries survive too — which is what we want.
 *
 * Sessions started with --no-session (ephemeral) are never registered.
 * Subagent / print / json / rpc runs are never registered.
 */
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REGISTRY_DIR = join(homedir(), ".pi", "agent", "session-registry");

export default function (pi: ExtensionAPI) {
  let signalled = false;
  let listening = false;
  let registeredId: string | undefined;

  const onSignal = () => {
    signalled = true;
  };

  const entryPath = (id: string) => join(REGISTRY_DIR, `${id}.json`);

  const writeEntry = (ctx: ExtensionContext) => {
    const sm = ctx.sessionManager;
    const sessionFile = sm.getSessionFile();
    if (!sessionFile) return; // ephemeral session; nothing to resume later

    const id = sm.getSessionId();
    const entry = {
      sessionId: id,
      name: sm.getSessionName() ?? "",
      cwd: sm.getCwd(),
      sessionFile,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };

    try {
      mkdirSync(REGISTRY_DIR, { recursive: true });
      const tmp = `${entryPath(id)}.tmp-${process.pid}`;
      writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
      renameSync(tmp, entryPath(id));
      registeredId = id;
    } catch {
      // Registry bookkeeping must never break the session itself.
    }
  };

  pi.on("session_start", async (_event, ctx) => {
    // Only track real interactive sessions — not subagents, pi -p, json, or rpc runs.
    if (ctx.mode !== "tui") return;

    if (!listening) {
      // prependListener so our flag is set ahead of pi's own (prepended)
      // graceful-shutdown signal handler in the dispatch order.
      process.prependListener("SIGTERM", onSignal);
      if (process.platform !== "win32") {
        process.prependListener("SIGHUP", onSignal);
      }
      listening = true;
    }

    writeEntry(ctx);
  });

  pi.on("session_info_changed", async (_event, ctx) => {
    if (registeredId) writeEntry(ctx);
  });

  pi.on("session_shutdown", async (event, _ctx) => {
    if (listening) {
      process.off("SIGTERM", onSignal);
      if (process.platform !== "win32") {
        process.off("SIGHUP", onSignal);
      }
      listening = false;
    }
    if (!registeredId) return;

    // Signal-driven quit (reboot / window closed / kill): keep the entry so
    // pi-resume-sessions restores this session at next login.
    if (event.reason === "quit" && signalled) return;

    try {
      rmSync(entryPath(registeredId), { force: true });
    } catch {
      // ignore
    }
    registeredId = undefined;
  });
}
