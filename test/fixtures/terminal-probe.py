"""Offline PTY probe for the actual Pi CLI. Standard library only; not extension code.
Usage: python3 terminal-probe.py <fixture directory> <absolute extension root> [--live|--manual]
No flag: inspect retained CLI acceptance. --live: create/drive a disposable durable-ui-* fixture.
--manual: launch that isolated fixture on the caller\'s terminal for human inspection.
Captures raw ANSI and an approximate plain viewport. This is not human visual acceptance.
"""
import codecs
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import struct
import subprocess
import sys
import termios
import time

root, extension = map(Path, sys.argv[1:3])
manual = "--manual" in sys.argv[3:]
live = "--live" in sys.argv[3:] or manual
cols, rows = 100, 40
if live:
    assert root.name.startswith("durable-ui-"), "Live UI probe requires a disposable durable-ui-* directory"
    for directory in ("agents", "config", "sessions"):
        (root / directory).mkdir(mode=0o700, exist_ok=True)
    (root / "agents/probe.md").write_text("---\nname: probe\ndescription: Disposable UI probe\ntools: hold, unavailable_fixture\ncolor: cyan\n---\nOriginal fixture role. Follow the requested fixture task.")
env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", PI_CODING_AGENT_DIR=str(root / "config"),
           PI_OFFLINE="1", PI_SKIP_VERSION_CHECK="1", PI_TELEMETRY="0", PI_SUBAGENT_AGENTS=str(root / "agents"),
           PI_SUBAGENT_STORAGE=str(root / "runs"), DURABLE_ACCEPTANCE_DIR=str(root), DURABLE_ACCEPTANCE_SCENARIO="ui" if live else "inspect")
args = ["pi", "--offline", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
        "-e", str(extension / "index.ts"), "-e", str(extension / "test/fixtures/cli-acceptance.ts"),
        "--provider", "acceptance-local", "--model", "faux-1", "--thinking", "off", "--tools", "subagent,hold",
        "--session-dir", str(root / "sessions"), "--session-id", "durable-ui" if live else "durable-acceptance", "--tui-mode", "fullscreen"]
