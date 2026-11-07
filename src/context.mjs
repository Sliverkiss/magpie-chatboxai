// src/context.mjs —— 共享上下文：厂商常量、客户端请求头、未登录兜底模型表
//
// ⚠ 改这里，不要改各个 hook 文件里的常量。
//   针脚模块只关心「怎么填这一个针脚」，厂商信息全在这儿。

import { CATALOG, CATALOG_BY_ID } from "./catalog.mjs"

/** 厂商 id：agent 用 `<id>/<model>` 命名，改完全世界都要跟着改 */
export const PROVIDER = "chatbox-ai"

/** 卡片上显示的供应商名：必须 <中文> <English>，英文照抄厂商官方品牌写法 */
export const PROVIDER_NAME = "Chatbox AI 免费额度"

/** 接口根：license、模型目录、网页登录都在这个域名下 */
export const ORIGIN = "https://api.chatboxai.app"

/** 网页端根：发验证码 / 登录 / license 列表走网页域名（不是 API 域名） */
export const WEB_ORIGIN = "https://chatboxai.app"

/**
 * 四条网关：Chatbox 按模型的 `apiStyle` 分流（官方客户端就是这么打的）。
 * 2026-11-03 实测四条都可用；跨协议直发（claude 走 openai 路径）虽然也通，
 * 但工具调用/思考档的下发格式按官方协议最稳，所以逐条声明。
 */
export const GATEWAYS = {
  openai: { npm: "@ai-sdk/openai-compatible", url: `${ORIGIN}/gateway/openai/v1` },
  "openai-responses": { npm: "@ai-sdk/openai", url: `${ORIGIN}/gateway/openai-responses/v1` },
  anthropic: { npm: "@ai-sdk/anthropic", url: `${ORIGIN}/gateway/anthropic/v1` },
  google: { npm: "@ai-sdk/google", url: `${ORIGIN}/gateway/google-ai-studio/v1beta` },
}

/** 默认网关（provider 级 api / `apiStyle` 缺失时） */
export const BASE = GATEWAYS.openai.url

/**
 * 决定 API 形状，别乱选：
 *   @ai-sdk/anthropic         → Anthropic Messages  /messages
 *   @ai-sdk/openai            → OpenAI Responses    /responses
 *   @ai-sdk/google            → Gemini              /models/<id>:streamGenerateContent
 *   @ai-sdk/openai-compatible → Chat completions    /chat/completions
 *
 * 只声明一种：网关替我们做了协议转换，按模型分流反而多一层会坏的地方。
 */
export const SDK = "@ai-sdk/openai-compatible"

/** license key 长期有效；这里只保留契约要求的字段，refresh 实际不做事 */
export const REFRESH_LEAD_MS = 5 * 60_000

/**
 * 客户端标识。Chatbox 官方客户端每个请求都带这五个头（`getChatboxHeaders()`），
 * 服务端不校验也能 200；带上是为了不像「凭空冒出来的第三方客户端」。
 */
const PLATFORM = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux"
export const CLIENT_HEADERS = {
  "CHATBOX-PLATFORM": "desktop",
  "CHATBOX-PLATFORM-TYPE": "desktop",
  "CHATBOX-CHANNEL": "stable",
  "CHATBOX-VERSION": "1.23.5",
  "CHATBOX-OS": PLATFORM,
}

/**
 * 图标 —— **两处必须一致**，缺一份就有地方显示灰方块：
 *   auth.icon（本文件导出，hooks/methods 用）→ 供应商列表那一行、用量概览的卡
 *   package.json 的 magpie.icon            → 插件列表那一行、插件详情页左上角
 * 见 HOOKS.md「插件自己的图标」。
 */
export const ICON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMjggMTI4Ij48cmVjdCB3aWR0aD0iMTI4IiBoZWlnaHQ9IjEyOCIgcng9IjI4IiBmaWxsPSIjMjI4YmU2Ii8+PHBhdGggZD0iTTY0IDI4Yy0xOS45IDAtMzYgMTMuNC0zNiAzMCAwIDkuNCA1LjIgMTcuOCAxMy40IDIzLjNMMzggMTAwbDIwLjMtMTAuMWMxLjkuMyAzLjguNSA1LjcuNSAxOS45IDAgMzYtMTMuNCAzNi0zMFM4My45IDI4IDY0IDI4eiIgZmlsbD0iI2ZmZiIvPjxjaXJjbGUgY3g9IjUwIiBjeT0iNTkiIHI9IjQuNSIgZmlsbD0iIzIyOGJlNiIvPjxjaXJjbGUgY3g9IjY0IiBjeT0iNTkiIHI9IjQuNSIgZmlsbD0iIzIyOGJlNiIvPjxjaXJjbGUgY3g9Ijc4IiBjeT0iNTkiIHI9IjQuNSIgZmlsbD0iIzIyOGJlNiIvPjwvc3ZnPg=="

