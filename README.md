# defer-queue

A Claude Code plugin that gives Claude Code [omp](https://github.com/can1357/oh-my-pi)'s follow-up queue: a prompt you queue while Claude is working is held and sent only after Claude finishes the turn on its own, as a turn of its own. It never steers or interrupts the running turn.

Stock Claude Code folds a message you queue mid-turn into the running turn as soon as the current tool calls finish. The `chat:queueSubmit` key (default `ctrl+x enter`) marks a prompt "wait its turn", but the engine queues it the same way and leaves the flag for hooks to act on. This plugin acts on it.

## Use

- **While Claude works, press `ctrl+x enter`** (or whatever you bind to `chat:queueSubmit`) instead of Enter. The prompt is held as one entry, and a line says `Queued until Claude finishes this turn (n waiting)`. Plain Enter still steers as usual.
- **Start a prompt with `->` or `=>`** to queue it with plain Enter, as in omp. While Claude works it waits; while idle with nothing waiting, it goes out at once as your own prompt.
- **`/queue <prompt>`** does the same from the command line, and works mid-turn. While idle it sends right away, or behind prompts already waiting. `/defer` is the same command, kept from 0.1.
- **Lists split.** After `->`, `=>` or `/queue`, a numbered (`1.`), lettered (`a)`) or Roman-numeral (`iv.`) list of two or more items in sequence queues one prompt per item; lines under an item stay with it. A gap, mixed `.` and `)`, mixed case or an empty item inside the list keeps the whole text as one prompt; an empty last item is dropped. Prompts sent with `ctrl+x enter` alone are never split.
- **`/queue`** with no text prints usage and lists what's waiting, including anything paused or kept under "Not sent".
- **A band above the prompt** lists held prompts, with these buttons:
  - **Take back** puts the newest held prompt back in the prompt box, after your draft with a blank line between, and leaves the turn running (omp's dequeue).
  - **Take back all** (shown with two or more held) puts them all back, oldest first.
  - **Discard** drops them.
  - **Send next** appears only while idle.

## Options

| Option (`/config`) | Default | What it does |
|---|---|---|
| **Defer every mid-turn prompt** (`defer_all_mid_turn`) | off | Holds every prompt you type while Claude works, so nothing steers. Not an omp behavior: omp's plain Enter always steers. |

There are no steering or interrupt mode settings: Claude Code keeps its own steering, and a plugin can't change how it works.

## When held prompts go out

- **One per turn.** When a main-conversation turn ends with an answer, the oldest held prompt is sent. Each later one waits for the previous one's turn to finish.
- **Esc puts them back.** When a main turn ends interrupted, every held prompt goes back in the prompt box, oldest first, after your draft, and nothing is sent. If the box can't take them (a dialog is open), they stay held and the queue pauses until you press **Send next**. A **Take back** or **Take back all** that can't reach the box leaves the pause in place. The mod sees the interrupt only once the turn has ended, so this happens after the stop, not before it as in omp, and it follows any interrupt of the main turn, not only Esc.
- **Nothing after an API error or a refusal.** Held prompts wait for the next turn that ends with an answer, or for **Send next**. omp has a recovery coordinator for these cases; Claude Code tells a plugin only why the turn ended, so the mod holds rather than guess.
- **Subagent turns don't count.** Their starts and ends are ignored, and only the end of the main turn that is running counts, once. A late or repeated end of an older turn releases nothing.
- **`/clear` (and a resume) moves them back** to the prompt box. Prompts written for the old conversation aren't sent into the new one, and a send scheduled before the `/clear` is cancelled. A held prompt the mod had already handed to Claude Code is checked again when Claude Code admits it (on 2.1.310 that can be after the `/clear`): if a `/clear` came first it is refused and kept under **Not sent**. One that Claude Code admitted before the `/clear` already started its turn in the old conversation. omp discards its queue here; this mod hands it back so nothing is lost. If the box can't take them, or a prompt was mid-send, they're kept under **Not sent** (below).
- **Not sent** is a second list in the band, and in `/queue`: prompts the mod will never send on its own (from before a `/clear` the box couldn't take, or a send a reload left unsettled, marked "may already have been sent"). **Put back in prompt box** or **Drop** them. A **Take back** (or an interrupt's restore) that is still on its way to the box when you `/clear`, and then can't reach it, lands here too, never back in the queue. So does a prompt you held that reached the mod only while the `/clear` was still running (another plugin can delay it): it was written for the old conversation.
- **Exiting the session loses them.** They are kept for the session only.
- **Queue input never jumps the line.** `/queue` or `->` sent while idle goes behind anything already waiting, and the oldest is sent.

## What a held prompt can't carry

A held prompt is resent with `$.prompt.submit({ asUser: true })`, so some things differ from typing it:

- **Images and other attachments:** a prompt with any isn't held. It goes to the turn as usual, with a toast.
- **`@file` mentions** aren't expanded. The model sees the literal `@path` and can read the file itself.
- **Slash commands and `!` shell lines** aren't held. Claude Code already runs them after the turn ends.
- **An IDE selection or hook-added context** from the original submission isn't kept.

If Claude Code or a hook refuses the resend, the prompt goes back to the prompt box. If the box can't take it either (a dialog is open), it goes back first in the queue and the queue pauses until you press **Send next**, so a refused prompt is never retried on its own.

A plugin reload (saving the plugin's files, `/reload-plugins`, an update) while a held prompt is being sent can't tell whether it went out. That prompt is kept under **Not sent** marked "may already have been sent", it is not resent, and the queue pauses.

## Keys

`chat:queueSubmit` is `ctrl+x enter` by default. To put it on a single chord, add this to `~/.claude/keybindings.json`:

```json
{ "context": "Chat", "bindings": { "ctrl+enter": "chat:queueSubmit" } }
```

That replaces the default `ctrl+enter` → `chat:sendNow`, which stays on `ctrl+x ctrl+s`. Terminals that don't report extended keys deliver `ctrl+enter` as plain Enter, which steers. On those, use `ctrl+x enter`.

## Install

The repository is its own marketplace (`.claude-plugin/marketplace.json`).

To install from a local clone, run this in a terminal:

```sh
claude plugin marketplace add <path to your clone>
claude plugin install defer-queue@defer-queue
```

A local-folder marketplace is read from the folder itself, so after editing, run `/reload-plugins` in a session.

To install from GitHub, once the repository is pushed and you have access, type this at a Claude Code prompt:

```
/plugin install defer-queue --marketplace chrisvaillancourt/defer-queue
```

To uninstall, run `claude plugin uninstall defer-queue@defer-queue`.

## Differences from omp

The queue follows omp's follow-up queue where Claude Code's plugin interface allows it. Where it doesn't, or where omp's behavior could lose a prompt, it differs on purpose:

- **Turns, not one run.** omp feeds a follow-up into the same agent run once the work would yield. Here each held prompt is a turn of its own, sent after the previous turn ends with an answer.
- **Esc restores after the stop.** omp withdraws queued input before it aborts. A plugin hears of the interrupt only from the turn's end, so the prompts come back just after.
- **`/clear` hands back.** omp discards its queue on a reset; this puts the prompts in the prompt box, or under **Not sent**.
- **Errors and refusals hold.** omp's recovery logic can resume a queue after some failures; here held prompts wait for the next answered turn or **Send next**.
- **No dequeue key.** omp's Alt+Up takes back the newest entry; here it's the band's **Take back** button. A plugin can't bind a new global key.
- **One mode.** omp's `followUpMode: "all"` delivers several queued prompts at once; Claude Code has no batch submit, so there is only one at a time. **Take back all** is the closest edit.
- **No attachments.** omp carries images through the queue; Claude Code can't resubmit them, so a prompt with an attachment isn't held.
- **Skills and commands.** omp can queue a skill as a follow-up; here slash commands and `!` lines are left to Claude Code, which already runs them after the turn.

## Cost

Nothing extra. The mod makes no model calls and adds nothing to the system prompt; each held prompt costs what typing it after the turn would.

## Limitations

- Held prompts live in session state: exiting the session loses them. Claude Code empties a plugin's session state at `/clear`, so the mod carries **Not sent** across in memory until the new conversation's state takes it over, which happens once Claude Code has switched to the new conversation (usually within milliseconds of the `/clear` finishing; the mod keeps trying for 10 seconds after that, and any use of the queue takes it over too). A plugin reload before the takeover loses the carried list, however long the `/clear` took.
- A prompt sent while nothing runs (`/queue` or `->` when idle) isn't checked again when Claude Code admits it: Claude Code 2.1.310 skips a plugin's own hook for a prompt the plugin sends from a timer. A `/clear` typed after it waits for its turn, so this only matters for a `/clear` typed while a turn ran that ended with an error, followed within the moment before that `/clear` runs by an idle `/queue`: that prompt would land in the new conversation. **Send next** and the release after an answered turn are checked.
- After a reload mid-send, a prompt can't be known sent or not; it is kept under **Not sent**, not resent.
- `@file` mentions, attachments, IDE selections and hook-added context from the original submission don't survive a resend (see above). The first item of an idle `->` list is the exception: it goes through as your own prompt.
- Claude Code 2.1.310 leaves a held prompt's text in the prompt box, so pressing Enter again sends it a second time. Clear the box yourself (the drop message says so). The mod can't clear it safely: the plugin interface has no "replace only if unchanged" write, and a blind replace could delete what you typed since.
- Prompts handed back go after your draft, not ahead of it as in omp, for the same reason: adding after the draft is the only write that can't delete what you're typing. Pressing **Take back** twice therefore leaves the newest first.
- Upgrading from 0.1 keeps prompts 0.1 was holding, but not its idea of which turn was running (0.1 counted subagent turns too). If the upgrade lands mid-turn, that turn's end releases nothing unless you hold another prompt during it (which tells the mod which turn is running); otherwise the next answered turn, or **Send next**, does.
- Tested in the terminal only. The desktop app and VS Code may stamp prompts with a different origin.

## Develop

- `scripts/check.sh` runs every commit gate: `claude plugin validate .`, `claude plugin test .` (`tests/*.test.ts(x)`), and a typecheck.
- `claude --plugin-dir .` runs a session with this working copy. If defer-queue is also installed, add `--settings '{"enabledPlugins":{"defer-queue@defer-queue":false}}'` so only the working copy loads.
- `uv run python scripts/drive.py --workdir <scratch dir>` drives a live interactive session through a pty (queueing needs a running turn and a key a headless run can't send) and checks the core flow with a throwaway observer mod: about five short Haiku turns.

The hooks API is early access and changes between Claude Code releases. This build was tested against Claude Code 2.1.310, in the terminal (2.1.310 raises `turn.start` for subagent runs too).

## License

MIT. See `LICENSE`.
