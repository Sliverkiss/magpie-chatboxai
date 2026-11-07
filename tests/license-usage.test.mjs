// tests/license-usage.test.mjs —— 额度按「段」建窗（2026-11-07 修复 210000 分母事故）
//
// 为什么需要它：`unified_token_limit` 不是「今日上限」，是 details 里各段的加总。
// 有 agent 加量时它 = 10000 + 200000 = 210000，string 拼出来的卡片是「111% / 323%」——
// 插件不报错、magpie 不报错，只有用户看见一个没有意义的数字。
// 下面第一段 fixture 是 2026-11-07 从 `GET /api/license/detail/realtime` 原样抓下来的
// 真实响应（只把 `key` 换成占位 UUID），字段一个不删 —— 形状变了这里必须先红。
//
// 跑法：node --test    （或 node tests/license-usage.test.mjs）

import test from "node:test"
import assert from "node:assert/strict"

import { usageFromDetail } from "../src/license.mjs"

const KEY = "00000000-0000-4000-8000-000000000000"

/** 带 agent 加量段（plan 6066/10000 + bonus 200000/200000，聚合 206066/210000） */
const WITH_BONUS = {
  type: "chatboxai-3.5",
  name: "Chatbox AI Free",
  plan: "free",
  status: "active",
  defaultModel: "chatboxai-3.5",
  remaining_quota_35: 0.39339999999999997,
  remaining_quota_4: 0,
  remaining_quota_unified: 0.01873333333333338,
  remaining_quota_image: 1,
  expansion_pack_limit: 0,
  expansion_pack_usage: 0,
  image_used_count: 0,
  image_total_quota: 5,
  plan_image_limit: 5,
  token_refreshed_time: "2026-11-07T02:32:23.747Z",
  token_next_refresh_time: "2026-11-08T00:00:00+08:00",
  token_expire_time: null,
  key: KEY,
  price_type: "one_time",
  order_type: "buy_license",
  utm_source: "",
  expires_at: null,
  recurring_canceled: null,
  payment_type: "unknown",
  unified_token_usage: 206066,
  unified_token_limit: 210000,
  unified_token_usage_details: [
    { type: "plan", token_usage: 6066, token_limit: 10000, expires_at: null },
    {
      type: "free_agent_mode_bonus",
      token_usage: 200000,
      token_limit: 200000,
      expires_at: "2026-11-09T12:40:58.094Z",
    },
  ],
  aggregated_reward_details: { token_usage: 200000, token_limit: 200000, image_usage: 0, image_limit: 0 },
}

/** 只有 plan 段的号（同一批实测里另外两个号就是这个形状） */
const PLAN_ONLY = {
  ...WITH_BONUS,
  remaining_quota_35: -2.2263,
  unified_token_usage: 32263,
  unified_token_limit: 10000,
  unified_token_usage_details: [{ type: "plan", token_usage: 32263, token_limit: 10000, expires_at: null }],
  aggregated_reward_details: null,
}

/** magpie 路由的判据（quota.mjs 注释 + HOOKS 二①）：aside 与无 used 的窗口都跳过 */
const routable = (u) => u.windows.filter((w) => w.aside !== true && (w.used !== undefined || w.balance !== undefined))

const byName = (u, name) => u.windows.find((w) => w.name === name)

// ── 核心：今日额度必须来自 plan 段，不是聚合值 ────────────────────

test("两段都在：今日额度 = plan 段（6066/10000），不是聚合的 206066/210000", () => {
  const u = usageFromDetail(WITH_BONUS)
  const daily = byName(u, "今日额度")
  assert.equal(daily.amount, 6066, "amount 必须是 plan 段用量，不是 unified_token_usage")
  assert.equal(daily.limit, 10000, "limit 必须是 plan 段上限，不是 210000")
  assert.equal(daily.used, 60.66, "占比按 6066/10000 算")
  assert.equal(daily.span, 86_400, "plan 段是真的按天重置")
  assert.ok(daily.resetsAt.includes("T"), "resetsAt 必须是 ISO")
  assert.equal(daily.resetsAt, new Date("2026-11-08T00:00:00+08:00").toISOString())
  assert.equal(u.plan, "Chatbox AI Free")
  assert.equal(u.until, new Date("2026-11-08T00:00:00+08:00").toISOString())
})

test("今日额度是唯一参与路由的窗口：aside 窗口全部被路由跳过", () => {
  const u = usageFromDetail(WITH_BONUS)
  const routed = routable(u)
  assert.equal(routed.length, 1, "只剩今日额度 —— 其余都是 aside 展示位")
  assert.equal(routed[0].name, "今日额度")
})

// ── bonus 段：耗尽也不许抛 QuotaShapeError ──────────────────────

