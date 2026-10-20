/**
 * @dsh-external/dsh-workflow-commands — 把 markdown 工作流命令模板桥接成 DSH 斜杠命令
 *
 * 模板是 markdown（含 frontmatter + `$ARGUMENTS` 占位符），展开后作为一条用户消息发给模型。
 * DSH 的命令必须由插件注册（ctx.commands.register），所以这里做一层桥接：
 *
 *   /w0 → 0.md（纯规划）      /w1 → 1.md（六阶段·大模型版）   /w2 → 2.md（六阶段·小模型版）
 *   /post、/oddba → post.md   其余 ~/.dsh/commands/*.md 自动发现，按文件名注册
 *
 * 命令名不能沿用 0/1/2 —— DSH 的解析规则要求字母开头；
 * 也不能叫 plan —— 内核自带 dsh-plan-mode 已占用 /plan，同名注册会抛异常。
 *
 * 模板支持三层展开，顺序固定：
 *   1. @include 片段递归展开（片段自身也可以 @include，限深防循环）
 *   2. 运行时变量替换（$DATE / $CWD / $MODEL …，未定义的 $XXX 原样保留）
 *   3. $ARGUMENTS 替换成用户输入的任务描述
 *
 * 零外部运行时依赖（只 node 内建模块）—— 不 import @deepseek-ai/*，
 * 可脱离 junction 依赖直接加载（同 dsh-project-memory 的约定）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

export const name = '@dsh-external/dsh-workflow-commands'
export const inject = ['commands', 'systemPrompt']

const HERE = dirname(fileURLToPath(import.meta.url))

// 加载诊断：这两行会进宿主日志。只看到「模块已加载」而看不到「apply 被调用」，
// 就说明 inject 的服务没就绪。
console.log('[workflow-cmds] 模块已加载')

/** 模板目录：默认读 ~/.dsh/commands，可用环境变量 DSH_WORKFLOW_DIR 覆盖。 */
/**
 * 模板目录候选，按优先级排列；读取是逐文件的，靠前的目录覆盖靠后的。
 *
 * DSH_WORKFLOW_DIR 是**显式指定**：给了它就独占，不再叠加用户目录与插件自带的兜底 ——
 * 否则想用它隔离一套模板（测试、多套工作流并存）时，本机的 ~/.dsh/commands 会渗进来。
 */
const DIR_CANDIDATES = process.env.DSH_WORKFLOW_DIR
  ? [process.env.DSH_WORKFLOW_DIR]
  : [
      join(homedir(), '.dsh', 'commands'),
      join(HERE, '..', 'templates'),
      join(homedir(), '.zcode', 'commands'),
    ]

/**
 * 第一个存在的候选目录，仅用于日志与错误提示。
 * 模板读取走 {@link findTemplatePath}，是**逐文件**按 DIR_CANDIDATES 顺序找的：
 * 这样用户目录里放哪个文件就覆盖哪个，没放的自动落到插件自带的 templates/ 兜底 ——
 * 而不是「用户目录一存在，插件自带模板就永远用不上」。
 */
export const TEMPLATE_DIR =
  DIR_CANDIDATES.find((d) => existsSync(d)) || DIR_CANDIDATES[DIR_CANDIDATES.length - 1]

/** 片段查找顺序：各模板目录的 _fragments/ 按候选顺序，最后是插件自带的 lib/fragments/。 */
const FRAGMENT_DIRS = [...DIR_CANDIDATES.map((d) => join(d, '_fragments')), join(HERE, 'fragments')]

/** 片段嵌套上限，兼作循环引用的兜底。 */
const MAX_INCLUDE_DEPTH = 8

/** 手动声明的命令：名字不是文件名的（w0/w1/w2）或需要别名（post/oddba）。 */
const EXPLICIT_SPECS = [
  { name: 'w0', file: '0.md', fallback: '纯规划：只产出可执行计划文档，不执行（对应 ZCode /0）' },
  { name: 'w1', file: '1.md', fallback: '六阶段工作流·大模型版（对应 ZCode /1）' },
  { name: 'w2', file: '2.md', fallback: '六阶段工作流·小模型版（对应 ZCode /2）' },
  // ODDBA 发帖/改帖：内核命令名必须 ^[a-z][a-z0-9_-]*$，中文名 /发帖 注册不了，
  // 故用 /post 与同义 /oddba；模板 post.md 见 ~/.dsh/commands/
  { name: 'post', file: 'post.md', fallback: 'ODDBA 发帖/改帖（全自动）' },
  { name: 'oddba', file: 'post.md', fallback: 'ODDBA 发帖/改帖（同 /post）' },
]

