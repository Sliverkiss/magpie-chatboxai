// tests/semantics.test.mjs —— 锁住「形状对、语义错」的那几处
//
// 为什么需要它：`scripts/check.mjs` 查的是**形状**（导出了什么、字段齐不齐、许可对不对）。
// 但真实踩过的坑几乎都在语义上，而且**都不报错**：
//   · 450/499 这种非标准状态码被透传 → 宿主以为是账号问题，把号停了
//   · 给 text-only 模型发图片 → 服务端不拦，模型无边界复读，额度打穿（2026-11-03 实测）
//   · 远端额度里 `remaining_quota_*` 是 0–1 小数，被当成「次」写进窗口 → 数字全错
//   · 模型目录整个失败却返回空表 → 卡片显示 0 models
//
// 跑法：node --test    （或 node tests/semantics.test.mjs）

import test from "node:test"
import assert from "node:assert/strict"

import { usage, usageWindow } from "../src/quota.mjs"
import { fromUpstream } from "../src/api.mjs"
import { buildModels, fromLive } from "../src/models.mjs"
import { hasImageInput, catalogSupportsImage } from "../src/chat.mjs"
import { usageFromDetail } from "../src/license.mjs"
import { licenseFromConfig, LICENSE_KEY_RE } from "../src/local.mjs"
import { rateOf } from "../src/context.mjs"

const KEY = "00000000-0000-4000-8000-000000000000"

// ── 上游错误语义（唯一真源：ERROR-CODES §2）────────────────────────

test("450 license_upgrade_required → 404 model_not_found（模型级，只搁置这个模型）", () => {
  const e = fromUpstream(
    450,
    { error: { code: "license_upgrade_required", detail: "Your license (Chatbox-AI 3.5 plan) does not support the chatboxai-4 model." } },
    "",
    "https://api.chatboxai.app/gateway/openai/v1/chat/completions",
  )
  assert.equal(e.status, 404)
  assert.equal(e.code, "model_not_found")
  assert.match(e.message, /套餐|model/i)
})

test("499 token_quota_exhausted → 429 rate_limited（退避到重置点，不标账号）", () => {
  const e = fromUpstream(499, { error: { code: "token_quota_exhausted", detail: "You've used up all your token quota" } }, "", "u")
  assert.equal(e.status, 429)
  assert.equal(e.code, "rate_limited")
})

test("401 license_not_found → sign_in_required；401 license_key_required 也是登录问题", () => {
  const a = fromUpstream(401, { error: { code: "license_not_found" } }, "", "u")
  assert.equal(a.code, "sign_in_required")
  const b = fromUpstream(401, { error: { code: "license_key_required" } }, "", "u")
  assert.equal(b.code, "sign_in_required")
})

test("400 bad_params → invalid_request（参数问题不换号）", () => {
  const e = fromUpstream(400, { error: { code: "bad_params", detail: "Invalid parameter." } }, "", "u")
  assert.equal(e.status, 400)
  assert.equal(e.code, "invalid_request")
})

test("5xx → 503 upstream_unavailable；429 → 429 rate_limited", () => {
  assert.equal(fromUpstream(503, null, "", "u").code, "upstream_unavailable")
  assert.equal(fromUpstream(500, null, "", "u").status, 503)
  assert.equal(fromUpstream(429, null, "", "u").code, "rate_limited")
})

// ── vision 闸（2026-11-03 额度事故的防腐层）─────────────────────────

test("hasImageInput 认 OpenAI / Anthropic / Responses 三种图片形状", () => {
  assert.equal(
    hasImageInput({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }] }),
    true,
  )
  assert.equal(
    hasImageInput({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }] }] }),
    true,
  )
  assert.equal(hasImageInput({ input: [{ type: "input_image", image_url: "data:image/png;base64,AA" }] }), true)
  assert.equal(hasImageInput({ messages: [{ role: "user", content: "hello" }] }), false)
  assert.equal(hasImageInput(null), false)
})

test("catalogSupportsImage：目录里 text-only 的模型必须拦；查不到的不拦（不猜）", () => {
  // deepseek-v4-flash 在 2026-11-03 的目录里没有 vision
  assert.equal(catalogSupportsImage("deepseek-v4-flash"), false)
  // gpt-6-astra 目录里标了 vision
  assert.equal(catalogSupportsImage("gpt-6-astra"), true)
  // 未知模型：不猜，放行给上游判
  assert.equal(catalogSupportsImage("some-future-model"), true)
})

// ── 额度：真账本只有 unified_token_* ──────────────────────────────

