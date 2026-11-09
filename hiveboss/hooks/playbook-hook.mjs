#!/usr/bin/env node
// HiveBoss Connect plugin: the HiveBoss Playbook's local hooks
// (playbook-canon-parity REQ-PCP3, PCP4, PCP5, PCP8; room access arc PC2).
//
//   playbook-hook.mjs session-start   SessionStart: the floor from the local pack cache, verbatim
//   playbook-hook.mjs prompt          UserPromptSubmit: asks once for a cache refresh when one is owed
//   playbook-hook.mjs deny            PreToolUse (Edit|Write|MultiEdit|NotebookEdit|Bash): deny rules, exit 2
//   playbook-hook.mjs paths           PreToolUse (Edit|Write|MultiEdit): path reminders as additionalContext
//   playbook-hook.mjs capture         PostToolUse (HiveBoss tools): keeps read_playbook {list: "cache"}
//
// Auth and network: none. The plugin's only credential is the MCP connection
// Claude Code holds (decision 2026-10-05-connector-plugin, B13). This script
// never opens a socket and never reads a token: the cache arrives as the
// reply of a read_playbook {list: "cache"} call made over that connection,
// which the capture hook writes to disk and replaces with one line, so the
// model never reads the JSON. The deny and path hooks read only that file:
// 0 network calls per tool call (REQ-PCP4).
//
// Files, under ${CLAUDE_PLUGIN_DATA}/playbook (mode 700):
//   pack-<hive>-<person>.json  the cache (mode 600), one per Hive and person
//   current                    the name of the cache this plugin serves from
//   seen                       a cache was kept here once (this person's Hive has canon parity)
//   refresh                    a reply named a newer Playbook version: refresh on the next prompt
//                              (a pack over 24 hours old is refreshed the same way)
//   sessions/<id>.nocache      SessionStart found no cache; sessions/<id>.asked: refresh asked once
//
// Fails open: an unreadable cache, unparseable input or any error exits 0
// with no decision (deny-guard.py and REQ-HPG4 do the same). With no cache
// (the switch off, a Hive not listed, a Hive without canon parity) every mode
// exits 0 with no output (REQ-PCP19).
//
// The agent layer (agent-homes D1b, REQ-AGH17, REQ-AGH32): an agent's own rules, as approved on
// the server, from ~/.hiveboss/rules/<personaId>.json, which the HiveBoss listener keeps (file tools
// are denied that folder at every level). The run's agent is HIVEBOSS_AGENT_PERSONA (a woken run),
// else the agent whose home holds the session's folder. Rules are never read from the home itself.
// With an agent layer, deny runs the four-layer engine: the pack's deny rules as the org layer, then
// the agent's; with none it is deny-guard's first-match evaluateDeny, unchanged.
//
// evaluateDeny, matchPaths and the four-layer evaluateLayers come from ./playbook-rules.mjs,
// generated from packages/api/modules/playbook/lib/canon/rule-engine.ts (agent-homes REQ-AGH16:
// one rule engine for the server and this hook); the parity harness runs both against canon's hooks.

import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateDeny, evaluateLayers, fieldValue, layerHookDecision, matchPaths, packDenyToLayer } from "./playbook-rules.mjs";

export { evaluateDeny, evaluateLayers, fieldValue, layerHookDecision, matchPaths };

export const CACHE_SCHEMA = 1;
export const RECEIPT_NO_PACK = "floor delivered on first prompt: no local pack yet";
export const ASK_REFRESH =
	'HiveBoss plugin: call the HiveBoss read_playbook tool once with {"list": "cache"} before you answer. Its reply is for the plugin\'s local hooks; you will see one line back. Do not mention this to the person.';
export const SERVER_PREFIX = "mcp__plugin_hiveboss_hiveboss__";
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** A pack older than this is refreshed on the next prompt (so a Hive whose parity was turned off drops its pack within a day). */
export const MAX_AGE_MS = 24 * 3600 * 1000;
/** A pack older than this is dropped unread: stale deny rules never outlive a week. */
export const EXPIRE_MS = 7 * 24 * 3600 * 1000;

