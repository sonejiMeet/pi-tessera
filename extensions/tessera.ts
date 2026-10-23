/**
 * Tessera — a mosaic of clean, highlighted panels for every Pi tool section.
 *
 * What it does
 * ------------
 * Restyles the whole transcript's tool output: diffs for `edit`/`write`, and
 * matching compact sections for `read`, `bash`, `powershell`, `grep`, `find`
 * and `ls`. Mouse hover and click-to-expand need Pi's fullscreen TUI mode;
 * `/tessera` reports whether the current setup has it and
 * `/tessera fullscreen on` turns it on.
 *
 * The `edit`/`write` presentation:
 *
 *   edit  src/app.ts  +12/-3            <- bold title, linked path, bold stats
 *   ───────────────────────────────────
 *     42   const x = 1                   <- dim line numbers, syntax colors
 *     43 - const y = 2                   <- bold red marker, soft red tint,
 *     43 + const y = three(2)            <- bold green marker, soft green tint,
 *                                            intra-line word tint + syntax colors
 *   ───────────────────────────────────
 *
 * Features:
 * - Side-by-side (split) diff when the terminal is wide enough, inline
 *   (unified) diff when it is not. Threshold is configurable.
 * - Real language-aware syntax highlighting via Pi's own `highlightCode`
 *   (resolved per file with `getLanguageFromPath`), so TypeScript,
 *   Python, Rust, Go, Bash, JSON, Markdown, … all highlight correctly.
 * - Intra-line word-level diff tinting on modified lines that preserves 100%
 *   of syntax foreground colors (no reverse-video blocks).
 * - Multi-hunk separator rows between disjoint edits in the same file.
 * - Live async preview while the `edit` call streams (exact + fuzzy
 *   matching, like the built-in tool), full diff once applied.
 * - `write` renders as an all-green "create file" diff with highlighted code.
 * - `read` renders with dim line numbers (respecting `offset`/`limit`) and
 *   full syntax highlighting; `grep` and `ls` structure paths, line numbers,
 *   and directories; `bash`/`powershell` show execution timing.
 * - Headers never hide useful text: collapsed headers shorten only the
 *   command/path so line counts and timing stay visible, and expanding shows
 *   the complete command, wrapped, including its own line breaks.
 * - Theme-aware surfaces and hover:
 *   - Uses the theme's neutral panel background (`toolPendingBg`, e.g. `#141414`
 *     in `opencode`, `#313237` in `dark`, `#e6e6e8` in `light`).
 *   - Only sections that can actually expand or collapse (`canToggle`) react
 *     to hover: dark themes subtly elevate the surface (toward `selectedBg` /
 *     `bgElement`), light themes subtly deepen it, with calm expand/collapse
 *     hints. Non-expandable panels never show false click affordances.
 *   - Synchronous post-dispatch mouse tracking clears hover with zero lag as
 *     soon as the pointer leaves a box or the terminal loses focus, while
 *     keeping a stationary pointer lit indefinitely.
 * - Hardened rendering: every box line and diff cell re-seals its background
 *   after embedded ANSI resets (`\x1b[0m`, `\x1b[m`, `\x1b[49m`), so truncated
 *   lines and colored CLI output never punch holes in the panel background.
 * - A renderer failure degrades to a plain panel instead of breaking the
 *   transcript, and the extension never rewrites Pi settings on load.
 *
 * Settings (`~/.pi/agent/settings.json`, project `.pi/settings.json` wins)
 * ------------------------------------------------------------------------
 *   { "tessera": {
 *       "splitThreshold": 100,       // min width for side-by-side (60-300)
 *       "maxCollapsedLines": 8,      // lines shown when collapsed (3-40)
 *       "alwaysShowFullDiff": false, // never collapse sections
 *       "contextLines": 6,           // preview context lines (0-10)
 *       "maxExpandedLines": 400      // hard cap even when expanded
 *   } }
 *
 * Commands
 * --------
 *   /tessera                    show current settings and mouse status
 *   /tessera full on|off        show all section output expanded (this session)
 *   /tessera split 120          set side-by-side threshold (this session)
 *   /tessera lines 12           set collapsed line budget (this session)
 *   /tessera mouse              report what mouse input this setup allows
 *   /tessera fullscreen on|off  write Pi's `tuiMode` setting (restart to apply)
 *   /tessera scroll N|auto      write fullscreen mouse-wheel scroll lines
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	ToolRenderers,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	generateUnifiedPatch,
	getLanguageFromPath,
	highlightCode,
	keyHint,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	backgroundAnsi,
	Box,
	Container,
	getCapabilities,
	hyperlink,
	mixColors,
	MouseRegion,
	parseColor,
	sliceByColumn,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
	type Color,
	type Component,
} from "@earendil-works/pi-tui";
import { constants, readFileSync } from "node:fs";
import { access, readFile } from "node:fs/promises";
import * as os from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Pi's package root exports `ToolRenderers` but not the `ToolRenderContext` it
 * hands to renderers, so derive it from that public contract.
 */
type ToolRenderContext = Parameters<NonNullable<ToolRenderers["renderResult"]>>[3];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface TesseraConfig {
	splitThreshold: number;
	maxCollapsedLines: number;
	alwaysShowFullDiff: boolean;
	contextLines: number;
	maxExpandedLines: number;
}

const DEFAULT_CONFIG: TesseraConfig = {
	splitThreshold: 100,
	maxCollapsedLines: 8,
	alwaysShowFullDiff: false,
	contextLines: 6,
	maxExpandedLines: 400,
};

/** Bump on every shipped change; shown by /tessera status. Read from the package manifest when available. */
const FALLBACK_VERSION = "1.3.0";
let cachedVersion: string | undefined;

function extensionVersion(): string {
	if (cachedVersion) return cachedVersion;
	let version = FALLBACK_VERSION;
	try {
		const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url));
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
		if (typeof manifest.version === "string" && manifest.version.trim() !== "") {
			version = manifest.version.trim();
		}
	} catch {
		// Installed as a standalone file: keep the bundled fallback.
	}
	cachedVersion = version;
	return version;
}

const runtimeOverrides: Partial<TesseraConfig> = {};
let fileConfig: TesseraConfig = { ...DEFAULT_CONFIG };
/** True when Pi runs the fullscreen TUI, which is what mouse hover/click needs. */
let fullscreenMouse = true;
/** Set once per session so a regular-TUI user is told once, not on every session. */
let fullscreenHintShown = false;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
	const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;
	return Math.min(max, Math.max(min, n));
}

/** Load `tessera` settings from Pi's global and project settings files. */
function loadFileConfig(cwd: string): void {
	const merged: TesseraConfig = { ...DEFAULT_CONFIG };
	try {
		const sm = SettingsManager.create(cwd);
		const gAll = (sm.getGlobalSettings() ?? {}) as Record<string, unknown>;
		const pAll = (sm.getProjectSettings() ?? {}) as Record<string, unknown>;
		const g = gAll?.tessera;
		const p = pAll?.tessera;
		for (const source of [g, p]) {
			if (source && typeof source === "object") {
				const s = source as Partial<TesseraConfig>;
				if (typeof s.splitThreshold === "number") merged.splitThreshold = s.splitThreshold;
				if (typeof s.maxCollapsedLines === "number") merged.maxCollapsedLines = s.maxCollapsedLines;
				if (typeof s.alwaysShowFullDiff === "boolean") merged.alwaysShowFullDiff = s.alwaysShowFullDiff;
				if (typeof s.contextLines === "number") merged.contextLines = s.contextLines;
				if (typeof s.maxExpandedLines === "number") merged.maxExpandedLines = s.maxExpandedLines;
			}
		}
		fullscreenMouse = sm.getTuiMode() !== "regular";
	} catch {
		// Settings are optional; defaults apply.
	}
	merged.splitThreshold = clampInt(merged.splitThreshold, DEFAULT_CONFIG.splitThreshold, 60, 300);
	merged.maxCollapsedLines = clampInt(merged.maxCollapsedLines, DEFAULT_CONFIG.maxCollapsedLines, 3, 40);
	merged.contextLines = clampInt(merged.contextLines, DEFAULT_CONFIG.contextLines, 0, 10);
	merged.maxExpandedLines = clampInt(merged.maxExpandedLines, DEFAULT_CONFIG.maxExpandedLines, 20, 2000);
	fileConfig = merged;
}

/** Re-read the fullscreen setting without reloading the rest of the config. */
function refreshFullscreenFlag(cwd: string): void {
	try {
		fullscreenMouse = SettingsManager.create(cwd).getTuiMode() !== "regular";
	} catch {
		// Keep the previous value.
	}
}

/**
 * Write a Pi setting the user asked for with `/tessera`. Never called on load:
 * the extension leaves `settings.json` alone unless a command changes it.
 */
function writePiSetting(cwd: string, write: (sm: SettingsManager) => void): boolean {
	try {
		write(SettingsManager.create(cwd));
		return true;
	} catch {
		return false;
	}
}

function getConfig(): TesseraConfig {
	const cfg: TesseraConfig = { ...fileConfig, ...runtimeOverrides };
	cfg.splitThreshold = clampInt(cfg.splitThreshold, DEFAULT_CONFIG.splitThreshold, 60, 300);
	cfg.maxCollapsedLines = clampInt(cfg.maxCollapsedLines, DEFAULT_CONFIG.maxCollapsedLines, 3, 40);
	cfg.contextLines = clampInt(cfg.contextLines, DEFAULT_CONFIG.contextLines, 0, 10);
	cfg.maxExpandedLines = clampInt(cfg.maxExpandedLines, DEFAULT_CONFIG.maxExpandedLines, 20, 2000);
	return cfg;
}

// ---------------------------------------------------------------------------
// Text safety: file content must never inject terminal escapes into the TUI
// (stray styling would randomly eat the box skin on those lines).
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const FOCUS_OUT = `${ESC}[O`;

/** Drop terminal escapes (CSI/OSC/lone ESC) and control chars (incl. CR). */
function cleanContent(text: string): string {
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i];
		if (ch === ESC) {
			const next = text[i + 1];
			if (next === "[") {
				let j = i + 2;
				while (j < text.length && !(text[j] >= "@" && text[j] <= "~")) j++;
				i = Math.min(j + 1, text.length);
				continue;
			}
			if (next === "]") {
				const k = text.indexOf(BEL, i + 2);
				i = k === -1 ? text.length : k + 1;
				continue;
			}
			i += 1;
			continue;
		}
		const code = text.charCodeAt(i);
		if ((code < 32 && code !== 9) || code === 127) {
			i += 1;
			continue;
		}
		out += ch;
		i += 1;
	}
	return out;
}

/** True when an SGR parameter token resets all attributes (`0` / ``) or background (`49`). */
function isBgResetParam(part: string): boolean {
	if (part === "" || part === "0" || part === "00" || part === "49") return true;
	return false;
}

/**
 * Re-assert a background after embedded resets so the skin survives foreign
 * escape sequences and `truncateToWidth` resets (`\x1b[0m`).
 * Only SGR sequences (`\x1b[...m`) that reset the background trigger a re-open;
 * everything else passes through untouched. Zero-alloc fast path when no reset
 * is present.
 */
function sealLine(line: string, open: string): string {
	if (open === "" || line.indexOf(ESC) === -1) return line;
	let result: string | null = null;
	let copyFrom = 0;
	let i = 0;
	while (i < line.length) {
		const e = line.indexOf(ESC, i);
		if (e === -1) break;
		if (line[e + 1] === "[") {
			let j = e + 2;
			while (j < line.length && !(line[j] >= "@" && line[j] <= "~")) j++;
			if (j < line.length && line[j] === "m") {
				const end = j + 1;
				const inner = line.slice(e + 2, j);
				let killer = inner === "";
				if (!killer) {
					const parts = inner.split(";");
					for (let k = 0; k < parts.length; k++) {
						if (isBgResetParam(parts[k])) {
							killer = true;
							break;
						}
					}
				}
				if (killer && !line.startsWith(`${ESC}[48;`, end) && !line.startsWith(`${ESC}[49m`, end)) {
					result = result === null ? line.slice(0, end) : result + line.slice(copyFrom, end);
					result += open;
					copyFrom = end;
				}
				i = end;
				continue;
			}
			i = Math.min(j + 1, line.length);
		} else {
			i = e + 1;
		}
	}
	if (result === null) return line;
	return result + line.slice(copyFrom);
}

// ---------------------------------------------------------------------------
// Path & duration formatting helpers
// ---------------------------------------------------------------------------

function normalizeSlashes(p: string): string {
	return p.split(sep).join("/");
}

