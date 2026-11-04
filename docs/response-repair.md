# 响应修复层：控制协议还原与空完成包判定

> 起因：走 OpenCode GO 网关（`opencode.ai/zen/go`）时，模型的控制协议会被当成普通文本解码回来。
> 两类现象都表现为"这一轮看起来成功结束了，但其实什么都没产出"：
>
> - **形态退化（问题 A）**：工具调用的标记文本落进正文/思考通道，工具没执行，模型自问自答，甚至伪造工具结果、复读跑飞。
> - **内容退化（问题 B）**：完成包里只有思考、没有正文也没有工具调用，却被当成正常 `stop`，整轮静默结束、不重试。

## 落点

| 文件 | 职责 |
|---|---|
| `lib/dsml.js` | 纯函数：识别标记、还原工具调用、清洗控制符、拦截伪造结果 |
| `lib/repair.js` | 流式状态机：按通道前瞻缓冲、转换或原样透传、退化护栏、计数 |
| `lib/pi-wire.js` | `streamVia` 接入修复层；`mapStopReason` 判空；`toPiContext` 回放清洗 |

> 源码约定：DSML 的全角竖线（U+FF5C）、句首块字符（U+2581）在 `lib/dsml.js` 里一律写成 JS 转义。
> 这两个字形与 ASCII 竖线肉眼难分，某些编辑器/传输会把它改坏，改坏后标记就再也匹配不上。

## 问题 A：标记还原

`RepairStream` 对 `text` / `reasoning` 两个通道同权处理：

1. 没看到标记前缀 → 立刻转发（首字延迟不受影响），只保留"可能是标记开头"的尾部；
2. 看到标记 → 缓冲到块闭合（上限 32 KB）；
3. 通过安全闸门 → 丢弃标记文本，合成标准工具调用事件（`block-start` → `tool-call-delta` → `block-end`）；
4. 闸门不通过 / 块被截断 / 解析失败 → **原样透传，一个字符都不丢**。

安全闸门（宁可不转，也不误吞）：块必须完整闭合；工具名必须出现在本次请求的 `tools` 里；块长不能超过 32 KB；参数必须是合法 JSON。

支持的形态：DSML `invoke`/`parameter`（含包装块与孤立残片）、Qwen `<tool_call>{json}</tool_call>`、Qwen `<function=…><parameter=…>`、GLM `<tool_call><name>/<parameters>`。

伪造结果：`tool_result` 标记 + 紧随的 JSON 整块删除，替换为"（已截获模型伪造的工具结果）"，**不生成任何工具调用**。

回放清洗：`toPiContext` 在把 assistant 历史写回上游前清掉标记。历史就是模型的示例，留着标记等于教它继续这么写；只清标记，不改用户/工具内容，也不动 DeepSeek 需要的 `reasoning_content` 回传。

## 问题 B：空完成包判定

旧逻辑只把 `content.length === 0` 当空响应，而 pi-ai 会把 `reasoning_content` 解码成一个 `thinking` 块，于是"只有思考"的完成包被判成正常结束。

现在判空看的是**实际产出的内容**（`RepairStream.evidence()`），不看 `content` 数组：

| 上游返回 | 判定 |
|---|---|
| 有正文 | `stop` |
| 无正文，但有工具调用（原生或还原出来的） | `tool-calls` |
| 没有正文、没有工具调用（可能只有思考） | `EMPTY_RESPONSE` → 走既有重试策略 |
| `finish_reason = length` | `max-tokens`（不混成空响应） |

`EMPTY_RESPONSE` 本来就在 `adapter.js` 的 `retryableCodes` 里，所以重试由 harness 统一负责；重试仍为空时，界面会出现明确错误，而不是静默成功。

**上下文过大时的特例**：实测这条网关在 prompt 约 30 万 token 后会只给思考、不给正文，而且重试同一 prompt 会稳定复现（`session-c4ba70c2` turn 8 的 4 次尝试全部如此）。因此当 `EMPTY_RESPONSE` 且 prompt ≥ 29 万 token 时，错误文案会直接说明"~299k-token prompt，网关只会返回思考内容，请压缩会话或新开"，而不是笼统的"没有回答"——因为这种情况下重试没有意义，用户需要的是换上下文。

> 相关：该路由在目录里声明 `contextWindow: 1000000`，而实际约 30 万就开始退化。若想从根上避免，可把该模型声明的上下文窗口调低到实际可用值，让 harness 提前压缩。

## 问题 A'：假的 `length` 截断

网关还有第三种坏包：流开始几百毫秒就结束，却把 `finish_reason` 标成 `length`。

真实样本（`session-95634b48` turn 20）：正文 **162 字符**、断在代码块中间、用时 **315 ms**、`usage` 整个缺失，而这次请求允许 32768 输出 token。照实转成 `max-tokens`，界面就会提示"已达到输出 token 上限"，把一次**被截断的半截答案**说成"你的回答太长"，下一轮还会把它当完整答案继续推理。

`suspectUpstreamTruncation()` 在三个条件同时成立时把它改判成可重试的 `PROVIDER_ERROR`：

1. 上游 `stopReason` 确实是 `length`；
2. 整条流用时 < 3 秒；
3. 正文很短（非空白字符 ≤ 1500）**且**上报的输出 token 缺失或不足请求上限的 10%。

三条都满足才动手：漏判只是保留旧提示（无害），误判要多花一次重试和它重新生成的 token。小预算请求（会话标题等辅助调用，上限 < 4096）一律不参与——它们上限本来就小，真截断与假截断无法区分。

## 开关

| 环境变量 | 作用 | 默认 |
|---|---|---|
| `DSH_OPENCODE_GO_REPAIR=off` | 整层关闭，行为回退到修复前 | 开启 |
| `DSH_OPENCODE_GO_KEEP_SPECIAL_TOKENS=1` | 保留字面控制符（排障时看原样） | 关闭 |
| `DSH_OPENCODE_GO_REPAIR_DEBUG=1` | 每条流结束打一行计数 | 关闭 |

计数项：`dsmlConverted`、`dsmlUnparsed`、`specialTokensStripped`、`fabricatedResults`、`degenerateAborts`、`emptyCompletions`、`suspectTruncations`。没有计数就无法判断"修好了没有"。

## 退化护栏

同一单元连续重复 ≥32 次，或单通道累计超过 100 000 非空白字符 → 主动结束流并给出 `max-tokens`（不是 `stop`），让上层知道这是被截断的，而不是正常完成。

## 测试

```bash
node --test
```

- `test/dsml.test.js`：解析器与清洗的单元用例（含负向：未声明工具、截断块、普通正文里的标记字样）。
- `test/repair.test.js`：流式状态机（逐字符喂入、跨 delta 标记、伪造结果、退化护栏、开关关闭时逐字节一致）。
- `test/stream-repair.test.js`：端到端，走真实 adapter → pi-ai 解码 → harness chunk，覆盖问题 A/B 的正负用例。
- `test/fixtures/*.json`：三份真实事故样本（正文形态、思考形态、伪造结果）。标记字符在 fixture 里用 `\uFF5C` 转义存储，文件保持 ASCII。