test("usageFromDetail 只把 unified_token_* 当占比窗口；其余是 aside 文本", () => {
  const u = usageFromDetail({
    name: "Chatbox AI Free",
    plan: "free",
    unified_token_usage: 775,
    unified_token_limit: 10_000,
    token_next_refresh_time: "2026-11-04T00:00:00+08:00",
    remaining_quota_35: 0.9225,
    remaining_quota_4: 0,
    image_total_quota: 5,
    image_used_count: 0,
  })
  assert.equal(u.plan, "Chatbox AI Free")
  assert.equal(u.windows.length, 2)
  const main = u.windows.find((w) => w.name === "今日额度")
  assert.equal(main.amount, 775)
  assert.equal(main.limit, 10_000)
  assert.ok(Number.isFinite(main.used) && Math.abs(main.used - 7.75) < 0.01)
  assert.ok(main.resetsAt.includes("T"), "resetsAt 必须是 ISO")
  const img = u.windows.find((w) => w.name === "生图额度")
  assert.equal(img.aside, true)
  // remaining_quota_35/4 是 0–1 小数，不能被当成「次」写进窗口
  assert.equal(u.windows.some((w) => w.name === "对话次数"), false)
})

test("usageFromDetail：额度透支（used > limit）不崩，used 仍有限", () => {
  const u = usageFromDetail({
    unified_token_usage: 11_664,
    unified_token_limit: 10_000,
    token_next_refresh_time: "2026-11-04T00:00:00+08:00",
  })
  const main = u.windows[0]
  assert.equal(main.used > 100, true)
})

test("usageFromDetail：上限未知时给 error，不伪造 limit、不造不参与路由的窗口", () => {
  const u = usageFromDetail({ unified_token_usage: 12 })
  assert.match(u.error, /上限/)
  assert.deepEqual(u.windows, [])
})

// ── 目录：三态降级 + 协议字段 ────────────────────────────────────

test("buildModels：整个目录缺失 → null（调用方退回快照，不返回空表）", () => {
  assert.equal(buildModels(null), null)
  assert.equal(buildModels({}), null)
  assert.equal(buildModels({ models: {} }), null)
})

test("buildModels：单条缺 id / 明确不可用 → 不列", () => {
  const built = buildModels({
    models: {
      ok: { modelId: "ok", modelName: "OK", capabilities: ["tool_use"], apiStyle: "openai", contextWindow: 1000 },
      bad: { modelName: "No id" },
      locked: { modelId: "locked", access: { available: false } },
    },
  })
  assert.deepEqual(Object.keys(built.models), ["ok"])
  assert.equal(built.dropped, 2)
})

test("fromLive：apiStyle 决定 api.npm / api.url（四条网关）", () => {
  const openai = fromLive({ modelId: "x", modelName: "X", apiStyle: "openai", capabilities: [], pricing: null })
  assert.equal(openai.api.npm, "@ai-sdk/openai-compatible")
  assert.ok(openai.api.url.endsWith("/gateway/openai/v1"))

  const responses = fromLive({ modelId: "y", modelName: "Y", apiStyle: "openai-responses", capabilities: [] })
  assert.equal(responses.api.npm, "@ai-sdk/openai")
  assert.ok(responses.api.url.endsWith("/gateway/openai-responses/v1"))

  const anthropic = fromLive({ modelId: "z", modelName: "Z", apiStyle: "anthropic", capabilities: ["reasoning"] })
  assert.equal(anthropic.api.npm, "@ai-sdk/anthropic")
  assert.ok(anthropic.api.url.endsWith("/gateway/anthropic/v1"))
  assert.equal(anthropic.capabilities.reasoning, true)

  const google = fromLive({ modelId: "g", modelName: "G", apiStyle: "google", capabilities: ["vision"] })
  assert.equal(google.api.npm, "@ai-sdk/google")
  assert.equal(google.capabilities.input.image, true)
})

test("fromLive：官方价进 cost，倍率按计算点换算，free 绝不从价格反推", () => {
  const entry = fromLive({
    modelId: "m",
    modelName: "M",
    apiStyle: "openai",
    capabilities: ["tool_use"],
    pricing: { officialInput: 0.3, officialOutput: 1.2, tokensPerComputePoint: 3.33 },
  })
  assert.deepEqual(entry.cost, { input: 0.3, output: 1.2, cache: { read: 0, write: 0 } })
  assert.equal(entry.rate, 1)
  assert.equal("free" in entry, false)
})

// ── 倍率：相对 chatboxai-3.5 的计算点倍数 ────────────────────────

