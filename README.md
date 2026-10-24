# Tessera

Theme-aware tool panels for [Pi](https://pi.dev), inspired by **OpenCode**, with syntax highlighting, diffs, and expandable output.

## Install

```bash
pi install npm:pi-tessera
```

Or install from GitHub:

```bash
pi install git:github.com/sonejiMeet/pi-tessera
```

Try without installing:

```bash
pi -e npm:pi-tessera
```

## Features

- Side-by-side or unified diffs for `edit`, with word-level highlighting.
- Syntax-highlighted output for `read` and `write`.
- Compact panels for `bash`, `powershell`, `grep`, `find`, and `ls`.
- Colors that follow your active theme.
- Expand output with `ctrl+o`, or click in fullscreen mode.

## Settings

Add a `tessera` block to `~/.pi/agent/settings.json` or `.pi/settings.json`. Project settings override global settings.

Default values:

```json
{
  "tessera": {
    "splitThreshold": 100,
    "maxCollapsedLines": 8,
    "alwaysShowFullDiff": false,
    "contextLines": 6,
    "maxExpandedLines": 400
  }
}
```

| Setting | Purpose |
|---|---|
| `splitThreshold` | Minimum terminal width for side-by-side diffs. |
| `maxCollapsedLines` | Lines shown in collapsed output. |
| `alwaysShowFullDiff` | Keep all sections expanded. |
| `contextLines` | Context lines in live edit previews. |
| `maxExpandedLines` | Maximum lines shown when expanded. |

## Commands

| Command | Action |
|---|---|
| `/tessera` | Show version and status. |
| `/tessera full on\|off` | Toggle expanded output for this session. |
| `/tessera split 120` | Set the side-by-side diff threshold. |
| `/tessera lines 12` | Set the collapsed line limit. |
| `/tessera mouse` | Check mouse support. |
| `/tessera fullscreen on\|off` | Change Pi’s fullscreen setting. Requires restart. |
| `/tessera scroll 8\|auto` | Change mouse-wheel scrolling. Requires restart. |

Settings are only written when you run the fullscreen or scroll commands.

## License

MIT
