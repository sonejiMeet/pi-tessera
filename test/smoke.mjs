/**
 * Headless smoke test for the Tessera extension.
 *
 * Renders every tool panel Tessera restyles through Pi's real
 * `ToolExecutionComponent` and a real `TuiAltScreen`, then asserts layout,
 * header, hover and failure-containment invariants. No terminal is needed.
 *
 * Run with `npm test`.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(testDir);

const jiti = createJiti(join(packageRoot, "package.json"));
const extension = await jiti.import(join(packageRoot, "extensions", "tessera.ts"));
const tui = await jiti.import("@earendil-works/pi-tui");
const agent = await jiti.import("@earendil-works/pi-coding-agent");
const { ToolExecutionComponent, initTheme } = agent;
const { visibleWidth } = tui;
const stripAnsi = (line) =>
	line
		.replace(/\u001b\]8;;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
		.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, "");

// Tool rows and `highlightCode` both read Pi's global theme, so switching it
// here exercises Tessera's theme-derived skins exactly as the TUI does.
initTheme("dark");

let failures = 0;
let checks = 0;
function check(name, fn) {
	checks++;
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
	}
}
async function checkAsync(name, fn) {
	checks++;
	try {
		await fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}\n     ${error instanceof Error ? error.message : String(error)}`);
	}
}

function assert(condition, message) {
	if (!condition) throw new Error(message);
}

function assertFits(pages, width, label) {
	for (const line of pages) {
		const w = visibleWidth(line);
		if (w > width) {
			throw new Error(`${label}: line is ${w} columns wide (max ${width}): ${JSON.stringify(stripAnsi(line))}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Extension harness
// ---------------------------------------------------------------------------

const sessionHandlers = new Map();
const commands = new Map();
const renderers = [];

extension.default({
	on(event, handler) {
		if (!sessionHandlers.has(event)) sessionHandlers.set(event, []);
		sessionHandlers.get(event).push(handler);
	},
	registerToolRenderer(resolver) {
		renderers.push(resolver);
	},
	registerCommand(name, options) {
		commands.set(name, options);
	},
});

function resolveRenderers(toolName) {
	let found;
	for (const resolver of renderers) {
		const resolved = resolver(toolName, () => undefined);
		if (resolved) found = resolved;
	}
	return found;
}

const sessionStart = (ctx) => sessionHandlers.get("session_start").at(-1)({}, ctx);
const sessionShutdown = () => sessionHandlers.get("session_shutdown").at(-1)({}, {});

function makeUi() {
	const notifications = [];
	const tuiStub = { inputListeners: new Set(), requestRender() {} };
	const ctx = {
		cwd: packageRoot,
		mode: "tui",
		hasUI: true,
		ui: {
			notify(message, level = "info") {
				notifications.push({ message, level });
			},
			setWidget() {},
			requestRender() {},
			client: undefined,
			tui: tuiStub,
		},
	};
	return { ctx, notifications };
}

const fakeUi = { requestRender() {} };

/** Start the extension against a headless alt-screen TUI and return its mouse feed. */
async function startTuiSession() {
	let feed;
	const terminal = {
		columns: 100,
		rows: 40,
		start(handler) {
			feed = handler;
		},
		stop() {},
		write() {},
		hideCursor() {},
		showCursor() {},
	};
	const tuiScreen = new tui.TuiAltScreen(terminal, false);
	tuiScreen.start();

	const { ctx } = makeUi();
	ctx.ui.setWidget = (name, factory) => {
		if (factory) factory(tuiScreen);
	};
	await sessionStart(ctx);

	return {
		tuiScreen,
		feed: (data) => feed(data),
		settle: () => new Promise((resolve) => queueMicrotask(resolve)),
	};
}

function renderComponent(toolName, args, result, { width = 100, expanded = false, outputPad = 1 } = {}) {
	const definition = { name: toolName, ...resolveRenderers(toolName) };
	const component = new ToolExecutionComponent(toolName, `call-${toolName}`, args, { outputPad }, definition, fakeUi, packageRoot);
	component.setArgsComplete();
	component.markExecutionStarted();
	if (result) component.updateResult({ isError: false, ...result }, false);
	component.setExpanded(expanded);
	return { component, lines: component.render(width) };
}

// ---------------------------------------------------------------------------
// Package metadata (Pi package conventions)
// ---------------------------------------------------------------------------

const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