// ── 模型表 ────────────────────────────────────────────────────────────
//
// ⚠ context 必须实测，不要凭印象填。这个数字会被转给 agent（DSH 等），
//   决定它什么时候压缩对话：填小了浪费容量、还会把路由组整体的窗口拉低；
//   填大了 agent 以为有余量，请求超了上游才报错。
//
// 这里用的是**厂商自己在 model_list 里声明的 contextWindow**（不是猜的），
// 而且只是未登录时的兜底 —— 登录后 provider.models 用账号自己的实时目录替换。

// ── 倍率 ────────────────────────────────────────────────────────────
//
// Chatbox 按「计算点」计价：模型目录里每条都带 `pricing.tokensPerComputePoint`
// （1 计算点能换多少 token）与 `officialInput/officialOutput`（官方美元价/百万 token）。
// 两者是同一件事的两种写法 —— 1 计算点 = $0.000001 的官方成本，所以
// 1/tokensPerComputePoint == officialInput（实测 63 条里 59 条精确吻合，其余 4 条是
// 厂商自己四舍五入/未同步）。**没有另一个「厂商倍率」字段**。
//
// magpie 的 `rate` 是「相对官方价的倍数」。这里用**相对基准模型 chatboxai-3.5**
// （免费计划的默认模型，3.33 token/点）来算：rate = 3.33 / 该模型的 token/点，
// 也就是「同样一句话，它比 Chatbox AI 3.5 多/少烧几倍计算点」。口径写在 README 与
// docs/internals.md，**不是折扣**。
export const RATE_BASE_MODEL = "chatboxai-3.5"
const BASE_TPC = CATALOG_BY_ID[RATE_BASE_MODEL]?.price?.tpc || 0
const BASE_INPUT = CATALOG_BY_ID[RATE_BASE_MODEL]?.price?.in || 0

const round2 = (n) => Math.round(n * 100) / 100

/** 相对 chatboxai-3.5 的计算点消耗倍数；算不出来返回 0（不猜） */
export function rateOf(price) {
  if (!price) return 0
  const tpc = Number(price.tpc)
  if (Number.isFinite(tpc) && tpc > 0 && BASE_TPC > 0) return round2(BASE_TPC / tpc)
  const input = Number(price.in)
  if (Number.isFinite(input) && input > 0 && BASE_INPUT > 0) return round2(input / BASE_INPUT)
  return 0
}

/** [id, 显示名, 上下文窗口, reasoning 档位] —— 从 catalog 派生的兼容视图 */
export const MODELS = CATALOG.map((m) => [
  m.id,
  m.name,
  m.context,
  m.caps.includes("reasoning") ? ["low", "medium", "high"] : undefined,
])

/**
 * 一个模型条目 —— `config` 的静态表和 `provider.models` 的动态表共用这一个工厂，
 * 两条路径写出来的形状必须一致（HOOKS 十一之三）。
 */
export function entryOf(m) {
  const vision = Array.isArray(m.caps) ? m.caps.includes("vision") : Boolean(m.vision)
  const reasoning = Array.isArray(m.caps) ? m.caps.includes("reasoning") : Boolean(m.reasoning)
  const toolcall = Array.isArray(m.caps) ? m.caps.includes("tool_use") : m.toolcall !== false
  const context = Number.isFinite(m.context) && m.context > 0 ? m.context : undefined
  const price = m.price || null
  const rate = rateOf(price)
  const gateway = GATEWAYS[m.apiStyle] || GATEWAYS.openai
  return {
    id: m.id,
    name: m.name || m.id,
    api: { id: m.id, url: gateway.url, npm: gateway.npm },
    status: "active",
    // cost 只用于显示（USD / 百万 token）；拿不到就不写，别填 0 假报免费
    ...(price ? { cost: { input: price.in, output: price.out, cache: { read: 0, write: 0 } } } : {}),
    ...(context ? { limit: { context } } : {}),
    // config 钩子的静态模型走 modalities；capabilities.input 是 provider.models 路径的字段。
    // 两个都写，避免「只写 capabilities 而 config 路径读不到模态」。
    modalities: { input: vision ? ["text", "image"] : ["text"], output: ["text"] },
    capabilities: {
      temperature: true,
      reasoning,
      toolcall,
      attachment: false,
      // HOOKS 十一之三：五个模态键必须显式写布尔（省略 image ≠ text）
      input: { text: true, image: vision, audio: false, video: false, pdf: false },
      output: { text: true },
    },
    ...(reasoning ? { variants: { low: {}, medium: {}, high: {} } } : {}),
    // 倍率：相对 chatboxai-3.5 的计算点倍数（display-only，不参与路由）
    ...(rate > 0 ? { rate } : {}),
  }
}

/** 静态模型表（未登录 / 拉取失败时兜底，必须有内容） */
export function staticModels() {
  const out = {}
  for (const m of CATALOG) out[m.id] = entryOf(m)
  return out
}

/** 框里所有小插头拿到的同一份上下文 */
export const ctx = { PROVIDER, PROVIDER_NAME, ORIGIN, WEB_ORIGIN, BASE, SDK, ICON, REFRESH_LEAD_MS, MODELS, staticModels }
