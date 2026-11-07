// src/chat.mjs —— 对话转发：流式、[DONE]、鉴权头、以及两个「不报错但结果错」的坑
//
// 实测契约（2026-11-03，Chatbox 1.23.5 / free 计划）：
//   · 四条网关都通，按模型的 `apiStyle` 分流（与官方客户端一致）：
//       openai             → /gateway/openai/v1/chat/completions
//       openai-responses   → /gateway/openai-responses/v1/responses
//       anthropic          → /gateway/anthropic/v1/messages      （x-api-key）
//       google             → /gateway/google-ai-studio/v1beta/…  （x-goog-api-key）
//   · **永远返回 SSE** —— 即使请求里写 `stream: false`
//   · **流末尾没有 `data: [DONE]`**，最后一帧带 `usage`
//   · **服务端不校验 vision 能力位**：给一个 text-only 模型发图片，它不报错，
//     会无边界复读（14k 帧 / 3.7MB / 一天额度打穿）。所以插件必须自己拦。

import { CATALOG_BY_ID } from "./catalog.mjs"
import { fromUpstream } from "./api.mjs"
import { PROVIDER_NAME } from "./context.mjs"

/** 上游没有的结束哨兵；补上之后 OpenAI 系客户端才会干净收尾 */
const DONE_FRAME = "data: [DONE]\n\n"

/** 只代理这四条网关；别的端点一律 501（ERROR-CODES：端点不存在用 501，不是 404） */
const GATEWAY_PATH = /\/gateway\/(openai|openai-responses|anthropic|google-ai-studio)\//

/** 统一的错误响应体（ERROR-CODES §1 的形状）。三个参数都是显式的，R1 要求的形态 */
export function errorResponse(status, code, message) {
  return new Response(
    JSON.stringify({ error: { message, type: "upstream_error", code, status } }),
    { status, headers: { "content-type": "application/json; charset=utf-8" } },
  )
}

/** 把上游的 SSE 流原样转发，并在结尾补 `data: [DONE]`（不读干流、不攒帧） */
export function appendDone(res) {
  const type = res.headers.get("content-type") || ""
  if (!res.body || !type.includes("text/event-stream")) return res
  const reader = res.body.getReader()
  const encoder = new TextEncoder()
  let finished = false
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          if (!finished) {
            finished = true
            controller.enqueue(encoder.encode(DONE_FRAME))
          }
          controller.close()
          return
        }
        controller.enqueue(value)
      } catch (e) {
        controller.error(e)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers })
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null
  } catch {
    return null
  }
}

/** 请求体里有没有图片（OpenAI / Anthropic / Responses 三种形状都认） */
export function hasImageInput(body) {
  if (!body || typeof body !== "object") return false
  const look = (node, depth = 0) => {
    if (depth > 4 || node == null) return false
    if (Array.isArray(node)) return node.some((v) => look(v, depth + 1))
    if (typeof node !== "object") return false
    const type = String(node.type || "")
    if (type === "image_url" || type === "image" || type === "input_image") return true
    if (node.image_url) return true
    // Gemini：inlineData / fileData（大小写两种拼法都见过）
    if (node.inlineData || node.inline_data || node.fileData || node.file_data) return true
    return Object.values(node).some((v) => (typeof v === "object" ? look(v, depth + 1) : false))
  }
  return look(body.messages ?? body.input ?? [])
}

/** 目录里这个模型能不能收图。查不到（新模型 / 未收录）时**不拦** —— 不猜。 */
export function catalogSupportsImage(modelId) {
  const m = CATALOG_BY_ID[String(modelId || "")]
  return m ? m.caps.includes("vision") : true
}

async function errorFromResponse(res, { modelId = "", knownModel = true } = {}) {
  const text = await res.text().catch(() => "")
  const json = parseJson(text)
  const e = fromUpstream(res.status, json, text, res.url)
  // 目录里没有这个 model id，且上游回 400 bad_params → 模型不存在（404 只搁置这个模型）
  if (!knownModel && res.status === 400) {
    return errorResponse(
      404,
      "model_not_found",
      `不认识模型 ${modelId || "（请求里没有 model）"}：${e.message}`,
    )
  }
  return errorResponse(e.status || 502, e.code || "upstream_error", e.message)
}

/**
 * loader 的 fetch：magpie 把「要发给上游的请求」交给我们。
 *
 * 返回值约束（HOOKS 六）：
 *   · 不读流 —— 上游是 SSE，原样交回去由 magpie 分帧
 *   · 状态码 / 头 / body 透传
 *   · 错误必须带上 status + code（ERROR-CODES §1）
 */
export function createChatFetch(getAuth) {
  return async function chatFetch(input, init) {
    const auth = await getAuth()
    if (!auth?.access) {
      return errorResponse(
        401,
        "sign_in_required",
        "未登录：请先在 magpie 里添加一个 Chatbox AI 账号",
      )
    }

    const req = input instanceof Request ? input : null
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : req?.url || ""
    if (!GATEWAY_PATH.test(url)) {
      return errorResponse(501, "not_implemented", `不代理这个端点：${url}`)
    }

    const isAnthropic = url.includes("/gateway/anthropic/")
    const isGoogle = url.includes("/gateway/google-ai-studio/")

    const headers = new Headers(init?.headers || req?.headers || {})
    // 按网关换鉴权头：anthropic 认 x-api-key，google 认 x-goog-api-key，其余认 Bearer
    headers.delete("authorization")
    headers.delete("x-api-key")
    headers.delete("x-goog-api-key")
    if (isAnthropic) headers.set("x-api-key", String(auth.access))
    else if (isGoogle) headers.set("x-goog-api-key", String(auth.access))
    else headers.set("authorization", `Bearer ${auth.access}`)
    if (isAnthropic && !headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01")
    if (auth.instanceId) headers.set("Instance-Id", String(auth.instanceId))
    // 这两个由运行时决定，不能透传
    headers.delete("content-length")
    headers.delete("host")

    let body = init?.body
    if (body === undefined && req) body = await req.text()

    // ── 拦「给 text-only 模型发图片」：服务端不拦，会无边界复读把额度打穿 ──
    let modelId = ""
    let knownModel = true
    if (typeof body === "string" && body.trim()) {
      const parsed = parseJson(body)
      modelId = String(parsed?.model || "")
      knownModel = !modelId || Boolean(CATALOG_BY_ID[modelId])
      if (modelId && hasImageInput(parsed) && !catalogSupportsImage(modelId)) {
        return errorResponse(
          400,
          "invalid_request",
          `模型 ${modelId} 不支持图片输入（capabilities 里没有 vision）。` +
            `请换一个能收图的模型（如 deepseek-v4-flash-vision / gpt-6-astra / claude-sonnet-5）。`,
        )
      }
    }

    let res
    try {
      res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: init?.signal || req?.signal,
      })
    } catch (e) {
      const msg = String(e?.message || e)
      if (/abort/i.test(String(e?.name || ""))) {
        return errorResponse(504, "upstream_timeout", `请求被中断：${msg}`)
      }
      return errorResponse(503, "upstream_unavailable", `连不上 Chatbox 网关（api.chatboxai.app）：${msg}`)
    }

    if (!res.ok) return errorFromResponse(res, { modelId, knownModel })
    return appendDone(res)
  }
}