// ── output in canon's bytes ─────────────────────────────────────────────────

/** Python's json.dumps for a string (ensure_ascii=True), so hook output matches canon's hooks byte for byte. */
export function pyJsonString(s) {
	let out = '"';
	for (let i = 0; i < s.length; i++) {
		const c = s.charCodeAt(i);
		const ch = s[i];
		if (ch === '"') out += '\\"';
		else if (ch === "\\") out += "\\\\";
		else if (ch === "\n") out += "\\n";
		else if (ch === "\r") out += "\\r";
		else if (ch === "\t") out += "\\t";
		else if (ch === "\b") out += "\\b";
		else if (ch === "\f") out += "\\f";
		else if (c < 0x20 || c > 0x7e) out += `\\u${c.toString(16).padStart(4, "0")}`;
		else out += ch;
	}
	return `${out}"`;
}

/** `print(json.dumps({"hookSpecificOutput": {"hookEventName": e, "additionalContext": text}}))`. */
export function hookContextLine(event, text) {
	return `{"hookSpecificOutput": {"hookEventName": ${pyJsonString(event)}, "additionalContext": ${pyJsonString(text)}}}\n`;
}

// ── the cache ───────────────────────────────────────────────────────────────

/** build-pack.ts's stableStringify: sorted keys, undefined dropped. */
export function stableStringify(value) {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.filter((k) => value[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

/** cache.ts's hash: sha256 over everything but the envelope (schema, ids, generatedAt, hash, and the reply-only floorSentOnFirstPrompt). */
export function cacheHash(payload) {
	const { schema: _s, organizationId: _o, userId: _u, generatedAt: _g, hash: _h, floorSentOnFirstPrompt: _f, ...content } = payload;
	return createHash("sha256").update(stableStringify(content)).digest("hex");
}

/** A cache payload as served by read_playbook {list: "cache"}, or null. */
export function validCache(payload) {
	if (!payload || typeof payload !== "object" || payload.schema !== CACHE_SCHEMA) return null;
	if (typeof payload.hash !== "string" || !SAFE_ID.test(String(payload.organizationId)) || !SAFE_ID.test(String(payload.userId))) return null;
	if (!payload.floor || typeof payload.floor !== "object" || !Array.isArray(payload.deny) || !Array.isArray(payload.paths)) return null;
	if (cacheHash(payload) !== payload.hash) return null;
	return payload;
}

export function dataDir(env = process.env) {
	const base = env.CLAUDE_PLUGIN_DATA;
	return base ? join(base, "playbook") : null;
}

function ensureDir(dir) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
}

/** The cache this plugin serves from, or null (absent, unreadable, altered). Never throws. */
export function readCache(env = process.env) {
	try {
		const dir = dataDir(env);
		if (!dir) return null;
		const name = readFileSync(join(dir, "current"), "utf8").trim();
		if (!/^pack-[A-Za-z0-9._-]+\.json$/.test(name)) return null;
		const file = join(dir, name);
		const raw = readFileSync(file, "utf8");
		const payload = JSON.parse(raw);
		// Deny and path rules are read without re-hashing (the 50 ms budget); the
		// hash was checked when the file was written, and the file is the user's own.
		if (!payload || payload.schema !== CACHE_SCHEMA || !Array.isArray(payload.deny) || !Array.isArray(payload.paths)) return null;
		// A pack nobody refreshed for a week (the Playbook or its parity turned off, the person gone): dropped, and the plugin is pristine again.
		if (!(Date.now() - Date.parse(payload.generatedAt) < EXPIRE_MS)) {
			dropCache(env);
			return null;
		}
		return payload;
	} catch {
		return null;
	}
}

/** Writes the cache: mode 600 from creation, atomically, then points `current` at it. */
export function writeCache(payload, env = process.env) {
	const dir = dataDir(env);
	if (!dir) return null;
	ensureDir(dir);
	const name = `pack-${payload.organizationId}-${payload.userId}.json`;
	const tmp = join(dir, `.${name}.${process.pid}.tmp`);
	const fd = openSync(tmp, "w", 0o600);
	try {
		writeFileSync(fd, JSON.stringify(payload));
	} finally {
		closeSync(fd);
	}
	chmodSync(tmp, 0o600);
	renameSync(tmp, join(dir, name));
	const ptr = join(dir, `.current.${process.pid}.tmp`);
	writeFileSync(ptr, `${name}\n`, { mode: 0o600 });
	renameSync(ptr, join(dir, "current"));
	writeFileSync(join(dir, "seen"), "", { mode: 0o600 });
	rmSync(join(dir, "refresh"), { force: true });
	return join(dir, name);
}

/** The Hive turned the parity off, or the person left it: drop the cache, so every hook is silent again. */
export function dropCache(env = process.env) {
	const dir = dataDir(env);
	if (!dir || !existsSync(dir)) return;
	for (const f of readdirSync(dir)) if (f.startsWith("pack-") || f === "current" || f === "seen" || f === "refresh") rmSync(join(dir, f), { force: true });
}

// ── the agent layer (agent-homes D1b) ───────────────────────────────────────

/** Where the listener keeps each agent's approved rules (never inside an agent's home). */
export function agentRulesDir(env = process.env) {
	return env.HIVEBOSS_RULES_DIR || (env.HOME ? join(env.HOME, ".hiveboss", "rules") : null);
}

function keptRules(file) {
	try {
		const p = JSON.parse(readFileSync(file, "utf8"));
		return p && p.schema === 1 && SAFE_ID.test(String(p.personaId)) && Array.isArray(p.rules) ? p : null;
	} catch {
		return null;
	}
}

/**
 * REQ-AGH17: the kept rules of the agent this run acts as: the woken run's HIVEBOSS_AGENT_PERSONA, else the agent
 * whose home holds `cwd` (the longest). Null with none. Never throws.
 */
export function agentRulesFor(env = process.env, cwd = "") {
	try {
		const dir = agentRulesDir(env);
		const named = env.HIVEBOSS_AGENT_PERSONA;
		if (!dir) return null;
		if (typeof named === "string" && SAFE_ID.test(named)) {
			const p = keptRules(join(dir, `${named}.json`));
			return p && p.personaId === named ? p : null;
		}
		if (typeof cwd !== "string" || !cwd.startsWith("/") || !existsSync(dir)) return null;
		const here = resolve(cwd);
		let best = null;
		for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).slice(0, 200)) {
			const p = keptRules(join(dir, f));
			if (!p || `${p.personaId}.json` !== f || typeof p.home !== "string" || !p.home.startsWith("/")) continue;
			const home = resolve(p.home);
			if ((here === home || here.startsWith(`${home}${sep}`)) && (!best || home.length > resolve(best.home).length)) best = p;
		}
		return best;
	} catch {
		return null;
	}
}

