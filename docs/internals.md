# 实现与协议取证（internals）

> 这份写给维护者：每个结论的来源、复现方式、以及**为什么这么做**。
> 用户看 [README](../README.md) 就够了。

## 1. 研究基线

| 项目 | 值 |
|---|---|
| Chatbox 客户端 | `1.23.5`（`app.asar`，2026-09-24 构建；反查时间 2026-11-03） |
| magpie 插件契约 | `magpie-plugin-scaffold` 0.3.7（HEAD `ab66e8f`）+ `HOOKS.md` |
| 探测账号 | Chatbox AI Free（`plan: "free"`） |
| 探测时间 | 2026-11-03 凌晨（+08:00） |

协议结论来自两处：`app.asar` 里 renderer / main 的压缩代码（`getChatboxHeaders`、`ChatboxAI` 类、
`ChatboxAILicenseDetailSchema`、`getChatboxAIModelList`），以及一次受控的真实请求探测。
原始响应与报告不在本仓库（含真实额度数字），只把**结论**写在这里。

## 2. 两套凭据

| 凭据 | 用在哪 | 怎么带 |
|---|---|---|
| `licenseKey`（uuid） | 全部 `/api/license/*`、`/api/chatbox_ai/model_list`、**全部 `/gateway/*`** | 裸值或 `Bearer`，按端点 |
| `accessToken` / `refreshToken` | `/api/user/*`、`/api/license/list_by_user` | `x-chatbox-access-token` |

`licenseKey` 就是 magpie 里的 `access`。邮箱登录只用来**找到** license：拿到 accessToken →
`GET https://chatboxai.app/api/license/list_by_user` → 取出 uuid → 之后一律只用 licenseKey。

## 3. 端点与网关（都是实测过的形状）

| 方法 | URL | 鉴权 | 说明 |
|---|---|---|---|
| GET | `https://api.chatboxai.app/api/license/detail/realtime` | `Authorization: <licenseKey>`（**裸**） | 额度 + 套餐；401 只可能是 `license_not_found` |
| POST | `https://api.chatboxai.app/api/license/validate` | 无 | `{licenseKey, instanceId}` → `{data:{valid}}`；**永远 200**，`instanceId` 不参与校验 |
| POST | `https://api.chatboxai.app/api/license/activate` | 无 | `{licenseKey, instanceName}` → `{data:{instanceId}}` |
| POST | `https://api.chatboxai.app/api/chatbox_ai/model_list` | 无 | `{licenseKey, language}`；**坏 key 也 200**，不能当校验用 |
| POST | `…/gateway/openai/v1/chat/completions` | `Authorization: Bearer <key>` | 全部模型都通，含 claude（服务端转协议） |
| POST | `…/gateway/openai-responses/v1/responses` | 同上 | `apiStyle: openai-responses` 的 5 个 gpt-6* |
| POST | `…/gateway/anthropic/v1/messages` | `x-api-key: <key>` | `apiStyle: anthropic` 的 Claude / Kimi / Qwen 条目 |
| POST | `…/gateway/google-ai-studio/v1beta/models/{id}:streamGenerateContent?alt=sse` | `x-goog-api-key: <key>`（实测 Bearer 也可） | `apiStyle: google` |
| POST | `https://chatboxai.app/api/auth/send_email_login_code` | 无 | `{email, lang}` → `data.result === "sent"` |
| POST | `https://chatboxai.app/api/auth/login_or_signup_with_email_code` | 无 | `{email, code}` → `data.access_token / refresh_token`（**body**） |
| GET | `https://chatboxai.app/api/license/list_by_user` | `x-chatbox-access-token` | 账号下的 license 列表 |

两个 origin 不要混：`chatboxai.app` 是 auth / user / license 列表；`api.chatboxai.app` 是 license 详情、
model_list、全部 gateway。

## 4. 为什么逐条声明 `api.npm`

magpie 的协议判定只看**模型条目的 `api.npm`**（契约里没有 `apiStyle`）：

```
openai            → @ai-sdk/openai-compatible
openai-responses  → @ai-sdk/openai
anthropic         → @ai-sdk/anthropic
google            → @ai-sdk/google
```

同时 `loader()` **不能返回 `baseURL`**：它优先级高于 `model.api`，写了就把四条网关压成一条。
所以 `loader()` 只给 `apiKey` / `headers` / `fetch`，URL 全在模型条目上。

鉴权头在 `src/chat.mjs` 里按网关重设：anthropic 用 `x-api-key`（并补 `anthropic-version`）、
google 用 `x-goog-api-key`、其余 `Authorization: Bearer`。

## 5. 额度字段

`detail/realtime` 的真账本只有 `unified_token_usage` / `unified_token_limit`（free 计划 10,000/天，
`token_next_refresh_time` 是北京时间 0 点）。几个容易读错的：

- `remaining_quota_35` / `remaining_quota_4` / `remaining_quota_unified` 是 **0–1 的小数**，不是「次」；
  它们只是 `1 - usage/limit` 的旧口径副本，**不要**拿来画窗口。
- `unified_token_usage` 可能大于 `limit`（透支），也可能变负；窗口要允许 `used > 100`。
- `image_total_quota` 是**每月**生图张数；视觉对话不消耗它（`image_used_count` 一直是 0）。

## 6. 错误语义（ERROR-CODES v1）

