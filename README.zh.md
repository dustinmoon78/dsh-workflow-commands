# dsh-workflow-commands

把 markdown 提示词模板桥接成 DSH 斜杠命令，支持 `@include` 公共片段，并为「按请求次数计费」的场景提供**每步请求预算注入**。

英文说明见 [README.md](README.md)。

## 为什么需要它

按请求次数计费时，唯一的成本变量就是**发了多少次请求**。在 agent 循环里，一次请求 = 一个模型步：模型回复一次（可能只带一个工具调用），工具结果回填，这又是一次计费请求。一个对话轮次内部可能烧掉几十次请求。

实测 59 个真实会话：3338 次计费请求 / 3586 次工具动作 = **每次请求 1.07 个动作**，93% 的请求只做一件事。模板里写「不超过 25 回合」没用——模型数不出请求数（同一批会话里，「报告实际回合数」这条强制项执行了 **0 次**）。

## 三块能力

1. **模板桥接**：目录里的每个 markdown 文件变成一个斜杠命令（`0.md` → `/w0`，`commit.md` → `/commit`）。模板**每次调用现读**，改内容即时生效；增删文件需要重启 DSH。

   查找是**逐文件**的，顺序：`DSH_WORKFLOW_DIR`（设了就独占，不叠加兜底）→ `~/.dsh/commands` → 插件自带的 `templates/` → `~/.zcode/commands`。
   哪个目录先有这个文件就用哪个 —— 所以你往 `~/.dsh/commands` 丢一个 `1.md` 只会覆盖它，不会把插件自带的其余模板一起挡掉。
2. **`@include` 片段**：公共段落放 `_fragments/<名字>.md`，用 `@include 名字 键="值"` 引入，行尾参数替换片段里的 `{{键}}`；支持嵌套（上限 8 层，循环会被拦下）；片段缺失直接报错而不是静默透传。
3. **请求预算注入**：敲过工作流命令的 agent，此后每一步的运行时上下文里会多一行 `[R4/12] …`；有子代理时主会话看到全树总账 `[R10/12 · 全树 15（已超预算）]`；子代理也各自计数。预算取自模板 frontmatter 的 `r-budget`，缺省 20。

## 安装

```bash
dsh plugin --profile <profile> add "file:/absolute/path/to/dsh-workflow-commands"
```

装完重启 DSH 桌面壳。本地 `file:` 安装是实体目录，改源码后要重新同步 `node_modules/` 下的副本再重启。

## 注入器的原理

它挂在三个内核扩展点上：

1. **通道**：`systemPrompt` 服务的 `context({ name, order, text })`，`text` 可以是函数、拿得到 agent。内核注释写明这些是 *assembled before each model step* 的 prompt 输入。
2. **锚点**：`agent/pre-step` 事件带 `{ agent, messages, signal, step }`。有个时序陷阱——第 N 步里 `assemble()`（触发 text 回调）发生在该事件之前，但真正进消息历史的是 `step()` 内 `refreshContext()` 的那次渲染；那时计数已更新，所以回调直接返回 `state.step` 即可，不需要 +1。
3. **作用域**：注册在 `agent.ctx`（agent 作用域），只有跑过工作流命令的 agent 受影响，普通对话不受干扰。

子孙 agent 通过 `agents` 服务发现：`isOwnedBy(id, owner)` 只回答直接子，所以要沿 owner 链做 BFS。总账按 agent id 记**只增不减**的台账——跑完的子代理会被回收出注册表，若只对 live 子孙求和，子代理一结束总数就会往下掉。

### 降级行为

注入器是纯尽力而为：拿不到 `agent.ctx` 或 `systemPrompt` 就返回 null、不注入，命令照常投递；计数全程 try/catch，不会打断 agent 循环；`agent/pre-step` 处理函数必定调用 `next()`，不截断 waterfall 链。

## 兼容性

注入器依赖 DSH **内部**扩展点（`systemPrompt.context`、`agent/pre-step` 事件、`agents` 服务）。内核自己在用，但不是稳定公开契约，DSH 升级可能破坏它；届时它会静默降级而不是报错，升级后请确认 `[R n/预算]` 是否还在。

在 DSH 0.2.x 上开发。模板桥接那一半没有这个依赖，只需要 `commands` 服务。

## 开发

```bash
node test.mjs   # 零依赖，跑在临时 fixture 目录上
```

## 许可证

BSD-3-Clause，见 [LICENSE](LICENSE)。
