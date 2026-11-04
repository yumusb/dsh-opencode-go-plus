# OpenCode Go / Go Plus 用量口径参考

> 2026-11-04 实测 + 官方文档核对。基线：DSH 0.2.1-rc.5，`dsh-opencode-go-plus`（本 PR 构建），
> 网关 `https://opencode.ai/zen/go`。

这份文档回答一个问题：**"5 小时 / 每周 / 每月"这三个数到底是什么，怎么读，什么时候重置。**
插件里侧栏底部那枚圆环、以及它点开的卡片，就是按这里的口径显示的。

---

## 1. 三个窗口是什么

官方 `console/go` 的「Usage limits」原文：

> Usage limits are defined as monthly dollar amounts. Each model has the following usage limits:
> **5-hour — 20% of the monthly limit; weekly — 50%; and monthly — 100%.**
> Each model's monthly limit determines how its usage counts toward those allowances. Each response
> reports how much the request counted, as `opencode.allowance`.

因此：

| 窗口 | 额度 | 含义 |
|---|---|---|
| `rolling`（5 小时） | 该模型月额度的 **20%** | 滑动窗，用来防突发；窗口内消耗到 20% 就停 |
| `weekly`（每周） | 月额度的 **50%** | 一周内的总消耗不得超一半月额度 |
| `monthly`（每月） | 月额度的 **100%** | 整个计费周期的总上限 |

三个窗口是**比例**关系而不是三个独立钱包：某模型月额度 $15，则 5 小时窗 $3、周窗 $7.5、月窗 $15。
`percent` 是该窗口额度的**已用比例**（网关与 console 都说 "used"），不是剩余。

**套餐差异**：Go / Go Plus / Go Teams 的窗口结构完全一样，区别只在每个模型的**月额度美元数**
（Go Plus 更高，Go Teams 每人一份）。所以插件显示的是百分比，而不是美元 —— 同一套 UI 对三种套餐都成立。

**超额兜底**：Console 里可以打开 **Extra Usage**，用余额在触顶后继续付费调用（Go Teams 默认开）。
没开时触顶就是 `rate-limited`。

---

## 2. 数据源：`GET {baseURL}/usage`

```
GET https://opencode.ai/zen/go/v1/usage
authorization: Bearer <本订阅的 API Key>
accept: application/json
```

实测（2026-11-04 00:16 +08:00，本站真实 Key）：

```json
{
  "usage": {
    "rolling": { "status": "ok", "percent": 1, "resetsAt": "2026-11-03T21:06:55.000Z" },
    "weekly":  { "status": "ok", "percent": 0, "resetsAt": "2026-11-09T00:00:00.000Z" },
    "monthly": { "status": "ok", "percent": 0, "resetsAt": "2026-12-03T13:15:46.000Z" }
  }
}
```

字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `usage.rolling/weekly/monthly` | object | 三个窗口；未知窗口名应忽略（网关以后可能加） |
| `.status` | string | 实测 `ok`；触顶时为 `rate-limited`。**按原样保留**，不要预判 |
| `.percent` | number | 该窗口已用百分比，0–100 |
| `.resetsAt` | ISO 8601 | 该窗口**重置时刻**（UTC） |

另一条可用路径：`https://opencode.ai/inference/go/v1/usage`（同样 200，同一份内容）。
`/zen/go/usage`、`/inference/go/usage`（无 `v1`）是 404，别用。

**鉴权失败**长这样：`401 {"type":"error","error":{"type":"AuthError","message":"Unauthorized"}}`。
无 Key 时同理。这与聊天接口的 `401 Invalid credential` 是两套文案，别把两者混为一谈。

---

## 3. `resetsAt` 的真实语义（实测推断）

| 窗口 | 观测值（本次） | 相对本次探测时间（00:16 +08:00） | 结论 |
|---|---|---|---|
| rolling | `2026-11-03T21:06:55Z` | +4h51m | 不是"整点"，是**窗口内最早那次消耗 + 5 小时**；消耗一停，这串时间就往前滑 |
| weekly | `2026-11-09T00:00:00Z` | +5d07h（周一 08:00 本地） | **自然周对齐**：周一 00:00 UTC |
| monthly | `2026-12-03T13:15:46Z` | +29d21h | **订阅周期锚点**（11-03 13:15:46 的次月同刻），不是自然月 1 号 |

所以 UI 上三种窗口的重置时间形态天然不同：5 小时是"从现在起算"的短倒计时，周/月是固定锚点。
面板按 Codex 的写法处理：**24 小时内给钟点（`13:30`），更远给日期（`11月9日`）**，悬停给完整本地时间。