| 上游 | 插件出口 | 理由 |
|---|---|---|
| 401 `license_not_found` / `license_key_required` | 401 `sign_in_required` | 真的登录问题 |
| 450 `license_upgrade_required` | 404 `model_not_found` | 套餐不支持该模型 → 只搁置这个模型 |
| 499 `token_quota_exhausted` | 429 `rate_limited` | 等重置，别把号标失效 |
| 400 `bad_params` | 400 `invalid_request`；目录里没有的 model id 则 404 | 参数问题不换号 |
| 429 | 429 `rate_limited` | 透传 |
| 5xx | 503 `upstream_unavailable` | 透传（可换号） |
| 网关超时 / abort | 504 `upstream_timeout` | 可重试 |

## 7. 那次额度事故（为什么有 vision 闸）

2026-11-03 探测时，用 `deepseek-v4-flash`（目录里没有 `vision`）发了一张 1×1 图片：
服务端**不校验**能力位，直接放过；模型开始无边界复读，`max_tokens: 8` 完全不生效，
吐出 14,254 帧 / 3.7 MB 且没有 `finish_reason`，一天额度（10,000）被打穿到 11,664。
所以 `src/chat.mjs` 在转发前按目录的 `capabilities` 拦图片输入。
这个闸是**必要**的，不是保守：同样的请求官方客户端不会发，但任何第三方反代都可能踩到。

## 8. 流式

- 四条网关**永远是 SSE**（写 `stream: false` 也一样），没有 `data: [DONE]`，usage 在最后一帧。
- 插件原样透传，只在结尾补 `data: [DONE]`（`appendDone`），不读干流、不攒帧。
- 工具调用按 OpenAI 标准分片：只有首块带 `id/type/name`，后续是空字符串 + `arguments` 增量，
  按 `index` 聚合；`finish_reason: "tool_calls"`。

## 9. 目录与快照

`provider.models` 每次拿账号的 `model_list`，成功就写一份快照到 `~/.cache/magpie/`，
失败退回快照、再退回内置 `src/catalog.mjs`（2026-11-03 快照，63 条）。
单条缺 `modelId` / `access.available === false` / `type !== "chat"` 的不列。
快照文件名带账号尾号（`plugin-store-chatbox-ai-snapshot-chatbox-ai__<尾 8 位>.json`），多账号不串。

## 10. 没做的事

- 没有每日签到（Chatbox 没有这个活动）。
- 没有自动领 `claim-free-agent-mode-reward`：那个端点非幂等、代码里没有冷却/幂等键，纯靠服务端判定，
  插件不替用户做不可撤销的事。
- 没有列生图模型（`imageModels`）：它们的调用面是 `/api/images/*` 与 Gemini 图像端点，
  与 chat 插件的 `fetch` 契约不同；先不做，避免 chat 列表里出现选不得的条目。
- 没有把 `chatbox-agent-mode: true` 发出去：它会改变额度口径，未验证，保持官方默认。

## 11. 倍率与计算点换算

Chatbox 没有单独叫「倍率」的字段。能拿到的是每条模型的：

```json
"pricing": { "tokensPerComputePoint": 6.67, "officialInput": 0.15, "officialOutput": 0.6,
             "tieredPricing": [] }
```

`tokensPerComputePoint`（下称 tpc）是「1 计算点能换多少 token」。它和官方美元价是同一件事：

```
1 计算点 = $0.000001 的官方成本
点数/百万 token = 1 / officialInput        （input）
```

实测 63 条里 59 条满足 `1 / tpc == officialInput`（±0.011 的四舍五入误差）；剩下 4 条
（`claude-sonnet-4.6`、`claude-sonnet-4.6-thinking`、`gpt-5.6-sol`、`kimi-k3`）是厂商自己
把 tpc 舍成了 0.33 或没跟着涨价同步，不是另一套倍率。

所以插件里的 `rate` 是**推导值**，口径固定为「相对基准模型 `chatboxai-3.5` 的计算点消耗倍数」：

```
rate = tpc(chatboxai-3.5) / tpc(model) = 3.33 / tpc(model)      （没有 tpc 时用 officialInput 比）
```

- 基准模型自己 = 1.00x
- `deepseek-v4.1-flash`（6.67 token/点）= 0.50x
- `gpt-6-astra`（0.1 token/点）= 33.30x
- 这是**消耗倍数，不是折扣**；magpie 的倍率胶囊只用于显示，不参与路由（HOOKS 十一之三）

### 计划点数 → token

官方定价页（`/model-pricing`）公布的每计划点数和 `tokensPerComputePoint` 完全对得上：
Lite 2,000,000 点 → DeepSeek V4 Flash 13.3M tokens（2e6 × 6.67 ≈ 13.34M）。

| 计划 | 点/月 | `deepseek-v4.1-flash` 输入 tokens | 输出 tokens（4 倍价） |
|---|---|---|---|
| Lite | 2,000,000 | ≈ 1,330 万 | ≈ 330 万 |
| Pro | 12,000,000 | ≈ 8,000 万 | ≈ 2,000 万 |
| Pro+ | 30,000,000 | ≈ 2 亿 | ≈ 5,000 万 |

免费计划不走点数：固定 **10,000 unified tokens / 天**，只能用 `basic` 组（26 个模型）。
