import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Ring the terminal bell only when Pi has fully settled: retries, compaction,
 * tool calls, and queued follow-ups are finished. Ghostty and iTerm2 can turn
 * BEL into an unfocused-tab attention marker.
 */
export default function (pi: ExtensionAPI) {
  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.mode === "tui") process.stdout.write("\x07");
  });
}
