# pi-session-resume

Restore your [pi](https://pi.dev) sessions after a reboot — the pi equivalent
of Claude Code SessionStart/SessionEnd hooks plus a boot script.

Your machine restarts for updates with a dozen pi sessions open. Instead of
reopening them by hand and trying to remember what each one was doing, run one
command and they all come back — as tabs, in the directories they were in,
with their full conversation history.

## Pieces

| Piece | What it does |
| --- | --- |
| `extensions/session-registry.ts` | auto-loaded by pi; tracks every open interactive session in `~/.pi/agent/session-registry/` |
| `bin/pi-resume-sessions` | reads the registry and reopens every interrupted session |

## Install

The extension loads automatically once this package is installed:

```bash
pi install git:github.com/erikdarlingdata/claude-plugins
```

The script needs to be on your PATH. Symlink it out of pi's package clone:

```bash
ln -s ~/.pi/agent/git/github.com/erikdarlingdata/claude-plugins/plugins/pi-session-resume/bin/pi-resume-sessions \
  /usr/local/bin/pi-resume-sessions
```

(Or copy the two files by hand — the extension goes anywhere in
`~/.pi/agent/extensions/`, the script anywhere on PATH. Nothing else to
configure.)

Requires `jq`. The default macOS target requires [Ghostty](https://ghostty.org);
`--tmux` works everywhere and needs no permissions. Sessions already running
when you install register themselves the next time they start.

## Use

After a reboot:

```bash
pi-resume-sessions
```

Every session that was open when the machine went down comes back, newest
first. On macOS that's one Ghostty window with a tab per session; elsewhere
(or with `--tmux`) they land in a detached tmux session named `pi-restore`
(`tmux attach -t pi-restore`). `--terminal` uses macOS Terminal.app, one
window per session — Terminal tabs can't be scripted without Accessibility
hacks, so Ghostty is the default.

```bash
pi-resume-sessions --list       # audit: state (live/dead), age, name, cwd
pi-resume-sessions --dry-run    # show what would happen
pi-resume-sessions --clean      # forget all dead entries instead of resuming
```

Safe to run anytime, not just after a reboot: sessions that are still running
are skipped, and a resumed session immediately re-registers itself.

## What gets resumed, and what doesn't

The registry distinguishes *how* a session ended:

| How the session ended | Resumed? |
| --- | --- |
| Ctrl+D, `/quit`, double Ctrl+C | no — you closed it on purpose |
| reboot, terminal window closed, `kill` | yes |
| crash, SIGKILL | yes |

The corollary: closing a terminal window **without** quitting pi counts as
"interrupted", so that session comes back next time. Ctrl+D or `/quit` is how
you end a session for good.

Relevance filters keep long-abandoned sessions from resurrecting. "Activity"
is the mtime of the session file — pi appends on every message, so it measures
when you last *conversed*, not merely whether a tab sat open:

```bash
pi-resume-sessions --max-age 24   # skip sessions idle >24h (default 72)
pi-resume-sessions --named-only   # only sessions named via pi -n / /name
pi-resume-sessions --all          # no filters
```

The default is 72h so a Monday-morning reboot doesn't drop Friday's sessions.
Override it persistently with `PI_RESUME_MAX_AGE_HOURS`. Filtered sessions are
reported, not deleted — rescue one with `--all` or `pi --session <id>`.

Name your sessions (`pi -n "pg migration"`, or `/name` inside a session) and
the resumed tabs and `--list` output read like a to-do list instead of UUIDs.

## macOS Automation permission (read this when Ghostty tabs don't open)

The first `pi-resume-sessions` run pops a dialog: *"(your terminal) wants to
control Ghostty"*. Click **Allow**. Gotchas learned the hard way:

- If the dialog gets dismissed or never appears, macOS records a **denial and
  never asks again**. Fix: System Settings → Privacy & Security → Automation →
  your terminal app → enable Ghostty, or reset with
  `tccutil reset AppleEvents com.apple.Terminal` (use your terminal's bundle
  id) and rerun.
- Don't test permission with innocuous reads like `get version` — basic
  Apple-event reads are permission-exempt and succeed even while denied. The
  real tell is `-1712` (timed out) / `-1743` (not permitted) from commands, or
  in `log show --predicate 'process == "ghostty"'`.
- Zero-permission fallback that always works: `pi-resume-sessions --tmux`.

## Design notes

- pi shuts down *gracefully* on SIGTERM/SIGHUP and emits the same
  `session_shutdown` event as a deliberate quit — so "delete the registry
  entry on shutdown" would wipe the registry moments before every reboot. The
  extension prepends its own in-process signal listener to tell the two apart
  (the event doesn't expose the difference).
- Only `tui`-mode sessions register. Without that guard, subagent and `pi -p`
  runs would pollute the registry, and killed background runs would resurrect
  as interactive tabs.
- There's deliberately no login LaunchAgent: background launchd processes get
  their own TCC identity and their Apple-event permission prompts are
  unreliable. One manual command after a reboot is dead reliable. If you want
  full auto anyway, a LaunchAgent running `pi-resume-sessions --tmux` needs no
  permissions at all.