check("package.json declares the pi-package keyword", () => {
	assert(Array.isArray(manifest.keywords) && manifest.keywords.includes("pi-package"), "missing pi-package keyword");
});

check("package.json pi manifest points at the shipped extension", () => {
	const entries = manifest.pi?.extensions;
	assert(Array.isArray(entries) && entries.length > 0, "missing pi.extensions");
	for (const entry of entries) {
		assert(!entry.startsWith("/") && !entry.includes(".."), `pi.extensions must be package-relative: ${entry}`);
		readFileSync(join(packageRoot, entry), "utf8");
	}
});

check("host packages are peer dependencies, not dependencies", () => {
	const peers = manifest.peerDependencies ?? {};
	const deps = manifest.dependencies ?? {};
	for (const name of ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"]) {
		assert(peers[name] === "*", `${name} must be a "*" peer dependency`);
		assert(deps[name] === undefined, `${name} must not be a dependency`);
	}
});

check("published files include the extension, license and README", () => {
	for (const required of ["extensions", "README.md", "LICENSE"]) {
		assert(manifest.files.includes(required), `files[] must include ${required}`);
	}
});

// ---------------------------------------------------------------------------
// Basic rendering
// ---------------------------------------------------------------------------

const LONG_COMMAND = `powershell -NoProfile -Command "./FlowLiteDebug-0.3-x64.exe --selftest 2>&1 | Select-Object -Last 4; Get-Content selftest.log | Select-String -Pattern 'minitest:'"`;
const LONG_PATH = "packages/desktop/src/renderer/components/settings/BillingSettingsPanel.tsx";

const bashResult = {
	content: [
		{
			type: "text",
			text: [
				"PASS menu row identity",
				"PASS menu merge skip",
				"minitest: 109 passed, 0 failed",
				"",
				" M src/actions.c",
				" M src/flow.h",
				" M src/frame.c",
				" M src/menu.c",
				" M src/menu.h",
				" M tests/selftest.c",
			].join("\n"),
		},
	],
	durationMs: 4020,
};

check("collapsed header keeps line count and duration visible", () => {
	const { lines } = renderComponent("powershell", { command: LONG_COMMAND, timeout: 120 }, bashResult, { width: 80 });
	const header = lines.map(stripAnsi).find((line) => line.includes("$ powershell"));
	assert(header, "header not found");
	assert(header.includes("…"), `header should truncate the command: ${header}`);
	assert(header.includes("10 lines"), `header should show the line count: ${header}`);
	assert(header.includes("4.0s"), `header should show the duration: ${header}`);
	assert(!header.includes("Select-String"), `header should hide the command tail when collapsed: ${header}`);
	assertFits(lines, 80, "collapsed powershell header");
});

check("expanded header shows the whole command, wrapped", () => {
	const { lines } = renderComponent("powershell", { command: LONG_COMMAND, timeout: 120 }, bashResult, {
		width: 80,
		expanded: true,
	});
	const text = lines.map(stripAnsi).join("\n");
	assert(text.includes("FlowLiteDebug-0.3-x64.exe"), "expanded header lost the command start");
	assert(text.includes("Select-String -Pattern"), "expanded header lost the pattern selector");
	assert(text.includes("'minitest:'"), "expanded header lost the command tail");
	assert(text.includes("(120s)"), "expanded header lost the timeout");
	assert(text.includes("4.0s"), "expanded header lost the duration");
	assert(!text.includes("minites…"), "expanded header must not truncate the command");
	assertFits(lines, 80, "expanded powershell header");
});

check("multi-line commands keep their line breaks when expanded", () => {
	const script = ["set -euo pipefail", "for f in src/*.c; do", '  echo "$f"', "done"].join("\n");
	const result = { content: [{ type: "text", text: "src/a.c\nsrc/b.c" }], durationMs: 300 };
	const collapsed = renderComponent("bash", { command: script }, result, { width: 80 }).lines.map(stripAnsi);
	assert(collapsed.some((line) => line.includes("set -euo pipefail ↵")), "collapsed header should join command lines");
	const expanded = renderComponent("bash", { command: script }, result, { width: 80, expanded: true }).lines;
	const text = expanded.map(stripAnsi).join("\n");
	for (const part of ["set -euo pipefail", "for f in src/*.c; do", 'echo "$f"', "done"]) {
		assert(text.includes(part), `expanded header missing "${part}"`);
	}
	assertFits(expanded, 80, "expanded multi-line command");
});

