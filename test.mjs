/**
 * dsh-workflow-commands 自测：不依赖 DSH，直接跑 apply() 验证插件逻辑。
 *   node test.mjs
 *
 * 覆盖：命令注册、自动发现、@include 片段展开、运行时变量、附件、空输入、重名保护。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

// 干净环境（CI 等）里既没有 DSH_WORKFLOW_DIR 也没有 ~/.dsh/commands，而模板目录是
// lib/index.js 加载时定死的常量 —— 所以必须在 import 之前把目录准备好，且 import 必须
// 是动态的：静态 import 会被提升到这段代码之前，env 就白设了。
if (!process.env.DSH_WORKFLOW_DIR && !existsSync(join(homedir(), '.dsh', 'commands'))) {
  const boot = mkdtempSync(join(tmpdir(), 'workflow-cmds-boot-'))
  mkdirSync(join(boot, '_fragments'), { recursive: true })
  writeFileSync(join(boot, '0.md'), '---\ndescription: 纯规划（自测 fixture）\nargument-hint: <任务描述>\nr-budget: 5\n---\n\n规划引擎：对任务「$ARGUMENTS」产出计划文档。\n')
  writeFileSync(join(boot, '1.md'), '---\ndescription: 三阶段工作流（自测 fixture）\nargument-hint: <任务描述>\nr-budget: 12\n---\n\n工作流引擎：对任务「$ARGUMENTS」执行三阶段流程，日期 $DATE。\n')
  writeFileSync(join(boot, 'hello.md'), '---\ndescription: 自动发现用（自测 fixture）\n---\n\n问候 $ARGUMENTS\n')
  writeFileSync(join(boot, '2.md'), '---\ndescription: 三阶段工作流·小模型版（自测 fixture）\nargument-hint: <任务描述>\nr-budget: 10\n---\n\n工作流引擎：对任务「$ARGUMENTS」执行三阶段流程。\n')
  process.env.DSH_WORKFLOW_DIR = boot
}

const { apply, inject, name, renderTemplate, buildSpecs } = await import('./lib/index.js')

const definitions = []
const delivered = []

apply({ commands: { register: (def) => definitions.push(def) } })

console.log('插件名 :', name)
console.log('inject :', JSON.stringify(inject))
console.log('已注册 :')
for (const d of definitions) console.log(`  /${d.name} — ${d.description}`)

const w1 = definitions.find((d) => d.name === 'w1')
if (!w1) {
  console.error('FAIL: 没有注册 w1')
  process.exit(1)
}

const invocation = {
  rawInput: ' 给 launcher 加托盘图标',
  agent: { followup: (m) => delivered.push(m) },
  attachments: [],
  signal: new AbortController().signal,
  commandId: 'selftest',
}

const okResult = w1.handler(invocation)
console.log('\n/w1 返回     :', JSON.stringify(okResult))
console.log('投递消息条数 :', delivered.length)
const firstCount = delivered.length

const msg = delivered[0]
const body = msg.content.find((b) => b.type === 'text').text
console.log('消息 role    :', msg.role, '| source:', JSON.stringify(msg.source))
console.log('有 id        :', typeof msg.id === 'string' && msg.id.length > 10)
console.log('正文前 70 字 :', body.slice(0, 70).replace(/\n/g, ' '))
console.log('任务已注入   :', body.includes('给 launcher 加托盘图标'))
console.log('$ARGUMENTS   :', body.includes('$ARGUMENTS') ? 'FAIL 仍残留' : '已全部替换')

const empty = w1.handler({ ...invocation, rawInput: '   ' })
console.log('\n空任务返回   :', JSON.stringify(empty))

// 附件：声明了 input.attachments 之后，handler 必须自己把块拼进消息，否则等于丢附件
const fakeImage = { type: 'image', source: { kind: 'attachment', attachmentId: 'a1' } }
const withAttachment = w1.handler({ ...invocation, rawInput: ' 看这张图', attachments: [fakeImage] })
const attachedMsg = delivered[delivered.length - 1]
console.log('\n带附件返回   :', JSON.stringify(withAttachment))
console.log('附件在正文前 :', attachedMsg.content[0] === fakeImage && attachedMsg.content.length === 2)

// 只有附件、没有文字也应当放行
const attachOnly = w1.handler({ ...invocation, rawInput: '', attachments: [fakeImage] })
console.log('仅附件返回   :', JSON.stringify(attachOnly))

// 空输入 + 无附件 = 真错误
const blank = w1.handler({ ...invocation, rawInput: '', attachments: [] })
console.log('空输入返回   :', JSON.stringify(blank))

// 命令定义必须声明 attachments，否则 composer 直接拒绝带附件的提交
const declared = definitions.every((d) => d.input && d.input.attachments === true)
console.log('已声明附件   :', declared)

// 重名保护：register 抛异常时只跳过该条，不能让整棵插件树挂掉
const conflicted = []
apply({
  commands: {
    register: (def) => {
      if (def.name === 'w1') throw new TypeError(`command "${def.name}" is already registered`)
      conflicted.push(def.name)
    },
  },
})
const survivedConflict = conflicted.includes('w0') && conflicted.includes('w2')
console.log('\n冲突时仍注册 :', JSON.stringify(conflicted))

// --- 自动发现：目录里除 0/1/2 之外的 md 也应注册出来 ---
const cmdNames = definitions.map((d) => d.name)
const LEGACY = ['w0', 'w1', 'w2', 'post', 'oddba']
console.log('\n发现额外模板:', cmdNames.filter((n) => !LEGACY.includes(n)).join(', ') || '(无)')

// --- @include 片段与运行时变量 ---
const today = new Date().toISOString().slice(0, 10)
console.log('片段残留    :', body.includes('@include') ? 'FAIL 仍有 @include' : '已全部展开')
console.log('参数残留    :', /\{\{/.test(body) ? 'FAIL 仍有 {{}}' : '已全部替换')
console.log('$DATE       :', body.includes(today) ? '已注入 ' + today : '未注入')
console.log('$MODEL      :', body.includes('$MODEL') ? '未知（invocation 未带 model，属预期）' : '已替换')

// --- 独立 fixture 目录：验证 DSH_WORKFLOW_DIR 覆盖 + 缺片段报错 + 自动发现边界 ---
const fix = mkdtempSync(join(tmpdir(), 'wcm-selftest-'))
mkdirSync(join(fix, '_fragments'))
mkdirSync(join(fix, 'nested'))
writeFileSync(join(fix, 'README.md'), '# 说明\n不是命令模板\n')
writeFileSync(join(fix, '0.md'), '数字开头不可注册，只走别名\n')
writeFileSync(join(fix, 'hello.md'), '---\ndescription: 自发现示例\n---\n\n值=$VALUE / 日期=$DATE / 任务=$ARGUMENTS\n')
writeFileSync(join(fix, 'uses-frag.md'), '@include frag 色=青\n')
writeFileSync(join(fix, 'nested', 'deep.md'), '不该被扫到\n')
writeFileSync(join(fix, '_fragments', 'frag.md'), '这是{{色}}色的片段\n')
writeFileSync(join(fix, 'broken.md'), '@include 不存在的片段\n')
const probe = [
  "const m = await import('./lib/index.js');",
  "const inv = { rawInput: '做点事', attachments: [], agent: {} };",
  "const r = (f) => m.renderTemplate(f, inv);",
  "console.log(JSON.stringify({",
  "  specs: m.buildSpecs().map((s) => s.name),",
  "  hello: r('hello.md'), usesFrag: r('uses-frag.md'), broken: r('broken.md'),",
  "}));",
].join('\n')
const child = spawnSync(process.execPath, ['--input-type=module', '-e', probe], {
  encoding: 'utf8',
  cwd: new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
  env: { ...process.env, DSH_WORKFLOW_DIR: fix },
})
let fx = null
try { fx = JSON.parse(child.stdout.trim().split('\n').pop()) } catch { /* 下面判 FAIL */ }
console.log('\nfixture 目录 :', fix)
console.log('fixture 结果  :', child.status === 0 ? JSON.stringify(fx) : '子进程 exit ' + child.status + ' ' + child.stderr)

