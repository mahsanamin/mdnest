"""Run a command on a pseudo-terminal and answer its prompts, like a person.

Used by tests/cli-unit.sh and tests/cli-login-update.sh to drive
`mdnest login <url>` with no token, which reads the token from /dev/tty. A
child on a pty has that pty as its /dev/tty, so the real prompt code runs.

    python3 tests/pty-drive.py -- mdnest login https://x

Answers come from the environment, in order, one per prompt:
    PTY_ANSWERS   answers separated by newlines (an empty line answers empty)
    PTY_PROMPTS   the prompt texts to wait for, separated by newlines
A prompt whose text contains "not shown" is a secret: the answer is typed
only once the terminal's ECHO flag is off, which is also how the test learns
that echo really was turned off (it prints "PTY-ECHO-STILL-ON" otherwise).
Typing before that would make the kernel echo the token itself, a race.

Prints everything the command wrote to the terminal, then exits with the
command's own status.
"""
import os
import pty
import select
import sys
import termios
import time

argv = sys.argv[sys.argv.index("--") + 1:]
answers = os.environ.get("PTY_ANSWERS", "").split("\n")
prompts = [p for p in os.environ.get("PTY_PROMPTS", "").split("\n") if p]

pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)

out = b""
seen = 0          # how much of `out` has been searched for prompts
step = 0
deadline = time.time() + 30
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.1)
    if r:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        out += chunk
    if step < len(prompts):
        idx = out.find(prompts[step].encode(), seen)
        if idx >= 0:
            seen = idx + len(prompts[step])
            if "not shown" in prompts[step]:
                off = False
                for _ in range(100):
                    if not termios.tcgetattr(fd)[3] & termios.ECHO:
                        off = True
                        break
                    time.sleep(0.05)
                if not off:
                    out += b"\nPTY-ECHO-STILL-ON\n"
            else:
                time.sleep(0.2)
            ans = answers[step] if step < len(answers) else ""
            os.write(fd, ans.encode() + b"\n")
            step += 1

_, status = os.waitpid(pid, 0)
sys.stdout.write(out.decode("utf-8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else (status >> 8))
