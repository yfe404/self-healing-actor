#!/usr/bin/env node
// Check tracked Markdown for broken relative links and forbidden writing patterns. Exit 1 on any finding.
// Usage: node scripts/check-docs.mjs [--all]
// --all also checks untracked Markdown unless git ignores it.
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const listCommand = process.argv.includes("--all")
	? "git ls-files --cached --others --exclude-standard -z -- '*.md'"
	: "git ls-files -z -- '*.md'";
const files = [...new Set(execSync(listCommand, { cwd: root, encoding: "utf8" })
	.split("\0")
	.filter(Boolean))];

// Wording this repository does not allow in its documents.
const banned = [
	[/\bBeats? [1-5]\b/, "use 'Step N', not 'Beat N'"],
	[/—/, "no em dashes"],
	[/\b(presenter|presentation|audience|runbook|rehears\w*|dry run|on stage|what to say)\b/i, "this is documentation, not a script for a talk"],
	[/\b(seamless(ly)?|leverage[sd]?|robust|cutting[- ]edge|game[- ]chang\w+|delve|unlock(s|ed)?|empower(s|ed)?|supercharge)\b/i, "marketing word"],
	[/\b(it'?s worth noting|in today's|at the end of the day|needless to say)\b/i, "filler phrase"],
	[/\bnot (only|just) [^.]{0,60} but (also )?/i, "'not X but Y' contrast"],
];

let findings = 0;
const report = (file, line, msg) => {
	findings += 1;
	console.log(`${file}:${line}: ${msg}`);
};

for (const file of files) {
	const text = readFileSync(resolve(root, file), "utf8");
	const lines = text.split("\n");
	let inCode = false;
	lines.forEach((line, i) => {
		if (/^\s*```/.test(line)) inCode = !inCode;
		if (inCode) return;
		for (const [re, msg] of banned) if (re.test(line)) report(file, i + 1, `${msg}: ${line.trim().slice(0, 100)}`);
		for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
			const target = m[1];
			if (/^(https?:|mailto:|#)/.test(target)) continue;
			const [path] = target.split("#");
			if (!existsSync(resolve(root, dirname(file), decodeURIComponent(path)))) report(file, i + 1, `broken link: ${target}`);
		}
	});
}

console.log(findings ? `${findings} finding(s) in ${files.length} files` : `ok: ${files.length} Markdown files, no findings`);
process.exit(findings ? 1 : 0);