/** 自动发现时跳过的文件名（小写比较）：README 是目录说明，不是命令模板。 */
const SKIP_FILES = new Set(['readme.md'])
/** DSH 命令名规则，与内核解析用的正则一致。 */
const COMMAND_NAME_RE = /^[a-z][a-z0-9_-]*$/
/** frontmatter 键名规则（description / argument-hint / allowed-tools…）。 */
const KEY_OK = /^[A-Za-z][A-Za-z0-9-]*$/

/** 拆掉 markdown frontmatter（那层是给旧命令格式的元数据，不该进模型上下文）。 */
function splitFrontmatter(raw) {
  const meta = {}
  if (!raw.startsWith('---')) return { meta, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end < 0) return { meta, body: raw }

  for (const line of raw.slice(3, end).split('\n')) {
    const i = line.indexOf(':')
    if (i <= 0) continue
    const key = line.slice(0, i).trim()
    if (KEY_OK.test(key)) meta[key] = line.slice(i + 1).trim()
  }

  let start = end + 4
  if (raw[start] === '\r') start += 1
  if (raw[start] === '\n') start += 1
  return { meta, body: raw.slice(start) }
}

/** 按候选顺序逐文件查找模板；找不到返回 null。 */
function findTemplatePath(file) {
  for (const dir of DIR_CANDIDATES) {
    const candidate = join(dir, file)
    if (existsSync(candidate)) return candidate
  }
  return null
}

