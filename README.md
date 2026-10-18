# dsh-workflow-commands

Bridge markdown prompt templates into DSH slash commands — with shared `@include` fragments, and a **per-step request-budget injector** for agents that are billed per request.

## Why this exists

If your provider bills **per request**, the only cost variable is how many requests you send. In an agent loop one request is one *model step*: the model replies (possibly carrying a single tool call), the tool result comes back, and that is another billed request. A single conversational turn can therefore burn dozens of requests.

We measured 59 real sessions:

| Metric | Value |
| --- | --- |
| Billed requests | 3,338 |
| Tool actions dispatched | 3,586 |
| **Actions per request** | **1.07** |
| Requests carrying exactly one tool call | 93% |

So 93% of the spend went to requests that did exactly one thing. Prompt-level rules such as *keep it under 25 turns* do not help: a model cannot count requests. In those same 59 sessions the template line *report your actual turn count* was executed **zero** times.

This plugin attacks both halves:

1. **Template bridge** — a folder of markdown files becomes slash commands, and shared paragraphs live in one place via `@include`.
2. **Request-budget injector** — once a workflow command fires, `[R n/budget]` is injected into the runtime context on every model step, so the model can see what it has already spent. Sub-agents are adopted automatically, and the parent sees the whole-tree total.

## What it does

### 1. Template bridge

Point it at a directory of markdown files and each one becomes a slash command:

| Template | Command |
| --- | --- |
| `0.md` | `/w0` |
| `1.md` | `/w1` |
| `2.md` | `/w2` |
| `commit.md` | `/commit` (auto-discovered) |

Templates are read **on every invocation**, so editing one takes effect immediately. Adding or removing a file requires a DSH restart, because the command registry is built in `apply()`.

Template directories are resolved in order: `DSH_WORKFLOW_DIR` → `~/.dsh/commands` → `~/.zcode/commands` (first one that exists).

Attachments are supported: drop images or files into the composer and they are delivered before the rendered body.

### 2. `@include` fragments

Keep shared paragraphs in `_fragments/<name>.md` and pull them in:

```markdown
@include budget 标题="Quota discipline" 标签="Long tasks"
```

- trailing `key=value` (or `key="value with spaces"`) pairs replace `{{key}}` inside the fragment; keys may be non-ASCII;
- fragments may include other fragments (max depth 8, cycles are rejected);
- a missing fragment is a hard error rather than a silently passed-through line.

### 3. Request-budget injector

After a workflow command runs, the plugin attaches a counter to that agent. From then on, every model step carries one line of runtime context:

```text
[R4/12] This is request 4 of this task. Every extra request costs money — batch independent actions into the same request.
```

With sub-agents in play, the parent sees the whole tree:

```text
[R10/12 · tree 15 (over budget)] main agent request 10; 2 sub-agents burned 5 more.
```

Sub-agents get their own counter, so they feel the cost too. The budget comes from the template frontmatter key `r-budget` (falling back to 20).

## Install

```bash
dsh plugin --profile <profile> add "file:/absolute/path/to/dsh-workflow-commands"
# or, from a git checkout
dsh plugin --profile <profile> add "git+https://github.com/dustinmoon78/dsh-workflow-commands.git"
```

Then restart the DSH desktop shell. Local `file:` installs are copied as real directories, so after editing the source you must re-sync the copy under `node_modules/` and restart again.

## How the injector works

This is the interesting part, and it leans on three internal DSH extension points:

1. **Channel** — the `systemPrompt` service (`dsh-system-prompt`) exposes `context({ name, order, text })`, where `text` may be a function receiving the agent. Its own doc comment says these are *the prompt inputs assembled before each model step*.
2. **Anchor** — the `agent/pre-step` event carries `{ agent, messages, signal, step }`. Note the ordering trap: within step N, `assemble()` (which renders `text`) runs *before* that event, but what actually lands in the message history is the `refreshContext()` render inside `step()`. By then the counter is current, so the callback can return `state.step` directly — no off-by-one.
3. **Scope** — registration happens on `agent.ctx`, not the global context, so only agents started through a workflow command are affected. Ordinary chats are untouched.

Descendants are found through the `agents` service: `isOwnedBy(id, owner)` only answers for direct children, so the plugin walks the owner chain breadth-first. Totals are kept in a monotonically increasing ledger keyed by agent id, because a finished sub-agent is garbage-collected out of the registry — summing live agents only would make the total go *down* when a sub-agent ends.

### Degradation

The injector is strictly best-effort:

- if `agent.ctx` or `systemPrompt` is unavailable it returns `null` and injects nothing — the command still delivers its template;
- counting is wrapped in `try/catch` so it can never break the agent loop;
- the `agent/pre-step` handler always calls `next()`, so the waterfall chain is never truncated.

## Compatibility

The injector depends on **internal** DSH extension points (`systemPrompt.context`, the `agent/pre-step` event, the `agents` service). They are used by the core itself but are not a stable public contract, so a DSH upgrade may break the injector. It degrades silently rather than failing loudly — check that `[R n/budget]` still appears after upgrading.

Developed against DSH 0.2.x. The template bridge half has no such dependency and only needs the `commands` service.

## Development

```bash
node test.mjs   # zero dependencies, runs against a temporary fixture directory
```

The test suite covers `@include` expansion, parameter substitution, runtime variables, frontmatter stripping, attachment handling, and command registration collisions.

## License

BSD-3-Clause. See [LICENSE](LICENSE).
