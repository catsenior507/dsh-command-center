import { createServer } from "node:http";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
//#region src/host/api.ts
/**
* Answer one panel request.
* @param deps - the watchers.
* @param method - HTTP method.
* @param path - request path, without the mount prefix.
* @param body - parsed JSON body, if any.
* @returns the reply.
*/
function handle(deps, method, path, body) {
	const questions = deps.questions.list();
	if (method === "GET" && (path === "/tasks" || path === "/state")) {
		const tasks = deps.watch === null ? [] : deps.watch.rows();
		return {
			status: 200,
			body: {
				ok: true,
				observe: deps.observe,
				needsYou: questions.length,
				questions,
				tasks,
				jobsWatched: deps.watch !== null
			}
		};
	}
	if (method === "GET" && path === "/health") return {
		status: 200,
		body: {
			ok: true,
			observe: deps.observe,
			jobsWatched: deps.watch !== null
		}
	};
	if (method === "POST" && path === "/kill") {
		const id = body !== null && typeof body === "object" ? body.id : void 0;
		if (typeof id !== "string" || id === "") return {
			status: 400,
			body: {
				ok: false,
				error: "id is required"
			}
		};
		return {
			status: 501,
			body: {
				ok: false,
				error: "kill is not wired yet"
			}
		};
	}
	return {
		status: 404,
		body: {
			ok: false,
			error: "not found"
		}
	};
}
//#endregion
//#region src/host/failures.ts
/**
* Read a numeric field without trusting its shape.
* @param value - the candidate.
* @returns the number, or null.
*/
function num(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}
/**
* Read a string field without trusting its shape.
* @param value - the candidate.
* @returns the string, or null.
*/
function str(value) {
	return typeof value === "string" && value !== "" ? value : null;
}
/**
* Count a conversation without keeping any of it.
*
* The conversation is the user's private data; the size is what answers "was
* this request unusually large", and it is safe to store.
* @param messages - the message list, in whatever shape the caller has.
* @returns the counts.
*/
function describe(messages) {
	const list = Array.isArray(messages) ? messages : [];
	let toolCalls = 0;
	let characters = 0;
	for (const m of list) {
		const msg = m;
		const parts = Array.isArray(msg?.content) ? msg.content : [];
		for (const p of parts) {
			const part = p;
			if (part?.type === "tool-call") toolCalls += 1;
			if (typeof part?.text === "string") characters += part.text.length;
		}
		if (typeof msg?.content === "string") characters += msg.content.length;
	}
	return {
		messages: list.length,
		toolCalls,
		characters
	};
}
/**
* Tracks consecutive failures that share a code.
*
* The point is to tell "the network hiccupped" from "this request cannot
* succeed". The first deserves patience; the second deserves to be reported
* early, because repeating an identical request cannot have a different outcome
* and only makes the failure slower.
*/
var FailureStreak = class {
	code = null;
	count = 0;
	/**
	* Record one failure.
	* @param code - the failure code.
	* @returns how many times this code has now failed in a row.
	*/
	note(code) {
		if (code === this.code) this.count += 1;
		else {
			this.code = code;
			this.count = 1;
		}
		return this.count;
	}
	/** Forget the streak; call this after any success. */
	reset() {
		this.code = null;
		this.count = 0;
	}
	/**
	* Whether repeated identical failures make further retries pointless.
	* @param threshold - how many in a row count as deterministic.
	* @returns true when the streak reached the threshold.
	*/
	looksDeterministic(threshold) {
		return this.count >= threshold;
	}
};
//#endregion
//#region src/host/liveness.ts
/** Rolling history of how long comparable work takes. */
var DurationHistory = class {
	byKey = /* @__PURE__ */ new Map();
	limit;
	/**
	* @param limit - how many recent observations to keep per key.
	*
	* Written as a field and an assignment rather than a constructor parameter
	* property: a parameter property is TypeScript that emits code, and the
	* runtime executes these files by stripping types, which cannot express it.
	*/
	constructor(limit = 50) {
		this.limit = limit;
	}
	/** Record one completed run. */
	record(key, durationMs) {
		if (!Number.isFinite(durationMs) || durationMs <= 0) return;
		const rows = this.byKey.get(key) ?? [];
		rows.push(durationMs);
		if (rows.length > this.limit) rows.splice(0, rows.length - this.limit);
		this.byKey.set(key, rows);
	}
	/** Percentile summary, or null below the sample floor. */
	baseline(key, minSamples = 3) {
		if (key === null) return null;
		const rows = this.byKey.get(key);
		if (rows === void 0 || rows.length < minSamples) return null;
		const sorted = [...rows].sort((a, b) => a - b);
		return {
			samples: sorted.length,
			p50: percentile(sorted, .5),
			p90: percentile(sorted, .9)
		};
	}
	/** Every key with enough samples to be useful. */
	keys() {
		return [...this.byKey.keys()];
	}
};
/** Nearest-rank percentile over an already sorted array. */
function percentile(sorted, q) {
	if (sorted.length === 0) return 0;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}
