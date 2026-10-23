# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] — first published release

Packaged for distribution as a Pi package (`pi-package`, `pi.extensions`,
host packages as `peerDependencies`), with a README, license, changelog and a
headless test suite that runs through Pi's real tool component.

### Added

- Expanded section headers now show the complete command: long commands wrap
  across lines, a command's own line breaks are preserved, and the trailing
  metadata (`· 12 lines · 4.0s`, hover hint) moves to the last line with room.
- Collapsed headers shorten only the command/path, so line counts, timing and
  the `click to expand` hint always stay visible.
- Path headers (`read`, `ls`, `edit`, `write`) keep the file name by eliding the
  front of the path at a directory boundary.
- `/tessera` argument completions and richer usage messages.
- Renderer failure containment: a thrown renderer degrades that section to a
  plain panel instead of breaking the transcript.
- `/tessera fullscreen on|off` now writes `tuiMode` explicitly.

### Changed

- The extension no longer rewrites `settings.json` while loading. `tuiMode` and
  `fullscreenWheelScrollLines` are only changed by the commands that name them;
  regular (non-fullscreen) users get a one-time hint instead.
- Settings are read from Pi's global and project settings using the session's
  working directory instead of the process working directory.
- The reported version comes from `package.json`, so `/tessera` cannot drift from
  the published package.
- Mouse tracking is only installed in interactive (TUI) sessions.

### Fixed

- Sections whose command or pattern had to be shortened in the collapsed header
  were not hoverable or clickable, even though expanding showed the full command.
  A shortened header now counts as hidden content: the section highlights on
  hover, shows `… full command · click to expand` (or `… full pattern`) as the
  last line of the panel, and collapses again afterwards. That footer also
  reports a shortened header alongside hidden output lines
  (`… 26 earlier lines · full command`), and the `click to expand` action is
  highlighted in the accent color on hover, in the header and in the footer.
- A `write` diff capped at 120 lines ended with `… 180 more lines (truncated)`
  while being clickable. It now ends with `… 180 more lines · click to expand`
  and drops the row once expanded.
- Expanded shell sections used to show only the truncated command, never the
  part that was cut.
- Hover could highlight panels that had nothing to expand, and could stick when
  the pointer moved straight from a panel to empty space.
- `truncateToWidth` resets no longer leave gaps in panel or diff backgrounds.
- Wide (CJK/emoji) commands and paths no longer overflow their panel.

## [1.2.0] — private

### Added

- Theme-derived panel and hover surfaces (`toolPendingBg`, `toolDiffAdded`,
  `toolDiffRemoved`) with elevation on dark themes and deepening on light themes.
- Intra-line word-level diff tinting that preserves syntax colors.
- Multi-hunk separators, linked paths, execution timing, structured `grep`/`ls`
  output, and `read` line numbers that respect `offset`/`limit`.
- Zero-lag mouse tracking: hover clears on pointer leave, focus loss, wheel and
  drag events.
- Hover and click affordances only on sections that can actually toggle.

### Fixed

- Pending tool panels disappearing while a tool was executing.
- Background holes from ANSI resets in tool output and truncated diff cells.

## [1.0.0] — private

- Initial panel styling for `edit`, `write`, `read`, `bash`, `powershell`,
  `grep`, `find` and `ls`, with split/inline diffs and syntax highlighting.