const checks = [
  ['五条历史命令都在', LEGACY.every((n) => cmdNames.includes(n))],
  ['自动发现带出额外模板', cmdNames.length > LEGACY.length],
  ['未注册 README', !cmdNames.includes('readme')],
  ['未注册数字开头的 0', !cmdNames.includes('0')],
  ['未占用内核名 plan', !definitions.some((d) => d.name === 'plan')],
  ['@include 已全部展开', !body.includes('@include')],
  ['片段参数已全部替换', !/\{\{/.test(body)],
  ['$DATE 已注入真实日期', body.includes(today)],
  ['$ARGUMENTS 已替换', !body.includes('$ARGUMENTS')],
  ['fixture: DSH_WORKFLOW_DIR 生效', !!fx && fx.specs.join(',') === 'broken,hello,uses-frag,w0,w1,w2,post,oddba'],
  ['fixture: 自动发现跳过嵌套目录', !!fx && !fx.specs.includes('deep')],
  ['fixture: 变量注入正确', !!fx && !fx.hello.error && fx.hello.text.includes(today) && fx.hello.text.includes('做点事')],
  ['fixture: 片段参数生效', !!fx && !fx.usesFrag.error && fx.usesFrag.text.includes('这是青色的片段')],
  ['fixture: 缺片段返回 error', !!fx && !!fx.broken.error && fx.broken.error.includes('不存在的片段')],
  ['renderTemplate 对缺模板报错', renderTemplate('nope.md', invocation).error?.includes('读不到模板') === true],
  ['命令声明了 attachments', declared],
  ['首次调用投递 1 条消息', firstCount === 1],
  ['消息是 user 角色', msg.role === 'user' && msg.source.kind === 'user'],
  ['任务描述已注入', body.includes('给 launcher 加托盘图标')],
  ['占位符已替换', !body.includes('$ARGUMENTS')],
  ['frontmatter 已剥离', !body.startsWith('---')],
  ['空任务报错', empty.kind === 'error'],
  ['附件进消息且排在正文前', attachedMsg.content[0] === fakeImage],
  ['仅附件放行', attachOnly.kind === 'success'],
  ['空输入 + 无附件报错', blank.kind === 'error'],
  ['重名冲突不中断其余注册', survivedConflict],
]

console.log('\n=== 结果 ===')
for (const [label, pass] of checks) console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}`)
process.exit(checks.every(([, p]) => p) ? 0 : 1)
