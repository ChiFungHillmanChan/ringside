# Changelog

## 0.8.0 (2026-10-14)

- Map, Tasks and Launch are three cards at the top, the one shown in the accent colour.
- Tasks lists every task in its own order: done ones ticked, the one in progress marked "now", a bar and counts on top.
- Launch: every agent type is a card, grouped by where it comes from (project, yours, plugins, built-in), with the colour and model its agent file names. The name takes the left 70% and **▶ run** the right 30%. Run opens a task box across the card, empty each time, and gives it the keys; **cancel** takes run's place. A running agent shows "running · 0:12" in its place, and a press opens it on the map. Skills are cards too.
- A Peek opens as a card right under what you pressed, not at the end of the map. A session's card says what it last said, its folder, its terminal, and what Jump there did.
- Jump there runs on its own timer: a redraw of the pane no longer cancels it halfway. A Terminal window minimised to the Dock comes back.
- The "(no map)" tag is gone from session rows. Background sessions done or blocked for over a day are left off the map.

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
