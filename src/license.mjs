// src/license.mjs —— 把 Chatbox 的实时额度翻译成 magpie 的额度窗口
//
// 上游（GET /api/license/detail/realtime）返回的字段（2026-11-07 实测，free 计划，6 个账号）：
//   unified_token_usage_details[]               **真账本**：按段的生命周期分开记，每段
//                                               `{ type, token_usage, token_limit, expires_at }`
//   unified_token_usage / unified_token_limit   ⚠ **不是「今日」**，是上面 details 各段之和。
//                                               有 agent 加量时 limit = 10000 + 200000 = 210000；
//                                               拿它当分母，卡片会显示 111% / 323% 这种假数字
//   token_next_refresh_time                     每日 0 点重置（ISO 带 +08:00；5 个号完全一致）
//   remaining_quota_35 / remaining_quota_4      历史字段，见下 ②
//   image_total_quota / image_used_count        生图额度（free 是 5 张）
//   expansion_pack_limit / expansion_pack_usage 加量包
//
// 段（`type`）只有两种生命周期，**必须分开建窗**，混在一起就是上面那个 bug：
//   "plan"                   真的按天重置 → 唯一可路由的「今日额度」窗口
//   "free_agent_mode_bonus"  按日历过期（每号不同，见段自己的 `expires_at`）
//
// 三条规矩（HOOKS 十一）：
//   ① 每条窗口都必须有 used（或能算出来的 amount+limit），否则路由不计入这个号
//   ② 时间一律转 ISO —— 上游给 "+08:00" 是合法 ISO，直接交给 toIso 即可
//   ③ aside 窗口只展示、不参与路由；至少要留一条参与路由的窗口，否则账号在路由里「不存在」

import { usage as buildUsage, usageWindow } from "./quota.mjs"

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

const fmt = (n) =>
  Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100)

/** 每日重置窗口的时长（秒）。只有 `plan` 段真的是按天的，别给 bonus 段复用 */
const DAILY_SPAN = 86_400

/** 唯一按天算的段。它缺席时说明上游是老形状，见 `usageFromDetail` 的兜底 */
const PLAN_SEGMENT = "plan"

/** 加量段的窗口名：上游 `type` 是给机器看的，卡片上得是人话。未知 type 落回 `加量（type）` */
const BONUS_WINDOW_NAMES = { free_agent_mode_bonus: "Agent 加量" }

/**
 * 「今日额度」窗口 —— 全插件唯一参与路由的那条。
 * 两个入参口径都可能是聚合值，所以调用方决定传哪一段；不可用时返回 undefined 让调用方兜底。
 */
function dailyWindow(amount, limit, resetAt) {
  if (amount === undefined || limit === undefined || limit <= 0) return undefined
  return usageWindow({
    name: "今日额度",
    amount,
    limit,
    unit: "tokens",
    resetsAt: resetAt,
    span: DAILY_SPAN,
  })
}

/**
 * 非 plan 段（agent 加量等）→ 只上卡片的旁路窗口。
 *
 * 为什么 **不给 amount/limit**：aside 窗口的分母就是余额本身，算出来永远是「剩余 100%」，
 * 而这里连分子都不可信 —— 实测 4 个带 bonus 的号（含刚注册、plan 用量为 0 的新号）
 * 全部精确卡在 `200000 / 200000`，分子要么是设备/IP 级共享、要么注册即预填。
 * 一个不信的口径配一个假分母，卡片上就只剩漂亮数字。
 * 所以按 HOOKS 二① 的写法：`used: 0` + `aside: true` + `display`，
 * 只陈述「有这么一批额度、上限多少、什么时候作废」，不断言用量。
 *
 * 为什么 **不给 `runsOut`**：那个字段是「失效时损失多少」，而损失多少取决于剩多少 ——
 * 正是我们不信的那个分子。给 0 是编的，给 limit 也是编的，宁可不填。
 */
function bonusWindows(segments) {
  const out = []
  for (const seg of segments) {
    if (seg.type === PLAN_SEGMENT) continue
    const limit = num(seg.token_limit)
    if (limit === undefined || limit <= 0) continue
    out.push(
      usageWindow({
        name: BONUS_WINDOW_NAMES[seg.type] || `加量（${seg.type || "未命名"}）`,
        used: 0,
        aside: true,
        display: `上限 ${fmt(limit)} tokens`,
        // 段自己的过期时刻就是「这批额度什么时候作废」（HOOKS 三③ 专门为它准备的字段）
        runsOutAt: seg.expires_at || undefined,
      }),
    )
  }
  return out
}

/** 把 detail/realtime 的 data 变成 usage() 的入参 */
export function usageFromDetail(detail) {
  const windows = []
  const resetAt = detail?.token_next_refresh_time || detail?.token_expire_time || undefined
  const plan = String(detail?.name || detail?.plan || "").trim() || undefined

  const segments = Array.isArray(detail?.unified_token_usage_details)
    ? detail.unified_token_usage_details.filter((s) => s && typeof s === "object")
    : []
  const planSeg = segments.find((s) => s.type === PLAN_SEGMENT)

  // ① 今日 token 额度 —— 唯一参与路由的窗口（free 计划每天 10000 点）
  //    优先用 plan 段；老版本 API 没有 details 时退回聚合值（行为与修复前一致，不能更差）。
  const daily =
    dailyWindow(num(planSeg?.token_usage), num(planSeg?.token_limit), resetAt) ??
    dailyWindow(num(detail?.unified_token_usage), num(detail?.unified_token_limit), resetAt)

  if (!daily) {
    // 拿不到上限：交给卡片的 error，不伪造 limit，也不造一条不参与路由的 textOnly 窗口
    return buildUsage({
      plan,
      error: "上游没有给出今日额度上限（license 详情里缺 unified_token_detail 的 plan 段和 unified_token_limit）",
      windows: [],
    })
  }
  windows.push(daily, ...bonusWindows(segments))

  // ② 老套餐分类的余量（`remaining_quota_35/4`）是**剩余比例**，不是「次」：
  //    实测 `remaining_quota_35 = 1 - plan.token_usage / plan.token_limit`
  //    （32263 / 10000 → -2.2263，6066 / 10000 → 0.3934），未超额时是 0–1、超额后是负数，
  //    上游不做 clamp。它只是 plan 段的另一种写法，真账本还是 `unified_token_usage_details`
  //    的 plan 段 —— 不单独画一行，避免「3.5 剩 1 次」这种误读。

  // ③ 生图额度（free 计划 5 张）
  const imgTotal = num(detail?.image_total_quota)
  const imgUsed = num(detail?.image_used_count) ?? 0
  if (imgTotal !== undefined && imgTotal >= 0) {
    const left = Math.max(0, imgTotal - imgUsed)
    windows.push(usageWindow({ name: "生图额度", used: 0, aside: true, display: `剩 ${fmt(left)} / ${fmt(imgTotal)} 张` }))
  }

  // ④ 加量包（有才算；没有了就不显示一行 0）
  const packLimit = num(detail?.expansion_pack_limit) ?? 0
  const packUsed = num(detail?.expansion_pack_usage) ?? 0
  if (packLimit > 0) {
    windows.push(
      usageWindow({ name: "加量包", used: 0, aside: true, display: `剩 ${fmt(packLimit - packUsed)} / ${fmt(packLimit)}` }),
    )
  }

  return buildUsage({
    plan,
    until: resetAt,
    windows,
  })
}
