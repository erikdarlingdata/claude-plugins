# Optional Pi extension recipes

These are opt-in quality-of-life recipes referenced by
[`pi-setup-guide.md`](../../pi-setup-guide.md). They are deliberately outside
the package's `pi.extensions` manifest: installing `claude-plugins` does not
silently activate personal TUI or provider behavior.

Copy only the files you want:

```bash
mkdir -p ~/.pi/agent/extensions
cp recipes/extensions/reply-timestamps.ts ~/.pi/agent/extensions/
cp recipes/extensions/clickable-links.ts ~/.pi/agent/extensions/
cp recipes/extensions/bang-notify.ts ~/.pi/agent/extensions/
cp recipes/extensions/settle-bell.ts ~/.pi/agent/extensions/
# Advanced and policy-sensitive; read its warning first:
cp recipes/extensions/refusal-fallback.ts ~/.pi/agent/extensions/
```

Run `/reload` after copying a local extension. **Pi-subagents aborts its running
children during session shutdown**, so let useful subagents finish before
reloading their parent session.

## Recipes

| File | Purpose | Self-test / config |
| --- | --- | --- |
| `reply-timestamps.ts` | Durable, TUI-only reply timestamps and a footer clock | `~/.pi/agent/reply-timestamps.json` |
| `clickable-links.ts` | OSC 8 links on markdown labels and bare URLs | `/linktest`; `~/.pi/agent/clickable-links.json` |
| `bang-notify.ts` | Wake Pi when a contextual `!` command finishes; learn command completions | `~/.pi/agent/bang-notify.json`; history in `bang-history.json` |
| `settle-bell.ts` | Ring BEL on `agent_settled` | Configure the terminal's bell/attention behavior |
| `refusal-fallback.ts` | Retry an approved false-positive provider refusal on another model | Edit constants in the source |

## Safety notes

- Extensions execute as your user and can run arbitrary code. Review every file
  before copying it.
- `refusal-fallback.ts` automatically resends the original request to another
  model. Use it only when that provider is approved for the data and the first
  refusal is a known false positive; never use it to evade a legitimate policy.
- `bang-notify.ts` never wakes for `!!` because that output is intentionally
  excluded from model context.
- OSC 8 capability settings override environment detection. Do not force
  hyperlinks through a terminal path that cannot render them.
- A write-only output surface needs a self-test. `/linktest` exists because an
  OSC sequence can fail silently while the extension believes it succeeded.
