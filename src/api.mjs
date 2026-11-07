// src/api.mjs —— 打上游的那一层，只有这一层知道 Chatbox 长什么样
//
// 为什么单独一个文件：钩子里出现的所有网络请求都从这里出，
// 好处是错误语义只在一处定义 —— 而错误语义正是最容易静默出错的地方。
//
// 三个约定（ERROR-CODES.md）：
//   ① 统一出口 `request()`：非 2xx、坏 JSON 都在这里变成 ApiError
//   ② **模型级错误用 404，不要 401** —— 401 会被 magpie 当成登录失效，整个账号被停
//   ③ 每个请求都带超时 —— 没有超时的 fetch 会挂死整张卡片

import { CLIENT_HEADERS, ORIGIN, PROVIDER_NAME, WEB_ORIGIN } from "./context.mjs"

/** 上游给的错误。带上 status 与 code，调用方才能分流。 */
export class ApiError extends Error {
  constructor(message, { status = 0, code = "", url = "", body = null } = {}) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.code = code
    this.url = url
    this.body = body
  }
}

/** 默认超时：列表/额度 10s，登录这类需要人工介入的 20s */
export const TIMEOUT = { short: 10_000, normal: 20_000 }

const hostOf = (url) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** 把上游的 `{ error: { code, detail, status, title } }` 翻译成插件错误码 */
export function fromUpstream(status, json, text, url) {
  const err = json?.error && typeof json.error === "object" ? json.error : null
  const upstreamCode = String(err?.code ?? json?.code ?? "")
  const message =
    String(err?.detail || err?.message || json?.message || text || "")
      .trim()
      .slice(0, 400) || `HTTP ${status}`
  // 宿主会在错误前面加自己的 provider 名，这里不要再重复一遍
  const detail = `上游返回 ${status}${upstreamCode ? `（${upstreamCode}）` : ""}：${message}`

  if (status === 401) {
    // 只有「key 不存在 / 会话失效」才是登录问题
    const code = /license_not_found|invalid_license|license_key_required|unauthorized/.test(upstreamCode)
      ? "sign_in_required"
      : "session_expired"
    return new ApiError(detail, { status, code, url, body: json })
  }
  if (status === 403) return new ApiError(detail, { status, code: "session_expired", url, body: json })
  if (status === 404) {
    const code = /model|模型|not_found/.test(upstreamCode + message) ? "model_not_found" : "upstream_error"
    return new ApiError(detail, { status, code, url, body: json })
  }
  if (status === 409) return new ApiError(detail, { status, code: "concurrency_conflict", url, body: json })
  if (status === 429) return new ApiError(detail, { status, code: "rate_limited", url, body: json })
  // 499 是 Chatbox 自己的「额度耗尽」码（非标准）。换成宿主管得着的 429，
  // 让它退避到下一个重置点，而不是把这个号标成登录失效。
  if (status === 499 || upstreamCode === "token_quota_exhausted" || upstreamCode === "free_token_quota_exhausted") {
    return new ApiError(`${detail}（额度已用完，等重置后再试）`, { status: 429, code: "rate_limited", url, body: json })
  }
  // 450：这个 license 的套餐不支持该模型（free 调 pro 模型）。
  // 模型级问题 → 404，宿主只搁置这个模型，不换号。
  if (status === 450 || upstreamCode === "license_upgrade_required") {
    return new ApiError(`${detail}（该模型需要更高的套餐）`, { status: 404, code: "model_not_found", url, body: json })
  }
  if (status === 501) return new ApiError(detail, { status, code: "not_implemented", url, body: json })
  if (status === 400 || status === 413 || status === 422) {
    return new ApiError(detail, { status, code: "invalid_request", url, body: json })
  }
  if (status >= 500) return new ApiError(detail, { status: 503, code: "upstream_unavailable", url, body: json })
  return new ApiError(detail, { status: 502, code: "upstream_error", url, body: json })
}

/** 统一请求出口：超时、非 2xx、坏 JSON 都变成 ApiError */
export async function request(url, { method = "GET", headers = {}, body, timeout = TIMEOUT.short } = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...CLIENT_HEADERS,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    })
  } catch (e) {
    const name = String(e?.name || "")
    const msg = String(e?.message || e)
    if (/abort/i.test(name) || /timeout|timed out/i.test(msg)) {
      throw new ApiError(`请求 Chatbox（${hostOf(url)}）超时：${msg}`, {
        status: 0,
        code: "upstream_timeout",
        url,
      })
    }
    throw new ApiError(`连不上 Chatbox（${hostOf(url)}）：${msg}`, { status: 0, code: "upstream_unavailable", url })
  }

  const text = await res.text().catch(() => "")
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  if (!res.ok) throw fromUpstream(res.status, json, text, url)
  if (json === null) {
    throw new ApiError(`${PROVIDER_NAME} 上游返回的不是 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`, {
      status: res.status,
      code: "upstream_error",
      url,
    })
  }
  return json
}

// ── 端点 ──────────────────────────────────────────────────────────────

