# 插件双版本兼容 — 交接与回滚文档

> 写于 2026-10-17。**在任何代码改动之前写成本文档**，目的是：如果改动把插件改崩了，
> 另一个 agent（或未来的我）能照这里独立接手，不必重新考古。

---

## 0. 一句话现状

本机 dsh 是 **0.1.5-rc.3**；npm `latest` 是 **0.2.0-rc.2**，`next` 是 **0.2.1-rc.2**（2026-10-17 发布）。
四个插件里 **只有一个**会因为升级而坏：**dsh-command-center**。其余三个经声明比对**没有发现破坏**。

---

## 1. 四个插件与仓库位置

| 插件 | 路径 | 仓库 | 当前 HEAD |
| --- | --- | --- | --- |
| dsh-clock | `D:\deepseek_harness\dsh-clock` | github.com/catsenior507/dsh-clock | 已推送 |
| dsh-command-center | `D:\deepseek_harness\dsh-command-center` | github.com/catsenior507/dsh-command-center | `7c5f51b` |
| dsh-context-assembler | `D:\deepseek_harness\dsh-context-assembler` | github.com/catsenior507/dsh-context-assembler | 已推送 |
| dsh-web-watchdog | `D:\deepseek_harness\igem\dsh-web-watchdog` | github.com/catsenior507/dsh-web-watchdog | `4e4edf9` |

---

## 2. 已确认的 API 差异（唯一会致坏的一处）

### dsh-jobs：0.1.5-rc.3 → 0.2.x（**破坏性**）

证据来源：`https://unpkg.com/@deepseek-ai/dsh-jobs@<version>/lib/types/index.d.ts` 逐行比对。

| 0.1.5-rc.3 | 0.2.x | 对我的影响 |
| --- | --- | --- |
| `list(caller?: Agent): JobSnapshot[]` | `list(caller?: SessionId): JobView[]` | **参数类型变了**：不能再按 agent 查 |
| `read(id, caller?: Agent): JobRead` | `read(id, caller?: SessionId): JobRead`（**消费式，未变**）| 无（本项目没开 read）|
| `kill(id, caller?: Agent, reason?)` | `kill(id, caller?: SessionId, reason?)` | 若要接 kill 需改 |
| `start(spec: JobStart)` | `start(spec: JobSpec)` | 未用 |
| `onJobsChanged(listener)` | **已移除** | **会运行时抛错** |
| `JobSnapshot` 接口 | 换成 `JobView` | 字段基本同名 |
| — | `events: JobEvents`（新）| 用于替代 onJobsChanged |
| — | `get(id, caller?)`（新）| **可用作版本判别** |
| — | `readAt(id, from, caller?)`（新，**非消费**）| 本项目未用；这是未来做"沉默信号"的正确入口 |
| — | `JobView.progress?: string`（新）| 未来做真实进度条的字段 |
| — | `wait(id, timeoutMs, ...)`（新）| 未用 |

**判别方法（推荐）**：`typeof jobs.get === 'function'` → 新 API；否则旧 API。
这是个稳定判别，因为 `get` 在 0.1.5 中不存在、在 0.2.x 中是必需成员。

### 经比对**没有变化**的面（可放心依赖）

| 包 | 比对结果 |
| --- | --- |
| `dsh-agent` 的 `agent/request-error` 载荷 | **完全相同**（agent/turn/step/provider/failure/retryPolicy/signal）|
| `dsh-tools` 的 `register` 与 `output` 要求 | **零变动** |
| `dsh-skill` 的 `register` 与 `SkillRegistration` | **零变动** |
| `dsh-session-persistence` 的 `list` / `open` | 不变（`read` 仅多一行 `readonly identity: symbol`）|
| `dsh-user-questions` | 声明增加 25 行，问题/答案类型仍存在 |

### **未验证**（不要当成"没问题"）

- `sessionController` 服务：dsh-clock 用 `ctx.get('sessionController')` 无类型取用，**任何 .d.ts 里都查不到**，
  所以无法用声明比对判断 0.2.x 是否改名。**升级后必须实际唤醒一次验证。**
- 客户端 slot 名（`sidebar.footer.action`）：它们是运行期字符串，不在类型里，同样**未验证**。
- `dsh-context-assembler` 依赖的 `sessions` / `tools` / surface 读写：**本轮未做比对**。

