"""Live interactive check of defer-queue in a real Claude Code session.

Queueing needs a running turn and the chat:queueSubmit key, which a headless
`claude -p` run can't give, so this drives the terminal UI through a pty
(stdlib only; no tmux needed). Run it from a scratch directory:

    uv run python scripts/drive.py --workdir /some/scratch/dir

It writes a throwaway observer mod into <workdir>/observer that logs
prompt.submit, prompt.fill, turn.start, turn.complete and command.run to
<workdir>/events.jsonl, starts `claude --plugin-dir <this repo> --plugin-dir
<observer> --model haiku`, and walks four scenarios:

  1. A long turn (a 25-second ping); `-> TWO` (plain Enter) and `THREE` (ctrl+x enter) typed
     during it. Expect: both held, then sent one per answered turn, in order.
  2. A long turn; `-> FIVE` typed during it, then Esc. Expect: FIVE filled
     back into the prompt box, nothing sent.
  3. `/queue` alone. Expect: usage plus the (empty) list.
  4. `-> SIX` while idle with nothing held. Expect: goes through as typed.

An installed copy of defer-queue would load too and hold prompts twice, so
the session gets --settings disabling `defer-queue@defer-queue` (override
with --installed-id). Check the debug log afterwards: the plugin must load
from this repo's path only.

Each run costs four or five short Haiku turns. Exit status 0 when every
expectation held; the summary prints what did not.
"""

from __future__ import annotations

import argparse
import json
import os
import pty
import re
import select
import struct
import sys
import time
from pathlib import Path

try:
    import fcntl
    import termios
except ImportError:  # pragma: no cover - POSIX only
    sys.exit("drive.py needs a POSIX pty")

REPO = Path(__file__).resolve().parent.parent
ANSI = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\x1b[=>]")

OBSERVER_MANIFEST = {
    "name": "dq-observer",
    "version": "0.0.1",
    "description": "Throwaway probe: logs queue-related events to a file.",
}

OBSERVER_MODULE = """
import type { EngineInterface, Register } from 'claude-code'

const OUT = %(out)s
const lines: string[] = []

async function log($: EngineInterface, row: Record<string, unknown>) {
  lines.push(JSON.stringify({ t: Date.now(), ...row }))
  try { await $.fs.write(OUT, lines.join('\\n') + '\\n') } catch {}
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => { await log($, { ev: 'session.start' }); return next(e) })
  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    await log($, { ev: 'prompt.submit', text: e.text, origin: e.origin, wait: e.wait, turnId: e.turnId, drop: r.drop })
    return r
  })
  on('prompt.fill', async ($, e, next) => { await log($, { ev: 'prompt.fill', text: e.text, mode: e.mode }); return next(e) })
  on('turn.start', async ($, e, next) => {
    await log($, { ev: 'turn.start', turnId: e.turnId, agentId: e.agentId, text: e.text.slice(0, 80) })
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    await log($, { ev: 'turn.complete', turnId: e.turnId, agentId: e.agentId, reason: e.reason, answer: e.answer.slice(0, 80) })
    return next(e)
  })
  on('command.run', async ($, e, next) => {
    const r = await next(e)
    await log($, { ev: 'command.run', command: e.command, args: e.args, text: r.text })
    return r
  })
}
"""