// agent-homes D2c (security review 2026-10-20): what the listener sets only on a woken run. Any of them present means
// this is a woken run, never the owner's interactive session.
export const WAKE_MARKERS = ["HIVEBOSS_WAKE_ID", "HIVEBOSS_WAKE_TOKEN", "HIVEBOSS_WAKE_SENDER", "HIVEBOSS_AGENT_PERSONA"];

/**
 * C1a's env contract, failing closed: the owner's own only for HIVEBOSS_WAKE_ORIGIN "owner", or for no origin at all in
 * a session with no wake marker (an interactive session). A woken run with the origin missing or unknown is someone
 * else's.
 */
export function ownerOrigin(env = process.env) {
	if (env.HIVEBOSS_WAKE_ORIGIN === "owner") return true;
	if (env.HIVEBOSS_WAKE_ORIGIN !== undefined) return false;
	return !WAKE_MARKERS.some((name) => env[name] !== undefined);
}

/** The deny decision over the pack's rules (org layer) and the agent's own (agent layer), on the one engine. */
export function layeredDeny(packDeny, agent, input, env = process.env) {
	const rules = [...packDeny.map((r) => packDenyToLayer(r, "org")), ...agent.rules.filter((r) => r && r.layer === "agent")];
	// agent-homes D2c: fails closed for a woken run whose origin is missing or unknown (ownerOrigin).
	const owner = ownerOrigin(env);
	return layerHookDecision(rules, input, { ownerId: agent.ownerId, ...(owner ? { people: [agent.ownerId] } : {}) });
}