---

## 3. 要改的文件（dsh-command-center）

按改动顺序，全部在 `D:\deepseek_harness\dsh-command-center\`：

| # | 文件 | 改什么 | 风险 |
| --- | --- | --- | --- |
| 1 | `src/host/registry.ts` | 把"按 Agent 逐个 list 再联合"的绕法，改成**按版本分派**：新 API 直接用 `list(sessionId)`，旧 API 保留现有联合逻辑 | **中** — 现有测试覆盖了联合逻辑，改动会动到测试期望 |
| 2 | `src/host/watch.ts` | 订阅方式分派：新 API 用 `jobs.events`，旧 API 用 `onJobsChanged` | **中** — 若新 API 的事件名/载荷与旧不同，需要适配层 |
| 3 | `src/host/watch.ts` 的类型 | `JobSnapshot` → 本地定义的最小结构（两版本字段的并集），避免依赖任一版本的类型 | 低 |
| 4 | `src/index.ts` | 注入的服务名与判别逻辑接线 | 低 |
| 5 | `test/registry.test.ts` / `test/watch.test.ts` | 增加新 API 形状的用例；旧用例保留 | 低 |
| 6 | `README.md` | 记录支持哪些 dsh 版本，以及判别方式 | 无 |

**不打算动的**：`src/host/liveness.ts`（纯算法，与 API 无关）、`src/host/failures.ts`（依赖的
`agent/request-error` 未变）、`src/host/questions.ts`（`user-questions/request` 未变）、
`src/host/api.ts`（对外 HTTP 形状不变）。

**其余三个插件**：本轮只做**验证**，不打算改代码。若验证发现问题再单独记录。

---

## 4. 回滚

每个仓库都可以回到本轮改动之前的提交：

```powershell
# command-center：回到双版本改动之前
cd D:\deepseek_harness\dsh-command-center
git log --oneline -3          # 找到本轮回滚锚点（提交信息含 "dual-version"）
git reset --hard <该提交的父提交>
```

**本轮开始前的锚点**：
- dsh-command-center: `7c5f51b`
- dsh-web-watchdog: `4e4edf9`
- dsh-clock: 保持原样
- dsh-context-assembler: 保持原样

---

## 5. 验证清单（改完后必须逐项跑）

1. `cd dsh-command-center && npx tsc --noEmit` → 主机半边 **0 错误**（客户端半边有既存的 React 类型报错，可忽略）
2. `node --test test/*.test.ts` → **全部通过**（本轮开始前是 63/63）
3. 重启 dsh，读 `~/.dsh/command-center/startup.log` → 应出现 `jobs=watched`（不是 `jobs=false`）
4. `curl http://127.0.0.1:4811/state` → `jobsWatched: true`，且真跑一个后台任务时 `tasks` 里能看到它
5. dsh-clock：升级后**真的唤醒一次**（设一个 30 秒的闹钟），确认 `sessionController` 仍可用
6. 看门狗：确认 `supervisor.pid` 与真实监督进程一致、`/api/watchdog/status` 的 `alive=true`

**注意**：这个包**没有**覆盖客户端的测试，`npm test` 只测主机半边。

---

## 6. 环境里的两个坑（都是本机实测过的）

1. **.ps1 必须带 UTF-8 BOM** ✗ 否则 PowerShell 5.1 按 ANSI 解码、中文变乱码、**语法解析失败**。
   `assets/supervisor.ps1` 曾因丢失 BOM 而完全无法运行，导致"计划重启彻底无效"。
   **任何新建/编辑的 .ps1 都要确认前三个字节是 `EF BB BF`。**
2. **看门狗的环境快照会被覆盖**：`web-watchdog/host-env.json` 在每次宿主重启时会被重新抓取，
   手改无效。要改行为请改代码里的门牌名，不要改那份快照。

---

## 7. 后续（用户计划的第二步）

用户计划：先升级 dsh → 再改一版**只支持新版本**的插件，去掉兼容分支以减少开销。

届时可以删除的兼容代码：
- `registry.ts` 里按 Agent 联合的旧路径
- `watch.ts` 里 `onJobsChanged` 分支
- 第 3 项里"两版本字段并集"的兼容结构

并且可以**新增**（有 `readAt` 与 `progress` 之后才做得到）：
- 真正的**沉默信号**（非消费式读取，不偷 `job_output`）
- 真正的**进度条**（用 `JobView.progress`）


---

## 8. 验证结果（2026-10-17 补，已按 §5 实测）

以下结论都来自**逐版本对比 unpkg 上的真实声明/产物**，不是回忆：

| 依赖面 | 0.1.5-rc.3 | 0.2.0-rc.2 | 0.2.1-rc.2 | 结论 |
| --- | --- | --- | --- | --- |
| `sessionController` 服务名 | 有 | 有 | 有 | ✅ 一致 |
| `prompt(request, signal)` 签名 | 一致 | 一致 | 一致 | ✅ 一致 |
| `SessionPromptRequest` 字段 | requestId/sessionId/mode/content/clientTimeZone | 同左 | 同左 | ✅ **完全相同** |
| `dsh-tools` 的 `register`/`output` | — | — | — | ✅ 零变动 |
| `dsh-skill` 的 `register`/`SkillRegistration` | — | — | — | ✅ 零变动 |
| `sidebar.footer.action` slot（客户端产物里查的）| 有 | 有 | 有 | ✅ 一致 |
| `sessions: SessionStore`（dsh-session）| 有(445 行) | 有(475 行) | 有(519 行) | ✅ 存在，仅增补 |
| `dsh` 包的 `bin` | `lib/bin.js` | `lib/bin.js` | `lib/bin.js` | ✅ 一致（看门狗重启路径安全）|
| **`dsh-jobs`** | Agent 版 | **SessionId 版** | **SessionId 版** | ⚠️ **唯一破坏点，已兼容** |

**结论**：升级到 0.2.0-rc.2 或 0.2.1-rc.2，只有 `dsh-command-center` 需要改动，而改动**已完成并通过 66/66 测试**。

## 9. 本轮实际改动（已完成）

只改了 `dsh-command-center`，三个文件：

| 文件 | 改动 | 为什么 |
| --- | --- | --- |
| `src/host/watch.ts` | `RegistryLike` **去掉 `onJobsChanged`**；`start()` 改为**每 `pollMs`（默认 2s）轮询 `list()`**；定时器 `unref()` | `onJobsChanged` 在 0.2.x 被移除，订阅式写法必然抛错；轮询在两个版本上是同一条代码路径 |
| `src/host/registry.ts` | `unionRegistry` 增加**版本判别**：`typeof jobs.get === 'function'` → 新 API 直接 `list()`（一次无围栏调用）；否则保持原有的按 agent 联合 | 新 API 的 `list(SessionId)` 不接受 Agent，联合逻辑在新版本上既多余又有害 |
| `test/watch.test.ts` | 把"订阅一次且幂等"改成"立即读一次且幂等"，新增"轮询持续到 dispose 为止" | 行为变了，测试必须跟着变 |
| `test/registry.test.ts` | 新增两条：新 API 走 `get()` 判别且**只发一次调用**；旧 API 仍按 agent 联合 | 新路径原本**零测试覆盖** |

**验证**：`node --test test/*.test.ts` → **66/66 通过**；`npx tsc --noEmit` 主机半边 **0 错误**；`npx tsdown` 构建通过。

**未改**：`liveness.ts`（纯算法）、`failures.ts`（`agent/request-error` 未变）、`questions.ts`（`user-questions/request` 未变）、`api.ts`（HTTP 形状不变）。

## 10. 第二步（升级后再做）的清单

用户计划升级后做"只支持新版本"的版本，届时删除：

1. `registry.ts` 里按 Agent 联合的旧分支，以及 `unionRegistry` 的版本判别；
2. `watch.ts` 的注释里关于两代 API 的说明；
3. 测试里"旧 API 仍按 agent 联合"那一条。

并**新增**（0.2.x 才有）：

- 用 `readAt(id, from)` 做**非消费式**的沉默信号采集（替代现在永远为 `null` 的 `observedSilenceMs`）；
- 用 `JobView.progress` 显示**真实进度**（替代现在基于历史耗时的估算）。