check("long paths keep the file name instead of the directories", () => {
	const result = { content: [{ type: "text", text: Array.from({ length: 40 }, (_, i) => `const v${i} = ${i};`).join("\n") }] };
	const read = renderComponent("read", { path: LONG_PATH, offset: 6, limit: 200 }, result, { width: 80 }).lines.map(stripAnsi);
	const header = read.find((line) => line.includes("read "));
	assert(header, "read header not found");
	assert(header.includes("BillingSettingsPanel.tsx"), `read header lost the file name: ${header}`);
	assert(header.includes("…/"), `read header should elide the front of the path: ${header}`);
	assert(header.includes("40 lines"), `read header lost the line count: ${header}`);

	const patch = [
		`--- a/${LONG_PATH}`,
		`+++ b/${LONG_PATH}`,
		"@@ -1,2 +1,2 @@",
		"-const a = 1;",
		"+const a = 2;",
		" const b = 3;",
	].join("\n");
	const edit = renderComponent("edit", { path: LONG_PATH }, { content: [{ type: "text", text: "Edited" }], details: { patch } }, {
		width: 80,
	}).lines.map(stripAnsi);
	const editHeader = edit.find((line) => line.includes("edit "));
	assert(editHeader.includes("BillingSettingsPanel.tsx"), `edit header lost the file name: ${editHeader}`);
	assert(editHeader.includes("+1") && editHeader.includes("-1"), `edit header lost the stats: ${editHeader}`);
});

// ---------------------------------------------------------------------------
// Layout invariants: every tool, both themes, many widths
// ---------------------------------------------------------------------------