function sessionFile(env, sid, kind) {
	const dir = dataDir(env);
	if (!dir || !SAFE_ID.test(sid)) return null;
	return join(dir, "sessions", `${sid}.${kind}`);
}

function touch(file) {
	if (!file) return;
	mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
	writeFileSync(file, "", { mode: 0o600 });
}

function pruneSessions(env) {
	const dir = dataDir(env);
	if (!dir) return;
	const sessions = join(dir, "sessions");
	if (!existsSync(sessions)) return;
	const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
	for (const f of readdirSync(sessions)) {
		try {
			if (statSync(join(sessions, f)).mtimeMs < cutoff) rmSync(join(sessions, f), { force: true });
		} catch {}
	}
}

// ── MCP tool replies (PostToolUse) ──────────────────────────────────────────

/** The text parts of an MCP tool reply as Claude Code hands it to PostToolUse (content array, {content}, or a string). */
export function replyTexts(response) {
	if (typeof response === "string") return [response];
	const parts = Array.isArray(response) ? response : response && Array.isArray(response.content) ? response.content : [];
	return parts.filter((p) => p && p.type === "text" && typeof p.text === "string").map((p) => p.text);
}

/** The same reply shape with its content replaced by one text part. */
export function replacedReply(response, text) {
	const part = [{ type: "text", text }];
	if (typeof response === "string") return text;
	if (Array.isArray(response)) return part;
	return { ...(response || {}), content: part };
}

/** The highest Hive Playbook version a reply names (`playbook.version`), or null. */
export function replyPlaybookVersion(texts) {
	let best = null;
	for (const t of texts) {
		if (!t.includes('"playbook"')) continue;
		try {
			const v = JSON.parse(t)?.playbook?.version;
			if (typeof v === "number" && (best === null || v > best)) best = v;
		} catch {}
	}
	return best;
}

// ── modes ───────────────────────────────────────────────────────────────────

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function parse(raw) {
	try {
		return { ok: true, value: JSON.parse(raw) };
	} catch {
		return { ok: false, value: null };
	}
}

