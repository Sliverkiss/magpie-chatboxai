// src/models.mjs —— 模型目录：映射、过滤、三态降级
//
// `provider.models` 是最容易「看起来对、实际错」的钩子（HOOKS 十七）：
//   ① 整个接口失败  → 退回上次快照（不要返回空表）
//   ② 接口成功但单条缺字段 → 不列（不猜）
//   ③ 登录失效      → 抛 signIn: "expired"
//
// Chatbox 的模型目录来自 `POST /api/chatbox_ai/model_list`：
//   data.models[<id>] = { modelId, modelName, description, labels, capabilities,
//                         apiStyle, contextWindow, costLevel, access, pricing }
//   capabilities 里是 "vision" / "tool_use" / "reasoning" 三个词（不是布尔字段）。

import { CATALOG } from "./catalog.mjs"
import { entryOf, staticModels } from "./context.mjs"
import { readSnapshot, writeSnapshot } from "./store.mjs"

/** 上游目录里这一条能不能给用户选（缺 id / 明确不可用 / 非 chat 的都不列） */
export function isUsable(m) {
  const id = String(m?.modelId ?? m?.id ?? "").trim()
  if (!id) return false
  if (m?.type && m.type !== "chat") return false
  if (m?.access && m.access.available === false) return false
  return true
}

/**
 * 把上游的一条模型变成 magpie 的模型条目。
 *
 * `pricing.officialInput/officialOutput` 是厂商公布的美元/百万 token 价，
 * 只用于 `cost` 显示 —— **不要**据此推导 `rate`：Chatbox 是按「计算点」计费的，
 * 倍率换算没有公开口径，猜一个数只会把用户骗到（HOOKS 十一之二）。
 */
export function fromLive(m) {
  const pricing = m?.pricing || null
  return entryOf({
    id: String(m.modelId).trim(),
    name: String(m.modelName || m.modelId).trim(),
    caps: Array.isArray(m.capabilities) ? m.capabilities : [],
    apiStyle: m.apiStyle,
    context: Number(m.contextWindow) || undefined,
    price:
      pricing && Number.isFinite(Number(pricing.officialInput)) && Number.isFinite(Number(pricing.officialOutput))
        ? {
            in: Number(pricing.officialInput),
            out: Number(pricing.officialOutput),
            tpc: Number(pricing.tokensPerComputePoint) || 0,
          }
        : null,
  })
}

/**
 * 组装一份完整目录。返回 null 表示「上游这次没给出可用目录」，调用方应退回快照。
 * 不会返回空 map —— 空 map 会让卡片显示 0 models。
 */
export function buildModels(data) {
  const source = data?.models
  if (!source || typeof source !== "object") return null
  const out = {}
  let dropped = 0
  for (const m of Object.values(source)) {
    if (!isUsable(m)) {
      dropped++
      continue
    }
    const entry = fromLive(m)
    // 单条缺字段（没有 id）→ 不列，不猜
    if (!entry.id) {
      dropped++
      continue
    }
    out[entry.id] = entry
  }
  if (Object.keys(out).length === 0) return null
  return { models: out, dropped, plan: data?.license?.plan }
}

/** 静态兜底（未登录 / 从未拉过目录） */
export function fallbackModels() {
  return staticModels()
}

/** 读上次快照；没有就返回 null。快照本身坏了也不抛。 */
export function snapshotModels({ siteId, account } = {}) {
  const snap = readSnapshot({ siteId, account })
  const models = snap?.models
  return models && typeof models === "object" && Object.keys(models).length > 0 ? models : null
}

/** 写快照（缓存写不进去不影响主流程） */
export function saveSnapshot(models, { siteId, account } = {}) {
  return writeSnapshot({ siteId, account }, models)
}

/** 目录里的 id 集合（测试 / 调试用） */
export function catalogIds() {
  return CATALOG.map((m) => m.id)
}
