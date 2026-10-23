# Tessera

A mosaic of clean, highlighted panels for every [Pi](https://pi.dev) tool section.

Tessera replaces Pi's default tool rows with theme-aware panels: syntax-highlighted
diffs for `edit` and `write`, matching compact sections for `read`, `bash`,
`powershell`, `grep`, `find` and `ls`, and mouse hover + click-to-expand on any
section that has hidden output.

```text
 edit  src/app.ts  +12/-3
 ─────────────────────────────────────────────────────────────
   42   const x = 1
   43 - const y = 2
   43 + const y = three(2)
 ─────────────────────────────────────────────────────────────

 $ npm test                                          · 38 lines · 4.0s
   ✓ 214 tests passed
   … 30 earlier lines · click to expand
```

## Install

```bash
# from npm
pi install npm:pi-tessera

# from git
pi install git:github.com/sonejiMeet/pi-tessera

# from a checkout
pi install ./path/to/pi-tessera
```

Try it for a single invocation without touching your settings:

```bash
pi -e npm:pi-tessera
```

If you previously kept a standalone copy at `~/.pi/agent/extensions/tessera.ts`,
delete it before installing the package. Pi would otherwise load both copies.

Remove it again with `pi remove npm:pi-tessera`.

## Requirements

- Pi 1.4 or newer.
- Pi's fullscreen TUI (`"tuiMode": "fullscreen"`, the default) for mouse hover and
  click-to-expand. In regular mode the panels still render and `ctrl+o` still
  expands sections; only the pointer affordances go away.

Tessera never writes to your settings on load. `/tessera fullscreen on` and
`/tessera scroll N` change `tuiMode` / `fullscreenWheelScrollLines` only when you
ask them to.

## What it does

| Tool | Rendering |
|---|---|
| `edit` | Split diff on wide terminals, unified diff otherwise. Line numbers, syntax colors, bold `-`/`+` markers, word-level tint on the exact changed tokens, `⋯ @@ … @@` separators between hunks, and a live preview while the call streams. |
| `write` | All-green "create file" diff with syntax highlighting; collapsed at 120 lines, ending in `… N more lines · click to expand`. |
| `read` | Line numbers that respect `offset`/`limit`, syntax highlighting, and Pi's truncation notice kept separate from the code. |
| `bash` / `powershell` | The full command in the header plus line count and execution time. The command is shortened only while collapsed; expanding shows all of it, wrapped, with its own line breaks. |
| `grep` | Highlighted pattern, dim `in <path>`, and structured `file:line:` prefixes. |
| `find` / `ls` | Linked paths, highlighted directories. |

Shared behavior:

- **Theme-aware surfaces.** Panel and hover colors are derived from the active
  theme (`toolPendingBg`, `userMessageBg`, `toolDiffAdded`/`toolDiffRemoved`), so
  dark themes elevate the hovered surface and light themes deepen it. Works with
  `dark`, `light` and custom themes such as `opencode`.
- **Hover only where it means something.** A section is clickable when it hides
  something: output lines beyond the collapsed budget, or a command/pattern that
  had to be shortened to fit the header. Those sections highlight on hover and
  end with a hint naming what is hidden, e.g.
  `… 26 earlier lines · full command · click to expand`. The action turns accent
  colored while hovered, both in that line and in the header. Sections that fit
  completely, and error panels, never advertise a click that does nothing.
- **Zero-lag hover.** Moving the pointer off a panel, or the terminal losing
  focus, clears the highlight immediately.
- **Sealed backgrounds.** Embedded ANSI resets from syntax highlighting,
  truncation or colored tool output can never punch holes in a panel background.
- **Failure containment.** A renderer error degrades that one section to a plain
  panel instead of breaking the transcript.

## Settings

Tessera reads a `tessera` block from Pi's global (`~/.pi/agent/settings.json`) and
project (`.pi/settings.json`) settings. Project values win.

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

| Key | Default | Range | Meaning |
|---|---|---|---|
| `splitThreshold` | `100` | 60–300 | Minimum terminal width for the side-by-side diff. |
| `maxCollapsedLines` | `8` | 3–40 | Output lines shown while a section is collapsed. |
| `alwaysShowFullDiff` | `false` | — | Never collapse sections. |
| `contextLines` | `6` | 0–10 | Context lines in the live `edit` preview. |
| `maxExpandedLines` | `400` | 20–2000 | Hard cap on lines shown even when expanded. |

## Commands

| Command | Effect |
|---|---|
| `/tessera` | Show version, layout settings and mouse status. |
| `/tessera full on\|off` | Expand every section (this session). |
| `/tessera split 120` | Side-by-side threshold (this session). |
| `/tessera lines 12` | Collapsed line budget (this session). |
| `/tessera mouse` | Report what mouse input the current terminal allows. |
| `/tessera fullscreen on\|off` | Write Pi's `tuiMode` setting (restart to apply). |
| `/tessera scroll 8\|auto` | Write `fullscreenWheelScrollLines` (restart to apply). |

Sections also expand and collapse with the usual `ctrl+o` toggle, or by clicking
them in fullscreen mode.

## Development

```bash
npm install
npm run check     # typecheck + headless render/hover tests
npm run pack:check
```

`test/smoke.mjs` loads the real extension through Pi's `ToolExecutionComponent`
and `TuiAltScreen`, then asserts layout, header, hover, settings, command and
failure-containment behavior without needing a terminal. The package layout
follows Pi's package conventions: `pi.extensions` points at
`./extensions/tessera.ts`, and the host packages are `peerDependencies` with a
`*` range so Pi keeps a single copy of `pi-tui` and `pi-coding-agent`.

## License

MIT