/**
* How long a task may stay silent before silence itself means something.
*
* Scaled to the work: a 2-second task going quiet for 30 seconds is already
* interesting, while a 10-minute build being quiet for 30 seconds is not.
*/
function silenceAllowance(baseline) {
	if (baseline === null) return 2e4;
	return Math.max(2e4, baseline.p50 * .5);
}
/**
* Judge one task.
* @param facts - the live facts about the task.
* @param history - comparable past runs.
* @param now - current instant, injected so the result is testable.
* @returns the assessment the panel renders.
*/
function assess(facts, history, now) {
	const elapsedMs = Math.max(0, now - facts.startedAt);
	const silenceMs = facts.lastOutputAt === null ? null : Math.max(0, now - facts.lastOutputAt);
	const baseline = history.baseline(facts.historyKey);
	if (facts.status !== "running" && facts.status !== "stopping") return {
		verdict: "done",
		elapsedMs,
		silenceMs,
		baseline,
		progress: 1,
		summary: STATUS_WORDS[facts.status] + "，用时 " + human(elapsedMs)
	};
	const allowance = silenceAllowance(baseline);
	const progress = baseline === null ? null : Math.min(.95, elapsedMs / Math.max(1, baseline.p90));
	if (facts.lastOutputAt === null) return {
		verdict: "unknown",
		elapsedMs,
		silenceMs: null,
		baseline,
		progress,
		summary: "运行中，已 " + human(elapsedMs) + "（未采集输出，无法判断是否卡住）"
	};
	const observed = silenceMs !== null;
	if (observed && silenceMs > allowance * 3 && baseline !== null && elapsedMs > baseline.p90 * 2) return {
		verdict: "stalled",
		elapsedMs,
		silenceMs,
		baseline,
		progress,
		summary: "已 " + human(silenceMs) + " 没有任何输出，且已超过同类任务的 " + human(baseline.p90) + "，很可能卡住了"
	};
	if (!observed || silenceMs <= allowance) {
		const overrun = baseline !== null && elapsedMs > baseline.p90;
		return {
			verdict: "live",
			elapsedMs,
			silenceMs,
			baseline,
			progress,
			summary: baseline === null ? "运行中，已 " + human(elapsedMs) + "（没有可比较的历史）" : "运行中，已 " + human(elapsedMs) + "，同类通常 " + human(baseline.p50) + (overrun ? "，已经超过上限 " + human(baseline.p90) + " 但仍在输出" : "")
		};
	}
	if (baseline !== null && elapsedMs > baseline.p90) return {
		verdict: "slow",
		elapsedMs,
		silenceMs,
		baseline,
		progress,
		summary: "比同类任务慢：已 " + human(elapsedMs) + "，同类通常 " + human(baseline.p50) + "（上限 " + human(baseline.p90) + "）"
	};
	return {
		verdict: "quiet",
		elapsedMs,
		silenceMs,
		baseline,
		progress,
		summary: "运行中，但已 " + human(silenceMs) + " 没有输出" + (baseline === null ? "，且没有可比较的历史，无法判断这算不算正常" : "（同类通常 " + human(baseline.p50) + "）")
	};
}
const STATUS_WORDS = {
	completed: "已完成",
	killed: "已停止",
	failed: "已失败",
	stopping: "正在停止",
	running: "运行中"
};
/** Compact duration: 8s, 3m20s, 1h04m. */
function human(ms) {
	const total = Math.max(0, Math.round(ms / 1e3));
	if (total < 60) return total + "s";
	const minutes = Math.floor(total / 60);
	const seconds = total % 60;
	if (minutes < 60) return seconds === 0 ? minutes + "m" : minutes + "m" + String(seconds).padStart(2, "0") + "s";
	return Math.floor(minutes / 60) + "h" + String(minutes % 60).padStart(2, "0") + "m";
}
//#endregion
//#region src/host/questions.ts
/** Records open questions. */
var QuestionWatch = class {
	open = /* @__PURE__ */ new Map();
	/**
	* Record the questions in one request.
	* @param request - the waterfall payload.
	* @param at - when it arrived.
	* @returns the ids recorded, for clearing later.
	*/
	note(request, at) {
		const parsed = parse(request);
		for (const q of parsed) this.open.set(q.id, {
			...q,
			askedAt: at
		});
		return parsed.map((q) => q.id);
	}
	/** Forget questions that have been answered or abandoned. */
	settle(ids) {
		for (const id of ids) this.open.delete(id);
	}
	/** Everything still waiting, oldest first. */
	list() {
		return [...this.open.values()].sort((a, b) => a.askedAt - b.askedAt);
	}
	/** How many are waiting. */
	get count() {
		return this.open.size;
	}
};
/**
* Pull the fields this file needs out of an untyped waterfall payload.
*
* Deliberately tolerant: this observes a protocol owned by another package, and
* an unrecognised extra field must not stop the panel from working. A question
* with no usable id is skipped rather than recorded under a guess.
* @param request - the payload.
* @returns the parsed questions.
*/
function parse(request) {
	if (request === null || typeof request !== "object") return [];
	const rows = request.questions;
	if (!Array.isArray(rows)) return [];
	const out = [];
	for (const row of rows) {
		if (row === null || typeof row !== "object") continue;
		if (typeof row.id !== "string" || row.id === "") continue;
		const options = Array.isArray(row.options) ? row.options.map((o) => o !== null && typeof o === "object" ? o.label : void 0).filter((l) => typeof l === "string") : [];
		out.push({
			id: row.id,
			question: typeof row.question === "string" ? row.question : "",
			...typeof row.header === "string" ? { header: row.header } : {},
			options
		});
	}
	return out;
}
/**
* Wrap the next answerer so open questions are visible while they wait.
*
* The returned function is a drop-in waterfall listener: it records, delegates,
* and clears whatever happens - answered, abandoned, or thrown. Returning the
* downstream promise unchanged is what keeps this from becoming a second
* answerer.
* @param watch - the tracker.
* @param now - clock, injected for tests.
* @returns the listener.
*/
function observeQuestions(watch, now = () => Date.now()) {
	return (request, next) => {
		const ids = watch.note(request, now());
		return Promise.resolve().then(next).finally(() => watch.settle(ids));
	};
}
//#endregion
//#region src/host/registry.ts
/**
* Note activity for every running job by consuming its output delta.
*
* This is the risky half of `read` mode: `JobRegistry.read` returns a consuming
* delta, so if the cursor turns out to be per-job rather than per-caller, this
* takes output away from the agent own `job_output`. It is therefore opt-in, and
* the first thing to do after enabling it is to check that `job_output` still
* returns output while a task runs.
*
* A read that throws is skipped: one unreadable job must not stop the clock that
* measures every other one.
* @param jobs - the job registry.
* @param agents - the agent registry.
* @param watch - the watcher to notify.
* @param now - clock, injected for tests.
* @returns how many jobs reported activity.
*/
function sampleActivity(jobs, agents, watch, now = () => Date.now()) {
	if (typeof jobs.read !== "function") return 0;
	const running = watch.rows().filter((r) => r.status === "running" || r.status === "stopping");
	let seen = 0;
	for (const row of running) {
		const callers = [void 0, ...agents.list()];
		for (const caller of callers) try {
			if (jobs.read(row.id, caller).text !== "") {
				watch.noteActivity(row.id, now());
				seen += 1;
			}
			break;
		} catch {}
	}
	return seen;
}
/**
* Union the jobs visible to every live agent, plus unowned jobs.
*
* Deduplicated by id: the same job can be visible through more than one caller
* when agents are nested, and a job listed twice would appear twice in the
* panel. A caller that throws is skipped rather than failing the whole read,
* because one dead agent must not blind the panel to everyone else.
* @param jobs - the job registry.
* @param agents - the agent registry.
* @returns a registry view the watcher can use.
*/
function unionRegistry(jobs, agents) {
	const newApi = typeof jobs.get === "function";
	return { list() {
		if (newApi) try {
			return jobs.list();
		} catch {
			return [];
		}
		const byId = /* @__PURE__ */ new Map();
		const collect = (caller) => {
			try {
				for (const job of jobs.list(caller)) byId.set(job.id, job);
			} catch {}
		};
		collect();
		for (const agent of agents.list()) collect(agent);
		return [...byId.values()];
	} };
}
//#endregion
//#region src/host/watch.ts
/**
* Watches background jobs and reports how alive each one looks.
*
* The registry is injected as a narrow interface rather than imported, so this
* file has no dependency on the harness and can be tested against a fake.
*
* @module dsh-command-center/host/watch
*/
/**
* Tracks live jobs and judges each one.
*
* It deliberately does NOT read job output. `JobRegistry.read` returns the
* consuming delta since the previous read, so a watcher that polls it may take
* output away from the agent's own `job_output` call. Until that is settled,
* activity arrives through {@link noteActivity} instead, called by whatever
* observes output without consuming it.
*/
var TaskWatch = class {
	registry;
	now;
	history;
	pollMs;
	lastActivity = /* @__PURE__ */ new Map();
	startedAt = /* @__PURE__ */ new Map();
	disposed = null;
	constructor(registry, options = {}) {
		this.registry = registry;
		this.now = options.now ?? (() => Date.now());
		this.history = options.history ?? new DurationHistory();
		this.pollMs = options.pollMs ?? 2e3;
	}
	/** Begin refreshing from the registry. Returns the disposer. */
	start() {
		if (this.disposed !== null) return this.disposed;
		this.reconcile();
		const timer = setInterval(() => {
			try {
				this.reconcile();
			} catch {}
		}, this.pollMs);
		if (typeof timer.unref === "function") timer.unref();
		this.disposed = () => {
			clearInterval(timer);
			this.disposed = null;
		};
		return this.disposed;
	}
	/**
	* Note that a job produced something, without consuming it.
	* @param id - the job id.
	* @param at - when it happened; defaults to now.
	*/
	noteActivity(id, at) {
		this.lastActivity.set(id, at ?? this.now());
	}
	/** Fold finished jobs into the duration history, newest window only. */
	reconcile() {
		const now = this.now();
		for (const job of this.registry.list()) {
			if (!this.startedAt.has(job.id)) this.startedAt.set(job.id, job.startedAt);
			if (job.status === "running" || job.status === "stopping") continue;
			const finished = job.finishedAt ?? now;
			const key = historyKey(job);
			if (!this.recorded.has(job.id)) {
				this.recorded.add(job.id);
				this.history.record(key, finished - job.startedAt);
			}
		}
	}
	recorded = /* @__PURE__ */ new Set();
	/** Judge every visible job. */
	rows() {
		const now = this.now();
		return this.registry.list().map((job) => {
			const lastActivity = this.lastActivity.get(job.id) ?? null;
			return {
				...assess({
					id: job.id,
					label: job.label,
					status: job.status,
					startedAt: job.startedAt,
					lastOutputAt: lastActivity,
					historyKey: historyKey(job)
				}, this.history, now),
				id: job.id,
				kind: job.kind,
				label: job.label,
				status: job.status,
				startedAt: job.startedAt,
				observedSilenceMs: lastActivity === null ? null : now - lastActivity
			};
		});
	}
};
/**
* Key under which a job's duration is remembered.
*
* The program, not the whole command: `pytest tests/a` and `pytest tests/b` are
* the same kind of work, and taking the first two words would file them
* separately because the path differs.
* @param job - the job.
* @returns the history key.
*/
function historyKey(job) {
	const head = job.label.trim().split(/\s+/)[0] ?? "";
	return job.kind + "|" + (head === "" ? job.kind : head);
}
//#endregion
//#region src/index.ts
/**
* dsh-command-center, host half.
*
* Two observers, one panel:
*
*   jobs       - what is running, from the job registry. State only: `read`
*                returns a consuming delta, so polling it might take output
*                away from the agent own `job_output`.
*   questions  - what the agent is waiting on. Observation only, never
*                answering, so the existing conversation UI keeps working.
*
* @module @dsh-external/dsh-client-plugin-command-center
*/
const name = "@dsh-external/dsh-client-plugin-command-center";
/**
* Nothing is injected, so the plugin loads even in a composition with no jobs.
* The registry is picked up through `inject` below when it is not there yet.
*/
const inject = [];
/**
* Reach the conversation through the agent, if the shape allows it.
*
* The declaration says the payload carries an `agent`, not a message list, so
* the messages have to be found through it - and its layout is not declared
* here. Every path is tried defensively and undefined is a valid answer: the
* caller records zeroes and, more usefully, the key names it did see, so the
* next failure says where to look instead of failing silently.
* @param agent - the agent from the payload.
* @returns the message list when one could be found.
*/
function readMessages(agent) {
	const a = agent;
	if (a === null || typeof a !== "object") return void 0;
	const s = a.session;
	if (Array.isArray(s?.messages)) return s.messages;
	if (Array.isArray(s?.history)) return s.history;
	const state = s?.state;
	if (Array.isArray(state?.messages)) return state.messages;
	if (Array.isArray(a.messages)) return a.messages;
}
/**
* List the key names of whatever an object exposes.
*
* Recorded so an unknown shape becomes known after one failure rather than
* after another round of guessing.
* @param value - the object to inspect.
* @returns its own key names, capped.
*/
function keysOf(value) {
	if (value === null || typeof value !== "object") return [];
	return Object.keys(value).slice(0, 24);
}
/**
* Append one failure record as a JSON line.
*
* Append-only on purpose: the interesting pattern is the sequence, and a file
* rewritten per event would lose exactly that.
* @param record - the record to write.
*/
/**
* Where diagnostics are written.
*
* Overridable, because a test that calls apply() would otherwise append to the
* real log - and then the log reads as though the live host had restarted with
* no services at all, which happened and cost a round of confusion: the last
* two lines said `jobs=false agents=false api=4823`, and 4823 is a test port.
* @returns the directory diagnostics belong in.
*/
function dataDir() {
	const override = process.env.DSH_COMMAND_CENTER_DATA;
	if (override !== void 0 && override !== "") return override;
	return join(homedir(), ".dsh", "command-center");
}
function appendFailure(record) {
	try {
		const dir = dataDir();
		mkdirSync(dir, { recursive: true });
		appendFileSync(join(dir, "llm-failures.jsonl"), JSON.stringify(record) + "\n");
	} catch {}
}
const PORT_BASE = 4811;
const PORT_ATTEMPTS = 8;
/**
* Whether the watcher may consume job output to measure silence.
*
* MEASURED, 2026-09-22: it may not. With this flag on, a background task that was
* plainly printing produced an EMPTY `job_output` for the agent - the consuming
* cursor in `JobRegistry.read` belongs to the job, not to the caller, so a second
* reader takes the delta away from the first. The mode was reverted the same day.
*
* The gate name was changed from DSH_COMMAND_CENTER_OBSERVE after the revert did
* not stick: the watchdog re-captures the host environment on every restart, so a
* value written into its snapshot is copied back from the live host and re-armed
* the theft. A new name that nothing sets cannot be resurrected that way.
*
* Do not turn this on again without a way to read output that does not consume it.
*/
const OBSERVE = process.env.DSH_COMMAND_CENTER_READ_OUTPUT === "i-have-verified-this-is-safe" ? "read" : "changed-only";
/**
* Mount the plugin.
* @param ctx - the cordis context.
*/
function apply(ctx, config) {
	const basePort = config?.port ?? PORT_BASE;
	const notes = [];
	const questions = new QuestionWatch();
	ctx.on("user-questions/request", observeQuestions(questions));
	notes.push("questions=observed");
	const streak = new FailureStreak();
	ctx.on("agent/request-error", ((payload, next) => {
		try {
			const p = payload ?? {};
			const code = str(p.failure?.code) ?? "UNKNOWN";
			const count = streak.note(code);
			appendFailure({
				at: Date.now(),
				code,
				message: str(p.failure?.message) ?? "",
				turn: num(p.turn),
				step: num(p.step),
				provider: str(p.provider),
				failure: p.failure ?? null,
				retryPolicy: p.retryPolicy ?? null,
				shape: describe(readMessages(p.agent)),
				agentKeys: keysOf(p.agent),
				sessionKeys: keysOf(p.agent?.session),
				streak: count,
				deterministic: streak.looksDeterministic(2)
			});
		} catch {}
		return next();
	}));
	notes.push("failures=observed");
	let watch = null;
	ctx.inject(["jobs", "agents"], (ready) => {
		const jobs = ready.get("jobs");
		const agents = ready.get("agents");
		if (jobs === void 0 || agents === void 0) {
			notes.push("jobs=" + String(jobs !== void 0) + " agents=" + String(agents !== void 0));
			record(notes);
			return;
		}
		watch = new TaskWatch(unionRegistry(jobs, agents), { history: new DurationHistory() });
		watch.start();
		notes.push("jobs=watched");
		notes.push("observe=" + OBSERVE);
		if (OBSERVE === "read") {
			const timer = setInterval(() => {
				try {
					sampleActivity(jobs, agents, watch);
				} catch {}
			}, 2e3);
			ctx.effect(() => () => {
				clearInterval(timer);
			}, "command-center: activity sampler");
		}
		record(notes);
	});
	record(notes);
	const start = () => {
		const deps = {
			get watch() {
				return watch;
			},
			questions,
			observe: OBSERVE
		};
		const server = createServer((req, res) => {
			const chunks = [];
			req.on("data", (c) => chunks.push(c));
			req.on("end", () => {
				const path = (req.url ?? "/").split("?")[0];
				let body = null;
				if (chunks.length > 0) try {
					body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				} catch {
					body = null;
				}
				const reply = handle(deps, req.method ?? "GET", path, body);
				res.writeHead(reply.status, {
					"content-type": "application/json",
					"access-control-allow-origin": "*"
				});
				res.end(JSON.stringify(reply.body));
			});
		});
		let listening = 0;
		const attempt = (offset) => {
			if (offset >= PORT_ATTEMPTS) {
				notes.push("api=failed");
				record(notes);
				return;
			}
			server.once("error", () => attempt(offset + 1));
			server.listen(basePort + offset, "127.0.0.1", () => {
				listening = basePort + offset;
				notes.push("api=" + String(listening));
				record(notes);
			});
		};
		attempt(0);
		ctx.effect(() => () => {
			if (listening !== 0) server.close();
		}, "command-center: carrier");
	};
	start();
}
/**
* Append one diagnostic line.
*
* The harness logger output is not readable from outside a running host, and an
* earlier plugin in this series failed to register a tool because the only
* evidence was a warning nobody could read. This file is that lesson: it names
* each part and can be read from disk while the host runs.
* @param notes - what happened during apply.
*/
function record(notes) {
	const line = (/* @__PURE__ */ new Date()).toISOString() + " apply: " + notes.join(" ");
	try {
		const dir = dataDir();
		mkdirSync(dir, { recursive: true });
		appendFileSync(dir + "\\startup.log", line + "\n");
	} catch {}
}
//#endregion
export { apply, inject, name };
