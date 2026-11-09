#!/usr/bin/env node
// one-hiveboss-sign-in-per-computer REQ-OSC2: the plugin's headersHelper for its HiveBoss server.
//
// Claude Code runs this when it connects to HiveBoss and again after a 401. It asks the HiveBoss CLI on this computer
// (`hiveboss mcp-headers`) for a short-lived Authorization header made from the computer's one sign-in, and prints
// it as JSON. Without the CLI, or with a CLI too old to know the command, it prints {} and Claude Code uses the
// plugin's own OAuth sign-in exactly as before (REQ-OSC8). When the person must act, the CLI's one line goes to
// stderr and this exits 1. It never prints a token anywhere but stdout, and never opens a browser.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function cliFileOf(env = process.env) {
	return join(env.HIVEBOSS_CLI_HOME || join(homedir(), ".hiveboss", "cli"), "hiveboss.mjs");
}

/** What to print and the exit code, from the CLI's answer (pure, for tests). */
export function answerOf(result) {
	if (!result || result.error || result.status === null) return { out: "{}\n", code: 0 };
	if (result.status === 1) return { err: String(result.stderr ?? "").trim().split("\n")[0] || "HiveBoss did not answer.", code: 1 };
	if (result.status !== 0) return { out: "{}\n", code: 0 };
	try {
		const headers = JSON.parse(String(result.stdout ?? "").trim());
		if (headers && typeof headers === "object" && !Array.isArray(headers) && Object.values(headers).every((v) => typeof v === "string")) return { out: `${JSON.stringify(headers)}\n`, code: 0 };
	} catch {}
	return { out: "{}\n", code: 0 };
}

export function run(env = process.env, spawn = spawnSync, exists = existsSync) {
	const cli = cliFileOf(env);
	if (!exists(cli)) return { out: "{}\n", code: 0 };
	// Claude Code gives a helper 10 seconds; the CLI's own lock wait and one refresh fit in 9.
	return answerOf(spawn(process.execPath, [cli, "mcp-headers", "--tool", "claude-code"], { env, encoding: "utf8", timeout: 9_000, stdio: ["ignore", "pipe", "pipe"] }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const answer = run();
	if (answer.out) process.stdout.write(answer.out);
	if (answer.err) process.stderr.write(`${answer.err}\n`);
	process.exitCode = answer.code;
}