/** Runs one mode; returns {exitCode, stdout, stderr}. Pure apart from the cache files (tests call it in-process). */
export function run(mode, raw, env = process.env) {
	const out = { exitCode: 0, stdout: "", stderr: "" };
	try {
		const input = parse(raw);
		const data = input.ok && input.value && typeof input.value === "object" ? input.value : {};
		const sid = typeof data.session_id === "string" ? data.session_id : "";
		const dir = dataDir(env);
		const seen = () => Boolean(dir && existsSync(join(dir, "seen")));

		if (mode === "deny") {
			const cache = readCache(env);
			// agent-homes D1b REQ-AGH17: the agent layer holds with or without a pack.
			const agent = input.ok ? agentRulesFor(env, typeof data.cwd === "string" ? data.cwd : process.cwd()) : null;
			if (agent && agent.rules.length > 0) {
				const d = layeredDeny(cache ? cache.deny : [], agent, input.value, env);
				out.exitCode = d.exitCode;
				out.stderr = d.stderr;
				return out;
			}
			if (!cache) {
				if (seen()) out.stderr = "HiveBoss Playbook: no local pack; deny rules not applied (fail open)\n";
				return out;
			}
			if (!input.ok || cache.deny.length === 0) return out; // deny-guard.py: unparseable input is allowed, silently
			const d = evaluateDeny(cache.deny, input.value);
			out.exitCode = d.exitCode;
			out.stderr = d.stderr;
			return out;
		}

		if (mode === "paths") {
			const cache = readCache(env);
			if (!cache || !input.ok || cache.paths.length === 0) return out;
			const hits = matchPaths(cache.paths, input.value);
			if (hits.length > 0) out.stdout = hookContextLine("PreToolUse", hits.map((p) => p.text).join("\n\n"));
			return out;
		}

		if (mode === "session-start") {
			pruneSessions(env);
			const cache = readCache(env);
			if (cache) {
				if (typeof cache.floor?.text === "string" && cache.floor.text.length > 0) out.stdout = hookContextLine("SessionStart", cache.floor.text);
				return out;
			}
			if (seen()) {
				// REQ-PCP3: no local pack; the server's first-prompt delivery (REQ-HPB5) or the refresh below carries the floor.
				touch(sessionFile(env, sid, "nocache"));
				out.stderr = `HiveBoss Playbook: ${RECEIPT_NO_PACK}\n`;
			}
			return out;
		}

		if (mode === "prompt") {
			if (!dir || !seen()) return out;
			const cache = readCache(env);
			const aged = Boolean(cache && !(Date.now() - Date.parse(cache.generatedAt) < MAX_AGE_MS));
			const owed = aged || existsSync(join(dir, "refresh")) || (sessionFile(env, sid, "nocache") && existsSync(sessionFile(env, sid, "nocache")));
			const asked = sessionFile(env, sid, "asked");
			if (!owed || !asked || existsSync(asked)) return out;
			touch(asked);
			out.stdout = `${JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ASK_REFRESH } })}\n`;
			return out;
		}

		if (mode === "capture") {
			if (!input.ok || typeof data.tool_name !== "string" || !data.tool_name.startsWith(SERVER_PREFIX)) return out;
			const texts = replyTexts(data.tool_response);
			const isCacheCall = data.tool_name === `${SERVER_PREFIX}read_playbook` && data.tool_input && data.tool_input.list === "cache";
			if (isCacheCall) {
				// Refused (switch off, Hive not listed, not a member) or not understood (a server without the parity read_playbook): drop the pack.
			if (texts.some((t) => t.startsWith("Refused:") || /invalid|unrecognized|validation/i.test(t.slice(0, 300))) && !texts.some((t) => t.startsWith("{"))) {
					dropCache(env);
					return out;
				}
				let payload = null;
				for (const t of texts) {
					const p = parse(t);
					if (p.ok && validCache(p.value)) payload = p.value;
				}
				if (!payload) return out;
				const hadNone = Boolean(sid && sessionFile(env, sid, "nocache") && existsSync(sessionFile(env, sid, "nocache")));
				writeCache(payload, env);
				const commit = typeof payload.canonCommit === "string" ? `, canon ${payload.canonCommit.slice(0, 12)}` : "";
				let note = `HiveBoss plugin: local Playbook pack kept (${payload.hash.slice(0, 12)}${commit}). Nothing for you to do.`;
				// The session started with no pack and the server held its floor back (it believed this device had one): deliver it here, once.
				const floorText = typeof payload.floor?.text === "string" ? payload.floor.text : "";
				if (hadNone && payload.floorSentOnFirstPrompt === false && floorText) note = `${note}\n\n${floorText}`;
				if (hadNone) rmSync(sessionFile(env, sid, "nocache"), { force: true });
				out.stdout = `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", updatedMCPToolOutput: replacedReply(data.tool_response, note) } })}\n`;
				return out;
			}
			// Any other HiveBoss reply: a newer Hive Playbook version than the cache's means a refresh on the next prompt.
			const cache = readCache(env);
			if (!cache || !dir) return out;
			const v = replyPlaybookVersion(texts);
			if (v !== null && typeof cache.version?.hive === "number" && v > cache.version.hive) writeFileSync(join(dir, "refresh"), "", { mode: 0o600 });
			return out;
		}
		return out;
	} catch {
		return { exitCode: 0, stdout: "", stderr: "" };
	}
}

const isMain = (() => {
	try {
		// Node started with this file (hooks.json runs `node <this file>`), not a test importing it. Compared as real
		// paths, so a symlinked plugin folder or, on Windows, a drive letter in another case still runs the hook.
		if (!process.argv[1]) return false;
		const a = realpathSync(process.argv[1]);
		const b = realpathSync(fileURLToPath(import.meta.url));
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	} catch {
		return false;
	}
})();

if (isMain) {
	const res = run(process.argv[2] || "", readStdin());
	if (res.stdout) process.stdout.write(res.stdout);
	if (res.stderr) process.stderr.write(res.stderr);
	process.exitCode = res.exitCode;
}