/**
 * 账号自己的模型目录。
 * ⚠ 实测（2026-11-03）：**这个端点不校验 license** —— 传一个不存在的 key 也返回
 * 同一份 free 目录。所以它不能当登录校验用，只用于「这个账号能看哪些模型」。
 */
export async function modelList(licenseKey, language = "zh-Hans") {
  const url = `${ORIGIN}/api/chatbox_ai/model_list`
  const json = await request(url, { method: "POST", body: { licenseKey, language }, timeout: TIMEOUT.short })
  return json?.data ?? null
}

/**
 * 实时额度。`Authorization` 是**裸 license key**（不带 Bearer）—— 这一点和网关相反，
 * 抄错会 401。
 */
export async function licenseDetail(licenseKey) {
  const url = `${ORIGIN}/api/license/detail/realtime`
  const json = await request(url, { headers: { authorization: licenseKey }, timeout: TIMEOUT.short })
  return json?.data ?? null
}

/** 校验 key 与实例绑定（登录时用；额度卡片不走它，省一次请求） */
export async function validateLicense(licenseKey, instanceId) {
  const url = `${ORIGIN}/api/license/validate`
  const json = await request(url, { method: "POST", body: { licenseKey, instanceId }, timeout: TIMEOUT.short })
  return json?.data ?? null
}

/** 把一个 license 绑到本机实例上（登录后调一次） */
export async function activateLicense(licenseKey, instanceName) {
  const url = `${ORIGIN}/api/license/activate`
  const json = await request(url, {
    method: "POST",
    body: { licenseKey, instanceName },
    timeout: TIMEOUT.normal,
  })
  return json?.data ?? null
}

/** 邮箱登录第一步：发验证码（会真的发邮件，只在用户点登录时调） */
export async function sendEmailLoginCode(email, lang = "zh-Hans") {
  const url = `${WEB_ORIGIN}/api/auth/send_email_login_code`
  const json = await request(url, { method: "POST", body: { email, lang }, timeout: TIMEOUT.normal })
  const result = json?.data?.result ?? null
  // 实测/代码：成功时是字符串 "sent"，不是布尔 true
  if (result !== "sent" && result !== true) {
    throw new ApiError(`${PROVIDER_NAME} 验证码没有发出去（上游返回 ${JSON.stringify(result)}）`, {
      status: 502,
      code: "internal_error",
      url,
      body: json,
    })
  }
  return result
}

/** 邮箱登录第二步：验证码换 token */
export async function loginWithEmailCode(email, code) {
  const url = `${WEB_ORIGIN}/api/auth/login_or_signup_with_email_code`
  const json = await request(url, { method: "POST", body: { email, code }, timeout: TIMEOUT.normal })
  const data = json?.data ?? {}
  const accessToken = String(data.access_token ?? "")
  const refreshToken = String(data.refresh_token ?? "")
  if (!accessToken) {
    throw new ApiError(`${PROVIDER_NAME} 登录没有返回 access_token（接口形状变了）`, {
      status: 502,
      code: "internal_error",
      url,
      body: json,
    })
  }
  return { accessToken, refreshToken }
}

/** 账号下所有 license（含 key、plan、状态） */
export async function listLicenses(accessToken) {
  const url = `${WEB_ORIGIN}/api/license/list_by_user`
  const json = await request(url, {
    // ⚠ 这个域名下的账号端点认 `x-chatbox-access-token`，不认 Authorization: Bearer
    headers: { "x-chatbox-access-token": accessToken },
    timeout: TIMEOUT.short,
  })
  return Array.isArray(json?.data) ? json.data : Array.isArray(json?.data?.licenses) ? json.data.licenses : []
}

/** 账号资料（邮箱 / 昵称 / 内部 id）—— 失败不阻塞登录，交给调用方 */
export async function userProfile(accessToken) {
  const url = `${WEB_ORIGIN}/api/user/profile`
  const json = await request(url, {
    headers: { "x-chatbox-access-token": accessToken },
    timeout: TIMEOUT.short,
  })
  return json?.data ?? null
}

/**
 * 把「这个模型不行」翻译成 404 —— 钩子层的铁律。
 * magpie 的语义：401/403 → 整个账号停用；404 → 只搁置这个模型。
 */
export function asModelError(e, modelId = "") {
  if (!(e instanceof ApiError)) return e
  const looksLikeModel = /model|模型|not found|不存在|no access|未开通|not support/i.test(String(e.message))
  if (looksLikeModel || e.status === 400 || e.status === 422) {
    return Object.assign(
      new ApiError(e.message, { status: 404, code: "model_not_found", url: e.url, body: e.body }),
      { modelId },
    )
  }
  return e
}

/** 登录态失效的判据。**只有真的确定失效才抛 signIn: "expired"** */
export function asSignInExpired(message = "Chatbox AI 登录已失效") {
  return Object.assign(new Error(message), { signIn: "expired" })
}

export function isAuthFailure(e) {
  return e instanceof ApiError && (e.status === 401 || e.status === 403)
}
