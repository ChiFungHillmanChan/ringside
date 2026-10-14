# Security policy

## Supported versions

Security fixes go into the latest release only. Please update before you report a problem.

| Version | Supported |
| --- | --- |
| 0.10.x (latest) | yes |
| 0.9.x and older (0.8.x and older were Agent Map) | no |

## Report a vulnerability

Please **do not** open a public issue for a security problem.

Report it privately through GitHub instead:

1. Go to the [Security tab](https://github.com/ChiFungHillmanChan/ringside/security) of this repository.
2. Choose **Report a vulnerability**.
3. Describe the problem, how to reproduce it, and what an attacker could do with it.

You will get an answer within 7 days. Ringside is maintained by one person in their own time, so a fix can take longer. We will keep you informed, and credit you in the release notes unless you would rather stay anonymous.

## What Ringside can reach

This helps you judge whether something is a vulnerability. Ringside runs inside Claude Code, on your computer, with your user's rights. On its own, it:

- reads Claude Code's session registry (`~/.claude/sessions/`), agent files (`~/.claude/agents`, `<repo>/.claude/agents`) and this session's subagent transcripts;
- writes one small file per session under `~/.claude/mods-data/ringside/`, and reads the files other sessions write there;
- keeps that folder private (`chmod 700`), and deletes board files in it that have not been written for a week (`find … -delete`, inside `~/.claude/mods-data/ringside/hub/` only);
- runs `ps` and `git rev-parse`;
- makes no network requests and calls no model.

When you press something in the pane, and only then, it:

- **Jump there / Open in Terminal:** runs `osascript` (macOS) or `tmux` to bring a session's window forward, or opens a new Terminal or iTerm2 window running `claude attach <id>`;
- **Stop:** calls `CronDelete` or `TaskStop` through Claude Code, under its usual permission check;
- **a choice card:** answers this session's question (`AskUserQuestion`) with the label you pressed, or puts that label into your prompt. A card for another session only jumps there: no session answers another's question;
- **Launch:** starts the agent type you picked with the task you typed, or runs the skill you picked;
- **the repo board:** posts your note, and with **wake** on, starts a turn in the other sessions in the same repository with it.

### The repo board

Notes on the repo board come from other Claude sessions on the same computer, working in the same git repository. Ringside adds notes that this session has not read yet to your next prompt, framed as what those sessions said, not as your instructions. Anything that can write to `~/.claude/mods-data/ringside/` can still put text in front of Claude, so that folder is only as trusted as your user account. Report anything that lets text from outside your account reach the board, or that lets a note do more than add text to the prompt.

## Good things to report

- a way to make Ringside run a command other than the ones above, or with arguments an attacker controls (for example through a session name, a folder name or a terminal name);
- a way to make Ringside read, write or delete files outside the folders listed above;
- a way to make Ringside hold, drop, change or send a prompt or a tool call, or answer a question nobody pressed;
- secrets shown on screen while recording mode (`CLAUDE_MODS_RECORDING=1`) is on.
