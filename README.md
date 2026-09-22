# dsh-command-center

一个 dsh 插件：把「正在跑什么、agent 在等谁、等了多久」放进一屏，并在 agent 停下来等你的时候喊你。

## 两组观察者

| | 看什么 | 怎么接 |
| --- | --- | --- |
| **jobs** | 正在运行的后台任务 | `ctx.jobs`，**跨 agent 联合**（见下） |
| **questions** | agent 正在等回答的问题 | `user-questions/request` waterfall，**只观察、绝不代答** |

## 三个必须知道的约束

### 1. `jobs.list()` 不传 caller 时看不到任何有主任务

任务按会话围墙，`list()` 省略 caller 只会返回无主任务。所以面板必须用
`ctx.agents.list()` 拿到所有活 agent，逐个 `list(agent)` 再按 id 去重合并
（`src/host/registry.ts`）。**这个坑靠读类型签名发现不了** —— `list(caller?)` 里的
问号看起来完全无害，只有真跑一个后台任务才会暴露：面板显示 `tasks: 0` 而任务明明在跑。

### 2. `ctx.slots` 是属性访问，必须声明 `inject`

```ts
// src/client/index.tsx 顶部必须是：
export const inject = ['slots']
```

缺少它，整个浏览器 bundle 加载失败：

```
cannot get property "slots" without inject
```

**`(ctx as unknown as {...}).slots` 这种强转骗得过 TypeScript，骗不过 cordis** ——
运行时照样抛。宿主端 `ctx.get('jobs')` 是方法调用，取不到返回 undefined，可以兜底；
客户端 `ctx.slots` 是属性访问，缺声明直接崩。**同样是取服务，两条路的安全性不同。**

`test/inject.test.ts` 会在测试阶段拦住这类错误，**并且有一条测试专门证明它抓得住这个 bug**。

### 3. `read` 模式**实测不安全**，已停用（2026-09-22 实测）

原本想在 `read` 模式下读任务输出来测「沉默多久」✓ 思路没错 ✗ **但实测结果是不能做**：

```
observe=read
agent sees: ""        ← job_output 什么都拿不到
```

**`JobRegistry.read()` 的消费游标是按任务记的，不是按调用者记的** ✓ —— 第二个读取者会把差异输出
从第一个那里拿走 ✗。所以插件一旦采样，agent 自己的 `job_output` 就永远返回空 ✓。

已回滚 ✗ 并把开关名从 `DSH_COMMAND_CENTER_OBSERVE` 改成了
`DSH_COMMAND_CENTER_READ_OUTPUT` ✓ —— **因为回滚一度没生效**：守望者每次重启宿主都会
**重新抓取**环境快照 ✓ 把运行中宿主里的旧值写回去 ✗ 于是盗窃被重新武装 ✓。换个没人设置的新名字，
这条路就断了 ✓。

**除非将来有了不消费的读取方式，否则不要再打开它** ✓。

### 4. 观察模式默认 `changed-only`

`JobRegistry.read()` 返回的是**消费式**差异输出。如果消费游标按任务记而不是按调用者记，
插件轮询就会把 agent 自己的 `job_output` 输出偷走。所以默认**不读输出**，每个响应里都带
`observe: 'changed-only'`，面板据此显示「无活动数据」而不是画一根没测过的进度条。

## 改这个插件的流程

浏览器半边的改动会**同时打断我自己的工作界面** —— GUI 坏了我就没法修，只能靠别人。所以：

1. **改代码 → `npm test`**（含 inject 守卫）**全绿**；
2. **`npm run build`**，并确认 `lib/client.js` 里 `exports.inject` 与 `dsh-clock` 一致；
3. 需要重启才生效，**重启前先说明**，不要突然打断对话；
4. 重启后**先读 `~/.dsh/command-center/startup.log`** 确认 `jobs=watched api=4811`，
   再去看界面。日志和 API 说法不一致时（曾经出现 `jobs=watched` 配 `jobsWatched=false`），
   **那个矛盾本身就是 bug 的位置**。

## 构建

```sh
npm install
npm test          # 47 个测试
npm run build     # lib/index.mjs (宿主) + lib/client.js (浏览器)
```

## 许可

MIT