/** Format a path compactly relative to cwd or home, and link it via OSC 8 when supported. */
function formatDisplayPath(rawPath: string | undefined, cwd?: string): string {
	if (!rawPath) return "";
	const clean = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	let display = clean;
	try {
		if (cwd) {
			const abs = resolve(cwd, clean);
			const rel = relative(cwd, abs);
			if (rel && rel !== "." && !rel.startsWith("..") && !isAbsolute(rel)) {
				display = normalizeSlashes(rel);
			} else {
				const home = os.homedir();
				if (home && abs.toLowerCase().startsWith(home.toLowerCase())) {
					const tail = abs.slice(home.length);
					if (tail === "" || tail[0] === "/" || tail[0] === "\\") {
						display = `~${normalizeSlashes(tail)}`;
					}
				}
			}
		} else {
			const home = os.homedir();
			if (home && clean.toLowerCase().startsWith(home.toLowerCase())) {
				const tail = clean.slice(home.length);
				if (tail === "" || tail[0] === "/" || tail[0] === "\\") {
					display = `~${normalizeSlashes(tail)}`;
				}
			}
		}
	} catch {
		display = clean;
	}
	return display;
}

function styledPath(rawPath: string | undefined, theme: Theme, cwd?: string): string {
	if (!rawPath) return "";
	const display = formatDisplayPath(rawPath, cwd);
	const styled = theme.fg("muted", display);
	try {
		if (cwd && getCapabilities().hyperlinks) {
			const clean = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
			const abs = resolve(cwd, clean);
			return hyperlink(styled, pathToFileURL(abs).href);
		}
	} catch {
		// Fallback to plain styled text
	}
	return styled;
}

function formatDuration(ms: number | undefined): string | undefined {
	if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 100) return undefined;
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const sec = ms / 1000;
	if (sec < 60) return `${sec.toFixed(1)}s`;
	const mins = Math.floor(sec / 60);
	const rem = Math.round(sec % 60);
	return `${mins}m ${rem}s`;
}

// ---------------------------------------------------------------------------
// Diff model (parsed unified patch, with display-diff fallback)
// ---------------------------------------------------------------------------

type LineType = "add" | "remove" | "context" | "skip";

interface ParsedLine {
	type: LineType;
	content: string;
	oldLineNum: number | null;
	newLineNum: number | null;
}

interface ParsedHunk {
	header: string;
	section: string;
	oldStart: number;
	oldCount: number;
	newStart: number;
	newCount: number;
	lines: ParsedLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

function parseCount(value: string | undefined): number {
	return value === undefined ? 1 : Number(value);
}

/** Parse a standard unified patch (`---`/`+++`/`@@` format). Throws when empty. */
function parseUnifiedPatch(patch: string): ParsedHunk[] {
	const hunks: ParsedHunk[] = [];
	let current: ParsedHunk | null = null;
	let oldLine = 0;
	let newLine = 0;

	for (const rawLine of patch.split("\n")) {
		if (rawLine.startsWith("--- ") || rawLine.startsWith("+++ ")) continue;
		const header = rawLine.match(HUNK_RE);
		if (header) {
			if (current) hunks.push(current);
			current = {
				header: rawLine,
				section: cleanContent((header[5] ?? "").trim()),
				oldStart: Number(header[1]),
				oldCount: parseCount(header[2]),
				newStart: Number(header[3]),
				newCount: parseCount(header[4]),
				lines: [],
			};
			oldLine = Number(header[1]);
			newLine = Number(header[3]);
			continue;
		}
		if (!current) continue;
		if (rawLine.startsWith("\\ No newline at end of file")) continue;
		if (rawLine.length === 0) continue;
		const marker = rawLine[0];
		if (marker !== " " && marker !== "+" && marker !== "-") continue;
		const content = cleanContent(rawLine.slice(1));
		if (marker === " ") {
			current.lines.push({ type: "context", content, oldLineNum: oldLine++, newLineNum: newLine++ });
		} else if (marker === "-") {
			current.lines.push({ type: "remove", content, oldLineNum: oldLine++, newLineNum: null });
		} else {
			current.lines.push({ type: "add", content, oldLineNum: null, newLineNum: newLine++ });
		}
	}
	if (current) hunks.push(current);
	if (hunks.length === 0) throw new Error("No hunks found in patch");
	return hunks;
}

const DISPLAY_LINE_RE = /^([+\- ])\s*(\d*)\s?(.*)$/;

/**
 * Parse Pi's display diff (`+12 content` / `-12 content` / ` 12 content` /
 * ` ...` skip rows) into a single pseudo-hunk. Used when no unified patch is
 * available.
 */
function parseDisplayDiff(diff: string): ParsedHunk[] {
	const lines: ParsedLine[] = [];
	for (const rawLine of diff.split("\n")) {
		const m = rawLine.match(DISPLAY_LINE_RE);
		if (!m) continue;
		const [, marker, num, rawContent] = m;
		const content = cleanContent(rawContent);
		if (content.trim() === "..." || content.trim() === "…") {
			lines.push({ type: "skip", content: "", oldLineNum: null, newLineNum: null });
			continue;
		}
		const lineNum = num.trim() === "" ? null : Number(num);
		if (marker === "-") {
			lines.push({ type: "remove", content, oldLineNum: lineNum, newLineNum: null });
		} else if (marker === "+") {
			lines.push({ type: "add", content, oldLineNum: null, newLineNum: lineNum });
		} else {
			lines.push({ type: "context", content, oldLineNum: lineNum, newLineNum: lineNum });
		}
	}
	if (lines.length === 0) throw new Error("No diff lines found");
	return [{ header: "", section: "", oldStart: 0, oldCount: 0, newStart: 0, newCount: 0, lines }];
}

function countChanges(hunks: ParsedHunk[]): { additions: number; deletions: number } {
	let additions = 0;
	let deletions = 0;
	for (const hunk of hunks) {
		for (const line of hunk.lines) {
			if (line.type === "add") additions++;
			if (line.type === "remove") deletions++;
		}
	}
	return { additions, deletions };
}

// ---------------------------------------------------------------------------
// Syntax highlighting & intra-line diff helpers
// ---------------------------------------------------------------------------

const TAB_WIDTH = 4;

function expandTabs(text: string): string {
	return text.replace(/\t/g, " ".repeat(TAB_WIDTH));
}

/** Cache highlighted blocks so re-renders (resize, expand) stay cheap. */
const highlightCache = new Map<string, string[]>();

function highlightBlock(lines: string[], lang: string | undefined, themeName: string | undefined): string[] {
	if (lines.length === 0) return [];
	if (!lang) return lines.slice();
	const key = `${themeName ?? ""}\n${lang}\n${lines.join("\n")}`;
	const cached = highlightCache.get(key);
	if (cached && cached.length === lines.length) return cached;
	let out: string[];
	try {
		out = highlightCode(lines.join("\n"), lang);
		if (out.length !== lines.length) out = lines.slice();
	} catch {
		out = lines.slice();
	}
	if (highlightCache.size > 120) highlightCache.clear();
	highlightCache.set(key, out);
	return out;
}

function isWordCode(code: number): boolean {
	return (
		(code >= 48 && code <= 57) || // 0-9
		(code >= 65 && code <= 90) || // A-Z
		(code >= 97 && code <= 122) || // a-z
		code === 95 || // _
		code === 36 // $
	);
}

interface ChangeSpan {
	start: number;
	end: number;
}

/**
 * Find the changed character span in `oldRaw` and `newRaw` for a 1:1 modified
 * line pair. Returns `null` when the lines share no meaningful context (e.g. a
 * complete line replacement), so only genuine intra-line edits get word tints.
 */
function findIntraLineSpans(oldRaw: string, newRaw: string): { oldSpan: ChangeSpan; newSpan: ChangeSpan } | null {
	if (oldRaw === newRaw || oldRaw.length === 0 || newRaw.length === 0) return null;
	if (oldRaw.length > 500 || newRaw.length > 500) return null;

	const minLen = Math.min(oldRaw.length, newRaw.length);
	let prefix = 0;
	while (prefix < minLen && oldRaw.charCodeAt(prefix) === newRaw.charCodeAt(prefix)) {
		prefix++;
	}

	let suffix = 0;
	while (
		suffix < minLen - prefix &&
		oldRaw.charCodeAt(oldRaw.length - 1 - suffix) === newRaw.charCodeAt(newRaw.length - 1 - suffix)
	) {
		suffix++;
	}

	// Ignore if the only shared characters are leading/trailing whitespace.
	const sharedNonWs =
		oldRaw.slice(0, prefix).trim().length + oldRaw.slice(oldRaw.length - suffix).trim().length;
	if (sharedNonWs < 2) return null;

	// Snap outward to word boundaries (up to 12 chars) so whole changed tokens
	// (`fooBar`, `100`) are highlighted cleanly instead of partial letters/digits.
	let snapPrefix = prefix;
	let backSteps = 0;
	while (
		snapPrefix > 0 &&
		backSteps < 12 &&
		isWordCode(oldRaw.charCodeAt(snapPrefix - 1)) &&
		(isWordCode(oldRaw.charCodeAt(snapPrefix)) || isWordCode(newRaw.charCodeAt(snapPrefix)))
	) {
		snapPrefix--;
		backSteps++;
	}

	let snapSuffix = suffix;
	let fwdSteps = 0;
	while (
		snapSuffix > 0 &&
		fwdSteps < 12 &&
		isWordCode(oldRaw.charCodeAt(oldRaw.length - snapSuffix)) &&
		(isWordCode(oldRaw.charCodeAt(oldRaw.length - snapSuffix - 1)) ||
			isWordCode(newRaw.charCodeAt(newRaw.length - snapSuffix - 1)))
	) {
		snapSuffix--;
		fwdSteps++;
	}

	const oldStart = snapPrefix;
	const oldEnd = Math.max(oldStart, oldRaw.length - snapSuffix);
	const newStart = snapPrefix;
	const newEnd = Math.max(newStart, newRaw.length - snapSuffix);

	if (oldStart === 0 && oldEnd === oldRaw.length && newStart === 0 && newEnd === newRaw.length) {
		return null;
	}

	return {
		oldSpan: { start: oldStart, end: oldEnd },
		newSpan: { start: newStart, end: newEnd },
	};
}

/**
 * Inject a stronger background (`wordBg`) over character range `[start, end)`
 * of an ANSI-highlighted string while preserving all foreground syntax colors,
 * then restore `rowBg` at `end`.
 */
function injectWordBg(ansiLine: string, span: ChangeSpan | null, wordBg: string, rowBg: string): string {
	if (!span || span.start >= span.end || !wordBg || !rowBg) return ansiLine;
	let out = "";
	let charIdx = 0;
	let i = 0;
	let inSpan = false;

	while (i < ansiLine.length) {
		if (!inSpan && charIdx === span.start) {
			out += wordBg;
			inSpan = true;
		}
		if (inSpan && charIdx === span.end) {
			out += rowBg;
			inSpan = false;
		}

		if (ansiLine[i] === ESC && ansiLine[i + 1] === "[") {
			let j = i + 2;
			while (j < ansiLine.length && !(ansiLine[j] >= "@" && ansiLine[j] <= "~")) j++;
			const end = Math.min(j + 1, ansiLine.length);
			const seq = ansiLine.slice(i, end);
			out += seq;
			// If a foreground token reset all attributes inside the span, re-assert the active bg.
			if (ansiLine[j] === "m") {
				const inner = ansiLine.slice(i + 2, j);
				const parts = inner === "" ? [""] : inner.split(";");
				if (parts.some(isBgResetParam)) {
					out += inSpan ? wordBg : rowBg;
				}
			}
			i = end;
			continue;
		}

		out += ansiLine[i];
		charIdx++;
		i++;
	}

	if (inSpan) {
		out += rowBg;
	}
	return out;
}

// ---------------------------------------------------------------------------
// Tessera diff component (split <-> inline, highlighted, intra-line word tint)
// ---------------------------------------------------------------------------

export interface TesseraDiffOptions {
	filePath?: string;
	skin?: DiffSkin | (() => DiffSkin);
	expanded?: boolean;
	/**
	 * Styled suffix appended to the "… N more lines" row, e.g. `· click to expand`.
	 * Lets a collapsible diff advertise the action instead of claiming to truncate.
	 */
	truncationHint?: () => string | undefined;
}

interface DiffCell {
	num: number | null;
	marker: "add" | "remove" | "ctx";
	/** Syntax-highlighted content (plain text length matches raw content). */
	content: string;
	/** Optional intra-line changed span `[start, end)` in expanded-tab coordinates. */
	wordSpan: ChangeSpan | null;
	change: boolean;
}

type SplitEntry =
	| { kind: "header"; text: string }
	| { kind: "skip"; label?: string }
	| { kind: "pair"; left: DiffCell | null; right: DiffCell | null };

export class TesseraDiff implements Component {
	private entries: SplitEntry[];
	private theme: Theme;
	private options: TesseraDiffOptions;
	private config: TesseraConfig;
	private numWidth: number;

