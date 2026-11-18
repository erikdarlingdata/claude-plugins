/**
 * Refusal Fallback Extension
 *
 * When a request fails with a provider content-policy refusal (e.g. Anthropic's
 * "blocked under Anthropic's Usage Policy"), switch the session to a fallback
 * model and continue the task automatically.
 *
 * Use only for approved false-positive provider filters; do not use automatic
 * rerouting to evade a legitimate policy block or move restricted data to a
 * provider that is not approved to receive it.
 *
 * Configure the fallback below. Thinking level "xhigh" = extra-high effort.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const FALLBACK_PROVIDER = "openrouter";
const FALLBACK_THINKING = "xhigh" as const;

// The fallback is picked from the catalog at refusal time, so new models need no
// edit here: the newest Opus older than the refusing model. A non-Opus model
// (or the ~opus-latest alias) falls back to the newest Opus below the newest.
// Why not ~opus-latest: it is the model that refuses. On 2026-10-05 Opus 5.5
// refused and Opus 5 then completed the same task.
const OPUS_ID = /^anthropic\/claude-opus-(\d+(?:\.\d+)?)$/;

export function pickFallback(registry: { getAll(): Array<{ provider: string; id: string }> }, current?: { provider: string; id: string }) {
	const opus = registry
		.getAll()
		.filter((m) => m.provider === FALLBACK_PROVIDER && OPUS_ID.test(m.id))
		.map((m) => ({ id: m.id, v: Number(OPUS_ID.exec(m.id)![1]) }))
		.sort((a, b) => b.v - a.v);
	if (opus.length === 0) return undefined;
	const cur = current?.id ? OPUS_ID.exec(current.id) : null;
	if (!cur) {
		// Not a versioned Opus: the alias means "newest", anything else (Fable, Sonnet) gets the newest Opus.
		return /opus-latest/.test(current?.id ?? "") ? opus[1]?.id : opus[0].id;
	}
	return opus.find((m) => m.v < Number(cur[1]))?.id;
}

/** Error messages matching any of these are treated as policy refusals. */
const REFUSAL_PATTERNS = [
	/usage policy/i,
	/refusals-and-fallback/i,
	/blocked under anthropic/i,
	/violative/i,
	/content filter/i,
];

const CONTINUE_PROMPT =
	"The previous attempt was blocked by the provider's content filter. " +
	"You are now a different model. Please continue with the original request.";

export default function (pi: ExtensionAPI) {
	// Guard: only one fallback attempt per failure, reset on any successful response.
	let attempted = false;

	pi.on("message_end", async (event, ctx) => {
		const msg = event.message;
		if (msg.role !== "assistant") return;

		const errorMessage = (msg as { errorMessage?: string }).errorMessage;
		if (!errorMessage) {
			attempted = false; // successful assistant message → re-arm
			return;
		}

		if (!REFUSAL_PATTERNS.some((p) => p.test(errorMessage))) return;

		if (attempted) {
			if (ctx.hasUI) ctx.ui.notify("Refusal on the fallback model too — not retrying. Rephrase and resend.", "error");
			return;
		}

		const fallbackId = pickFallback(ctx.modelRegistry, ctx.model);
		const model = fallbackId ? ctx.modelRegistry.find(FALLBACK_PROVIDER, fallbackId) : undefined;
		if (!model) {
			if (ctx.hasUI) ctx.ui.notify(`No older Opus in the catalog to fall back to from ${ctx.model?.id}`, "error");
			return;
		}
		attempted = true;

		const ok = await pi.setModel(model);
		if (!ok) {
			if (ctx.hasUI) {
				ctx.ui.notify(`No auth for fallback provider ${FALLBACK_PROVIDER}`, "error");
			}
			return;
		}
		pi.setThinkingLevel(FALLBACK_THINKING);

		if (ctx.hasUI) {
			ctx.ui.notify(
				`Refusal detected — falling back to ${model.id} (${FALLBACK_THINKING}). ` +
					"Use Ctrl+L to switch back.",
				"warning",
			);
		}

		// Re-trigger the turn on the new model. If the agent is still winding
		// down the errored turn, queue as a follow-up; otherwise send now.
		try {
			if (ctx.isIdle()) {
				pi.sendUserMessage(CONTINUE_PROMPT);
			} else {
				pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
			}
		} catch {
			// Streaming state changed between check and send; queue it.
			pi.sendUserMessage(CONTINUE_PROMPT, { deliverAs: "followUp" });
		}
	});
}
