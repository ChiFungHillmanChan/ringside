# Contributing to Ringside

Thank you for helping. Ringside is a small project, and every bug report, idea, test on a new terminal, docs fix and pull request makes it better.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Report a bug.** [Open a bug report](https://github.com/ChiFungHillmanChan/ringside/issues/new?template=bug_report.yml). Say what you did, what you expected and what happened instead. Include your Claude Code version, system and terminal.
- **Suggest an idea.** [Open a feature request](https://github.com/ChiFungHillmanChan/ringside/issues/new?template=feature_request.yml). Describe the problem first, then the change you would like.
- **Try it somewhere new.** Linux, Windows, WezTerm, Kitty, Ghostty, the desktop app: tell us what works and what does not.
- **Improve the docs.** If something in the README confused you, it will confuse others too.
- **Send code.** Small fixes are welcome straight away. For a bigger change, open an issue first, so we can agree on the shape before you spend time on it.

Security problems are the exception: report them privately, as [SECURITY.md](SECURITY.md) describes.

## Set up

You need:

- Claude Code 2.1.287 or newer (`claude --version`)
- Node.js 18 or newer, for the type check (`npx`)
- git

Then:

```sh
git clone https://github.com/ChiFungHillmanChan/ringside.git
cd ringside
claude --plugin-dir .
```

That session loads your clone. Every time you save a file, the session reloads the mod (hot reload), so you see your change without restarting.

If you also have Ringside installed from the marketplace, turn that copy off while you work, so only your clone runs:

```sh
claude plugin disable ringside@ringside
# and when you are done:
claude plugin enable ringside@ringside
```

## Project layout

| Path | What lives there |
| --- | --- |
| `hooks/register.tsx` | The hooks and the whole pane: tabs, map, Peek, Tasks, Launch, the band above the prompt |
| `hooks/map.ts` | The model as pure functions: building the map, NEEDS YOU, the stuck rules, plain words for tool calls, the desktop picture |
| `hooks/fleet.ts` | Other sessions on this computer, and Jump there |
| `hooks/hub.ts` | The per-session board files and the repo board |
| `hooks/agents.ts` | The launcher catalogue: agent files, sections, colours |
| `hooks/loops.ts` | `/loop` schedules and self-paced loops |
| `types/index.d.ts` | The shape of every value Ringside keeps in Claude Code's state |
| `tests/` | Tests run by `claude plugin test` |
| `media/` | The README's GIF and screenshots |

## Run the checks

Run all three before you send a pull request:

```sh
claude plugin validate .          # reads the manifest and module the way Claude Code will
claude plugin test .              # runs everything in tests/
npx -p typescript@5 tsc -p .      # type check
```

The type check needs the type files that Claude Code writes to `.claude-plugin/types/` the first time it loads the mod. So start one session with `claude --plugin-dir .` before you run `tsc`. That folder is in `.gitignore`.

CI runs `validate` and `test` on every push and pull request.

## Write tests

- Logic that does not need Claude Code belongs in `map.ts`, `agents.ts`, `fleet.ts`, `hub.ts` or `loops.ts`, as pure functions. Test it directly, as `tests/map.test.ts` and `tests/logic.test.ts` do.
- Behaviour of the pane is tested by mounting it with the test kit, as `tests/ringside.test.tsx` does. Press buttons by their `key`, then check what is drawn. Mount on both the `terminal` and `desktop` surfaces when a change touches drawing.
- A bug fix comes with a test that fails without the fix.

## House rules

These keep Ringside safe to leave running all day. Please keep to them, and say so in your pull request if a change has to bend one.

1. **Never get in the way of the person.** Ringside never holds, drops or rewrites a prompt, and never denies, delays or changes a tool call. It watches.
2. **Local only.** No network requests and no model calls.
3. **Quiet above the prompt.** Nothing is drawn above the prompt unless something needs the person (a wait in another session, or something that may be stuck), and only while the pane is hidden.
4. **Plain words.** Say "reading pricing.ts", not `Read {"file_path": ...}`. Labels say what a button does.
5. **Other mods are sources, not rivals.** Read another mod's state only after checking its shape. Never write to it.
6. **Slow work runs outside a press.** Anything slow (such as `osascript`) runs from `$.clock.after(0, ...)`, not inside a button's `onPress`. A redraw can cancel work started inside a press.
7. **Measure in terminal cells.** Use `fit` and `padEnd` from `map.ts`, which count wide characters as two cells.
8. **No emoji in the interface.** Use the glyphs already in use (`✓`, `○`, `!`, `├─▸`).

## Code style

- TypeScript, strict. Match the code around your change: its naming, its comment density and its idioms.
- Comments say why, not what.
- Keep functions small, and keep pure logic out of `register.tsx` where you can.

## Commits and pull requests

1. Make a branch from `main`.
2. Keep each pull request to one topic.
3. Write commit messages in the imperative mood, with a short first line: `Jump: bring back a minimised Terminal window`.
4. Add a line under **Unreleased** at the top of [CHANGELOG.md](CHANGELOG.md), in plain words for users.
5. For a change you can see, add a screenshot or a short capture (`tmux capture-pane -p -e` works well) to the pull request.
6. Fill in the pull request template, and make sure the checks pass.

A maintainer reviews every pull request. Expect questions. They are about the change, not about you.

## Release (maintainers)

1. Move the **Unreleased** notes in `CHANGELOG.md` under a new version heading with today's date.
2. Bump `version` in `.claude-plugin/plugin.json`.
3. Run the three checks.
4. Commit, tag `vX.Y.Z`, push, and publish a GitHub release with the changelog notes.

Installs update with `claude plugin marketplace update ringside` followed by `claude plugin update ringside@ringside`.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE), the same license as the project.