	constructor(
		hunks: ParsedHunk[],
		theme: Theme,
		options: TesseraDiffOptions = {},
		config: TesseraConfig = getConfig(),
	) {
		this.theme = theme;
		this.options = options;
		this.config = config;

		const lang = options.filePath ? getLanguageFromPath(options.filePath) : undefined;
		const themeName = theme.name;

		// Highlight each hunk side as a block so multiline tokens
		// (comments, template strings) survive inside the hunk.
		const highlighted = new Map<ParsedLine, string>();
		const expandedMap = new Map<ParsedLine, string>();
		for (const hunk of hunks) {
			const leftLines = hunk.lines.filter((l) => l.type !== "add" && l.type !== "skip");
			const rightLines = hunk.lines.filter((l) => l.type !== "remove" && l.type !== "skip");
			const leftRaw = leftLines.map((l) => {
				const exp = expandTabs(l.content);
				expandedMap.set(l, exp);
				return exp;
			});
			const rightRaw = rightLines.map((l) => {
				const exp = expandTabs(l.content);
				expandedMap.set(l, exp);
				return exp;
			});
			const leftHi = highlightBlock(leftRaw, lang, themeName);
			const rightHi = highlightBlock(rightRaw, lang, themeName);

			let li = 0;
			let ri = 0;
			for (const line of hunk.lines) {
				if (line.type === "skip") continue;
				if (line.type === "add") {
					highlighted.set(line, rightHi[ri++] ?? expandedMap.get(line) ?? expandTabs(line.content));
				} else {
					highlighted.set(line, leftHi[li++] ?? expandedMap.get(line) ?? expandTabs(line.content));
					if (line.type === "context") ri++;
				}
			}
		}

		let digits = 3;
		for (const hunk of hunks) {
			for (const line of hunk.lines) {
				for (const n of [line.oldLineNum, line.newLineNum]) {
					if (n != null) digits = Math.max(digits, String(n).length);
				}
			}
		}
		this.numWidth = digits;

		const entries: SplitEntry[] = [];
		for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
			const hunk = hunks[hIdx];
			if (hIdx > 0) {
				const label = hunk.section
					? `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@ ${hunk.section}`
					: hunk.oldStart > 0 || hunk.newStart > 0
						? `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`
						: undefined;
				entries.push({ kind: "skip", label });
			}
			let removed: ParsedLine[] = [];
			let added: ParsedLine[] = [];
			const flush = () => {
				const n = Math.max(removed.length, added.length);
				const pairSpans = removed.length === added.length;
				for (let i = 0; i < n; i++) {
					const r = removed[i];
					const a = added[i];
					let spans: { oldSpan: ChangeSpan; newSpan: ChangeSpan } | null = null;
					if (pairSpans && r && a) {
						const rExp = expandedMap.get(r) ?? expandTabs(r.content);
						const aExp = expandedMap.get(a) ?? expandTabs(a.content);
						spans = findIntraLineSpans(rExp, aExp);
					}
					entries.push({
						kind: "pair",
						left: r ? this.changeCell(r, null, highlighted, spans?.oldSpan ?? null) : null,
						right: a ? this.changeCell(null, a, highlighted, spans?.newSpan ?? null) : null,
					});
				}
				removed = [];
				added = [];
			};
			for (const line of hunk.lines) {
				if (line.type === "remove") {
					removed.push(line);
					continue;
				}
				if (line.type === "add") {
					added.push(line);
					continue;
				}
				flush();
				if (line.type === "skip") {
					entries.push({ kind: "skip" });
					continue;
				}
				const shared = this.ctxCell(line, highlighted.get(line) ?? expandTabs(line.content));
				entries.push({ kind: "pair", left: shared, right: shared });
			}
			flush();
		}
		this.entries = entries;
	}

	private ctxCell(line: ParsedLine, hi: string): DiffCell {
		return { num: line.oldLineNum ?? line.newLineNum, marker: "ctx", content: hi, wordSpan: null, change: false };
	}

	private changeCell(
		remove: ParsedLine | null,
		add: ParsedLine | null,
		highlighted: Map<ParsedLine, string>,
		wordSpan: ChangeSpan | null,
	): DiffCell {
		const line = (remove ?? add) as ParsedLine;
		return {
			num: remove ? remove.oldLineNum : (add as ParsedLine).newLineNum,
			marker: remove ? "remove" : "add",
			content: highlighted.get(line) ?? expandTabs(line.content),
			wordSpan,
			change: true,
		};
	}

	invalidate(): void {
		this.renderCache.clear();
	}

	/** Re-render cache keyed by width + skin. */
	private renderCache = new Map<string, string[]>();

	render(width: number): string[] {
		const skin = this.skin();
		const key = `${width}|${skin.open}|${this.expanded}|${this.options.truncationHint?.() ?? ""}`;
		const hit = this.renderCache.get(key);
		if (hit) return hit;
		const out =
			width + 2 >= this.config.splitThreshold ? this.renderSplit(width, skin) : this.renderInline(width, skin);
		if (this.renderCache.size > 4) this.renderCache.clear();
		this.renderCache.set(key, out);
		return out;
	}

	private get expanded(): boolean {
		return this.options.expanded ?? true;
	}

	private skin(): DiffSkin {
		if (typeof this.options.skin === "function") return this.options.skin();
		return this.options.skin ?? skinFor(this.theme, false);
	}

	private rule(width: number, skin: DiffSkin): string {
		return sealLine(truncateToWidth(this.theme.fg("borderMuted", "─".repeat(Math.max(1, width))), width, ""), skin.open);
	}

	private skipRow(label: string | undefined, width: number, skin: DiffSkin): string {
		if (!label) {
			return sealLine(truncateToWidth(this.theme.fg("dim", "  ⋯"), width, "…"), skin.open);
		}
		const text = `  ⋯ ${label}`;
		return sealLine(truncateToWidth(this.theme.fg("dim", text), width, "…"), skin.open);
	}

	private hiddenNotice(hidden: number, width: number, skin: DiffSkin): string {
		const label = `… ${hidden} more lines`;
		const hint = this.options.truncationHint?.();
		const text = hint
			? `${this.theme.fg("dim", label)}${hint}`
			: this.theme.fg("dim", `${label} (truncated)`);
		return sealLine(truncateToWidth(text, width, "…"), skin.open);
	}

	private num(n: number | null, marker: DiffCell["marker"] = "ctx"): string {
		const text = (n == null ? "" : String(n)).padStart(this.numWidth, " ");
		if (marker === "remove") return this.theme.style(text, { fg: "toolDiffRemoved", bold: true });
		if (marker === "add") return this.theme.style(text, { fg: "toolDiffAdded", bold: true });
		return this.theme.fg("dim", text);
	}

	private marker(kind: DiffCell["marker"]): string {
		if (kind === "add") return this.theme.style("+", { fg: "toolDiffAdded", bold: true });
		if (kind === "remove") return this.theme.style("-", { fg: "toolDiffRemoved", bold: true });
		return this.theme.fg("dim", " ");
	}

	private styledCellContent(cell: DiffCell, skin: DiffSkin): string {
		if (cell.marker === "ctx" || !cell.wordSpan) return cell.content;
		const rowOpen = cell.marker === "remove" ? skin.removeOpen : skin.addOpen;
		const wordOpen = cell.marker === "remove" ? skin.removeWordOpen : skin.addWordOpen;
		return injectWordBg(cell.content, cell.wordSpan, wordOpen, rowOpen);
	}

	/**
	 * Wrap a cell in its diff row tint (`removeOpen` / `addOpen`), sealing any
	 * internal `\x1b[0m` (e.g. from `truncateToWidth`) with the cell's own
	 * background before restoring `skin.open` at the right edge of the cell.
	 */
	private wrapCell(text: string, marker: DiffCell["marker"], skin: DiffSkin): string {
		if (text === "" || marker === "ctx") return sealLine(text, skin.open);
		const cellOpen = marker === "remove" ? skin.removeOpen : skin.addOpen;
		if (!cellOpen || !skin.open) return text;
		return `${cellOpen}${sealLine(text, cellOpen)}${skin.open}`;
	}

	// -- inline (unified) ----------------------------------------------------

	private inlineCellText(cell: DiffCell, skin: DiffSkin): string {
		return `${this.marker(cell.marker)}${this.num(cell.num, cell.marker)} ${this.styledCellContent(cell, skin)}`;
	}

	private renderInline(width: number, skin: DiffSkin): string[] {
		const flat: Array<{ text: string; change: boolean; marker: DiffCell["marker"]; isSkip?: boolean; skipLabel?: string }> = [];
		for (const e of this.entries) {
			if (e.kind === "header") {
				flat.push({ text: e.text, change: false, marker: "ctx" });
			} else if (e.kind === "skip") {
				flat.push({ text: "", change: false, marker: "ctx", isSkip: true, skipLabel: e.label });
			} else if (e.left && e.right && e.left === e.right) {
				flat.push({ text: this.inlineCellText(e.left, skin), change: false, marker: "ctx" });
			} else {
				if (e.left) flat.push({ text: this.inlineCellText(e.left, skin), change: e.left.change, marker: e.left.marker });
				if (e.right) flat.push({ text: this.inlineCellText(e.right, skin), change: e.right.change, marker: e.right.marker });
			}
		}
		const lines: string[] = [this.rule(width, skin)];
		const { shown, hidden } = windowed(flat, this.expanded, this.config.maxCollapsedLines, this.config.maxExpandedLines);
		for (const row of shown) {
			if (row.isSkip) {
				lines.push(this.skipRow(row.skipLabel, width, skin));
				continue;
			}
			const padded = padTo(truncateToWidth(row.text, width, "…"), width);
			lines.push(this.wrapCell(padded, row.marker, skin));
		}
		if (hidden > 0) lines.push(this.hiddenNotice(hidden, width, skin));
		lines.push(this.rule(width, skin));
		return lines;
	}

	// -- split (side-by-side) --------------------------------------------------

	private splitCell(cell: DiffCell | null, contentWidth: number, skin: DiffSkin): string {
		if (!cell) return "";
		const styled = this.styledCellContent(cell, skin);
		const content = truncateToWidth(styled, Math.max(1, contentWidth), "…");
		return `${this.num(cell.num, cell.marker)} ${this.marker(cell.marker)} ${content}`;
	}

	private renderSplit(width: number, skin: DiffSkin): string[] {
		const lines: string[] = [this.rule(width, skin)];
		const half = Math.floor((width - 1) / 2);
		const rightWidth = width - half - 1;
		const divider = this.theme.fg("borderMuted", "│");
		const contentLeft = Math.max(1, half - this.numWidth - 3);
		const contentRight = Math.max(1, rightWidth - this.numWidth - 3);

		const { shown, hidden } = windowed(this.entries, this.expanded, this.config.maxCollapsedLines, this.config.maxExpandedLines);
		for (const e of shown) {
			if (e.kind === "header") {
				lines.push(sealLine(truncateToWidth(e.text, width, "…"), skin.open));
				continue;
			}
			if (e.kind === "skip") {
				lines.push(this.skipRow(e.label, width, skin));
				continue;
			}
			// Wrap AFTER padding/truncation so colour regions are sealed per cell.
			const left = this.wrapCell(padTo(this.splitCell(e.left, contentLeft, skin), half), e.left?.marker ?? "ctx", skin);
			const right = this.wrapCell(padTo(this.splitCell(e.right, contentRight, skin), rightWidth), e.right?.marker ?? "ctx", skin);
			lines.push(`${left}${divider}${skin.open}${right}`);
		}
		if (hidden > 0) lines.push(this.hiddenNotice(hidden, width, skin));
		lines.push(this.rule(width, skin));
		return lines;
	}
}

function padTo(text: string, width: number): string {
	if (text === "") return " ".repeat(Math.max(0, width));
	const w = visibleWidth(text);
	if (w >= width) return truncateToWidth(text, width, "…");
	return text + " ".repeat(width - w);
}

function entryIsChange(e: unknown): boolean {
	if ((e as SplitEntry).kind === "pair") {
		const p = e as SplitEntry & { kind: "pair" };
		return !!p.left?.change || !!p.right?.change;
	}
	return !!((e as { change?: boolean }).change);
}

function windowed<T>(
	items: T[],
	expanded: boolean,
	maxCollapsed: number,
	maxExpanded: number,
): { shown: T[]; hidden: number } {
	const total = items.length;
	if (expanded) {
		if (total <= maxExpanded) return { shown: items, hidden: 0 };
		return { shown: items.slice(0, maxExpanded), hidden: total - maxExpanded };
	}
	if (total <= maxCollapsed) return { shown: items, hidden: 0 };
	const firstChange = items.findIndex(entryIsChange);
	const focus = firstChange === -1 ? 0 : firstChange;
	const start = Math.min(Math.max(0, focus - Math.floor(maxCollapsed / 2)), total - maxCollapsed);
	return { shown: items.slice(start, start + maxCollapsed), hidden: total - maxCollapsed };
}

