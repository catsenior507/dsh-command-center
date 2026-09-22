window.__ModuleLoader__.load({
	id: "@dsh-external/dsh-client-plugin-command-center",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		//#region \0rolldown/runtime.js
		var __create = Object.create;
		var __defProp = Object.defineProperty;
		var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
		var __getOwnPropNames = Object.getOwnPropertyNames;
		var __getProtoOf = Object.getPrototypeOf;
		var __hasOwnProp = Object.prototype.hasOwnProperty;
		var __copyProps = (to, from, except, desc) => {
			if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
				key = keys[i];
				if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
					get: ((k) => from[k]).bind(null, key),
					enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
				});
			}
			return to;
		};
		var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule || !__hasOwnProp.call(mod, "default") ? __defProp(target, "default", {
			value: mod,
			enumerable: true
		}) : target, mod));
		//#endregion
		let react = require("react");
		react = __toESM(react, 1);
		let react_dom_client = require("react-dom/client");
		//#region src/client/styles.ts
		const UI_FONT = "-apple-system, BlinkMacSystemFont, \"Segoe UI\", \"Microsoft YaHei\", sans-serif";
		/** Panel surface. Centred, opaque, with no overlay behind it. */
		const panel = {
			position: "fixed",
			left: "50%",
			top: "50%",
			transform: "translate(-50%, -50%)",
			zIndex: 2147483e3,
			width: "min(560px, calc(100vw - 32px))",
			maxHeight: "min(88vh, 820px)",
			display: "flex",
			flexDirection: "column",
			background: "#1b1e24",
			color: "#e8eaee",
			border: "1px solid #3a4150",
			borderRadius: "14px",
			boxShadow: "0 18px 48px rgba(0, 0, 0, 0.55)",
			fontFamily: UI_FONT,
			fontSize: "13px",
			overflow: "hidden"
		};
		/** Title bar. Pinned; the body below it is the only scroller. */
		const header = {
			display: "flex",
			alignItems: "center",
			gap: "8px",
			padding: "10px 12px",
			background: "#242832",
			borderBottom: "1px solid #3a4150",
			flex: "none"
		};
		/** The single scrolling region. minHeight 0 is what lets it shrink. */
		const body = {
			flex: "1 1 auto",
			minHeight: 0,
			overflowY: "auto",
			padding: "10px 12px"
		};
		/** Sidebar trigger: transparent at rest, like the sibling plugins. */
		const sidebarButton = {
			display: "flex",
			alignItems: "center",
			justifyContent: "center",
			gap: "6px",
			minHeight: "28px",
			padding: "0 10px",
			whiteSpace: "nowrap",
			border: "1px solid transparent",
			borderRadius: "6px",
			background: "transparent",
			color: "inherit",
			fontFamily: UI_FONT,
			fontSize: "12px",
			cursor: "pointer"
		};
		/** The count of things waiting on a human. */
		const badge = {
			minWidth: "15px",
			height: "15px",
			padding: "0 4px",
			borderRadius: "999px",
			background: "#d93f3f",
			color: "#ffffff",
			fontSize: "10px",
			lineHeight: "15px",
			textAlign: "center",
			fontWeight: 700
		};
		/** One row per task or question. */
		const row = {
			border: "1px solid #3a4150",
			borderRadius: "9px",
			padding: "8px 10px",
			marginBottom: "6px",
			background: "#22262f"
		};
		/** A short status word. */
		const pill = {
			display: "inline-block",
			padding: "0 6px",
			borderRadius: "999px",
			fontSize: "10px",
			border: "1px solid currentColor",
			whiteSpace: "nowrap",
			marginRight: "5px"
		};
		/** Small secondary text. */
		const muted = {
			color: "#98a1b0",
			fontSize: "11px"
		};
		//#endregion
		//#region src/client/panel.tsx
		/**
		* The command-center panel.
		*
		* It reports what is running, what the agent is waiting on, and how long each has
		* been going - all facts. How far along a long silence is, is not a fact: the
		* watcher runs in changed-only mode, so the panel prints that it has no activity
		* data rather than drawing a progress bar over a number nobody measured.
		*
		* @module dsh-command-center/client/panel
		*/
		const PORTS = [
			4811,
			4812,
			4813,
			4814,
			4815,
			4816,
			4817,
			4818
		];
		/** Verdict word in the panel language. A raw english word here is a bug. */
		const VERDICT_LABEL = {
			unknown: "无数据",
			live: "活跃",
			quiet: "安静",
			slow: "偏慢",
			stalled: "疑似卡住",
			done: "结束"
		};
		const VERDICT_COLOUR = {
			unknown: "#8a93a3",
			live: "#1f8a4c",
			quiet: "#a9761a",
			slow: "#a9761a",
			stalled: "#d93f3f",
			done: "#666e7d"
		};
		/**
		* Find the carrier and read its state.
		*
		* The port is tried in order because the host walks upward when the base port is
		* taken; a panel hard-coded to one port would show nothing on a machine where
		* something else reached it first.
		* @returns the state, or null when nothing answered.
		*/
		async function readState() {
			for (const port of PORTS) try {
				const res = await fetch("http://127.0.0.1:" + String(port) + "/state", { signal: AbortSignal.timeout(2500) });
				if (!res.ok) continue;
				const payload = await res.json();
				if (payload.ok === true) return payload;
			} catch {}
			return null;
		}
		/**
		* Compact duration: 8s, 3m20s, 1h04m.
		* @param ms - milliseconds.
		* @returns the text.
		*/
		function duration(ms) {
			const s = Math.max(0, Math.round(ms / 1e3));
			if (s < 60) return String(s) + "s";
			const m = Math.floor(s / 60);
			if (m < 60) return String(m) + "m" + String(s % 60).padStart(2, "0") + "s";
			return String(Math.floor(m / 60)) + "h" + String(m % 60).padStart(2, "0") + "m";
		}
		const h = react.default.createElement;
		/**
		* The panel.
		* @param props - open state and a close handler.
		* @returns the element, or null when closed.
		*/
		function CommandPanel(props) {
			const [state, setState] = (0, react.useState)(null);
			const [failed, setFailed] = (0, react.useState)(false);
			const { open, onClose } = props;
			(0, react.useEffect)(() => {
				if (!open) return;
				let alive = true;
				const poll = async () => {
					const next = await readState();
					if (!alive) return;
					setState(next);
					setFailed(next === null);
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, 4e3);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const onKey = (event) => {
					if (event.key === "Escape") onClose();
				};
				window.addEventListener("keydown", onKey);
				return () => window.removeEventListener("keydown", onKey);
			}, [open, onClose]);
			if (!open) return null;
			const tasks = state === null ? [] : state.tasks;
			const questions = state === null ? [] : state.questions;
			const children = [];
			children.push(h("div", {
				style: header,
				key: "h"
			}, h("strong", { key: "t" }, "指挥台"), questions.length > 0 ? h("span", {
				style: badge,
				key: "b"
			}, String(questions.length)) : null, h("span", {
				style: { flex: 1 },
				key: "s"
			}), h("button", {
				key: "x",
				onClick: onClose,
				title: "关闭",
				style: {
					border: "none",
					background: "transparent",
					cursor: "pointer",
					fontSize: "15px",
					color: "inherit"
				}
			}, "✕")));
			const inner = [];
			if (failed) inner.push(h("div", {
				style: muted,
				key: "f"
			}, "连不上插件端口（4811-4818）。宿主可能刚重启，稍后再试。"));
			if (questions.length > 0) {
				inner.push(h("div", {
					style: {
						...muted,
						marginBottom: "4px"
					},
					key: "qh"
				}, "在等你回答"));
				for (const q of questions) inner.push(h("div", {
					style: row,
					key: q.id
				}, h("div", { style: {
					fontWeight: 600,
					marginBottom: "3px"
				} }, q.header ?? "提问"), h("div", null, q.question), q.options.length > 0 ? h("div", { style: {
					...muted,
					marginTop: "4px"
				} }, "可选：" + q.options.join(" / ")) : null, h("div", { style: {
					...muted,
					marginTop: "4px"
				} }, "请到对话里回答 —— 本面板只负责提醒。")));
			}
			inner.push(h("div", {
				style: {
					...muted,
					marginBottom: "4px"
				},
				key: "th"
			}, "运行中的任务"));
			if (tasks.length === 0) inner.push(h("div", {
				style: muted,
				key: "tn"
			}, "当前没有后台任务。"));
			for (const t of tasks) inner.push(h("div", {
				style: row,
				key: t.id
			}, h("div", null, h("span", { style: {
				...pill,
				color: VERDICT_COLOUR[t.verdict] ?? "#8a93a3"
			} }, VERDICT_LABEL[t.verdict] ?? t.verdict), h("span", { style: { fontWeight: 600 } }, t.id), h("span", { style: {
				...muted,
				marginLeft: "6px"
			} }, duration(t.elapsedMs))), h("div", { style: {
				...muted,
				marginTop: "3px",
				wordBreak: "break-all"
			} }, t.label), h("div", { style: { marginTop: "3px" } }, t.summary), t.progress === null ? h("div", { style: {
				...muted,
				marginTop: "3px"
			} }, "（无活动数据：观察模式 " + (state === null ? "?" : state.observe) + "，未采集输出）") : null));
			children.push(h("div", {
				style: body,
				key: "b"
			}, ...inner));
			return h("div", {
				style: panel,
				role: "dialog",
				"aria-label": "指挥台"
			}, ...children);
		}
		//#endregion
		//#region src/client/index.tsx
		/**
		* Client services this plugin needs.
		*
		* Declaring `slots` is what makes the sidebar seat reachable; without it cordis
		* refuses the `ctx.slots` access with `cannot get property "slots" without inject`.
		*/
		const inject = ["slots"];
		const SIDEBAR_SLOT = "sidebar.footer.action";
		/** Minimal external store for the open flag, shared by both trees. */
		let open = false;
		const listeners = /* @__PURE__ */ new Set();
		/** @returns whether the panel is open. */
		function isOpen() {
			return open;
		}
		/**
		* Subscribe to the open flag.
		* @param listener - called on change.
		* @returns the unsubscribe function.
		*/
		function subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/**
		* Open or close the panel.
		* @param next - the new value.
		*/
		function setOpen(next) {
			open = next;
			for (const listener of listeners) listener();
		}
		/**
		* The sidebar trigger, with a count when something is waiting on a human.
		* @returns the button element.
		*/
		function CenterButton() {
			const isOpenNow = (0, react.useSyncExternalStore)(subscribe, isOpen, isOpen);
			const [waiting, setWaiting] = react.default.useState(0);
			react.default.useEffect(() => {
				let alive = true;
				const poll = async () => {
					const state = await readState();
					if (alive && state !== null) setWaiting(state.needsYou);
				};
				poll();
				const timer = setInterval(() => {
					poll();
				}, 5e3);
				return () => {
					alive = false;
					clearInterval(timer);
				};
			}, []);
			const label = waiting > 0 ? "指挥台 · " + String(waiting) + " 项待处理" : "指挥台";
			const style = isOpenNow ? {
				...sidebarButton,
				opacity: 1
			} : sidebarButton;
			return react.default.createElement("button", {
				style,
				title: label,
				"aria-label": label,
				onClick: () => setOpen(!isOpenNow)
			}, react.default.createElement("span", { "aria-hidden": "true" }, "🧭"), waiting > 0 ? react.default.createElement("span", { style: badge }, String(waiting)) : null, react.default.createElement("span", null, "指挥台"));
		}
		/**
		* Mount the client half.
		* @param ctx - the cordis context.
		*/
		function apply(ctx) {
			const mount = document.createElement("div");
			mount.setAttribute("data-dsh-command-center", "");
			document.body.append(mount);
			let root = null;
			try {
				root = (0, react_dom_client.createRoot)(mount);
				root.render(react.default.createElement(CommandPanel, {
					open,
					onClose: () => setOpen(false)
				}));
			} catch {
				mount.remove();
				return;
			}
			subscribe(() => {
				root?.render(react.default.createElement(CommandPanel, {
					open,
					onClose: () => setOpen(false)
				}));
			});
			const slots = ctx.slots;
			if (slots === void 0 || typeof slots.inject !== "function") return;
			let registered;
			ctx.effect(() => {
				const outer = slots.inject(SIDEBAR_SLOT, () => {
					registered = slots.register({
						name: SIDEBAR_SLOT,
						id: "command-center",
						order: 21
					}, CenterButton);
					return registered;
				});
				return () => {
					outer?.();
					registered?.();
				};
			}, "command-center: sidebar trigger");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map