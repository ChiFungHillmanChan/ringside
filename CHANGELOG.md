# Changelog

All notable changes to Ringside are listed here. Versions follow [semantic versioning](https://semver.org/).

## Unreleased

- Recording mode now masks the desktop drawing too. Session names, branches and what each node is doing were shown there unmasked.
- A Stop that is refused or fails no longer takes the loop or shell off the map. It stays listed, and a toast says why it could not be stopped. A failed `TaskStop` of Claude's own no longer ends the shell on the map either.
- A background shell is no longer dropped after three hours while it still runs. It leaves the map when its notification arrives, when it is stopped, or when the session's next Stop no longer lists it.

## 0.9.0 (2026-10-14)

Agent Map is now **Ringside**.

- The plugin, the marketplace and the command are renamed: `/ringside` (was `/agent-map`). Claude's board tool is now `mcp__ringside__hub`, and each session's file lives under `~/.claude/mods-data/ringside/`. The README's "Coming from Agent Map" section shows how to switch.
- The repository moved to [ChiFungHillmanChan/ringside](https://github.com/ChiFungHillmanChan/ringside). Old links redirect.
- Agent dots in the launcher use clearer colours, so blue and purple no longer look alike.
- A subagent's Peek no longer lists its hand-back as a step. Its answer still shows below the steps.
- The launcher's filter box now reads `find:` (it read `find › :`).
- A new README with a walkthrough GIF of the terminal and a guide to every tab, plus CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue and pull request templates, and CI that validates and tests every change.

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