test("rateOf：有 tokensPerComputePoint 就用它换算（3.33 / tpc）", () => {
  // deepseek-v4.1-flash：6.67 token/点 → 3.33/6.67 = 0.5x
  assert.equal(rateOf({ in: 0.15, out: 0.6, tpc: 6.67 }), 0.5)
  // gpt-6-astra：0.1 token/点 → 33.3x
  assert.equal(rateOf({ in: 10, out: 50, tpc: 0.1 }), 33.3)
  // 基准模型自己 = 1x
  assert.equal(rateOf({ in: 0.3, out: 1.2, tpc: 3.33 }), 1)
})

test("rateOf：没有 tpc 时退回官方输入价比（同一件事的另一种写法）", () => {
  assert.equal(rateOf({ in: 0.15, out: 0.6 }), 0.5)
  assert.equal(rateOf({ in: 10, out: 50 }), 33.33)
})

test("rateOf：没有价格 → 0（不猜、不编造）", () => {
  assert.equal(rateOf(null), 0)
  assert.equal(rateOf({}), 0)
  assert.equal(rateOf({ in: 0, out: 0 }), 0)
})

test("fromLive：条目带上倍率，且不碰 free", () => {
  const entry = fromLive({
    modelId: "m",
    modelName: "M",
    apiStyle: "openai",
    capabilities: [],
    pricing: { officialInput: 0.15, officialOutput: 0.6, tokensPerComputePoint: 6.67 },
  })
  assert.equal(entry.rate, 0.5)
  assert.equal("free" in entry, false)
})

// ── 本机导入：只读、不猜 ─────────────────────────────────────────

test("licenseFromConfig：从客户端 config.json 取 key / instance / email", () => {
  const license = licenseFromConfig({
    settings: {
      licenseKey: KEY,
      licenseInstances: { [KEY]: "instant-id-1" },
      lastSelectedLicenseByUser: { "user@example.com": KEY },
      licensePlanName: "Chatbox AI Free",
      hasExpiredLicense: false,
    },
  })
  assert.deepEqual(license, {
    licenseKey: KEY,
    instanceId: "instant-id-1",
    email: "user@example.com",
    plan: "Chatbox AI Free",
    expired: false,
    activation: "",
  })
})

test("licenseFromConfig：没有 key / 形状不对 → null（不抛、不编造）", () => {
  assert.equal(licenseFromConfig(null), null)
  assert.equal(licenseFromConfig({ settings: {} }), null)
  assert.equal(licenseFromConfig({ settings: { licenseKey: "not-a-uuid" } }), null)
  assert.equal(LICENSE_KEY_RE.test(KEY), true)
})

// ── 额度窗口构造器（脚手架继承，保留覆盖）──────────────────────────

test("quota: 缺 used 且没有 amount/limit → 抛（text-only 必须显式）", () => {
  assert.throws(() => usageWindow({ name: "额度" }), /used 必填/)
})

test("quota: aside + amount/limit → 抛（假占比）", () => {
  assert.throws(() => usageWindow({ name: "赠送", aside: true, amount: 1, limit: 2 }), /aside/)
})

test("quota: 钱包型带 used / amount → 抛", () => {
  assert.throws(() => usageWindow({ name: "积分", balance: 6291, used: 0, unit: "积分" }), /钱包型/)
  assert.throws(() => usageWindow({ name: "积分", balance: 6291, amount: 1, limit: 2 }), /钱包型/)
  const w = usageWindow({ name: "积分", balance: 6291, unit: "积分" })
  assert.equal(w.balance, 6291)
  assert.equal(w.used, undefined)
})

test("quota: span 不是正整数 → 抛；正常窗口原样通过", () => {
  assert.throws(() => usageWindow({ name: "a", used: 1, span: 0 }), /span/)
  assert.throws(() => usageWindow({ name: "a", used: 1, span: 1.5 }), /span/)
  const w = usageWindow({ name: "今日额度", used: 37, span: 86_400, resetsAt: 1793000000 })
  assert.deepEqual(w, { name: "今日额度", used: 37, span: 86_400, resetsAt: new Date(1793000000 * 1000).toISOString() })
})

test("quota: 全是 aside / textOnly → 抛（这个号在路由里不存在）", () => {
  assert.throws(
    () => usage({ windows: [{ name: "用量", textOnly: true, display: "1,234 剩余（上限未知）" }] }),
    /所有窗口都不参与路由/,
  )
})

test("quota: usage() 逐个过一遍窗口，并且不改动其余字段", () => {
  const u = usage({
    plan: "Pro",
    windows: [{ name: "今日额度", used: 37, span: 86_400 }, { name: "积分", balance: 100, unit: "积分" }],
  })
  assert.equal(u.plan, "Pro")
  assert.equal(u.windows.length, 2)
  assert.equal(u.windows[0].used, 37)
  assert.equal(u.windows[1].balance, 100)
})
