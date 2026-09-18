# dsh-opencode-go-plus

[English](README.md) | 中文

DSH 的 OpenCode GO 插件。模型清单和能力都是实时读的，不依赖 DSH 包里那份快照，所以一条路由就能用上网关的全部模型，不管它讲哪种协议。

它有自己的路由，可以和已有的 OpenCode GO 路由并存，方便对比。迁移见[下文](#怎么从自带的那条迁移过来)。

适用 DSH `0.1.6-alpha.1`。

## 为什么不直接用 DSH 自带的？

DSH 自带一个 LLM 适配器 `llm-pi-ai`（包名 `@deepseek-ai/dsh-llm-pi-ai`）。它默认什么都不做：设置里没有 `llm-pi-ai.providers.<route>` 之前，一条路由都不注册。刚装好的 DSH 里没有 OpenCode GO。

但它加一条很方便。pi-ai 自带一份模型目录，**设置 → 模型**会把这些 provider 全列出来让你点，`opencode-go` 就在里面。点一下就往 `llm-pi-ai.providers.opencode-go` 写一条，路由随即生效。

如果你用的就是这条，那它接这个网关有两个问题。

### 1. 模型清单是写死的

`llm-pi-ai` 的「获取可用模型」读的是 pi-ai 的**内置目录**，那是跟着 npm 包发出去的一个 JSON 文件。`opencode-go` 在里面，所以那个按钮连网都不上，直接把文件里的列表给你。

网关在两次 DSH 发版之间新增、改名、下架的模型，都要等 DSH 下次发版才看得见。而且没东西可刷新，因为它根本不联网。

本插件是运行时去读 OpenCode 发布的目录（`models.dev`，OpenCode 自己也用这份），挂载时读一次，每次获取再读一次，看到的就是网关现在的样子。已启用的模型会完整存在你的设置里，断网也能用。

### 2. 协议只能写在路由上

网关同一个地址后面有好几种协议，用错了直接失败：`union-alpha` 走 chat completions 报 **HTTP 500**，`grok-4.6` 报 **`not supported for format oa-compat`**。

协议本该从目录里读。但过期的目录不认识新模型，这种模型就没有协议。而 `llm-pi-ai` 只能在**路由**上指定协议，一指定就会盖掉这条路由下所有模型从目录读到的值。

所以不同协议的模型没法放在一条 `llm-pi-ai` 路由里，你得每种协议开一条，还得记住哪个模型归哪条。本插件是按**模型**定协议的，一条路由就够。能做到这点，前提正是元数据是实时的——所以这两个问题其实是一个。

## 有什么好处

- **模型和能力实时读**，想刷新就刷新，不用等 DSH 发版。
- **一条路由吃下所有协议**，不用开第二条，也不用记哪个模型归哪条。
- **不动 DSH 的文件。** 网关不认没有 `x-opencode-session` 的请求（HTTP 400）。会话 ID 由适配器自己发，不用装 fetch 包装，升级也不会被覆盖。
- **一张卡片全搞定。** 网关地址、API key、真能验出 key 对不对的连接测试、模型启用清单，带搜索、筛选、全选/反选和未保存提示。
- **能发现重复路由。** 要是在别处也配了 OpenCode GO，模型在选择器里会出现两次，卡片认得出并可以一键删掉多的那条。
- **中英双语。** 卡片文字和选择器里的能力标记跟着 DSH 的语言走。

## 工作原理

```text
settings: dsh-opencode-go-plus          本插件自己的命名空间
  ├── providerRoute / baseURL / apiKeyEnv / modelSource
  ├── retries / timeoutMs / defaultContextWindow / defaultMaxTokens
  └── models: [{ id, name?, contextWindow?, maxTokens?, input?, reasoning?, efforts?, api? }]

credentials: apiKeyEnv 引用（卡片写入，浏览器看不到）

ctx.llm.registerAdapter([providerRoute], OpenCodeGoAdapter)
```

本插件只注册适配器，**不往 DSH 的可配置 provider 目录里注册**。原因见[疑难](#疑难)。

### 协议编码

协议本身全部交给 [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai)（MIT）编码，也就是 DSH 官方 `llm-pi-ai` 用的同一个库，本插件一个都不自己实现。

`lib/pi-wire.js` 只做三件事：按模型挑协议、把 DSH 的对话转成 pi-ai 的 `Context`、把 pi-ai 的事件流转回 DSH 的 `StreamChunk`。这层转换跟协议无关，所以只写一份，不用写三份。

### 模型元数据

网关的 `GET /v1/models` 只返回 `id` / `object` / `created` / `owned_by`，没有任何能力信息，`/v1/models/{id}` 也是 404。

所以模型的信息来自 OpenCode 发布的目录（`https://models.dev/api.json` 里的 `opencode-go`），每个模型的协议就用它的 AI SDK 包名表示。优先级从高到低：

1. 你在 settings 里明确写的那条
2. 实时的公开目录
3. 都没有——协议不知道就直接报错，不猜

没有内置的模型表。卡片写回 settings 的是**完整条目**（含协议），所以目录连不上时，已启用的模型照样能用。

## 环境要求

- 装好 DSH，`web` profile 至少启动过一次
- Node.js ≥ 18
- OpenCode GO 订阅和 API key

## 安装

```bash
# 发布后从 npm 安装
dsh plugin --profile web add dsh-opencode-go-plus

# 或者从本地 checkout 安装
dsh plugin --profile web add "$PWD"
```

然后重启 `dsh web`，浏览器硬刷新。

## 使用

打开 **设置 → 插件 → 插件配置 → "OpenCode GO Plus"**：

| 控件 | 作用 |
|---|---|
| 网关地址 + API key | 直接填了保存。地址进 settings，key 进凭据存储。 |
| 测试连接 | 测的是**输入框里当前的值**，保存没保存都行，所以可以先验 key 再决定要不要存。对当前用到的每种协议各发一次请求，告诉你 key 到底能不能用。测的是未保存的值时，结果里会写明。 |
| 获取可用模型 | 拉网关的实时列表当候选，已启用的自动勾上。 |
| 搜索 / 筛选 | 按 id 或名字找；在 全部 / 已启用 / 未启用 之间切。 |
| 全选 / 反选 / 清空 | **只对当前看得见的那些生效**。搜索完再点全选，不会把整张表都勾上。 |
| 启用所选 / 停用全部 | 只写入勾上的 id。全都不勾也是正常状态，等于全部停用。 |

模型选择器里这个 provider 叫 **OpenCode GO Plus**，和官方的 `OpenCode GO` 区分开。

保存和测试互不影响：保存只负责写入，测试只负责验。key 输入框留空，两边都表示「沿用已存的 key」。所以不用纠结先后 —— 填好、测通、再保存就行。

在对话里输入 `/opencode-go-plus-refresh` 可以全量同步一次。

## 配置参考

`~/.dsh/settings.yaml` 里的 `dsh-opencode-go-plus` 分节（用卡片改也行）：

| key | 默认 | 说明 |
|---|---|---|
| `providerRoute` | `opencode-go-plus` | 本适配器占用的路由键 |
| `baseURL` | `https://opencode.ai/zen/go` | 网关地址（版本段按协议自动补） |
| `apiKeyEnv` | `OPENCODE_GO_API_KEY` | 凭据引用，密钥在 `~/.dsh/.credentials.yaml` |
| `modelSource` | `catalog` | `catalog` 提供目录里的全部模型，`selected` 只提供 `models` 里的 |
| `retries` | `3` | 瞬时失败重试几次（聊天请求也用这个） |
| `timeoutMs` | `15000` | 读目录和拉网关列表的单次超时 |
| `streamTimeoutMs` | `300000` | **聊天**请求的单次超时。必须显式设置：否则 Anthropic SDK 会用自己 10 分钟的默认值，连接卡住时整轮就一直挂着，而不是及时失败进入重试 |
| `defaultContextWindow` | `262144` | 目录没写容量时用这个上下文窗口 |
| `defaultMaxTokens` | `32768` | 每次**请求**要多少输出，不是模型能力 |
| `models` | `[]` | 启用清单，含义看 `modelSource` |

`modelSource` 是为了区分空数组的两种意思，免得「全都不勾」被当成「还没选」：

| `modelSource` | `models` | 实际提供 |
|---|---|---|
| `catalog`（默认） | `[]` | 实时目录里的全部模型 |
| `catalog` | 非空 | 只有这些 |
| `selected` | `[]` | **一个都不提供** |
| `selected` | 非空 | 只有这些 |

条目字段：`id`（必填）、`name`、`contextWindow`、`maxTokens`、`input`（`["text","image"]`）、`reasoning`、`efforts`（思考档位，档位 id 就是要发出去的值）、`offWire`（关闭档位实际发什么，比如 `hy3` 要发 `"none"`）、`api`（`openai-completions` / `anthropic-messages` / `openai-responses`）。

## 怎么从自带的那条迁移过来

**什么都不用先删。** 本插件占用的路由键是 `opencode-go-plus`，自带那条一般叫 `opencode-go`。键不一样就能共存，模型选择器里两条都会列出来，你可以并排试，再决定留哪个。

凭据引用一样（都是 `OPENCODE_GO_API_KEY`），一份 key 两边都能用。

最省事的做法是完全不搬模型字段：在卡片上填好网关地址和 key，点 **获取可用模型**，勾上要的就行。名字、容量、模态、协议都会从目录补全。

真要整段复制的话，这些字段原样能用：`baseURL`、`apiKeyEnv`、`models[].id`、`models[].name`、`models[].contextWindow`、`models[].maxTokens`、`models[].input`。

三处不一样：

| `llm-pi-ai` | 本插件 | 为什么 |
|---|---|---|
| `api`（路由级） | `api`（**每个模型一个**） | 本插件的核心：一条路由跑多种协议。目录里已经写好了，基本不用自己填。 |
| `models[].reasoningEfforts`（`{high: "high"}`） | `models[].efforts`（`["high"]`）加 `offWire` | 档位 id 就是要发出去的值，只有「关闭」需要单独说明。 |
| `models[].compat` | 不支持 | pi-ai 适配层的东西，这里没有对应概念。 |

还有两处行为不一样：

- **`input: []` 是「听目录的」**，和 pi-ai 一样（它的 `declaredInput` 遇到空数组返回 `undefined`）。照抄 `input: []` **不会**把图文能力弄丢。
- **`maxTokens` 是模型上限，不是请求上限。** pi-ai 会把显式写的 `maxTokens` 当成每次请求要的输出；本插件的请求上限是 `defaultMaxTokens`（默认 32768），再按模型上限裁一下。直接填模型上限，等于每发一次请求就找网关要那么多输出。

### 怎么把旧的那条删掉

**默认没什么要关的。** `llm-pi-ai` 本来就不注册路由，`opencode-go` 是因为你加过才存在。跑通本插件后你也可以留着，只是同一个网关上挂了两个 provider，共用的模型在选择器里会列两次。

卡片会自己发现：OpenCode GO 要是配在别处，卡片会写出来，并给一个**删掉 xxx** 的按钮。它只删那一条，同一份配置里别的东西（包括别的 provider）都留着。插件启动时也会往日志里写一条，因为重复是出现在模型选择器里的，你不一定会去开那张卡片。

判断依据是**这条路由配没配**，不是看地址：`opencode-go` 就是 OpenCode GO，指官方域名还是反代都算；完全没填内容的路由（`opencode-go: {}`，也就是在设置→模型 里点一下加出来的样子）也算，因为它照样服务整个目录。只是 pi-ai **能加但你没加**的 provider 不算。

**唯一要先确认的：** 如果默认模型还指着要删的那条路由，下一次请求会直接报 `NO_ADAPTER`（`no adapter registered for provider "opencode-go"`）。先把默认模型改到本插件的路由（`opencode-go-plus`）或别的 provider，再删。默认模型还指着它的时候，卡片会**拒绝删除**，不会给你留个坏掉的默认值。

想自己动手也行：**设置 → 模型**里有删除按钮，或者从 `~/.dsh/settings.yaml` 里删掉 `llm-pi-ai.providers.opencode-go` 整段。

两种办法都不碰凭据：两条路由读的是同一个 `OPENCODE_GO_API_KEY`，删了旧的也不影响本插件。

## 疑难

- **「设置 → 模型」里为什么没有它？** 那个页面只认它自己写死的两种布局（`llm-deepseek`、`llm-pi-ai`），别的插件一律只显示一句「请编辑 settings.yaml」，一个可编辑的字段都不给。硬塞进去只会多一条点不动的死条目，所以本插件不去注册。配置都用插件卡片——聊天里的模型选择器读的是适配器注册表，跟那个页面没关系，什么都不缺。
- **模型报 "has no known wire protocol"。** 它存下来的条目里没有 `api`，当时目录又连不上。联网时在卡片里启用一次（会记下协议），或者直接给这条加上 `api`。
- **`Invalid API key` / 401。** key 不对，或者订阅过期了。用卡片上的测试连接确认。
- **模型被 403 拒绝（政策或地区）。** 网关把政策拦截报成 `DataPolicyError`，把地区封锁报成 `RegionError`，状态码都是 403。这两种都不是凭据问题，所以插件不把它们归到 `AUTH`——而 `AUTH` 恰好是 DSH 聊天和轨迹界面唯一会替换成固定文案「API 密钥无效」的码，原文会被丢掉。这样一来真实报文就能到界面上，包括 `DataPolicyError` 里那条同意链接。403 是永久拒绝，不会重试。遇到 `DataPolicyError`，去报文里那个链接同意该模型的数据使用条款；遇到 `RegionError`，说明这个模型不在你所在地区提供服务。
- **某一轮报 "Connection error." / `PI_AI_ERROR`。** 提供方根本没回话——连接被断开，或反代卡住。这类会被判为 `TRANSPORT` 并按 `retries` 重试；`streamTimeoutMs` 限制单次尝试最多挂多久。
- **偶尔 503。** 网关上游池子时不时满，会按 `retries` 重试。
- **改了没反应。** 重启 `dsh web`，浏览器硬刷新。

## 许可

MIT