> 注意：`rolling` 的 +5h 是**随消耗移动**的，因此"4h51m 后重置"意味着你还有近 5 小时的窗没用满；
> 一旦你继续请求，这个时刻会被推后。别把它当固定日程。

---

## 4. 插件里的映射

一行 + 一张卡片：

- **侧栏底部**：头像行右下角一枚 26px 的双半圆环 —— **上弧 = 5 小时窗口，下弧 = 一周**，弧长即用量，
  中心是 OpenCode 标志。**单色**（次要文字色）；某窗口触顶或 100% 时整环灰显（"空了"，不是"报警"）。
- **悬停**半弧：该半弧加粗并浮出 `20% 5h` / `88% 周` 的提示（单位取字典的短标签）。
- **点击**：强制刷新一次，并从环的**上方**浮出卡片（右对齐环、自动收在视口内；不覆盖侧栏其它行）。
- **卡片**：标题 + 右上角 `↗` 打开 `https://opencode.ai/console/`；三行 = 5 小时 / 每周 / 每月，
  每行「标签 | 百分比 | 重置时间」，限额那行把「重置时间」换成「已达限额」；页脚「更新于 HH:mm」。

| 界面元素 | 数据 |
|---|---|
| 环·上弧 | `rolling.percent` |
| 环·下弧 | `weekly.percent` |
| 环·中心 | OpenCode 标志（`currentColor`） |
| 卡片三行 | `rolling / weekly / monthly` 的 `percent` + `resetsAt` |
| 某行「已达限额」 | 该窗口 `status === "rate-limited"` |
| 页脚「更新于」 | `fetchedAt`（Intl 按 harness 语言格式化） |
| 右上角 `↗` | `https://opencode.ai/console/`（浏览器里登录，插件不代持账号） |

设计约束（下一轮改版别破掉）：

- 环上**没有数字文字**：读数靠弧长 + 悬停；限额靠灰显和卡片里的行内文案，**不用彩色**（色盲友好，也不抢注意力）。
- 只有卡片里的标签可以截断；百分比与重置时间永远完整。
- 时间一律交给 `Intl`，语言来自 `ctx.locale`。
- 圆环挂在侧栏底部区块里、绝对定位到右下角（不改那一行原有布局；容器非 relative 时临时提升，卸载还原）。
  当成包含块导致错位。

刷新与缓存：

- 自动刷新 **每 3 分钟**一次（页面隐藏时不刷）；点开卡片时额外强制刷新一次；
- **宿主侧 30 秒 TTL + 单飞**：同一时刻最多一次上游请求；
- 探测失败**保留上一次成功读数**，卡片页脚写状态，环按旧数据画；
- Key 只在宿主侧使用，浏览器只拿到百分比与时间。

**不做本地记账**：网关是唯一的额度真相。本地按 token 估算美元既不准（峰谷价、长上下文价、
缓存价各不相同），也会和网关打架。

---

## 5. 排错

| 面板显示 | 原因 | 处理 |
|---|---|---|
| 未配置 API Key | `OPENCODE_GO_API_KEY` 没有值 | 设置 → 插件 → 本插件卡片里填 Key，或写 `~/.dsh/.credentials.yaml` 的 `refs` |
| 凭据无效 | 网关 401/403（Key 错、被吊销、或订阅已过期） | 去 Console 重新复制 Key |
| 暂不可用 | 超时/网络/非 2xx/响应不合契约 | 看 DSH 日志；直连可用性见 `network-and-quota.md` |
| 五个数值全是 `—` | 响应里没有对应窗口 | 网关改过契约；抓 `GET /v1/usage` 原文核对 |
| 数字长时间不动 | 页面隐藏（后台标签页不轮询） | 切回前台即刷新，或点「刷新」 |

---

## 6. 采集证据（可复现）

```powershell
# 只读探测三个候选端点（本机 Key 从 ~/.dsh/.credentials.yaml 的 refs 读取）
curl.exe -s -H "authorization: Bearer $env:OPENCODE_GO_API_KEY" https://opencode.ai/zen/go/v1/usage
```

本次记录（2026-11-04 00:16 +08:00）：

| 端点 | 状态 | 备注 |
|---|---|---|
| `/zen/go/v1/usage` | 200 | 本文样本 |
| `/zen/go/usage` | 404 | HTML 落回控制台页面 |
| `/inference/go/v1/usage` | 200 | 与上者同内容 |
| `/inference/go/usage` | 404 | — |

官方文档：<https://opencode.ai/v2/docs/console/go>（Usage limits / Estimated requests / Usage beyond limits）；
每次响应里的额度记账字段见 <https://opencode.ai/v2/docs/console/api/inference>（`opencode.allowance`、
`opencode.billing_source` = `go` / `go-plus` / `go-teams`）。