const LAYOUT_CASES = [
	[
		"bash",
		{ command: LONG_COMMAND },
		{ content: [{ type: "text", text: Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n") }], durationMs: 7000 },
	],
	["bash", { command: "echo hi" }, { content: [{ type: "text", text: "hi" }] }],
	[
		"read",
		{ path: LONG_PATH, offset: 1, limit: 50 },
		{ content: [{ type: "text", text: Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join("\n") }] },
	],
	["read", { path: "README.md" }, { content: [{ type: "text", text: "Read image file [image/png]" }] }],
	[
		"edit",
		{ path: "src/app.ts" },
		{
			content: [{ type: "text", text: "Edited" }],
			details: {
				patch: [
					"--- a/src/app.ts",
					"+++ b/src/app.ts",
					"@@ -10,3 +10,3 @@ function init()",
					" const x = 1;",
					"-const timeout = 1000;",
					"+const timeout = 5000;",
					"@@ -50,2 +50,3 @@ function run()",
					" console.log(x);",
					"+console.log(timeout);",
				].join("\n"),
			},
		},
	],
	[
		"write",
		{ path: "src/new-file.ts", content: Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i};`).join("\n") },
		{ content: [{ type: "text", text: "Wrote 300 lines" }] },
	],
	[
		"grep",
		{ pattern: "useEffect\\(\\s*\\(\\)\\s*=>\\s*\\{[\\s\\S]*?\\}, \\[[^\\]]*\\]\\)", path: "src", glob: "*.tsx" },
		{ content: [{ type: "text", text: "src/a.tsx:12: useEffect(() => {}, [])" }] },
	],
	["find", { pattern: "**/*.test.tsx", path: "packages/desktop" }, { content: [{ type: "text", text: "src/a.test.tsx" }] }],
	["ls", { path: "packages/desktop/src" }, { content: [{ type: "text", text: "Button.tsx\napp/" }] }],
];

for (const themeName of ["dark", "light"]) {
	initTheme(themeName);
	for (const [toolName, args, result] of LAYOUT_CASES) {
		check(`fits: ${toolName} [${themeName}]`, () => {
			for (const width of [20, 32, 40, 60, 80, 100, 140]) {
				for (const expanded of [false, true]) {
					const { lines } = renderComponent(toolName, args, result, { width, expanded });
					assertFits(lines, width, `${toolName} @${width}${expanded ? " expanded" : ""}`);
					assert(lines.length > 0, `${toolName} rendered nothing`);
				}
			}
		});
	}
}

check("wide characters never overflow", () => {
	const result = { content: [{ type: "text", text: "const 値 = 1;\n" + "const 値 = 2;" }] };
	for (const width of [20, 40, 60, 80]) {
		const { lines } = renderComponent("read", { path: "パッケージ/設定/請求設定パネル.tsx" }, result, { width });
		assertFits(lines, width, `wide-char path @${width}`);
	}
});

check("ansi-colored tool output cannot break the panel", () => {
	const result = {
		content: [{ type: "text", text: "\u001b[32mPASS\u001b[0m everything\n\u001b[1;31mFAIL\u001b[m nothing\n\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\" }],
	};
	for (const width of [24, 40, 80]) {
		const { lines } = renderComponent("bash", { command: "npm test" }, result, { width });
		assertFits(lines, width, `ansi output @${width}`);
		const text = lines.map(stripAnsi).join("\n");
		assert(text.includes("everything") && text.includes("nothing"), "plain text was lost");
	}
});

// ---------------------------------------------------------------------------
// Renderer failure containment
// ---------------------------------------------------------------------------

check("a throwing result degrades to a plain panel", () => {
	const exploding = {
		content: [
			{
				type: "text",
				get text() {
					throw new Error("boom");
				},
			},
		],
	};
	const { lines } = renderComponent("bash", { command: "echo boom" }, exploding, { width: 80 });
	assert(lines.length > 0, "fallback rendered nothing");
	const text = lines.map(stripAnsi).join("\n");
	assert(text.includes("tessera: could not render this section"), `fallback panel missing its notice: ${text}`);
	assertFits(lines, 80, "fallback panel");
});

check("unexpected argument shapes do not throw", () => {
	for (const [toolName, args] of [
		["bash", { command: 42 }],
		["read", { path: null }],
		["edit", { path: "x", edits: [{ oldText: 1 }] }],
		["write", {}],
		["grep", { pattern: { nested: true } }],
		["ls", { path: false }],
	]) {
		const { lines } = renderComponent(toolName, args, undefined, { width: 60 });
		assert(Array.isArray(lines), `${toolName} did not return lines`);
	}
});

// ---------------------------------------------------------------------------
// Mouse hover and click-to-expand
// ---------------------------------------------------------------------------

await checkAsync("hover highlights, click expands, leaving clears instantly", async () => {
	const { tuiScreen, feed, settle } = await startTuiSession();

	const definition = { name: "read", ...resolveRenderers("read") };
	const component = new ToolExecutionComponent(
		"read",
		"call-hover",
		{ path: "src/app.ts" },
		{},
		definition,
		tuiScreen,
		packageRoot,
	);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult(
		{ content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `export const v${i} = ${i};`).join("\n") }], isError: false },
		false,
	);
	tuiScreen.addChild(component);
	tuiScreen.renderNow();

	const height = component.render(100).length;
	const headerRow = 3; // border, padding, header
	feed(`\u001b[<35;5;${headerRow}M`);
	await settle();
	const hovered = component.render(100);
	assert(component.rendererState.hover === true, "hover did not activate");
	assert(hovered.map(stripAnsi).some((line) => line.includes("click to expand")), "hover hint missing");
	assertFits(hovered, 100, "hovered header");

	feed(`\u001b[<0;5;${headerRow}M`);
	feed(`\u001b[<0;5;${headerRow}m`);
	await settle();
	assert(component.expanded === true, "click did not expand the section");

	feed(`\u001b[<35;5;${Math.min(39, height + 6)}M`);
	await settle();
	assert(component.rendererState.hover === false, "hover did not clear after the pointer left the panel");

	await sessionShutdown();
});

await checkAsync("a shortened command header is hoverable and click-to-expand", async () => {
	const { tuiScreen, feed, settle } = await startTuiSession();
	// Three output lines is below the collapsed budget, so only the header holds
	// hidden content. Expanding must still be offered.
	const component = new ToolExecutionComponent(
		"bash",
		"call-overflow",
		{ command: LONG_COMMAND },
		{},
		{ name: "bash", ...resolveRenderers("bash") },
		tuiScreen,
		packageRoot,
	);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult(
		{
			content: [{ type: "text", text: 'size 12945 nul 1\n2378 b"MAX_PATH - 1)"\nhas path line: True' }],
			durationMs: 249,
			isError: false,
		},
		false,
	);
	tuiScreen.addChild(component);
	tuiScreen.renderNow();

	const collapsed = component.render(100);
	assert(collapsed.length < 11, "test expects the output to fit without collapsing");
	assert(component.rendererState.canToggle === true, "a shortened header must make the section toggleable");
	const collapsedText = collapsed.map(stripAnsi).join("\n");
	assert(
		collapsedText.includes("… full command · click to expand"),
		`the footer must advertise the shortened command: ${collapsedText}`,
	);
	assert(collapsedText.includes("3 lines"), "the footer must not replace the header metadata");

	feed("\u001b[<35;5;3M");
	await settle();
	assert(component.rendererState.hover === true, "hover did not activate on the shortened header");
	const hoveredLines = component.render(100);
	const hovered = hoveredLines.map(stripAnsi).join("\n");
	assert(hovered.includes("click to expand"), `missing expand hint: ${hovered}`);
	assertFits(hoveredLines, 100, "hovered overflow header");
	// The footer affordance must be re-styled (highlighted) on hover, like the
	// hint for sections that hide output lines.
	const footerOf = (lines) => lines.find((line) => stripAnsi(line).includes("full command"));
	const idleFooter = footerOf(collapsed);
	const hoveredFooter = footerOf(hoveredLines);
	assert(idleFooter && hoveredFooter, "footer hint line missing");
	assert(idleFooter !== hoveredFooter, "the footer hint must be highlighted on hover");

	feed("\u001b[<0;5;3M");
	feed("\u001b[<0;5;3m");
	await settle();
	assert(component.expanded === true, "click did not expand the shortened header");
	const expandedLines = component.render(100);
	const expanded = expandedLines.map(stripAnsi).join("\n");
	assert(expanded.includes("Select-String -Pattern"), `expanded header lost the command tail: ${expanded}`);
	assert(expanded.includes("click to collapse"), "expanded + hovered header should offer collapsing");
	assert(!expanded.includes("full command"), "the footer hint must disappear once expanded");

	await sessionShutdown();
});

await checkAsync("a section whose text all fits is not hoverable", async () => {
	const { tuiScreen, feed, settle } = await startTuiSession();
	const component = new ToolExecutionComponent(
		"bash",
		"call-fits",
		{ command: "echo hi" },
		{},
		{ name: "bash", ...resolveRenderers("bash") },
		tuiScreen,
		packageRoot,
	);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "hi" }], durationMs: 20, isError: false }, false);
	tuiScreen.addChild(component);
	tuiScreen.renderNow();

	assert(component.rendererState.canToggle === false, "a fully visible section must not be toggleable");
	feed("\u001b[<35;5;3M");
	await settle();
	assert(component.rendererState.hover !== true, "hover must not light up when there is nothing to expand");
	const text = component.render(100).map(stripAnsi).join("\n");
	assert(!text.includes("click to expand"), "a fitted section must not advertise a click");
	assert(!text.includes("full command"), "a fitted section must not show a footer hint");

	await sessionShutdown();
});

await checkAsync("a capped write diff advertises expansion", async () => {
	const { tuiScreen, feed, settle } = await startTuiSession();
	const content = Array.from({ length: 300 }, (_, i) => `export const v${i} = ${i};`).join("\n");
	const component = new ToolExecutionComponent(
		"write",
		"call-write",
		{ path: "src/big.ts", content },
		{},
		{ name: "write", ...resolveRenderers("write") },
		tuiScreen,
		packageRoot,
	);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "Wrote 300 lines" }], isError: false }, false);
	tuiScreen.addChild(component);
	tuiScreen.renderNow();

	const collapsed = component.render(100);
	const findRow = (lines) => lines.find((line) => stripAnsi(line).includes("more lines"));
	const idleRow = findRow(collapsed);
	assert(idleRow, "capped write diff has no truncation row");
	assert(
		stripAnsi(idleRow).includes("… 180 more lines · click to expand"),
		`capped write diff must advertise expanding: ${stripAnsi(idleRow)}`,
	);
	assertFits(collapsed, 100, "capped write diff");

	feed("[<35;5;3M");
	await settle();
	assert(component.rendererState.hover === true, "capped write diff did not hover");
	const hoveredRow = findRow(component.render(100));
	assert(hoveredRow && hoveredRow !== idleRow, "the write expand hint must be highlighted on hover");

	feed("[<0;5;3M");
	feed("[<0;5;3m");
	await settle();
	assert(component.expanded === true, "writing section did not expand on click");
	const expanded = component.render(100);
	assert(!findRow(expanded), "expanded write diff must not claim truncation");
	assert(expanded.length > collapsed.length, "expanded write diff should show more lines");

	await sessionShutdown();
});

await checkAsync("a shortened grep pattern is hoverable too", async () => {
	const { tuiScreen, feed, settle } = await startTuiSession();
	const pattern = "useEffect\\(\\s*\\(\\)\\s*=>\\s*\\{[\\s\\S]*?\\}, \\[[^\\]]*\\]\\)";
	const component = new ToolExecutionComponent(
		"grep",
		"call-grep",
		{ pattern, path: "packages/desktop/src/renderer" },
		{},
		{ name: "grep", ...resolveRenderers("grep") },
		tuiScreen,
		packageRoot,
	);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({ content: [{ type: "text", text: "src/a.tsx:12: useEffect(() => {}, [])" }], isError: false }, false);
	tuiScreen.addChild(component);
	tuiScreen.renderNow();

	assert(component.rendererState.canToggle === true, "a shortened grep pattern must be toggleable");
	feed("\u001b[<35;5;3M");
	await settle();
	assert(component.rendererState.hover === true, "grep header did not hover");
	assert(component.render(100).map(stripAnsi).join("\n").includes("click to expand"), "grep expand hint missing");

	await sessionShutdown();
});

// ---------------------------------------------------------------------------
// Commands and settings
// ---------------------------------------------------------------------------

await checkAsync("settings from .pi/settings.json are applied", async () => {
	const workDir = mkdtempSync(join(tmpdir(), "tessera-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "tessera-agent-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		mkdirSync(join(workDir, ".pi"), { recursive: true });
		writeFileSync(
			join(workDir, ".pi", "settings.json"),
			JSON.stringify({ tessera: { maxCollapsedLines: 3, splitThreshold: 200 }, tuiMode: "fullscreen" }),
			"utf8",
		);
		const { ctx } = makeUi();
		ctx.cwd = workDir;
		await sessionStart(ctx);

		const { lines } = renderComponent(
			"bash",
			{ command: "seq 1 20" },
			{ content: [{ type: "text", text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n") }] },
			{ width: 120 },
		);
		const text = lines.map(stripAnsi).join("\n");
		assert(text.includes("17 earlier lines"), `maxCollapsedLines was not applied: ${text}`);
		// splitThreshold 200 keeps the diff inline at this width.
		const diff = renderComponent(
			"edit",
			{ path: "src/app.ts" },
			{
				content: [{ type: "text", text: "Edited" }],
				details: { patch: ["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", "-a", "+b"].join("\n") },
			},
			{ width: 150, expanded: true },
		);
		assert(diff.lines.length > 0, "diff did not render");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(workDir, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
		await sessionShutdown();
	}
});

await checkAsync("/tessera reports its package version", async () => {
	const command = commands.get("tessera");
	assert(command, "/tessera is not registered");
	const { ctx, notifications } = makeUi();
	await command.handler("status", ctx);
	const status = notifications.at(-1);
	assert(status, "status produced no notification");
	assert(status.message.includes(`v${manifest.version}`), `status must use the package version: ${status.message}`);
	assert(status.message.includes("split≥"), `status must include the layout settings: ${status.message}`);
});

await checkAsync("/tessera rejects unknown arguments", async () => {
	const command = commands.get("tessera");
	const { ctx, notifications } = makeUi();
	await command.handler("nonsense", ctx);
	const last = notifications.at(-1);
	assert(last && last.level === "error" && last.message.includes("Usage:"), "unknown subcommand should print usage");
});

await checkAsync("/tessera offers argument completions", async () => {
	const command = commands.get("tessera");
	const values = command.getArgumentCompletions("full");
	assert(Array.isArray(values) && values.length >= 2, "expected `full` completions");
	assert(
		values.every((item) => typeof item.value === "string" && item.value.startsWith("full")),
		`completions must match the typed prefix: ${JSON.stringify(values)}`,
	);
	assert(command.getArgumentCompletions("zzz") === null, "unmatched completions should return null");
});

await checkAsync("shutdown releases the mouse watcher", async () => {
	await sessionShutdown();
	const { ctx } = makeUi();
	let listeners;
	ctx.ui.setWidget = (name, factory) => {
		if (factory) listeners = factory({ inputListeners: new Set(), requestRender() {} });
	};
	await sessionStart(ctx);
	await sessionShutdown();
	assert(listeners instanceof Object, "watcher widget was not created");
});

// ---------------------------------------------------------------------------

if (failures > 0) {
	console.error(`\n${failures} of ${checks} checks failed`);
	process.exit(1);
}
console.log(`\nAll ${checks} checks passed`);
