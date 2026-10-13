# Acknowledgements

Agent Map was built to work with other Claude Code mods, not to replace them. Thank you to the people behind these projects. No code was copied from them. Where Agent Map reads another mod's state, it reads it only when that mod is loaded, and only in the shape that mod publishes.

## Mods Agent Map reads or hands off to

- **[savvy-progress](https://github.com/johnnyvizz/claude-kit/tree/main/plugins/savvy-progress)** by johnnyvizz (MIT). Agent Map shows the step progress and cost estimate that savvy-progress collects from subagents (its `agents` state).
- **[Flightdeck](https://github.com/scasella/claude-flightdeck)** by Stephen Casella (MIT). Agent Map shows each subagent's context size and the workflow agents that Flightdeck's `agents` and `loops` state track. Flightdeck's "what it can reach" table also shaped the one in this README.
- **[Replay Theater](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater)** by Claude Code DevRel, Anthropic (Apache-2.0). This session's Peek offers its `/replay` command.

## Ideas

- **[agent-graph](https://github.com/theishandubey/claude-mods/tree/main/plugins/agent-graph)** by theishandubey (MIT). It draws a card graph on the desktop and an indented tree in the terminal, which shaped Agent Map's desktop drawing.
- **[Filetree](https://github.com/data-goblin/claude-code-filetree)** by Kurt Buhler (MIT). Its README showed how much a short demo GIF and an honest feature list help.
- **[awesome-claude-code-mods](https://github.com/karanb192/awesome-claude-code-mods)** by karanb192 (CC0-1.0). This catalogue made it possible to see what already existed: several single-session agent trees and multi-session boards. Agent Map aims to join those two ideas in one place.

## Tools

Built and tested with Claude Code's mod engine and its test kit (`claude plugin validate`, `claude plugin test`).