function readTemplate(file) {
  const found = findTemplatePath(file)
  if (found === null) return null
  try {
    return splitFrontmatter(readFileSync(found, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 扫所有候选目录，返回可自动注册的文件名（按候选顺序去重，最后排序，行为可复现）。
 * 靠前目录里的同名文件优先，与 {@link findTemplatePath} 的逐文件语义一致。
 */
function discoverTemplates() {
  const seen = new Set()
  for (const dir of DIR_CANDIDATES) {
    let entries
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (extname(f).toLowerCase() !== '.md') continue
      if (basename(f).startsWith('_')) continue
      if (SKIP_FILES.has(f.toLowerCase())) continue
      if (!COMMAND_NAME_RE.test(basename(f, '.md'))) continue
      seen.add(f)
    }
  }
  return [...seen].sort()
}

/**
 * 组装最终命令表：先自动发现，再补手动声明的。
 * 同名时先到先得 —— 避免 /post 既是发现来的又被显式声明一遍。
 */
export function buildSpecs() {
  const specs = []
  const taken = new Set()

  for (const file of discoverTemplates()) {
    const cmd = basename(file, '.md')
    if (taken.has(cmd)) continue
    taken.add(cmd)
    specs.push({ name: cmd, file, fallback: `${cmd}（模板 ${file}）` })
  }
  for (const spec of EXPLICIT_SPECS) {
    if (taken.has(spec.name)) continue
    taken.add(spec.name)
    specs.push(spec)
  }
  return specs
}

function findFragment(name) {
  for (const dir of FRAGMENT_DIRS) {
    const p = join(dir, name + '.md')
    if (existsSync(p)) return p
  }
  return null
}

/** 解析 @include 行尾的参数：key="带空格的值" 或 key=value。键名允许中文（片段名必须是 ASCII，因为它是文件名）。 */
function parseParams(rest) {
  const params = {}
  for (const m of rest.matchAll(/([^\s=]+)=("[^"]*"|\S+)/g)) {
    params[m[1]] = m[2].replace(/^"|"$/g, '')
  }
  return params
}

function applyParams(text, params) {
  if (Object.keys(params).length === 0) return text
  return text.replace(/\{\{\s*([^\s}]+)\s*\}\}/g, (whole, key) =>
    key in params ? params[key] : whole,
  )
}

/**
 * 展开 @include。找不到的片段不静默吞掉 —— 记进 missing，交给 handler 报错，
 * 否则模型会收到一句它不认识的 "@include foo"，比直接失败更难排查。
 */
function expandIncludes(text, missing, depth = 0, seen = new Set()) {
  if (depth > MAX_INCLUDE_DEPTH) {
    missing.push('片段嵌套超过 ' + MAX_INCLUDE_DEPTH + ' 层')
    return text
  }
  // 片段名放宽到任意非空白串：名字写错（含中文）时要报「片段不存在」，
  // 而不是把 @include 原样透传给模型，那更难排查。
  return text.replace(/^[ \t]*@include[ \t]+([^\s]+)(.*)$/gm, (line, name, rest) => {
    const path = findFragment(name)
    if (!path) {
      missing.push(name)
      return line
    }
    const key = resolve(path)
    if (seen.has(key)) {
      missing.push(name + '（循环引用）')
      return line
    }
    const frag = readFileSync(path, 'utf8')
    const nextSeen = new Set(seen)
    nextSeen.add(key)
    const inner = expandIncludes(splitFrontmatter(frag).body, missing, depth + 1, nextSeen)
    // 片段末尾的换行由模板自己的换行接上，不带过来，否则会多出空行
    return applyParams(inner, parseParams(rest)).replace(/\n+$/, '')
  })
}

/** 没在模板 frontmatter 里声明 r-budget 时的默认请求预算。 */
export const DEFAULT_REQUEST_BUDGET = 20

/** 每个 agent 的请求计数注入器：agent → { disposers, state }（WeakMap，agent 被回收即自动清理）。 */
const requestCounters = new WeakMap()

/**
 * 收集挂在某个 root agent 下的全部子孙 agent（按运行时归属，不是会话血缘）。
 *
 * 用 agents 服务的 isOwnedBy(id, owner) 逐层展开：子代理的 owner 是创建它的 agent，
 * 孙代理的 owner 是子代理，所以从 root 出发做 BFS。
 *
 * @param agents - 内核 agents 服务。
 * @param rootAgent - 起点 agent。
 * @returns 子孙 agent 列表（不含 root 自己）；服务缺方法时返回空数组。
 */
function collectDescendants(agents, rootAgent) {
  if (typeof agents?.list !== 'function' || typeof agents?.isOwnedBy !== 'function') return []
  const all = agents.list()
  const seen = new Set([rootAgent.id])
  const found = []
  let frontier = [rootAgent]
  while (frontier.length > 0) {
    const next = []
    for (const owner of frontier) {
      for (const candidate of all) {
        if (seen.has(candidate.id)) continue
        if (agents.isOwnedBy(candidate.id, owner)) {
          seen.add(candidate.id)
          found.push(candidate)
          next.push(candidate)
        }
      }
    }
    frontier = next
  }
  return found
}

/**
 * 把计数器补装到 root 新出现的子孙 agent 上，让子代理也看得到自己的请求数。
 * 已装过的直接跳过（requestCounters 是 WeakMap，查得到就说明装过）。
 *
 * @returns 本次新装上的数量。
 */
function adoptDescendants(agentCtx, rootAgent, budget) {
  const agents = agentCtx?.get?.('agents') ?? agentCtx?.agents
  if (agents === undefined || agents === null) return 0
  let adopted = 0
  for (const child of collectDescendants(agents, rootAgent)) {
    if (requestCounters.has(child)) continue
    if (installRequestCounter(child, budget) !== null) adopted += 1
  }
  return adopted
}

/**
 * 汇总 root 名下子孙 agent 已经烧掉的请求数。
 *
 * 台账（ledger）只增不减：子孙 agent 跑完被回收后 requestCounters（WeakMap）里就查不到了，
 * 若直接按当前 live 子孙求和，子代理一结束总账就会“退账”。所以这里按 agent id 记历史峰值，
 * 只在新值更大时覆盖。
 *
 * @param ledger - 该 root 的子孙台账 Map<agentId, step>，由调用方持有。
 * @returns { total, active } —— total 是子孙累计请求数，active 是烧过请求的子孙个数。
 */
function tallyDescendants(agentCtx, rootAgent, ledger) {
  const agents = agentCtx?.get?.('agents') ?? agentCtx?.agents
  if (agents === undefined || agents === null) return { total: 0, active: 0 }
  for (const child of collectDescendants(agents, rootAgent)) {
    const step = requestCounters.get(child)?.state?.step ?? 0
    if (step > (ledger.get(child.id) ?? 0)) ledger.set(child.id, step)
  }
  let total = 0
  let active = 0
  for (const step of ledger.values()) {
    if (step > 0) {
      total += step
      active += 1
    }
  }
  return { total, active }
}

/**
 * 给一个 agent 装上「请求计数」注入：此后每一步把 [R n/预算] 追加进运行时上下文。
 *
 * 计数锚点是内核的 agent/pre-step 事件，payload 的 step 就是当前步号（= 第几次计费请求）。
 * 时序上 assemble 早于该事件，但真正落进消息的是 step 内 refreshContext 的那次渲染 ——
 * 那时计数已经更新，所以 text 回调直接用 state.step 就与真实请求号一致，不需要 +1。
 *
 * 同一 agent 再次调用命令时先撤掉旧注册：prompt context 同名重复注册会抛错。
 *
 * @param agent - 命令 invocation 上的 agent，需要 agent.ctx 作用域。
 * @param budget - 本次任务的请求预算，只用于展示分母。
 * @param options.adopt - 为 true 时，每步顺带把计数器补装到新出现的子孙 agent 上（子代理也看得到自己的请求数）。
 * @returns 计数状态；agent 不具备所需作用域时返回 null（不注入，命令照常投递）。
 */
export function installRequestCounter(agent, budget, options = {}) {
  const agentCtx = agent?.ctx
  if (typeof agentCtx?.on !== 'function' || typeof agentCtx?.systemPrompt?.context !== 'function') return null

  const previous = requestCounters.get(agent)
  if (previous) for (const dispose of previous.disposers) { try { dispose?.() } catch { /* 旧注册可能已随作用域失效 */ } }

  const state = { step: 0, childLedger: new Map() }
  const disposers = []

  disposers.push(agentCtx.on('agent/pre-step', async (payload, next) => {
    try {
      const step = Number(payload?.step)
      if (Number.isFinite(step)) state.step = step
      if (options.adopt === true) {
        adoptDescendants(agentCtx, agent, budget)
        const tally = tallyDescendants(agentCtx, agent, state.childLedger)
        state.childTotal = tally.total
        state.childActive = tally.active
      }
    } catch { /* 计数失败不得影响 agent 流程 */ }
    return typeof next === 'function' ? next() : undefined
  }))

  disposers.push(agentCtx.systemPrompt.context({
    name: 'workflow:request-counter',
    order: 19,
    text: () => {
      if (state.step <= 0) return ''
      const childTotal = state.childTotal ?? 0
      const childActive = state.childActive ?? 0
      const whole = state.step + childTotal
      const head = childActive > 0
        ? `[R${state.step}/${budget} · 全树 ${whole}${whole > budget ? '（已超预算）' : ''}] 主会话第 ${state.step} 次请求，${childActive} 路子代理共烧 ${childTotal} 次。`
        : `[R${state.step}/${budget}] 本次任务第 ${state.step} 次请求。`
      return `${head}每多一次请求就多付一次钱——无依赖的动作先并进同一次请求。`
    },
  }))

  requestCounters.set(agent, { disposers, state })
  return state
}

/** 从模板 frontmatter 读请求预算；缺省或非法时回落到 DEFAULT_REQUEST_BUDGET。 */
export function budgetOf(template) {
  const raw = Number.parseInt(String(template?.meta?.['r-budget'] ?? ''), 10)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_BUDGET
}

function modelName(agent) {
  const m = agent?.model
  if (typeof m === 'string') return m
  if (m && typeof m === 'object') return String(m.id ?? m.name ?? '未知')
  return '未知'
}

/** 运行时变量。模型拿不到宿主真实模型名时回落成「未知」，不做任何猜测。 */
export function runtimeVars(invocation) {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const date = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
  const time = pad(now.getHours()) + ':' + pad(now.getMinutes())
  return {
    DATE: date,
    TIME: time,
    DATETIME: date + ' ' + time,
    CWD: process.cwd(),
    HOME: homedir(),
    DSH: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    MODEL: modelName(invocation?.agent),
  }
}

/** 只替换已知变量；未定义的 $XXX 原样留着（模板里的 $ARGUMENTS 就是靠这个走到最后一步）。 */
function applyVars(text, vars) {
  return text.replace(/\$([A-Z][A-Z_]*)\b/g, (whole, key) => (key in vars ? vars[key] : whole))
}

/**
 * 把模板变成要投递的消息正文。失败时返回 error 原因，不投空消息。
 */
export function renderTemplate(file, invocation) {
  const t = readTemplate(file)
  if (!t) return { error: '读不到模板 ' + file + '（已找过：' + DIR_CANDIDATES.join(' / ') + '；可用 DSH_WORKFLOW_DIR 指定目录）' }

  const missing = []
  let text = expandIncludes(t.body, missing)
  if (missing.length > 0) {
    return { error: '模板 ' + file + ' 引用了不存在的片段：' + missing.join('、') }
  }

  const task = (invocation.rawInput || '').trim()
  text = applyVars(text, runtimeVars(invocation))
  text = text.replaceAll('$ARGUMENTS', task || '（按所附内容执行）')
  return { text, hint: t.meta['argument-hint'] }
}

/**
 * 本插件投递的工作流正文所用的 source kind。
 *
 * 模板展开后是一整段工作流指令，**不是**用户写的话。内核按 source.kind 区分
 * 两者：只有 kind === 'user' 的消息算「人类消息」，而会话标题正是从人类消息
 * 生成的（dsh-session-title 的 sessionTitleUserMessageOf 只认 'user'）。
 *
 * 早期这里写死 'user'，于是 /w1 展开的整段模板被当成用户的第一句话，标题
 * 拿它去生成 —— 结果是「你是一个**请求经济优先**的工」这种把模板首句截断的
 * 标题，而不是任务本身的名字。
 *
 * 所以这里拆成两条：任务描述走 'user'（人类消息，标题取它），模板走本
 * 插件自己的 kind（非人类消息，模型照样看得见，标题不取它）。
 */
export const WORKFLOW_SOURCE_KIND = 'workflow-command'

/**
 * 组装一条 user 消息。等价于内核的 createUserMessage。
 * 附件块排在正文之前 —— 内核只把 admitted 的块交给 handler，不拼进来就等于丢附件。
 */
function userMessage(text, attachments) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [...attachments, { type: 'text', text }],
    source: { kind: 'user' },
  }
}

/**
 * 组装一条装着工作流指令的消息。
 *
 * 刻意不是人类消息：内核的 user/message 只要求 source.kind 是非空字符串
 * （不像 system/assistant/tool 有白名单），而会话标题只数 'user'。模型看到
 * 的内容没变，变的只是「这条是不是用户说的话」——正是标题需要的那条区别。
 */
function workflowMessage(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: WORKFLOW_SOURCE_KIND },
  }
}