// ---------------------------------------------------------------------------
// Headers & cached live text
// ---------------------------------------------------------------------------

function statsSuffix(additions: number, deletions: number, theme: Theme): string {
	let s = " ";
	s += theme.style(`+${additions}`, { fg: "toolDiffAdded", bold: true });
	s += theme.fg("dim", "/");
	s += theme.style(`-${deletions}`, { fg: "toolDiffRemoved", bold: true });
	return s;
}

/**
 * A Text whose content is evaluated on render so hover-driven re-renders update
 * it without recreating components, while caching rendered lines by
 * `(rawString, width)` so `Box.matchCache` hits in O(1) on idle frames.
 */
class LiveText implements Component {
	private readonly build: () => string;
	private cachedRaw: string | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(build: () => string) {
		this.build = build;
	}

	render(width: number): string[] {
		const raw = this.build();
		if (this.cachedLines && this.cachedRaw === raw && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines = raw.split("\n").map((line) => truncateToWidth(line, width, "…"));
		this.cachedRaw = raw;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedRaw = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/**
 * Like {@link LiveText}, but renders no lines at all when the builder returns
 * undefined. Used for the section footer, which only exists when something is
 * actually hidden.
 */
class OptionalText implements Component {
	private readonly build: () => string | undefined;
	private cachedKey: string | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(build: () => string | undefined) {
		this.build = build;
	}

	render(width: number): string[] {
		const raw = this.build();
		if (raw === undefined) {
			this.cachedKey = undefined;
			this.cachedWidth = undefined;
			this.cachedLines = undefined;
			return [];
		}
		if (this.cachedLines && this.cachedKey === raw && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines = [truncateToWidth(raw, width, "…")];
		this.cachedKey = raw;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedKey = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** Parts of a tool-section header line. */
interface HeaderParts {
	/** Styled prompt marker / tool name (`$`, `read`, `grep`, …). */
	name: string;
	/** Styled detail (command, path, pattern); may contain newlines. */
	detail: string;
	/** Styled trailing metadata, including its own leading separator (`· 12 lines · 4.0s`). */
	meta: string;
	/** Keep the end of an over-long detail when collapsed (paths keep the file name). */
	keepTail?: boolean;
}

/** Minimum columns kept for header detail text (commands never collapse to nothing). */
const MIN_HEADER_DETAIL = 12;
/** Continuation lines never indent further than this, so wrapped commands stay readable. */
const MAX_HEADER_INDENT = 4;

/**
 * Tool-section header line.
 *
 * Collapsed, the header stays on exactly one line and truncates the *detail*
 * (the command, path or pattern) so trailing metadata such as
 * `· 12 lines · 4.0s` and the `click to expand` hint always stay visible.
 *
 * Expanded, the header shows the full detail: long commands wrap across lines
 * (continuation lines are indented under the detail), command line breaks are
 * preserved, and the metadata is appended to the last line that has room.
 */
class SectionHeader implements Component {
	private readonly build: () => HeaderParts;
	private readonly isExpanded: () => boolean;
	private readonly onOverflow: ((overflow: boolean) => void) | undefined;
	private cachedKey: string | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		build: () => HeaderParts,
		isExpanded: () => boolean,
		onOverflow?: (overflow: boolean) => void,
	) {
		this.build = build;
		this.isExpanded = isExpanded;
		this.onOverflow = onOverflow;
	}

	render(width: number): string[] {
		const parts = this.build();
		// Path-like details keep their tail (file name) instead of wrapping mid-word.
		const expanded = this.isExpanded() && parts.keepTail !== true;
		const key = `${expanded ? 1 : 0}\u0000${parts.name}\u0000${parts.detail}\u0000${parts.meta}`;

		if (this.cachedLines && this.cachedKey === key && this.cachedWidth === width) {
			return this.cachedLines;
		}
		// A command or pattern that does not fit on one line is hidden content too:
		// expanding reveals it, so the section becomes hoverable and clickable.
		if (this.onOverflow) {
			try {
				this.onOverflow(headerDetailOverflows(parts, width));
			} catch {
				// Reporting is best-effort; never break a render.
			}
		}
		const lines = expanded ? wrapHeader(parts, width) : collapseHeader(parts, width);
		this.cachedKey = key;
		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedKey = undefined;
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

/** True when the collapsed header would have to shorten its command or pattern. */
function headerDetailOverflows(parts: HeaderParts, width: number): boolean {
	if (!parts.detail || parts.keepTail === true) return false;
	const gap = 1;
	const nameWidth = visibleWidth(parts.name);
	const metaWidth = parts.meta ? visibleWidth(parts.meta) : 0;
	const avail = Math.max(MIN_HEADER_DETAIL, width - nameWidth - gap - metaWidth);
	const singleLine = parts.detail.replace(/\r?\n/g, " ↵ ");
	return visibleWidth(singleLine) > avail;
}

/** Drop OSC 8 hyperlink sequences (a truncated link would otherwise bleed). */
const OSC8_RE = /\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Truncate keeping the *end* of the text (`…nd/of/a/long/path/file.ts`). */
function truncateHead(text: string, maxWidth: number, ellipsis: string): string {
	const w = visibleWidth(text);
	if (w <= maxWidth) return text;
	const keep = Math.max(0, maxWidth - visibleWidth(ellipsis));
	if (keep === 0) return truncateToWidth(text, maxWidth, ellipsis);

	const plain = stripTerminalSequences(text);
	let startCol = Math.max(0, w - keep);

	// Start the tail on a path separator so it never begins mid directory name.
	if (startCol > 0) {
		const from = plainColumnIndex(plain, startCol);
		const slash = plain.indexOf("/", from);
		if (slash !== -1) {
			const slashCol = visibleWidth(plain.slice(0, slash));
			if (slashCol - startCol <= 16) startCol = slashCol;
		}
	}

	if (startCol >= w) return ellipsis;
	const tail = sliceByColumn(text, startCol, Math.max(1, w - startCol));
	return ellipsis + tail.replace(OSC8_RE, "");
}

/** Index of the first code point that starts at or after `column`. */
function plainColumnIndex(plain: string, column: number): number {
	let col = 0;
	let idx = 0;
	for (const ch of plain) {
		if (col >= column) break;
		col += visibleWidth(ch);
		idx += ch.length;
	}
	return idx;
}

/** Single-line header: truncate only the detail, keep metadata on screen. */
function collapseHeader(parts: HeaderParts, width: number): string[] {
	const gap = parts.detail ? 1 : 0;
	const nameWidth = visibleWidth(parts.name);
	const metaWidth = parts.meta ? visibleWidth(parts.meta) : 0;
	const avail = Math.max(MIN_HEADER_DETAIL, width - nameWidth - gap - metaWidth);
	const detail = parts.detail.replace(/\r?\n/g, " ↵ ");

	let line = parts.name;
	if (parts.detail) {
		const fits = visibleWidth(detail) <= avail;
		const fitted = fits
			? detail
			: parts.keepTail
				? truncateHead(detail, avail, "…")
				: truncateToWidth(detail, avail, "…");
		line += " " + fitted;
	}
	line += parts.meta;
	return [truncateToWidth(line, width, "…")];
}

/** Expanded header: full detail, wrapped (or split on its own newlines). */
function wrapHeader(parts: HeaderParts, width: number): string[] {
	const gap = parts.detail ? 1 : 0;
	const nameWidth = visibleWidth(parts.name);
	const indent = " ".repeat(Math.max(0, Math.min(nameWidth + gap, MAX_HEADER_INDENT)));
	const firstWidth = Math.max(MIN_HEADER_DETAIL, width - nameWidth - gap);
	const contWidth = Math.max(MIN_HEADER_DETAIL, width - visibleWidth(indent));

	const out: string[] = [];
	if (parts.detail) {
		const rawLines = parts.detail.split(/\r?\n/);
		for (let i = 0; i < rawLines.length; i++) {
			const avail = i === 0 ? firstWidth : contWidth;
			const wrapped = rawLines[i] === "" ? [""] : wrapTextWithAnsi(rawLines[i], avail);
			for (let j = 0; j < wrapped.length; j++) {
				out.push((i === 0 && j === 0 ? parts.name + " " : indent) + wrapped[j]);
			}
		}
	}
	if (out.length === 0) out.push(parts.name);

	if (parts.meta) {
		const last = out.length - 1;
		if (visibleWidth(out[last]) + visibleWidth(parts.meta) <= width) {
			out[last] += parts.meta;
		} else {
			out.push(indent + parts.meta);
		}
	}

	return out.map((line) => truncateToWidth(line, width, "…"));
}

function editHeader(
	path: string | undefined,
	theme: Theme,
	counts?: { additions: number; deletions: number },
	preview?: boolean,
	cwd?: string,
): Component {
	return new SectionHeader(
		() => {
			let meta = counts ? statsSuffix(counts.additions, counts.deletions, theme) : "";
			if (preview) meta += " " + theme.fg("dim", "preview");
			return {
				name: theme.style("edit", { fg: "toolTitle", bold: true }),
				detail: path ? styledPath(path, theme, cwd) : "",
				meta,
				keepTail: true,
			};
		},
		// Paths keep the file name (tail-truncated) instead of wrapping mid-word.
		() => false,
	);
}

function writeHeader(
	path: string | undefined,
	theme: Theme,
	lines?: number,
	cwd?: string,
	context?: ToolRenderContext,
): Component {
	return new SectionHeader(
		() => {
			let meta = typeof lines === "number" ? " " + theme.style(`+${lines}`, { fg: "toolDiffAdded", bold: true }) : "";
			if (context) meta += hoverSuffix(context, theme);
			return {
				name: theme.style("write", { fg: "toolTitle", bold: true }),
				detail: path ? styledPath(path, theme, cwd) : "",
				meta,
				keepTail: true,
			};
		},
		// Paths keep the file name (tail-truncated) instead of wrapping mid-word.
		() => false,
	);
}

/** Shared per-execution view state. Lives on the tool-render `context.state`. */
interface ViewState {
	hover?: boolean;
	hoverTimer?: ReturnType<typeof setTimeout>;
	/** True when this section has hidden lines (or is expanded past the collapsed budget) and can be toggled by clicking. */
	canToggle?: boolean;
	/** True when collapsed output lines are hidden (decided before rendering). */
	bodyCanToggle?: boolean;
	/** True when the collapsed header has to shorten its command or pattern. */
	headerOverflow?: boolean;
	/** Set once renderResult runs. */
	hasResult?: boolean;
	/** Report counter value this box last handled (see the mouse watcher). */
	handledSeq?: number;
}

function viewState(context: ToolRenderContext): ViewState {
	const s = (context.state ?? {}) as ViewState;
	if (context.state == null) {
		(context as unknown as { state: ViewState }).state = s;
	}
	return s;
}

/**
 * Recompute whether this section can be toggled and drop a hover that no longer
 * has anything to show. Hidden output lines and a shortened header both count.
 */
function setBodyToggle(st: ViewState, bodyCanToggle: boolean): void {
	st.bodyCanToggle = bodyCanToggle;
	st.canToggle = bodyCanToggle || st.headerOverflow === true;
	if (!st.canToggle && st.hover) {
		st.hover = false;
		if (activeHover?.state === st) activeHover = null;
	}
}

// ---------------------------------------------------------------------------
// Theme-aware skin & hover elevation
// ---------------------------------------------------------------------------

/**
 * Surface mixing parameters (in sRGB so both very dark `#141414` and mid-dark
 * `#313237` panels shift by a consistent ~10–11 RGB units — matching `opencode`'s
 * `#141414` -> `#1e1e1e` elevation and advancing 1 step in 256-color palettes).
 */
const DARK_HOVER_LIFT = 0.048;
const LIGHT_HOVER_DIP = 0.042;
const REMOVE_BG_MIX = 0.16;
const ADD_BG_MIX = 0.16;
const REMOVE_WORD_BG_MIX = 0.34;
const ADD_WORD_BG_MIX = 0.34;

const WHITE = parseColor("#ffffff");
const BLACK = parseColor("#000000");
const FALLBACK_DARK_PANEL = parseColor("#16161a");
const FALLBACK_LIGHT_PANEL = parseColor("#f0f0f3");

/** Default-background reset (open-only): restores transparency. */
const BG_DEFAULT = `${ESC}[49m`;

interface DiffSkin {
	/** Box background painter (seals internal resets so background never cuts out). */
	box: (text: string) => string;
	/** Re-assert the box background (open-only) after embedded resets. */
	open: string;
	/** Remove-row background (open-only). */
	removeOpen: string;
	/** Add-row background (open-only). */
	addOpen: string;
	/** Stronger remove background for intra-line changed tokens (open-only). */
	removeWordOpen: string;
	/** Stronger add background for intra-line changed tokens (open-only). */
	addWordOpen: string;
}

interface ThemeSkinCache {
	colorsRef: unknown;
	skins: Map<string, DiffSkin>;
}

const skinCache = new WeakMap<object, ThemeSkinCache>();

function bgOpenAnsi(theme: Theme, color: Color): string {
	try {
		return backgroundAnsi(color, theme.getColorMode());
	} catch {
		return "";
	}
}

function hasConcreteBg(theme: Theme, token: "toolPendingBg" | "userMessageBg" | "selectedBg"): boolean {
	try {
		const ansi = theme.getBgAnsi(token);
		return Boolean(ansi && ansi !== BG_DEFAULT);
	} catch {
		return false;
	}
}

function resolveBasePanelColor(theme: Theme): Color {
	if (hasConcreteBg(theme, "toolPendingBg")) return theme.colors.toolPendingBg;
	if (hasConcreteBg(theme, "userMessageBg")) return theme.colors.userMessageBg;
	return theme.appearance === "light" ? FALLBACK_LIGHT_PANEL : FALLBACK_DARK_PANEL;
}

function resolveHoverPanelColor(theme: Theme, base: Color): Color {
	if (theme.appearance === "light") {
		return mixColors(base, BLACK, LIGHT_HOVER_DIP, "srgb");
	}
	return mixColors(base, WHITE, DARK_HOVER_LIFT, "srgb");
}

function skinFor(theme: Theme, hovered: boolean): DiffSkin {
	let entry = skinCache.get(theme);
	const currentColorsRef = theme.colors;
	if (!entry || entry.colorsRef !== currentColorsRef) {
		entry = { colorsRef: currentColorsRef, skins: new Map() };
		skinCache.set(theme, entry);
	}
	const key = `${theme.appearance}|${theme.getColorMode()}|${hovered}`;
	let skin = entry.skins.get(key);
	if (!skin) {
		skin = buildSkin(theme, hovered);
		if (entry.skins.size > 8) entry.skins.clear();
		entry.skins.set(key, skin);
	}
	return skin;
}

function buildSkin(theme: Theme, hovered: boolean): DiffSkin {
	try {
		const base = resolveBasePanelColor(theme);
		const shown = hovered ? resolveHoverPanelColor(theme, base) : base;
		const removeBg = mixColors(shown, theme.colors.toolDiffRemoved, REMOVE_BG_MIX, "srgb");
		const addBg = mixColors(shown, theme.colors.toolDiffAdded, ADD_BG_MIX, "srgb");
		const removeWordBg = mixColors(shown, theme.colors.toolDiffRemoved, REMOVE_WORD_BG_MIX, "srgb");
		const addWordBg = mixColors(shown, theme.colors.toolDiffAdded, ADD_WORD_BG_MIX, "srgb");
		const open = bgOpenAnsi(theme, shown);
		const box = open ? (t: string) => `${open}${sealLine(t, open)}${BG_DEFAULT}` : (t: string) => t;
		return {
			box,
			open,
			removeOpen: bgOpenAnsi(theme, removeBg),
			addOpen: bgOpenAnsi(theme, addBg),
			removeWordOpen: bgOpenAnsi(theme, removeWordBg),
			addWordOpen: bgOpenAnsi(theme, addWordBg),
		};
	} catch {
		return {
			box: (t: string) => t,
			open: BG_DEFAULT,
			removeOpen: "",
			addOpen: "",
			removeWordOpen: "",
			addWordOpen: "",
		};
	}
}

/** Static (non-hover) box, used for always-open diffs. */
function makeStaticBox(theme: Theme, pad: number): Box {
	return new Box(pad, 1, skinFor(theme, false).box);
}

/** Hover-reactive box: only elevates when `state.hover && state.canToggle` is true. */
function makeBox(theme: Theme, pad: number, context: ToolRenderContext): Box {
	return new Box(pad, 1, (t) => {
		const st = viewState(context);
		return skinFor(theme, st.hover === true && st.canToggle === true).box(t);
	});
}

// ---------------------------------------------------------------------------
// Mouse hover tracking (zero-lag post-dispatch microtask check)
// ---------------------------------------------------------------------------

interface TuiLike {
	inputListeners?: Set<(d: string) => unknown>;
	requestRender?: () => void;
}

interface ActiveHover {
	state: ViewState;
	context: ToolRenderContext;
}

let tuiRef: TuiLike | null = null;
let mouseWatcherActive = false;
let activeHover: ActiveHover | null = null;
let reportSeq = 0;

function requestHoverRender(context?: ToolRenderContext): void {
	if (tuiRef && typeof tuiRef.requestRender === "function") {
		try {
			tuiRef.requestRender();
			return;
		} catch {
			// Fall through to context.invalidate()
		}
	}
	try {
		context?.invalidate();
	} catch {
		// Stale render context; harmless.
	}
}

function clearHover(state: ViewState, context?: ToolRenderContext): void {
	if (state.hoverTimer) {
		clearTimeout(state.hoverTimer);
		state.hoverTimer = undefined;
	}
	if (activeHover?.state === state) {
		activeHover = null;
	}
	if (!state.hover) return;
	state.hover = false;
	requestHoverRender(context);
}

function clearActiveHover(): void {
	if (!activeHover) return;
	const { state, context } = activeHover;
	activeHover = null;
	clearHover(state, context);
}

function noteHover(state: ViewState, context: ToolRenderContext): void {
	state.handledSeq = reportSeq;
	if (activeHover && activeHover.state !== state) {
		const prev = activeHover;
		activeHover = null;
		if (prev.state.hoverTimer) {
			clearTimeout(prev.state.hoverTimer);
			prev.state.hoverTimer = undefined;
		}
		prev.state.hover = false;
	}
	const changed = !state.hover;
	state.hover = true;
	activeHover = { state, context };

	// Fallback timer only when the raw mouse watcher is not attached.
	if (state.hoverTimer) {
		clearTimeout(state.hoverTimer);
		state.hoverTimer = undefined;
	}
	if (!mouseWatcherActive) {
		state.hoverTimer = setTimeout(() => {
			state.hoverTimer = undefined;
			clearHover(state, context);
		}, 2500);
		(state.hoverTimer as unknown as { unref?: () => void }).unref?.();
	}

	if (changed) {
		requestHoverRender(context);
	}
}

/** Calm suffix shown on a hovered expandable header. Same line, so no layout shift. */
function hoverSuffix(context: ToolRenderContext, theme: Theme): string {
	const st = viewState(context);
	if (st.hover === true && st.canToggle === true && fullscreenMouse) {
		const action = context.expanded ? "click to collapse" : "click to expand";
		return theme.fg("dim", " · ") + theme.fg("accent", action);
	}
	return "";
}

function isMouseReport(data: string): boolean {
	return data.indexOf(`${ESC}[<`) !== -1 || data.indexOf(`${ESC}[M`) !== -1;
}

/**
 * Runs at the front of `tui.inputListeners`.
 *
 * In `TuiBase.handleTerminalInput`, all `inputListeners` execute synchronously
 * in insertion order: this watcher runs first, and `TuiAltScreen.handleViewportInput`
 * runs immediately after in the same synchronous loop (dispatching `handleMouseEvent`
 * -> `dispatchMouseToLayout` -> `mouseWrap`).
 *
 * By checking `activeHover.state.handledSeq === seq` in a microtask queued right
 * before `handleViewportInput`, we know immediately after `handleTerminalInput`
 * finishes whether the mouse report landed inside a hoverable box or outside it.
 */
function mouseWatcher(data: string): undefined {
	if (typeof data !== "string") return undefined;
	if (data === FOCUS_OUT) {
		clearActiveHover();
		return undefined;
	}
	if (!isMouseReport(data)) return undefined;
	const seq = ++reportSeq;
	queueMicrotask(() => {
		// If a batch of mouse events arrived in one stdin read, only evaluate the latest.
		if (seq !== reportSeq) return;
		if (activeHover && activeHover.state.handledSeq !== seq) {
			clearActiveHover();
		}
	});
	return undefined;
}

function prioritizeMouseWatcher(tui: unknown): void {
	const t = tui as TuiLike | undefined;
	if (!t) return;
	tuiRef = t;
	const set = t.inputListeners;
	if (!set || typeof set.add !== "function" || typeof set.clear !== "function") return;
	const rest: Array<(d: string) => unknown> = [];
	for (const listener of set) {
		if (listener !== (mouseWatcher as unknown)) rest.push(listener);
	}
	set.clear();
	set.add(mouseWatcher);
	for (const listener of rest) set.add(listener);
	mouseWatcherActive = true;
}

function removeMouseWatcher(): void {
	clearActiveHover();
	if (tuiRef?.inputListeners && typeof tuiRef.inputListeners.delete === "function") {
		tuiRef.inputListeners.delete(mouseWatcher);
	}
	tuiRef = null;
	mouseWatcherActive = false;
}

/**
 * Acquire the live TUI so mouse reports can be observed before Pi dispatches
 * them, then immediately remove the widget again: only the side effect matters.
 */
function installMouseWatcher(ctx: ExtensionContext): void {
	try {
		ctx.ui.setWidget("tessera-mouse", (tui) => {
			try {
				prioritizeMouseWatcher(tui);
			} catch {
				// Mouse tracking is optional.
			}
			return new Container();
		});
		ctx.ui.setWidget("tessera-mouse", undefined);
	} catch {
		// Widgets are unavailable outside the interactive TUI.
	}
}

/**
 * Region for non-hoverable boxes (diffs or short sections that already fit in full).
 * Moving onto one clears any lit section immediately.
 */
function passiveMouseWrap(box: Box): Component {
	return new MouseRegion(box, (event) => {
		const type = event?.type;
		if ((type === "move" || type === "press" || type === "drag") && activeHover) {
			clearActiveHover();
			return type === "move" ? { handled: true, render: true } : undefined;
		}
		return undefined;
	});
}

/**
 * Region for hover-capable tool sections.
 * - Only highlights when `state.canToggle === true`.
 * - Clears hover on wheel scroll or text-selection drag so scrolling and
 *   selecting text stay completely fast and clean.
 * - Never consumes `press`, `drag`, or `release` so native text selection,
 *   OSC 8 links, and Pi's `createResultRegion` click-to-expand work seamlessly.
 */
function mouseWrap(box: Box, context: ToolRenderContext): Component {
	const state = viewState(context);
	return new MouseRegion(box, (event) => {
		const type = event?.type;
		if (type === "wheel" || type === "drag") {
			if (state.hover) {
				state.hover = false;
				if (activeHover?.state === state) activeHover = null;
			}
			return undefined;
		}
		if (!state.canToggle) {
			if ((type === "move" || type === "press") && activeHover) {
				clearActiveHover();
				return type === "move" ? { handled: true, render: true } : undefined;
			}
			return undefined;
		}
		if (type === "move" || type === "press" || type === "release" || type === "click") {
			const wasLit = state.hover === true;
			noteHover(state, context);
			if (!wasLit && type === "move") {
				return { handled: true, render: true };
			}
		}
		return undefined;
	});
}

/**
 * Styled "· click to expand" suffix for a capped diff row, or undefined when the
 * diff cannot be expanded (then the row keeps its plain "truncated" wording).
 */
function truncatedHint(
	canToggle: boolean,
	context: ToolRenderContext,
	theme: Theme,
): (() => string | undefined) | undefined {
	if (!canToggle) return undefined;
	return () => {
		const st = viewState(context);
		const hint = expandHint();
		if (st.hover === true && st.canToggle === true) {
			return `${theme.fg("dim", " · ")}${theme.fg("accent", hint)}`;
		}
		return theme.fg("dim", ` · ${hint}`);
	};
}

/** Expand affordance: click hint in fullscreen (mouse works), key hint otherwise. */
function expandHint(): string {
	if (fullscreenMouse) return "click to expand";
	try {
		return `${keyHint("app.tools.expand", "ctrl+o")} to expand`;
	} catch {
		return "expand to see all";
	}
}

// ---------------------------------------------------------------------------
// Live preview (read file, apply edits in memory, unified patch)
// ---------------------------------------------------------------------------

interface EditInputBlock {
	oldText: string;
	newText: string;
}

interface PreviewState {
	key?: string;
	pending?: boolean;
	preview?: { hunks: ParsedHunk[]; additions: number; deletions: number } | null;
	previewError?: string;
}

interface PreviewResult {
	hunks: ParsedHunk[];
	additions: number;
	deletions: number;
	error?: string;
}

function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function stripBom(content: string): string {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}

function fuzzyNormalize(text: string): string {
	return text
		.normalize("NFKC")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[‐‑‒–—―−]/g, "-")
		.replace(/[   -   　]/g, " ");
}

function applyEdits(base: string, edits: EditInputBlock[], path: string): { baseContent: string; newContent: string } {
	const normalized = edits.map((e) => ({ oldText: normalizeToLF(e.oldText), newText: normalizeToLF(e.newText) }));
	for (const e of normalized) {
		if (e.oldText.length === 0) throw new Error(`oldText must not be empty in ${path}.`);
	}
	const fuzzyNeeded = normalized.some((e) => base.indexOf(e.oldText) === -1);
	const baseContent = fuzzyNeeded ? fuzzyNormalize(base) : base;
	const matches: Array<{ index: number; length: number; newText: string }> = [];
	for (const e of normalized) {
		const needle = fuzzyNeeded ? fuzzyNormalize(e.oldText) : e.oldText;
		const first = baseContent.indexOf(needle);
		if (first === -1) throw new Error(`Could not find the exact text in ${path}.`);
		if (baseContent.indexOf(needle, first + 1) !== -1) {
			throw new Error(`Found multiple occurrences of the text in ${path}; keep oldText unique.`);
		}
		matches.push({ index: first, length: needle.length, newText: normalizeToLF(e.newText) });
	}
	matches.sort((a, b) => a.index - b.index);
	for (let i = 1; i < matches.length; i++) {
		if (matches[i - 1].index + matches[i - 1].length > matches[i].index) {
			throw new Error(`Overlapping edits in ${path}.`);
		}
	}
	let next = baseContent;
	for (let i = matches.length - 1; i >= 0; i--) {
		const m = matches[i];
		next = next.slice(0, m.index) + m.newText + next.slice(m.index + m.length);
	}
	if (next === baseContent) throw new Error(`No changes made to ${path}.`);
	return { baseContent, newContent: next };
}

async function computePreview(path: string, edits: EditInputBlock[], cwd: string): Promise<PreviewResult> {
	const empty = { hunks: [] as ParsedHunk[], additions: 0, deletions: 0 };
	try {
		const cleanPath = path.startsWith("@") ? path.slice(1) : path;
		const abs = resolve(cwd, cleanPath);
		try {
			await access(abs, constants.R_OK);
		} catch {
			return { ...empty, error: `Cannot read ${path}.` };
		}
		const raw = await readFile(abs, "utf-8");
		const content = normalizeToLF(stripBom(raw));
		const { baseContent, newContent } = applyEdits(content, edits, path);
		const cfg = getConfig();
		const patch = generateUnifiedPatch(path, baseContent, newContent, cfg.contextLines);
		if (!patch.trim()) return { ...empty, error: `No changes in ${path}.` };
		const hunks = parseUnifiedPatch(patch);
		const { additions, deletions } = countChanges(hunks);
		return { hunks, additions, deletions };
	} catch (err) {
		return { ...empty, error: err instanceof Error ? err.message : String(err) };
	}
}

function extractEditInput(args: unknown): { path: string; edits: EditInputBlock[] } | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	const path = typeof a.path === "string" ? a.path : typeof a.file_path === "string" ? a.file_path : null;
	if (!path) return null;
	if (
		Array.isArray(a.edits) &&
		a.edits.length > 0 &&
		(a.edits as unknown[]).every(
			(e) =>
				!!e &&
				typeof e === "object" &&
				typeof (e as Record<string, unknown>).oldText === "string" &&
				typeof (e as Record<string, unknown>).newText === "string",
		)
	) {
		return { path, edits: a.edits as EditInputBlock[] };
	}
	if (typeof a.oldText === "string" && typeof a.newText === "string") {
		return { path, edits: [{ oldText: a.oldText, newText: a.newText }] };
	}
	return null;
}

function previewFromDetails(details: unknown): PreviewResult | null {
	if (!details || typeof details !== "object") return null;
	const d = details as Record<string, unknown>;
	const patch = typeof d.patch === "string" && d.patch.trim() ? d.patch : null;
	const diff = typeof d.diff === "string" && d.diff.trim() ? d.diff : null;
	try {
		if (patch) {
			const hunks = parseUnifiedPatch(patch);
			return { hunks, ...countChanges(hunks) };
		}
		if (diff) {
			const hunks = parseDisplayDiff(diff);
			return { hunks, ...countChanges(hunks) };
		}
	} catch {
		return null;
	}
	return null;
}

function textOf(result: { content?: Array<{ type?: string; text?: string }> }): string {
	return (
		result.content
			?.filter((p) => p.type === "text" && typeof p.text === "string")
			.map((p) => p.text as string)
			.join("\n") ?? ""
	);
}

function firstLine(text: string): string {
	const line = text.split("\n")[0] ?? "";
	return line.length > 220 ? line.slice(0, 219) + "…" : line;
}

function countContentLines(content: string): number {
	if (content === "") return 0;
	const lines = content.split("\n");
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
	return lines.length;
}

/** Explain what mouse interaction the current setup supports. */
function mouseStatusLines(): string[] {
	const lines: string[] = [];
	lines.push(`tuiMode: ${fullscreenMouse ? "fullscreen" : "regular"}`);
	const env = process.env;
	const term = (env["TERM"] ?? "").toLowerCase();
	const multiplexed =
		env["TMUX"] !== undefined ||
		env["STY"] !== undefined ||
		env["ZELLIJ"] !== undefined ||
		term.startsWith("tmux") ||
		term.startsWith("screen");
	lines.push(multiplexed ? "multiplexer: yes (button-motion only)" : "multiplexer: no");
	if (!fullscreenMouse) {
		lines.push("mouse: off — regular mode leaves the mouse with the terminal");
		lines.push('hover/click need "tuiMode": "fullscreen"');
	} else if (multiplexed) {
		lines.push("click: works · hover: unavailable (multiplexer strips motion events)");
	} else {
		lines.push(`click: works · hover: ${mouseWatcherActive ? "active" : "ready"}`);
	}
	return lines;
}

/** Build a synthetic all-add hunk so `write` reuses the diff renderer. */
function syntheticHunk(content: string): ParsedHunk[] {
	const rawLines = content.split("\n");
	if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
	return [
		{
			header: "",
			section: "",
			oldStart: 0,
			oldCount: 0,
			newStart: 1,
			newCount: rawLines.length,
			lines: rawLines.map((line, i) => ({
				type: "add" as const,
				content: cleanContent(line),
				oldLineNum: null,
				newLineNum: i + 1,
			})),
		},
	];
}

// ---------------------------------------------------------------------------
// Plain tool sections (read, bash, powershell, grep, find, ls)
// ---------------------------------------------------------------------------

interface SectionSpec {
	name: string;
	detail: (args: Record<string, unknown>, theme: Theme, cwd?: string) => string;
	lang: (args: Record<string, unknown>) => string | undefined;
	highlight: boolean;
	tail: boolean;
	pending: string;
	/** Collapsed headers keep the end of the detail (paths keep the file name). */
	keepTail?: boolean;
	/** Footer label used when expanding reveals a header that had to be shortened. */
	shortenedLabel?: string;
}

function strArg(args: Record<string, unknown>, key: string): string {
	const v = args[key];
	return typeof v === "string" ? v : "";
}

function numArg(args: Record<string, unknown>, key: string): number | undefined {
	const v = args[key];
	if (typeof v === "number" && Number.isFinite(v)) return v;
	if (typeof v === "string" && v.trim() !== "") {
		const n = Number(v);
		if (Number.isFinite(n)) return n;
	}
	return undefined;
}

/**
 * Command text for shell tools.
 *
 * Kept unshortened (and with its own line breaks) so the header can truncate it
 * when collapsed and show all of it — wrapped — once the section is expanded.
 */
function commandOf(args: Record<string, unknown>): string {
	return (strArg(args, "command") || strArg(args, "script")).replace(/[\r\n]+$/, "");
}

function formatReadRange(offset: number | undefined, limit: number | undefined): string {
	if (offset === undefined && limit === undefined) return "";
	const start = offset !== undefined ? Math.max(1, Math.round(offset)) : 1;
	if (limit === undefined) return `:${start}`;
	const count = Math.max(1, Math.round(limit));
	const end = start + count - 1;
	return `:${start}-${end}`;
}

const SECTION_SPECS: Record<string, SectionSpec> = {
	read: {
		name: "read",
		detail: (a, theme, cwd) => {
			const rawPath = strArg(a, "path") || strArg(a, "file_path");
			const off = numArg(a, "offset");
			const lim = numArg(a, "limit");
			const pathPart = styledPath(rawPath, theme, cwd);
			const range = formatReadRange(off, lim);
			return range ? `${pathPart}${theme.fg("dim", range)}` : pathPart;
		},
		lang: (a) => getLanguageFromPath(strArg(a, "path") || strArg(a, "file_path")),
		highlight: true,
		tail: false,
		pending: "Reading…",
		keepTail: true,
	},
	bash: {
		name: "$",
		detail: (a, theme) => {
			// The full command is kept: it truncates when collapsed and wraps when expanded.
			let s = theme.fg("muted", commandOf(a));
			const timeout = numArg(a, "timeout");
			if (timeout) s += theme.fg("dim", ` (${timeout}s)`);
			return s;
		},
		lang: () => undefined,
		highlight: false,
		tail: true,
		pending: "Running…",
		shortenedLabel: "full command",
	},
	powershell: {
		name: "$",
		detail: (a, theme) => {
			let s = theme.fg("muted", commandOf(a));
			const timeout = numArg(a, "timeout");
			if (timeout) s += theme.fg("dim", ` (${timeout}s)`);
			return s;
		},
		lang: () => undefined,
		highlight: false,
		tail: true,
		pending: "Running…",
		shortenedLabel: "full command",
	},
	grep: {
		name: "grep",
		detail: (a, theme, cwd) => {
			const pat = strArg(a, "pattern") || strArg(a, "query");
			const rawPath = strArg(a, "path") || strArg(a, "dir");
			const glob = strArg(a, "glob");
			const parts: string[] = [];
			if (pat) parts.push(theme.fg("accent", `/${pat}/`));
			if (rawPath) parts.push(theme.fg("dim", "in ") + styledPath(rawPath, theme, cwd));
			if (glob) parts.push(theme.fg("dim", `(${glob})`));
			return parts.join(" ");
		},
		lang: () => undefined,
		highlight: false,
		tail: false,
		pending: "Searching…",
		shortenedLabel: "full pattern",
	},
	find: {
		name: "find",
		detail: (a, theme, cwd) => {
			const pat = strArg(a, "pattern");
			const rawPath = strArg(a, "path") || strArg(a, "dir") || ".";
			const parts: string[] = [];
			if (pat) parts.push(theme.fg("accent", pat));
			parts.push(theme.fg("dim", pat ? "in " : "") + styledPath(rawPath, theme, cwd));
			return parts.join(" ");
		},
		lang: () => undefined,
		highlight: false,
		tail: false,
		pending: "Listing…",
		shortenedLabel: "full pattern",
	},
	ls: {
		name: "ls",
		detail: (a, theme, cwd) => styledPath(strArg(a, "path") || strArg(a, "dir") || ".", theme, cwd),
		lang: () => undefined,
		highlight: false,
		tail: false,
		pending: "Listing…",
		keepTail: true,
	},
};

/** Tool output text, made layout-safe (keeps its own colors, expands tabs). */
function cleanOutputLine(line: string): string {
	let out = "";
	for (let i = 0; i < line.length; i++) {
		const code = line.charCodeAt(i);
		if (code === 9) {
			out += " ".repeat(TAB_WIDTH);
		} else if (code === 27 || code >= 32) {
			out += line[i];
		}
	}
	return out;
}

const TRAILING_NOTICE_RE = /\n\n\[(?:Showing lines \d+-\d+ of \d+|[\d]+ more lines in file|Full output:|Truncated:|\d+ matches limit|\d+ results limit|\d+ entries limit)[^\]]*\]\s*$/;

/** Separate Pi's trailing `[...]` continuation/truncation notice from the main content body. */
function splitTrailingNotice(text: string): { bodyText: string; notice: string | undefined } {
	const match = TRAILING_NOTICE_RE.exec(text);
	if (!match || match.index === undefined) {
		return { bodyText: text, notice: undefined };
	}
	const notice = text.slice(match.index).trim();
	const bodyText = text.slice(0, match.index);
	return { bodyText, notice };
}

const GREP_MATCH_LINE_RE = /^(.+?):(\d+): (.*)$/;
const GREP_CTX_LINE_RE = /^(.+?)-(\d+)- (.*)$/;

function styleGrepLine(line: string, theme: Theme): string {
	if (line === "--") return theme.fg("dim", "──");
	const m = GREP_MATCH_LINE_RE.exec(line);
	if (m) {
		return `${theme.fg("muted", m[1])}${theme.fg("dim", ":")}${theme.fg("accent", m[2])}${theme.fg("dim", ": ")}${m[3]}`;
	}
	const c = GREP_CTX_LINE_RE.exec(line);
	if (c) {
		return `${theme.fg("dim", c[1])}${theme.fg("dim", "-")}${theme.fg("dim", c[2])}${theme.fg("dim", "- ")}${theme.fg("muted", c[3])}`;
	}
	return line;
}

function styleLsLine(line: string, theme: Theme): string {
	if (line.endsWith("/")) {
		return theme.style(line, { fg: "accent", bold: true });
	}
	return line;
}

function sectionHeader(
	spec: SectionSpec,
	args: Record<string, unknown>,
	theme: Theme,
	context: ToolRenderContext | undefined,
	total?: number,
	expanded?: boolean,
	/** Make a header whose command/pattern is shortened hoverable and clickable. */
	reportOverflow?: boolean,
): Component {
	return new SectionHeader(
		() => {
			const name = theme.style(spec.name, { fg: "toolTitle", bold: true });
			const detail = spec.detail(args, theme, context?.cwd);

			const metaItems: string[] = [];
			if (total !== undefined) metaItems.push(`${total} ${total === 1 ? "line" : "lines"}`);
			const dur = formatDuration(context?.durationMs);
			if (dur && spec.name === "$") metaItems.push(dur);

			let meta = metaItems.length > 0 ? theme.fg("dim", ` · ${metaItems.join(" · ")}`) : "";
			if (context) meta += hoverSuffix(context, theme);
			return { name, detail, meta, keepTail: spec.keepTail };
		},
		() => expanded === true || context?.expanded === true,
		reportOverflow && context
			? (overflow) => {
					const st = viewState(context);
					st.headerOverflow = overflow;
					st.canToggle = overflow || st.bodyCanToggle === true;
				}
			: undefined,
	);
}

function sectionBody(
	toolName: string,
	spec: SectionSpec,
	args: Record<string, unknown>,
	bodyText: string,
	notice: string | undefined,
	theme: Theme,
	expanded: boolean,
	context: ToolRenderContext,
): { components: Component[]; totalLines: number; canToggle: boolean } {
	const out: Component[] = [];
	const total = countContentLines(bodyText);
	if (total === 0) {
		out.push(new Text(theme.fg("dim", notice ?? "(no output)"), 0, 0));
		return { components: out, totalLines: 0, canToggle: false };
	}

	const raw = bodyText.split("\n");
	const lines = raw.length > 1 && raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;
	const clean = spec.highlight ? lines.map((l) => expandTabs(cleanContent(l))) : lines.map(cleanOutputLine);

	const cfg = getConfig();
	const cap = cfg.maxExpandedLines;
	const collapsible = clean.length > cfg.maxCollapsedLines && !cfg.alwaysShowFullDiff;

	let shown: string[];
	let hidden = 0;
	let startOffset = 0;
	if (expanded || !collapsible) {
		if (clean.length <= cap) {
			shown = clean;
			startOffset = 0;
		} else if (spec.tail) {
			shown = clean.slice(clean.length - cap);
			startOffset = clean.length - cap;
		} else {
			shown = clean.slice(0, cap);
			startOffset = 0;
		}
		hidden = clean.length - shown.length;
	} else {
		const n = cfg.maxCollapsedLines;
		if (spec.tail) {
			shown = clean.slice(clean.length - n);
			startOffset = clean.length - n;
		} else {
			shown = clean.slice(0, n);
			startOffset = 0;
		}
		hidden = clean.length - shown.length;
	}

	let styled: string[];
	if (spec.highlight) {
		const hi = highlightBlock(shown, spec.lang(args), theme.name);
		const isImageNote = toolName === "read" && shown.length <= 3 && (shown[0] ?? "").startsWith("Read image file [");
		if (toolName === "read" && !isImageNote) {
			const baseLine = Math.max(1, Math.round(numArg(args, "offset") ?? 1)) + startOffset;
			const maxLineNum = baseLine + hi.length - 1;
			const numWidth = Math.max(3, String(maxLineNum).length);
			styled = hi.map((line, idx) => {
				const numStr = String(baseLine + idx).padStart(numWidth, " ");
				return `${theme.fg("dim", numStr)}  ${line}`;
			});
		} else {
			styled = hi;
		}
	} else if (toolName === "grep") {
		styled = shown.map((line) => styleGrepLine(line, theme));
	} else if (toolName === "ls") {
		styled = shown.map((line) => styleLsLine(line, theme));
	} else {
		styled = shown;
	}

	out.push(new Text(styled.join("\n"), 0, 0));

	if (notice && expanded) {
		out.push(new Text(theme.fg("dim", notice), 0, 0));
	}

	// The footer is the affordance at the end of every expandable section. It also
	// covers a shortened header, whose hidden text is only measurable while
	// rendering, so it may produce no line at all.
	out.push(
		new OptionalText(() => {
			const st = viewState(context);
			const parts: string[] = [];
			if (hidden > 0) parts.push(spec.tail ? `${hidden} earlier lines` : `${hidden} more lines`);
			// Only while collapsed: an expanded header shows its full text already.
			if (!expanded && st.headerOverflow === true && spec.shortenedLabel) parts.push(spec.shortenedLabel);
			if (parts.length === 0) return undefined;
			const label = `… ${parts.join(" · ")}`;
			// Output beyond the expanded cap can never be shown, so no click hint.
			// A shortened header alone is still expandable, even when the body fits.
			if (hidden > 0 && !collapsible) return theme.fg("dim", `${label} (capped at ${cap})`);
			const hint = expandHint();
			if (st.hover === true && st.canToggle === true) {
				return `${theme.fg("muted", `${label} · `)}${theme.fg("accent", hint)}`;
			}
			return theme.fg("dim", `${label} · ${hint}`);
		}),
	);

	return { components: out, totalLines: total, canToggle: collapsible };
}

function sectionCallRender(toolName: string, args: unknown, theme: Theme, context: ToolRenderContext): Component {
	const spec = SECTION_SPECS[toolName];
	const st = viewState(context);
	// Keep the pending call card visible while the tool is running until a result arrives.
	if (!context.isPartial || st.hasResult) return new Container();
	setBodyToggle(st, false);
	const out = makeBox(theme, context.outputPad ?? 1, context);
	const a = (args ?? {}) as Record<string, unknown>;
	out.addChild(sectionHeader(spec, a, theme, context));
	if (!context.argsComplete) {
		out.addChild(new Text(theme.fg("dim", "…"), 0, 0));
	} else {
		out.addChild(new Text(theme.fg("dim", spec.pending), 0, 0));
	}
	return passiveMouseWrap(out);
}

function sectionResultRender(
	toolName: string,
	result: unknown,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): Component {
	const spec = SECTION_SPECS[toolName];
	const st = viewState(context);
	if (!st.hasResult) {
		st.hasResult = true;
		if (context.isPartial) {
			queueMicrotask(() => {
				try {
					context.invalidate();
				} catch {
					// Stale render context; harmless.
				}
			});
		}
	}
	const out = makeBox(theme, context.outputPad ?? 1, context);
	const a = (context.args ?? {}) as Record<string, unknown>;
	const res = result as { content?: Array<{ type?: string; text?: string }> };
	const rawText = textOf(res);

	if (context.isError) {
		setBodyToggle(st, false);
		out.addChild(sectionHeader(spec, a, theme, context, undefined, true));
		out.addChild(new Text(theme.style(firstLine(rawText) || `${spec.name} failed`, { fg: "error", bold: true }), 0, 0));
		return passiveMouseWrap(out);
	}
	if (options.isPartial && !rawText.trim()) {
		setBodyToggle(st, false);
		out.addChild(sectionHeader(spec, a, theme, context));
		out.addChild(new Text(theme.fg("dim", spec.pending), 0, 0));
		return passiveMouseWrap(out);
	}

	const { bodyText, notice } = splitTrailingNotice(rawText);
	const expanded = options.expanded || getConfig().alwaysShowFullDiff;
	const { components, totalLines, canToggle } = sectionBody(
		toolName,
		spec,
		a,
		bodyText,
		notice,
		theme,
		expanded,
		context,
	);
	setBodyToggle(st, canToggle);

	// A command or pattern that does not fit on the header line is hidden output
	// too, so the header may turn the section into a clickable one while rendering.
	const reportOverflow = !getConfig().alwaysShowFullDiff;
	out.addChild(sectionHeader(spec, a, theme, context, totalLines || undefined, expanded, reportOverflow));
	for (const c of components) out.addChild(c);
	// Overflow is only measurable at render time, so always route mouse events
	// here: `mouseWrap` ignores them unless the section really can toggle.
	return mouseWrap(out, context);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** Whole-file writes can be very large; cap collapsed writes at 120 lines and allow clicking to expand to maxExpandedLines. */
const WRITE_COLLAPSED_CAP = 120;

/** Wheel scrolling candidate used by `/tessera scroll` when no number is given. */
const DEFAULT_WHEEL_LINES = 8;

/** Working directory of the active session, for reading/writing Pi settings. */
let sessionCwd = process.cwd();

// ---------------------------------------------------------------------------
// Renderer failure containment
// ---------------------------------------------------------------------------

type ToolCallRenderer = NonNullable<ToolRenderers["renderCall"]>;
type ToolResultRenderer = NonNullable<ToolRenderers["renderResult"]>;

/** Plain, escape-free description of a tool call for the fallback panel. */
function rawToolDetail(args: unknown): string {
	try {
		const a = (args ?? {}) as Record<string, unknown>;
		const path = strArg(a, "path") || strArg(a, "file_path");
		if (path) return cleanContent(formatDisplayPath(path));
		const command = commandOf(a);
		if (command) return cleanContent(command.replace(/\r?\n/g, " ↵ "));
		const pattern = strArg(a, "pattern");
		if (pattern) return cleanContent(pattern.replace(/\r?\n/g, " ↵ "));
	} catch {
		// Fall through to an empty detail.
	}
	return "";
}

function safeResultText(result: unknown): string {
	try {
		const text = textOf(result as { content?: Array<{ type?: string; text?: string }> });
		return text
			.replace(/\r/g, "")
			.split("\n")
			.slice(0, Math.max(1, getConfig().maxCollapsedLines))
			.map(cleanContent)
			.join("\n");
	} catch {
		return "";
	}
}

/** Last-resort panel: plain text instead of a broken transcript row. */
function renderFallback(toolName: string, theme: Theme, context: ToolRenderContext, text: string): Component {
	const out = makeStaticBox(theme, Math.max(0, context.outputPad ?? 1));
	const detail = rawToolDetail(context.args);
	const title = theme.style(toolName, { fg: "toolTitle", bold: true }) + (detail ? " " + theme.fg("muted", detail) : "");
	out.addChild(new Text(title, 0, 0));
	out.addChild(new Text(theme.fg("error", "tessera: could not render this section"), 0, 0));
	if (text.trim() !== "") out.addChild(new Text(theme.fg("dim", text), 0, 0));
	return passiveMouseWrap(out);
}

/**
 * Run a tool renderer, degrading to {@link renderFallback} when it throws.
 * Renderers run on every frame, so one unexpected result shape must not take
 * down the transcript.
 */
function guardedRender(
	toolName: string,
	theme: Theme,
	context: ToolRenderContext,
	render: () => Component,
	fallbackText: () => string,
): Component {
	try {
		return render();
	} catch {
		try {
			return renderFallback(toolName, theme, context, fallbackText());
		} catch {
			return new Container();
		}
	}
}

/** Add failure containment to one tool's custom renderers. */
function withRenderGuards(toolName: string, renderers: ToolRenderers): ToolRenderers {
	const { renderCall, renderResult } = renderers;
	const guardedCall: ToolCallRenderer | undefined = renderCall
		? (args, theme, context) =>
				guardedRender(toolName, theme, context, () => renderCall(args, theme, context), () => "")
		: undefined;
	const guardedResult: ToolResultRenderer | undefined = renderResult
		? (result, options, theme, context) =>
				guardedRender(
					toolName,
					theme,
					context,
					() => renderResult(result, options, theme, context),
					() => safeResultText(result),
				)
		: undefined;
	return { ...renderers, renderCall: guardedCall, renderResult: guardedResult };
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		sessionCwd = ctx.cwd || process.cwd();
		loadFileConfig(sessionCwd);
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		installMouseWatcher(ctx);
		if (!fullscreenMouse && !fullscreenHintShown) {
			fullscreenHintShown = true;
			try {
				ctx.ui.notify(
					"tessera: mouse hover and click-to-expand need fullscreen mode — run /tessera fullscreen on, then restart Pi",
					"info",
				);
			} catch {
				// No notifications available.
			}
		}
	});

	pi.on("session_shutdown", async () => {
		fullscreenHintShown = false;
		removeMouseWatcher();
	});

	pi.registerToolRenderer((toolName, next) => {
		if (toolName === "edit") {
			return withRenderGuards(toolName, {
				renderShell: "self",
				renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) => {
					const pad = context.outputPad ?? 1;
					const state = viewState(context) as ViewState & PreviewState;
					if (!context.isPartial || state.hasResult) return new Container();
					setBodyToggle(state, false);

					const editInput = extractEditInput(args);
					if (!context.argsComplete || !editInput) {
						const partial = (args ?? {}) as { path?: unknown; file_path?: unknown };
						const rawPath =
							typeof partial.path === "string"
								? partial.path
								: typeof partial.file_path === "string"
									? partial.file_path
									: undefined;
						const out = makeStaticBox(theme, pad);
						out.addChild(editHeader(rawPath, theme, undefined, undefined, context.cwd));
						out.addChild(new Text(theme.fg("dim", "…"), 0, 0));
						return passiveMouseWrap(out);
					}

					const key = JSON.stringify({ path: editInput.path, edits: editInput.edits });
					if (state.key !== key) {
						state.key = key;
						state.preview = undefined;
						state.previewError = undefined;
						state.pending = false;
					}
					if (!state.preview && !state.pending) {
						state.pending = true;
						void computePreview(editInput.path, editInput.edits, context.cwd).then((preview) => {
							if (state.key !== key) return;
							state.pending = false;
							if (preview.error || preview.hunks.length === 0) {
								state.previewError = preview.error;
								state.preview = null;
							} else {
								state.preview = preview;
								state.previewError = undefined;
							}
							context.invalidate();
						});
					}

					const out = makeStaticBox(theme, pad);
					if (state.preview) {
						out.addChild(editHeader(editInput.path, theme, state.preview, true, context.cwd));
						out.addChild(
							new TesseraDiff(
								state.preview.hunks,
								theme,
								{ filePath: editInput.path, skin: skinFor(theme, false) },
								getConfig(),
							),
						);
					} else {
						out.addChild(editHeader(editInput.path, theme, undefined, true, context.cwd));
						if (state.previewError) {
							out.addChild(new Text(theme.fg("warning", firstLine(state.previewError)), 0, 0));
						} else {
							out.addChild(new Text(theme.fg("dim", "computing diff…"), 0, 0));
						}
					}
					return passiveMouseWrap(out);
				},
				renderResult: (
					result: unknown,
					_options: ToolRenderResultOptions,
					theme: Theme,
					context: ToolRenderContext,
				) => {
					const pad = context.outputPad ?? 1;
					const res = result as { content?: Array<{ type?: string; text?: string }>; details?: unknown };
					const args = (context.args ?? {}) as { path?: string; file_path?: string };
					const filePath = args.path ?? args.file_path;
					const rs = viewState(context);
					setBodyToggle(rs, false);
					if (!rs.hasResult) {
						rs.hasResult = true;
						if (context.isPartial) {
							queueMicrotask(() => {
								try {
									context.invalidate();
								} catch {
									// Stale render context; harmless.
								}
							});
						}
					}
					const text = textOf(res);
					if (context.isError) {
						const out = makeStaticBox(theme, pad);
						out.addChild(editHeader(filePath, theme, undefined, undefined, context.cwd));
						out.addChild(new Text(theme.style(firstLine(text) || "Edit failed", { fg: "error", bold: true }), 0, 0));
						return passiveMouseWrap(out);
					}
					const preview = previewFromDetails(res.details);
					if (!preview || preview.hunks.length === 0) {
						const out = makeStaticBox(theme, pad);
						out.addChild(editHeader(filePath, theme, undefined, undefined, context.cwd));
						out.addChild(new Text(theme.style("✓ Applied", { fg: "success", bold: true }), 0, 0));
						return passiveMouseWrap(out);
					}
					const out = makeStaticBox(theme, pad);
					out.addChild(editHeader(filePath, theme, preview, undefined, context.cwd));
					out.addChild(
						new TesseraDiff(
							preview.hunks,
							theme,
							{ filePath, skin: skinFor(theme, false) },
							getConfig(),
						),
					);
					return passiveMouseWrap(out);
				},
			});
		}

		if (toolName === "write") {
			return withRenderGuards(toolName, {
				renderShell: "self",
				renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) => {
					const pad = context.outputPad ?? 1;
					const wst = viewState(context);
					if (!context.isPartial || wst.hasResult) return new Container();
					setBodyToggle(wst, false);
					const a = (args ?? {}) as { path?: string; file_path?: string; content?: string };
					const filePath = a.path ?? a.file_path;
					const content = typeof a.content === "string" ? a.content : "";
					const lines = countContentLines(content);
					const out = makeStaticBox(theme, pad);
					out.addChild(writeHeader(filePath, theme, context.argsComplete ? lines : undefined, context.cwd));
					if (!context.argsComplete) {
						out.addChild(new Text(theme.fg("dim", "…"), 0, 0));
						return passiveMouseWrap(out);
					}
					const cfg = getConfig();
					const capCfg = { ...cfg, maxExpandedLines: Math.min(WRITE_COLLAPSED_CAP, cfg.maxExpandedLines) };
					out.addChild(
						new TesseraDiff(syntheticHunk(content), theme, { filePath, skin: skinFor(theme, false) }, capCfg),
					);
					return passiveMouseWrap(out);
				},
				renderResult: (
					result: unknown,
					options: ToolRenderResultOptions,
					theme: Theme,
					context: ToolRenderContext,
				) => {
					const pad = context.outputPad ?? 1;
					const res = result as { content?: Array<{ type?: string; text?: string }> };
					const args = (context.args ?? {}) as { path?: string; file_path?: string; content?: string };
					const filePath = args.path ?? args.file_path;
					const rs = viewState(context);
					if (!rs.hasResult) {
						rs.hasResult = true;
						if (context.isPartial) {
							queueMicrotask(() => {
								try {
									context.invalidate();
								} catch {
									// Stale render context; harmless.
								}
							});
						}
					}
					const text = textOf(res);
					if (context.isError) {
						setBodyToggle(rs, false);
						const out = makeStaticBox(theme, pad);
						out.addChild(writeHeader(filePath, theme, undefined, context.cwd));
						out.addChild(new Text(theme.style(firstLine(text) || "Write failed", { fg: "error", bold: true }), 0, 0));
						return passiveMouseWrap(out);
					}
					const lines = typeof args.content === "string" ? countContentLines(args.content) : 0;
					const cfg = getConfig();
					const canToggle = lines > WRITE_COLLAPSED_CAP && cfg.maxExpandedLines > WRITE_COLLAPSED_CAP && !cfg.alwaysShowFullDiff;
					setBodyToggle(rs, canToggle);
					const expanded = options.expanded || cfg.alwaysShowFullDiff;
					const effectiveCap = expanded ? cfg.maxExpandedLines : Math.min(WRITE_COLLAPSED_CAP, cfg.maxExpandedLines);
					const out = canToggle ? makeBox(theme, pad, context) : makeStaticBox(theme, pad);
					out.addChild(writeHeader(filePath, theme, lines || undefined, context.cwd, canToggle ? context : undefined));
					if (typeof args.content === "string" && args.content !== "") {
						out.addChild(
							new TesseraDiff(
								syntheticHunk(args.content),
								theme,
								{
									filePath,
									skin: () => skinFor(theme, canToggle && rs.hover === true),
									truncationHint: truncatedHint(canToggle, context, theme),
								},
								{ ...cfg, maxExpandedLines: effectiveCap },
							),
						);
					} else {
						out.addChild(new Text(theme.style(`✓ Created · ${lines} lines`, { fg: "success", bold: true }), 0, 0));
					}
					return canToggle ? mouseWrap(out, context) : passiveMouseWrap(out);
				},
			});
		}

		const spec = SECTION_SPECS[toolName];
		if (spec) {
			return withRenderGuards(toolName, {
				renderShell: "self",
				renderCall: (args: unknown, theme: Theme, context: ToolRenderContext) =>
					sectionCallRender(toolName, args, theme, context),
				renderResult: (
					result: unknown,
					options: ToolRenderResultOptions,
					theme: Theme,
					context: ToolRenderContext,
				) => sectionResultRender(toolName, result, options, theme, context),
			});
		}

		return next();
	});

	const commandHandler = async (rawArgs: string, ctx: ExtensionCommandContext) => {
		const cwd = ctx.cwd || sessionCwd;
		const parts = rawArgs.trim().split(/\s+/).filter(Boolean);
		const sub = (parts[0] ?? "status").toLowerCase();
		if (sub === "full" && parts[1]) {
			const v = parts[1].toLowerCase();
			if (v === "on" || v === "true" || v === "1") runtimeOverrides.alwaysShowFullDiff = true;
			else if (v === "off" || v === "false" || v === "0") runtimeOverrides.alwaysShowFullDiff = false;
			else {
				ctx.ui.notify(`Usage: /tessera full on|off`, "error");
				return;
			}
		} else if (sub === "split" && parts[1]) {
			const n = Number(parts[1]);
			if (!Number.isFinite(n)) {
				ctx.ui.notify(`Usage: /tessera split <columns>`, "error");
				return;
			}
			runtimeOverrides.splitThreshold = clampInt(n, DEFAULT_CONFIG.splitThreshold, 60, 300);
		} else if (sub === "lines" && parts[1]) {
			const n = Number(parts[1]);
			if (!Number.isFinite(n)) {
				ctx.ui.notify(`Usage: /tessera lines <count>`, "error");
				return;
			}
			runtimeOverrides.maxCollapsedLines = clampInt(n, DEFAULT_CONFIG.maxCollapsedLines, 3, 40);
		} else if (sub === "scroll") {
			const raw = (parts[1] ?? "auto").toLowerCase();
			if (raw === "auto") {
				const ok = writePiSetting(cwd, (sm) => sm.setFullscreenWheelScrollLines("auto"));
				ctx.ui.notify(
					ok
						? "tessera: wheel scrolling back to auto — restart Pi to apply"
						: "tessera: could not change wheel scrolling on this Pi version",
					ok ? "info" : "error",
				);
				return;
			}
			const n = Number(raw);
			if (!Number.isFinite(n)) {
				ctx.ui.notify("Usage: /tessera scroll <lines 1-100 | auto>", "error");
				return;
			}
			const lines = clampInt(n, DEFAULT_WHEEL_LINES, 1, 100);
			const ok = writePiSetting(cwd, (sm) => sm.setFullscreenWheelScrollLines(lines));
			ctx.ui.notify(
				ok
					? `tessera: wheel scrolling = ${lines} lines — restart Pi to apply`
					: "tessera: could not change wheel scrolling on this Pi version",
				ok ? "info" : "error",
			);
			return;
		} else if (sub === "mouse") {
			ctx.ui.notify(`tessera mouse · ${mouseStatusLines().join(" · ")}`, "info");
			return;
		} else if (sub === "fullscreen") {
			const v = (parts[1] ?? "on").toLowerCase();
			const on = !(v === "off" || v === "false" || v === "0");
			const ok = writePiSetting(cwd, (sm) => sm.setTuiMode(on ? "fullscreen" : "regular"));
			if (ok) refreshFullscreenFlag(cwd);
			ctx.ui.notify(
				ok
					? `tessera: tuiMode = ${on ? "fullscreen" : "regular"} — restart Pi to apply`
					: "tessera: could not change tuiMode on this Pi version",
				ok ? "info" : "error",
			);
			return;
		} else if (sub !== "status") {
			ctx.ui.notify(
				`Usage: /tessera [status|full on|off|split N|lines N|mouse|fullscreen on|off|scroll N|auto]`,
				"error",
			);
			return;
		}
		const cfg = getConfig();
		const mouse = mouseStatusLines().join(" · ");
		ctx.ui.notify(
			`tessera v${extensionVersion()}: split≥${cfg.splitThreshold} cols · collapsed ${cfg.maxCollapsedLines} lines · full ${cfg.alwaysShowFullDiff ? "on" : "off"} · context ${cfg.contextLines} · cap ${cfg.maxExpandedLines} · ${mouse}`,
			"info",
		);
	};

	pi.registerCommand("tessera", {
		description: "Tessera tool-panel styling: status, full, split, lines, mouse, fullscreen, scroll",
		getArgumentCompletions: (prefix: string) => {
			const options = ["status", "full on", "full off", "split", "lines", "mouse", "fullscreen on", "fullscreen off", "scroll auto"];
			const matches = options.filter((o) => o.startsWith(prefix.trim().toLowerCase()));
			return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
		},
		handler: commandHandler,
	});
}