test("bonus 段（200000/200000 已耗尽）窗口形态合法：aside + display，不给 amount/limit", () => {
  const u = usageFromDetail(WITH_BONUS)
  const bonus = byName(u, "Agent 加量")
  assert.ok(bonus, "bonus 段必须单独一条窗口")
  // aside 窗口给 amount/limit 会算出「永远剩余 100%」的假占比，构造器直接抛 QuotaShapeError；
  // 这里断言它确实走的是 display 形态
  assert.equal(bonus.aside, true)
  assert.equal(bonus.amount, undefined)
  assert.equal(bonus.limit, undefined)
  assert.equal(bonus.used, 0, "used: 0 是 aside 文本窗口的固定写法（HOOKS 二①）")
  assert.equal(bonus.display, "上限 200000 tokens")
  assert.equal(bonus.runsOutAt, "2026-11-09T12:40:58.094Z", "作废时刻取段自己的 expires_at")
  assert.equal(bonus.span, undefined, "bonus 不是按天窗口，别给 span")
  assert.equal("runsOut" in bonus, false, "剩多少不可信，就不填「损失多少」")
})

test("bonus 段整段耗尽（used 顶满）也不抛 —— 构造器只拿 display，不碰百分比", () => {
  assert.doesNotThrow(() => usageFromDetail(WITH_BONUS))
  // 分子大于分母（设备/IP 级共享记账）也不该让整张卡片坏掉
  assert.doesNotThrow(() =>
    usageFromDetail({
      ...WITH_BONUS,
      unified_token_usage_details: [
        { type: "plan", token_usage: 10000, token_limit: 10000, expires_at: null },
        { type: "free_agent_mode_bonus", token_usage: 999999, token_limit: 200000, expires_at: "2026-11-09T12:40:58.094Z" },
      ],
    }),
  )
})

test("未知 type 的段也建窗：名字落回「加量（type）」，不静默丢掉", () => {
  const u = usageFromDetail({
    ...WITH_BONUS,
    unified_token_usage_details: [
      { type: "plan", token_usage: 10, token_limit: 10000, expires_at: null },
      { type: "referral_bonus", token_usage: 5, token_limit: 500, expires_at: "2026-11-10T00:00:00Z" },
    ],
  })
  const w = byName(u, "加量（referral_bonus）")
  assert.ok(w)
  assert.equal(w.aside, true)
})

test("没有 expires_at 的段：不给 runsOutAt（undefined 不出现在窗口里）", () => {
  const u = usageFromDetail({
    ...WITH_BONUS,
    unified_token_usage_details: [
      { type: "plan", token_usage: 10, token_limit: 10000, expires_at: null },
      { type: "free_agent_mode_bonus", token_usage: 0, token_limit: 200000, expires_at: null },
    ],
  })
  const bonus = byName(u, "Agent 加量")
  assert.equal(bonus.runsOutAt, undefined)
})

// ── 兜底：老版本 API 没有 details，行为不能比修复前差 ────────────

test("unified_token_usage_details 缺失 → 退回聚合值，仍产出可路由的今日额度", () => {
  const { unified_token_usage_details: _drop, ...old } = PLAN_ONLY
  const u = usageFromDetail(old)
  const daily = byName(u, "今日额度")
  assert.ok(daily, "兜底必须有今日额度窗口")
  assert.equal(daily.amount, 32263)
  assert.equal(daily.limit, 10000)
  assert.equal(daily.used, 322.63)
  assert.equal(daily.span, 86_400)
  assert.equal(routable(u).length, 1, "兜底路径也必须留一条可路由窗口，否则这个号在路由里不存在")
  assert.equal(u.error, undefined, "兜底不是错误")
})

test("details 是空数组 / 不是数组 → 同样走兜底", () => {
  for (const details of [[], null, undefined, "nope", 0]) {
    const u = usageFromDetail({ ...PLAN_ONLY, unified_token_usage_details: details })
    assert.equal(byName(u, "今日额度")?.amount, 32263, `details=${JSON.stringify(details)} 也要兜底`)
  }
})

test("plan 段存在但上限是 0（上游漏填）→ 退回聚合值", () => {
  const u = usageFromDetail({
    ...PLAN_ONLY,
    unified_token_usage_details: [{ type: "plan", token_usage: 32263, token_limit: 0, expires_at: null }],
  })
  assert.equal(byName(u, "今日额度")?.amount, 32263)
})

test("两段都拿不到上限 → error + 空窗口（不伪造 limit）", () => {
  const u = usageFromDetail({ unified_token_usage_details: [{ type: "plan", token_usage: 1 }] })
  assert.match(u.error, /上限/)
  assert.deepEqual(u.windows, [])
})

// ── 其余窗口不受影响 ────────────────────────────────────────────

test("生图额度 / 加量包：仍然是 aside 文本位，随数据有无出现", () => {
  const u = usageFromDetail(WITH_BONUS)
  assert.equal(byName(u, "生图额度").display, "剩 5 / 5 张")
  assert.equal(byName(u, "加量包"), undefined, "expansion_pack_limit=0 不显示")
  const withPack = usageFromDetail({ ...PLAN_ONLY, expansion_pack_limit: 500, expansion_pack_usage: 120 })
  assert.equal(byName(withPack, "加量包").display, "剩 380 / 500")
})

test("remaining_quota_35 是剩余比例（可为负），不再被当成「次」写进窗口", () => {
  const u = usageFromDetail(PLAN_ONLY)
  assert.equal(PLAN_ONLY.remaining_quota_35 < 0, true, "fixture 自己就是超额后的负数")
  assert.equal(u.windows.some((w) => w.name === "对话次数"), false)
  assert.equal(u.windows.some((w) => w.name === "3.5"), false)
})