export function apply(ctx) {
  console.log('[workflow-cmds] apply 被调用 | commands.register =', typeof ctx.commands?.register)
  const specs = buildSpecs()
  let registered = 0
  for (const spec of specs) {
    const t = readTemplate(spec.file)
    let dispose
    try {
      dispose = ctx.commands.register({
        name: spec.name,
        description: (t && t.meta.description) || spec.fallback,
        // 不声明 attachments 时，composer 会直接拒绝带附件的提交（附件根本拖不进来）
        input: { hint: (t && t.meta['argument-hint']) || '<任务描述>（可附图片/文件）', attachments: true },
        handler: (invocation) => {
          const task = (invocation.rawInput || '').trim()
          const attachments = Array.isArray(invocation.attachments) ? invocation.attachments : []
          if (!task && attachments.length === 0) {
            return {
              kind: 'error',
              text: `/${spec.name} 需要任务描述或至少一个附件，例如：/${spec.name} 修复登录超时`,
            }
          }
          const rendered = renderTemplate(spec.file, invocation)
          if (rendered.error) return { kind: 'error', text: rendered.error }
          installRequestCounter(invocation.agent, budgetOf(t), { adopt: true })
          // 两条消息，一个回合：
          //   inject   → next-step，任务描述，source.kind='user'（人类消息，标题取它）
          //   followup → next-turn，工作流指令，source.kind='workflow-command'（非人类消息）
          //
          // 顺序由内核的 inbox 语义决定：claim('next-turn') 一次只取一条 next-turn，
          // 而 next-step 全部取走 —— 两条都走 followup 的话，任务描述会被留到下一
          // 个回合才落地，工作流指令反而先到。所以指令走 inject、描述走 followup。
          //
          // 早先这里是把展开后的整段模板当唯一一条用户消息发出去。后果是会话标题
          // 拿模板首句去生成（「你是一个**请求经济优先**的工」），而不是任务的名字：
          // 内核的会话标题只从 source.kind === 'user' 的消息取素材。
          invocation.agent.inject(workflowMessage(rendered.text))
          invocation.agent.followup(userMessage(task, attachments))
          const extra = attachments.length ? `，附 ${attachments.length} 个附件` : ''
          return {
            kind: 'success',
            text: `已投递 /${spec.name} 工作流：${task || '（仅附件）'}${extra}`,
          }
        },
      })
    } catch (error) {
      // 同名命令已被占用（内核新增或别的插件）。跳过这一条，别让整棵插件树挂掉。
      console.error(`[workflow-cmds] /${spec.name} 注册失败（很可能名字已被占用）：${error?.message ?? error}`)
      continue
    }
    // register 返回 disposer 说明注册真的进了 registry（返回 undefined = 没注册上）
    if (typeof dispose === 'function') registered += 1
    console.log(`[workflow-cmds] /${spec.name} → ${spec.file} | disposer=${typeof dispose}`)
  }
  console.log(`[workflow-cmds] ${specs.length} 条候选 / ${registered} 条注册成功 | 模板目录=${TEMPLATE_DIR}`)
}