class Session:
    def __init__(self, argv: list[str], cwd: Path, raw_log: Path) -> None:
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(cwd)
            os.execvp(argv[0], argv)
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 140, 0, 0))
        self.raw = raw_log.open("wb")
        self.text = b""

    def pump(self, seconds: float) -> None:
        end = time.monotonic() + seconds
        while (left := end - time.monotonic()) > 0:
            ready, _, _ = select.select([self.fd], [], [], min(left, 0.2))
            if not ready:
                continue
            try:
                chunk = os.read(self.fd, 65536)
            except OSError:
                return
            if not chunk:
                return
            self.raw.write(chunk)
            # The TUI moves the cursor instead of drawing spaces, so text is kept
            # without escapes or whitespace, and needles are matched the same way.
            self.text = (self.text + re.sub(rb"\s+", b"", ANSI.sub(b"", chunk)))[-200_000:]

    def key(self, seq: str, gap: float = 0.5) -> None:
        """One key, sent whole (an escape sequence split up reads as Esc)."""
        os.write(self.fd, seq.encode())
        self.pump(gap)

    def send(self, data: str, gap: float = 0.05) -> None:
        for ch in data:
            os.write(self.fd, ch.encode())
            self.pump(gap)

    def type_line(self, text: str, submit: str = "\r") -> None:
        self.send(text, gap=0.02)
        self.pump(0.4)
        self.send(submit, gap=0.3)

    def screen_has(self, needle: str) -> bool:
        return re.sub(r"\s+", "", needle).encode() in self.text

    def close(self) -> None:
        for _ in range(2):
            try:
                os.write(self.fd, b"\x03")
            except OSError:
                break
            self.pump(1.0)
        try:
            os.kill(self.pid, 15)
        except ProcessLookupError:
            pass
        self.raw.close()


def events(path: Path) -> list[dict]:
    if not path.exists():
        return []
    rows = []
    for line in path.read_text().splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            pass
    return rows


def wait_for(s: Session, path: Path, check, timeout: float) -> bool:
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        s.pump(0.5)
        if check(events(path)):
            return True
    return False


def main_completions(rows: list[dict], reason: str | None = None) -> list[dict]:
    return [
        r for r in rows
        if r["ev"] == "turn.complete" and r.get("agentId") is None and (reason is None or r.get("reason") == reason)
    ]


