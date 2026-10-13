# Changelog

## 0.7.0 (2026-10-13)

First public release, as Agent Map. It grew out of a personal "cockpit" pane (0.1 to 0.6).

- The map: every Claude Code session on this computer as a box, with the subagents, background shells, loops and workflow agents each one started hanging under it. Waiting and possibly stuck sessions come first. Idle ones fold into one line each.
- NEEDS YOU across sessions. Stuck rules: the same call failing 3 times in a row, 10 minutes with no new step, or one foreground step over 20 minutes.
- Plain words for every step ("reading pricing.ts", "searching the code", "running tests").
- Peek on agents, sessions, loops and shells. Jump there for Terminal, iTerm2, tmux and background sessions.
- Lists sessions from Claude Code's own registry; no other mod needed. `CLAUDE_CONFIG_DIR` is respected.
- Reads savvy-progress and Flightdeck when they are loaded; offers Replay Theater's replay.
- Desktop: the map is also drawn as one picture, sized to the pane.
- One row above the prompt, only while the pane is hidden and only when another session waits on you or something may be stuck.
