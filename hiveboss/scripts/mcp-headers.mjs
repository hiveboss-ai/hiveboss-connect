#!/usr/bin/env node
// one-hiveboss-sign-in-per-computer REQ-OSC2: the plugin's headersHelper for its HiveBoss server.
//
// Claude Code runs this when it connects to HiveBoss and again after a 401. It asks the HiveBoss CLI on this computer
// (`hiveboss mcp-headers`) for a short-lived Authorization header made from the computer's one sign-in, and prints
// it as JSON. Without the CLI, or with a CLI too old to know the command, it prints {} and Claude Code uses the
// plugin's own OAuth sign-in exactly as before (REQ-OSC8). When the person must act, the CLI's one line goes to
// stderr and this exits 1. It never prints a token anywhere but stdout, and never opens a browser.
//
// Headless Bee keys: with HIVEBOSS_BEE_KEY (the key) or HIVEBOSS_BEE_KEY_FILE (a file only you can read that holds it)
// set, it prints that key's header instead, so `claude -p` from cron works as the Bee. A key that is set but not usable
// is one line on stderr and exit 1: the run never falls back to your own sign-in.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function cliFileOf(env = process.env) {
	return join(env.HIVEBOSS_CLI_HOME || join(homedir(), ".hiveboss", "cli"), "hiveboss.mjs");
}

export const BEE_KEY_PATTERN = /^hbbk_v1_[A-Za-z0-9_-]{43}$/;

/**
 * Headless Bee keys: the Bee key's header from HIVEBOSS_BEE_KEY or HIVEBOSS_BEE_KEY_FILE, `{ err }` when one is set but
 * cannot be used, or null when neither is set. The key is never in an error line.
 */
export function beeKeyAnswer(env = process.env, fs = { readFileSync, statSync }, platform = process.platform) {
	const direct = (env.HIVEBOSS_BEE_KEY ?? "").trim();
	const file = (env.HIVEBOSS_BEE_KEY_FILE ?? "").trim();
	if (!direct && !file) return null;
	let key = direct;
	if (!key) {
		const path = file.startsWith("~/") ? join(homedir(), file.slice(2)) : file;
		try {
			// Like ssh with a private key: a file others can read is refused.
			if (platform !== "win32" && (fs.statSync(path).mode & 0o077) !== 0) return { err: `HIVEBOSS_BEE_KEY_FILE can be read by others. Run: chmod 600 ${path}`, code: 1 };
			key = String(fs.readFileSync(path, "utf8")).trim();
		} catch {
			return { err: "HIVEBOSS_BEE_KEY_FILE can't be read.", code: 1 };
		}
	}
	if (!BEE_KEY_PATTERN.test(key)) return { err: "That is not a HiveBoss Bee key (it starts with hbbk_v1_).", code: 1 };
	return { out: `${JSON.stringify({ Authorization: `Bearer ${key}` })}\n`, code: 0 };
}

/** Connect review 2026-11-09: said when the CLI itself failed (Node also exits 1 for an error nobody caught). */
export const CLI_FAILED_LINE = "The HiveBoss program on this computer stopped with an error. Run: hiveboss update";

/** True when stderr is a Node error report (a source line, a stack), not the CLI's one line for the person. */
export function isCrash(stderr) {
	const text = String(stderr ?? "");
	return /^\s+at .+\(?.+:\d+:\d+\)?$/m.test(text) || /^(file:\/\/|node:)\S*:\d+/m.test(text) || /^\w*Error: /m.test(text);
}

/** What to print and the exit code, from the CLI's answer (pure, for tests). */
export function answerOf(result) {
	if (!result || result.error || result.status === null) return { out: "{}\n", code: 0 };
	// A crash is never shown as its first stderr line (that was `file:///…/hiveboss.mjs:5712` on a real computer).
	if (result.status === 1 && isCrash(result.stderr)) return { err: CLI_FAILED_LINE, code: 1 };
	if (result.status === 1) return { err: String(result.stderr ?? "").trim().split("\n")[0] || "HiveBoss did not answer.", code: 1 };
	if (result.status !== 0) return { out: "{}\n", code: 0 };
	try {
		const headers = JSON.parse(String(result.stdout ?? "").trim());
		if (headers && typeof headers === "object" && !Array.isArray(headers) && Object.values(headers).every((v) => typeof v === "string")) return { out: `${JSON.stringify(headers)}\n`, code: 0 };
	} catch {}
	return { out: "{}\n", code: 0 };
}

export function run(env = process.env, spawn = spawnSync, exists = existsSync) {
	const bee = beeKeyAnswer(env);
	if (bee) return bee;
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
