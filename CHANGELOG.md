# 更新记录

> 每个版本一节，**一条一行**，说用户能感知的变化。
> 格式与规矩见 [UPDATING.md](./UPDATING.md)。

## 0.1.5 — 2026-11-07

**额度卡片：超额不再画 322% 的条，赠量不再谎报「剩余 100%」**

10,000/天 是软限 —— 2026-11-07 实测 7 个号里 6 个烧到 11,103–32,263，全部 499
`token_quota_exhausted`（同时刻 6,066 的那个号四种模型全通，证明限额是账号级、不是模型级）。
所以「超出上限」是真的，需要修的只有**怎么画**：

- 「今日额度」超额时 `used` 夹到 **100**，超出量写进 `display`
  （`已耗尽 32,263 / 10,000 tokens · 超出 22,263`）。`amount` / `limit` 仍是真实数字；
  路由分组只看 `>= 98`，夹到 100 后仍是 `spent`，排序语义一点没变
- 「Agent 加量」等赠量段改成 `textOnly: true`：**连 `used: 0` 都不给**。
  `used: 0` 在宿主眼里是「剩余 100%」，于是卡片一半说「超出 22,263」、一半说「剩余 100%」，
  两个方向都错。分子不可信就不报占比，只报上限与作废时刻
- 「生图额度」改按 `remaining_quota_image`（上游自己的剩余**比例**）算，
  `image_used_count` 只在比例缺失时兜底（它恒为 0，视觉对话不消耗它）
- `usageWindow()` 变幂等（构造过的窗口带不可枚举暗号）：`usage()` 二次过构造器时，
  text-only 窗口不会再被当成「忘了写 `used`」而抛 `QuotaShapeError`
- 测试：`tests/license-usage.test.mjs` 增加超额夹取、比例优先、越界夹取三条

## 0.1.4 — 2026-11-07

**额度卡片显示 111% / 323%：分母混进了一个按 3 天过期的加量段**

上游 `unified_token_limit` 不是「今日上限」，是 `unified_token_usage_details` 里各段的加总。
有 agent 加量时它是 `10000 + 200000 = 210000`，而分子 `unified_token_usage` 也把 bonus 段算了进去 ——
两者生命周期不同（plan 段每天 0 点重置，bonus 段按段自己的 `expires_at` 日历过期），
拼成一条窗口就是「今日额度 206066 / 210000」，卡片和路由都读到一个不存在的周期。
更糟的是 bonus 段的分子不可信：实测 4 个带加量的号（含刚注册、plan 用量为 0 的新号）
全部精确卡在 `200000 / 200000`，多半是设备/IP 级共享记账，或者注册即预填。

改法是**按段建窗**：`plan` 段出「今日额度」（`amount` / `limit` / `token_next_refresh_time` / `span: 86400`，
唯一参与路由的窗口）；`free_agent_mode_bonus` 段单独出「Agent 加量」，`resetsAt` 用段自己的
`expires_at`，标 `aside: true` 且**只给 `display`**（aside 给 `amount`/`limit` 会算出「永远剩余 100%」
的假占比，构造器直接抛 `QuotaShapeError`），分子既然不可信就不断言用量、也不填 `runsOut`。
`unified_token_usage_details` 缺失或 plan 段不可用时退回聚合值，行为与修复前一致。

- 顺带更正 `remaining_quota_35/4` 的注释：它是**剩余比例**（`1 - plan.用量 / plan.上限`），
  不是「次」，也不保证 0–1 —— 超额后是负数（实测 `-2.2263`），上游不 clamp
- 测试：新增 `tests/license-usage.test.mjs`（12 条），第一段 fixture 是 2026-11-07 从
  `GET /api/license/detail/realtime` 原样抓下来的真实响应，锁住 plan 段优先、bonus 段形态、
  兜底路径与「至少一条可路由窗口」

## 0.1.3 — 2026-11-03

- 倍率胶囊：按平台自己的 `tokensPerComputePoint` 换算成「相对 Chatbox AI 3.5 的计算点消耗倍数」（显示用，不参与路由）
- README / docs 补上计算点与 token 的换算表（Lite 200 万点 ≈ 1330 万 `deepseek-v4.1-flash` 输入 token）

## 0.1.2 — 2026-11-03

- 脱敏：测试用例与注释里不再出现真实 license key（历史一并重写）

## 0.1.1 — 2026-11-03

- 错误信息不再重复供应商名（magpie 已经在前面加了一次）
- 图片闸补上 Gemini 的 `inlineData` / `fileData` 形状，四种协议一视同仁

## 0.1.0 — 2026-11-03

**首个版本：把 Chatbox AI 接进 magpie**

- 三条登录路：从本机 Chatbox 客户端导入 license（只读）、粘贴 license key、邮箱验证码登录
- 63 个模型的目录跟着平台实时拉取，未登录时用内置快照兜底
- 按模型的 `apiStyle` 分流到四条原生网关：Chat Completions / Responses / Anthropic Messages / Gemini
- 额度卡片：今日 token 用量与上限、重置时间、生图额度；透支如实显示超过 100%
- 收图能力按平台目录先拦：给 text-only 模型发图片直接拒绝，不让上游无边界复读
- 错误语义：登录失效 401、模型不可用（含「需要更高套餐」）404、额度用完 429、网关超时 504
- 流式转发原样透传并在末尾补 `data: [DONE]`；工具调用、思考档按官方协议下发