if manual:
    print("Offline synthetic UI fixture. Try: ui success, ui failure, ui hold (Escape cancels).")
    print("Use Ctrl+O to expand and /subagents to inspect. Closing/killing this Pi affects only this disposable session.")
    sys.exit(subprocess.run(args, cwd=root, env=env).returncode)
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
process = subprocess.Popen(args, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
raw = bytearray()
screen = [[" "] * cols for _ in range(rows)]
r = c = 0
saved = (0, 0)
pending = ""
decoder = codecs.getincrementaldecoder("utf-8")("replace")


def consume(text):
    global r, c, saved, pending, screen
    pending += text
    while pending:
        if pending[0] == "\x1b":
            if len(pending) < 2:
                return
            if pending[1] == "[":
                match = re.match(r"\x1b\[([0-?]*)([ -/]*)([@-~])", pending)
                if not match:
                    return
                params, _, command = match.groups()
                pending = pending[match.end():]
                nums = [int(x or 0) for x in params.lstrip("?<=>").split(";") if x.isdigit() or not x] or [0]
                n = nums[0] or 1
                if command in "Hf":
                    r = max(0, min(rows - 1, n - 1))
                    c = max(0, min(cols - 1, (nums[1] if len(nums) > 1 else 1) - 1))
                elif command == "A": r = max(0, r - n)
                elif command == "B": r = min(rows - 1, r + n)
                elif command == "C": c = min(cols - 1, c + n)
                elif command == "D": c = max(0, c - n)
                elif command == "G": c = min(cols - 1, n - 1)
                elif command == "d": r = min(rows - 1, n - 1)
                elif command == "J":
                    if nums[0] in (2, 3): screen = [[" "] * cols for _ in range(rows)]
                    elif nums[0] == 0:
                        screen[r][c:] = [" "] * (cols - c)
                        for i in range(r + 1, rows): screen[i] = [" "] * cols
                elif command == "K":
                    if nums[0] == 2: screen[r] = [" "] * cols
                    elif nums[0] == 0: screen[r][c:] = [" "] * (cols - c)
                    elif nums[0] == 1: screen[r][:c+1] = [" "] * (c+1)
                elif command == "S":
                    for _ in range(min(n, rows)): screen.pop(0); screen.append([" "] * cols)
                elif command == "s": saved = (r, c)
                elif command == "u" and not params.startswith("?"): r, c = saved
                elif command == "n" and nums[0] == 6: os.write(master, f"\x1b[{r+1};{c+1}R".encode())
                elif command == "c": os.write(master, b"\x1b[?1;2c")
                continue
            if pending[1] == "]":
                end = re.search(r"\x07|\x1b\\", pending[2:])
                if not end:
                    return
                body = pending[2:2+end.start()]
                if body in ("10;?", "11;?"):
                    color = "ffff/ffff/ffff" if body.startswith("10") else "0000/0000/0000"
                    os.write(master, f"\x1b]{body[:2]};rgb:{color}\x1b\\".encode())
                pending = pending[2+end.end():]
                continue
            if pending[1] in ("_", "P", "^"):
                end = pending.find("\x1b\\", 2)
                if end < 0: return
                pending = pending[end+2:]
                continue
            if pending[1] == "7": saved = (r, c)
            if pending[1] == "8": r, c = saved
            pending = pending[2:]
            continue
        ch, pending = pending[0], pending[1:]
        if ch == "\r": c = 0
        elif ch == "\n":
            r += 1
            if r >= rows: screen.pop(0); screen.append([" "] * cols); r = rows - 1
        elif ch == "\b": c = max(0, c - 1)
        elif ch == "\t": c = min(cols - 1, ((c // 8) + 1) * 8)
        elif ch >= " ":
            if c >= cols:
                c = 0; r += 1
                if r >= rows: screen.pop(0); screen.append([" "] * cols); r = rows - 1
            screen[r][c] = ch
            c += 1


def drain(seconds=0.6):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], max(0, deadline-time.monotonic()))
        if readable:
            try: chunk = os.read(master, 65536)
            except OSError: break
            if not chunk: break
            raw.extend(chunk)
            consume(decoder.decode(chunk))


def snapshot(name, expected=()):
    drain()
    text = "\n".join("".join(line).rstrip() for line in screen)
    (root / f"ui-{name}.txt").write_text(text)
    print(f"{name}: {root / ('ui-' + name + '.txt')}")
    for needle in expected:
        assert needle in text, f"{name}: missing {needle!r}; see captured viewport and raw stream"
    return text


try:
    drain(2)
    if live:
        os.write(master, b"ui success\r")
        snapshot("success", ("Done",))
        os.write(master, b"ui failure\r")
        os.write(master, b"\x0f")
        snapshot("failure", ("Failed", "fixture-provider-error"))
        os.write(master, b"\x0f")
        os.write(master, b"ui hold\r")
        snapshot("running", ("Running",))
        os.write(master, b"\x1b")
        snapshot("aborted", ("Cancelled",))
        os.write(master, b"ui hold\r")
        snapshot("before-kill", ("Running",))
        process.kill()
        process.wait(timeout=5)
        (root / "ui-before-kill.ansi").write_bytes(raw)
        os.close(master)
        # Respect the real 10-second crash lease; do not delete or alter locks.
        locks = list((root / "runs").glob("*.lock"))
        time.sleep(max(0, max(lock.stat().st_mtime for lock in locks) + 11 - time.time()))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        process = subprocess.Popen(args, cwd=root, env=env, stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
        os.close(slave)
        raw = bytearray()
        screen = [[" "] * cols for _ in range(rows)]
        r = c = 0
        pending = ""
        decoder = codecs.getincrementaldecoder("utf-8")("replace")
        drain(2)
        snapshot("reopened", ("interrupted · /subagents",))
        events = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
        inspection = next(event for event in events if event["event"] == "inspected" and event["pid"] == process.pid)
        print("Reopen UI context:", inspection.get("mode"), inspection.get("hasUI"))
        assert any(run["status"] == "interrupted" for run in inspection["runs"])
        assert not any(event["event"] == "model" and not event["parent"] and event["pid"] == process.pid for event in events)
    else:
        snapshot("collapsed")
    os.write(master, b"\x0f")  # Pi's Ctrl+O: expand tool results
    snapshot("expanded")
    os.write(master, b"/subagents\r")
    snapshot("menu", ("Durable subagents", "interrupted") if live else ())
    os.write(master, b"\r")
    snapshot("actions")
    os.write(master, b"\r")  # View result
    # Assert the run's own data, not this extension's label styling, so a wording change cannot pass for a missing panel.
    snapshot("result", ("Interrupted", "ui hold") if live else ())
    if live:
        os.write(master, b"/subagents\r")
        snapshot("resume-menu", ("interrupted",))
        os.write(master, b"\r")
        snapshot("resume-actions", ("Resume", "Cancel"))
        os.write(master, b"\x1b[B\r")
        snapshot("resume-confirm", ("Resume delegation?", "uncertain"))
        before = (root / "effect.txt").read_text()
        os.write(master, b"\r")  # Explicitly approve this fixture's resume
        snapshot("resumed", ("Done", "A tool's outcome is unknown", "outcome is uncertain"))
        assert (root / "effect.txt").read_text() == before, "Interactive resume repeated a fixture effect"
        assert "interrupted · /subagents" not in "\n".join("".join(line) for line in screen), "Resume left a stale pending-work footer"
        cols = 50
        screen = [[" "] * cols for _ in range(rows)]
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
        import signal
        os.kill(process.pid, signal.SIGWINCH)
        snapshot("narrow", ("Done",))
    os.write(master, b"\x03")
    drain(0.2)
    os.write(master, b"\x03")
    drain(0.5)
finally:
    if process.poll() is None:
        process.terminate()
        try: process.wait(timeout=5)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
    (root / "ui-raw.ansi").write_bytes(raw)
    os.close(master)