def plugin_submits(rows: list[dict]) -> list[str]:
    return [r["text"] for r in rows if r["ev"] == "prompt.submit" and r["origin"].get("kind") == "plugin"]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--workdir", type=Path, required=True, help="scratch directory the session runs in")
    ap.add_argument("--plugin-dir", type=Path, default=REPO, help="defer-queue working copy (default: this repo)")
    ap.add_argument("--installed-id", default="defer-queue@defer-queue", help="installed plugin id to disable")
    ap.add_argument("--model", default="haiku")
    args = ap.parse_args()

    work = args.workdir.resolve()
    observer = work / "observer"
    (observer / ".claude-plugin").mkdir(parents=True, exist_ok=True)
    (observer / "hooks").mkdir(parents=True, exist_ok=True)
    out = work / "events.jsonl"
    if out.exists():
        out.unlink()  # generated by the previous run
    (observer / ".claude-plugin" / "plugin.json").write_text(json.dumps(OBSERVER_MANIFEST))
    (observer / "hooks" / "hooks.json").write_text('{ "modules": ["./observe.ts"] }')
    (observer / "hooks" / "observe.ts").write_text(OBSERVER_MODULE % {"out": json.dumps(str(out))})
    session_dir = work / "session"
    session_dir.mkdir(exist_ok=True)

    debug = work / "debug.log"
    argv = [
        "claude",
        "--plugin-dir", str(args.plugin_dir.resolve()),
        "--plugin-dir", str(observer),
        "--model", args.model,
        "--settings", json.dumps({"enabledPlugins": {args.installed_id: False}}),
        "--allowedTools", "Bash(ping:*)",  # the Bash tool refuses a foreground sleep
        "--debug-file", str(debug),
    ]
    print("running:", " ".join(argv), f"(cwd {session_dir})")
    s = Session(argv, session_dir, work / "screen.raw")
    failures: list[str] = []

    def expect(ok: bool, what: str) -> None:
        print(("ok   " if ok else "FAIL ") + what)
        if not ok:
            failures.append(what)

    try:
        # The trust dialog defaults to "No, exit": move to "Yes" explicitly.
        for _ in range(40):
            s.pump(0.5)
            if s.screen_has("Enter to confirm"):
                s.key("\x1b[B", gap=0.8)
                s.key("\r", gap=1.0)
                break
        if not wait_for(s, out, lambda r: any(x["ev"] == "session.start" for x in r), 30):
            expect(False, "session started (observer saw session.start)")
            return 1
        s.pump(3)

        # 1. Two follow-ups queued during a long turn, one by each ingress.
        s.type_line("Use the Bash tool to run: ping -c 25 127.0.0.1. Then reply with only the word ONE.")
        expect(wait_for(s, out, lambda r: any(x["ev"] == "turn.start" and x.get("agentId") is None for x in r), 30),
               "first turn started")
        s.pump(5)
        s.type_line("-> Reply with only the word TWO.")
        s.pump(1)
        s.key("\x15")  # ctrl+u: a held prompt's text stays in the box; clear it as a person would
        s.type_line("Reply with only the word THREE.", submit="\x18\r")
        s.pump(1)
        s.key("\x15")
        expect(wait_for(s, out, lambda r: len(main_completions(r, "answer")) >= 3, 180),
               "three answered main turns (ONE, then TWO, then THREE)")
        rows = events(out)
        expect(plugin_submits(rows) == ["Reply with only the word TWO.", "Reply with only the word THREE."],
               f"plugin sent TWO then THREE, one per turn: {plugin_submits(rows)}")
        # The observer sits beneath defer-queue: a held prompt never reaches it
        # as the person's own.
        leaked = [x["text"] for x in rows if x["ev"] == "prompt.submit"
                  and x["origin"].get("kind") == "composer" and ("TWO" in x["text"] or "THREE" in x["text"])]
        expect(leaked == [], f"neither follow-up reached the turn as typed: {leaked}")

        # 2. Esc during a turn with a follow-up queued puts it back, sends nothing.
        s.pump(3)
        s.type_line("Use the Bash tool to run: ping -c 30 127.0.0.1. Then reply with only the word FOUR.")
        n_start = len([x for x in events(out) if x["ev"] == "turn.start"])
        wait_for(s, out, lambda r: len([x for x in r if x["ev"] == "turn.start"]) > n_start, 30)
        s.pump(5)
        s.type_line("-> Reply with only the word FIVE.")
        s.pump(1)
        s.key("\x15")
        s.pump(1)
        s.send("\x1b", gap=0.5)
        expect(wait_for(s, out, lambda r: len(main_completions(r, "aborted")) >= 1, 30), "turn ended aborted after Esc")
        s.pump(5)
        rows = events(out)
        fills = [x["text"] for x in rows if x["ev"] == "prompt.fill"]
        expect(any("Reply with only the word FIVE." in f for f in fills), f"FIVE filled back into the box: {fills}")
        expect("Reply with only the word FIVE." not in plugin_submits(rows), "FIVE was not sent")

        # 3. /queue alone prints usage and the list. Clear the restored draft first.
        s.send("\x15", gap=0.5)  # ctrl+u
        s.type_line("/queue")
        expect(wait_for(s, out, lambda r: any(x["ev"] == "command.run" and x.get("command") == "queue" for x in r), 20)
               or s.screen_has("Usage: /queue"), "/queue ran")
        s.pump(2)
        expect(s.screen_has("Usage: /queue"), "/queue printed usage")

        # 4. Shorthand while idle with nothing held goes through as typed.
        s.type_line("-> Reply with only the word SIX.")
        expect(wait_for(s, out, lambda r: any(
            x["ev"] == "turn.start" and x.get("agentId") is None and "SIX" in x.get("text", "") for x in r), 30),
            "idle -> SIX started a turn")
        rows = events(out)
        six = [x for x in rows if x["ev"] == "prompt.submit" and "SIX" in x["text"]]
        expect(any(x["origin"].get("kind") == "composer" and x["text"] == "Reply with only the word SIX." for x in six),
               f"SIX entered as the person's own prompt, arrow stripped: {[(x['text'], x['origin']) for x in six]}")
        wait_for(s, out, lambda r: len(main_completions(r, "answer")) >= 4, 60)
    finally:
        s.close()

    print(f"events: {out}\ndebug log: {debug}\nscreen: {work / 'screen.raw'}")
    print("summary:", "all expectations held" if not failures else f"{len(failures)} failed: {failures}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
