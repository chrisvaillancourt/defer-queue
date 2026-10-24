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
  - **Take back** puts the newest held prompt back in the prompt box, ahead of your draft with a blank line between, and leaves the turn running (omp's dequeue).
  - **Take back all** (shown with two or more held) puts them all back, oldest first.
  - **Discard** drops them.
  - **Send next** appears only while idle.

Set **Defer every mid-turn prompt** (`defer_all_mid_turn`) in `/config` to hold every prompt typed while Claude works, so nothing steers.

## When held prompts go out

- **One per turn.** When a main-conversation turn ends with an answer, the oldest held prompt is sent. Each later one waits for the previous one's turn to finish.
- **Esc puts them back.** When a main turn ends interrupted, every held prompt goes back in the prompt box, oldest first, ahead of your draft, and nothing is sent. If the box can't take them (a dialog is open), they stay held and the queue pauses until you press **Send next**. The mod sees the interrupt only once the turn has ended, so this happens after the stop, not before it as in omp, and it follows any interrupt of the main turn, not only Esc.
- **Nothing after an API error or a refusal.** Held prompts wait for the next turn that ends with an answer, or for **Send next**. omp has a recovery coordinator for these cases; Claude Code tells a plugin only why the turn ended, so the mod holds rather than guess.
- **Subagent turns don't count.** Their starts and ends are ignored, and only the end of the main turn that is running counts, once. A late or repeated end of an older turn releases nothing.
- **`/clear` (and a resume) moves them back** to the prompt box. Prompts written for the old conversation aren't sent into the new one, and a send scheduled before the `/clear` is cancelled. omp discards its queue here; this mod hands it back so nothing is lost. If the box can't take them, or a prompt was mid-send, they're kept under **Not sent** (below).
- **Not sent** is a second list in the band, and in `/queue`: prompts the mod will never send on its own (from before a `/clear` the box couldn't take, or a send a reload left unsettled, marked "may already have been sent"). **Put back in prompt box** or **Drop** them.
- **Exiting the session loses them.** They are kept for the session only.

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
claude plugin marketplace add ~/dev/github/chrisvaillancourt/defer-queue
claude plugin install defer-queue@defer-queue
```

A local-folder marketplace is read from the folder itself, so after editing, run `/reload-plugins` in a session.

To install from GitHub, once the repository is pushed and you have access, type this at a Claude Code prompt:

```
/plugin install defer-queue --marketplace chrisvaillancourt/defer-queue
```

To uninstall, run `claude plugin uninstall defer-queue@defer-queue`.

## Develop

- `claude plugin test .` runs `tests/*.test.tsx` against the engine.
- `claude plugin validate .` checks the manifest and hooks.
- `claude --plugin-dir .` runs a session with this working copy.
- To type-check: Claude Code writes `.claude-plugin/types/` (gitignored) whenever it loads the plugin, and `tsconfig.json` extends it, so `tsc -p .` works after one load.

The hooks API is early access and changes between Claude Code releases. This build was tested against Claude Code 2.1.310, in the terminal (2.1.310 raises `turn.start` for subagent runs too). The desktop app and VS Code may stamp prompts with a different origin, and haven't been tested.
