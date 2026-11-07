// magpie 插件：Chatbox AI 免费额度
//
// 把本机 Chatbox 客户端（或你自己的 Chatbox 账号）那个 license 背后的模型，
// 接进 magpie / OpenCode：DeepSeek V4、GPT-6、Claude 5、Gemini 4、Grok 4.7……
// 全部走 Chatbox 自己的 OpenAI 兼容网关 `https://api.chatboxai.app/gateway/openai/v1`。
//
// ═══════════════════════════════════════════════════════════════════════
// 九项清单（实现全在 src/，本文件只做装配）
// ═══════════════════════════════════════════════════════════════════════
//
//  ① config(cfg)                      声明 provider + 静态模型表
//  ② auth.methods[].authorize()       登录（三条路：本机导入 / 粘贴 key / 邮箱验证码）
//  ③ auth.refresh(auth, provider)     续期（license key 长期有效，这里是空续期）
//  ④ auth.loader(getAuth, provider)   请求接管（转给网关 + 补 [DONE]）
//  ⑤ auth.usage(getAuth, provider)    额度 → 卡片进度条
//  ⑥ auth.checkin(getAuth, provider)  签到（Chatbox 没有签到，如实说）
//  ⑦ provider.models(provider,{auth}) 每账号目录（model_list + 快照兜底）
//  ⑧ "chat.headers"(input, output)    每请求加 session 头
//
//  ⑨ 数据字段：accountId（邮箱）/ uid / auth.icon / magpie.icon / maxConcurrency
//
// ═══════════════════════════════════════════════════════════════════════
// 三条铁律
// ═══════════════════════════════════════════════════════════════════════
//
// 1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
// 2. authorize() 立刻返回 —— 真正等用户的是 callback()，否则和 magpie 死锁
// 3. refresh 返回的是合并 —— client.auth.set 是整体替换，两者不同
//
// ═══════════════════════════════════════════════════════════════════════

import os from "node:os"

import { BASE, ICON, MODELS, PROVIDER, PROVIDER_NAME, REFRESH_LEAD_MS, SDK, staticModels } from "./src/context.mjs"
import { createUsageCache } from "./src/usage-cache.mjs"
import { usageFromDetail } from "./src/license.mjs"
import { configCandidates, readLocalLicense } from "./src/local.mjs"
import { fallbackModels, buildModels, saveSnapshot, snapshotModels } from "./src/models.mjs"
import { createChatFetch } from "./src/chat.mjs"
import {
  activateLicense,
  licenseDetail,
  listLicenses,
  loginWithEmailCode,
  modelList,
  sendEmailLoginCode,
  userProfile,
  validateLicense,
} from "./src/api.mjs"

const SITE = PROVIDER

/** 本机实例名：激活 license 时用，出现在 Chatbox 的「已登录设备」里 */
function deviceName() {
  const host = String(os.hostname() || "").trim().slice(0, 32) || "magpie"
  return `magpie@${host}`
}

/** 账号的缓存键：license key 的尾部 8 位 —— 不把整把 key 写进文件名 */
function keyOf(auth) {
  const raw = String(auth?.access || auth?.key || "")
  return raw.length >= 8 ? raw.slice(-8) : raw
}

/** 从任意形状的 license 列表里找出 license key（字段名不稳定，按 uuid 形状扫） */
function licenseKeysOf(list) {
  const out = []
  const seen = new Set()
  const walk = (value, depth = 0) => {
    if (depth > 4 || value == null) return
    if (typeof value === "string") {
      const s = value.trim()
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) && !seen.has(s)) {
        seen.add(s)
        out.push(s)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const v of value) walk(v, depth + 1)
      return
    }
    if (typeof value === "object") {
      for (const v of Object.values(value)) walk(v, depth + 1)
    }
  }
  walk(list)
  return out
}

export const ChatboxAiAuthPlugin = async (_ctx, _options) => {
  // 额度卡片会被频繁刷新：成功 60 秒、失败 5 秒，同 key 并发合并。
  // key 用 license key 的尾部 —— 不能用 provider id，否则多账号会串额度。
  const usageCache = createUsageCache({ ttlMs: 60_000, failTtlMs: 5_000 })

  return {
    // ═══ ① 声明 provider ═════════════════════════════════════════════
    config: async (cfg) => {
      cfg.provider ??= {}
      // ⚠ 用 ??= ，不要覆盖用户在 plugins.json 里配的
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: SDK,
        api: BASE,
        models: staticModels(), // ⚠ 未登录时也必须有内容
      }
    },

    auth: {
      provider: PROVIDER,

      // ── 数据字段（不是钩子）──────────────────────────────────────
      // ⚠ 图标要写两份（这里 + package.json.magpie.icon），缺一份就有地方显示灰方块
      icon: ICON,
      maxConcurrency: 4,
      refreshLead: REFRESH_LEAD_MS,

      // ═══ ② 登录 ═════════════════════════════════════════════════
      methods: [
        {
          type: "oauth",
          label: `从本机 Chatbox 客户端导入`,
          /**
           * 免登录路：Chatbox 桌面端已经把 license key 存在
           * `%APPDATA%/xyz.chatboxapp.app/config.json` 里，插件只读。
           */
          async authorize() {
            return {
              instructions:
                "本插件读取本机 Chatbox 客户端已登录的 license key（只读，不修改客户端）。" +
                "确认本机 Chatbox 已登录后点继续。",
              method: "auto",
              opened: true,
              async callback() {
                const local = readLocalLicense()
                if (!local) {
                  return {
                    type: "failed",
                    error:
                      "本机没有找到已登录的 Chatbox 客户端（config.json 里没有 licenseKey）。" +
                      "请先在 Chatbox 里登录，或改用「粘贴 license key / 邮箱验证码登录」。",
                  }
                }
                try {
                  const check = await validateLicense(local.licenseKey, local.instanceId)
                  if (!check?.valid) {
                    return { type: "failed", error: "本机 license 校验失败（可能已过期），请先在 Chatbox 里重新登录" }
                  }
                } catch (e) {
                  return { type: "failed", error: `校验本机 license 失败：${e?.message || e}` }
                }
                return {
                  type: "success",
                  access: local.licenseKey,
                  refresh: "",
                  expires: 0,
                  accountId: local.email || "",
                  uid: "",
                  instanceId: local.instanceId || "",
                  metadata: { plan: local.plan, source: "desktop-import", file: local.file },
                }
              },
            }
          },
        },

        {
          type: "oauth",
          label: "粘贴 license key",
          prompts: [
            {
              type: "password",
              key: "licenseKey",
              message: "Chatbox AI license key",
              placeholder: "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
              validate: (v) =>
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || "").trim())
                  ? undefined
                  : "license key 是 36 位的 uuid",
            },
          ],
          async authorize(inputs) {
            const key = String(inputs?.licenseKey || "").trim()
            if (!key) return { type: "failed", error: "没有收到 license key" }
            try {
              const check = await validateLicense(key, "")
              if (!check?.valid) return { type: "failed", error: "这个 license key 无效或已过期" }
            } catch (e) {
              return { type: "failed", error: `校验 license 失败：${e?.message || e}` }
            }
            return {
              type: "success",
              access: key,
              refresh: "",
              expires: 0,
              accountId: "",
              uid: "",
              instanceId: "",
              metadata: { source: "manual" },
            }
          },
        },

        {
          type: "oauth",
          label: "邮箱验证码登录",
          prompts: [
            {
              type: "text",
              key: "email",
              message: "邮箱",
              placeholder: "you@example.com",
              validate: (v) => (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || "").trim()) ? undefined : "邮箱格式不对"),
            },
          ],
          /**
           * 两步：authorize 里发验证码（一次网络请求，不等用户），
           * 面板用 `method: "code"` 收验证码，callback(code) 换 token → 找 license → 激活。
           */
          async authorize(inputs) {
            const email = String(inputs?.email || "").trim()
            if (!email) return { type: "failed", error: "没有收到邮箱" }
            try {
              await sendEmailLoginCode(email)
            } catch (e) {
              return { type: "failed", error: `验证码发送失败：${e?.message || e}` }
            }
            return {
              url: "https://chatboxai.app",
              instructions: `验证码已发到 ${email}。把邮件里的验证码填进下面的输入框。`,
              method: "code",
              opened: true,
              async callback(code) {
                const c = String(code || "").trim()
                if (!c) return { type: "failed", error: "验证码为空" }
                let tokens
                try {
                  tokens = await loginWithEmailCode(email, c)
                } catch (e) {
                  return { type: "failed", error: `登录失败：${e?.message || e}` }
                }
                let keys = []
                try {
                  keys = licenseKeysOf(await listLicenses(tokens.accessToken))
                } catch (e) {
                  return { type: "failed", error: `读取账号 license 失败：${e?.message || e}` }
                }
                if (keys.length === 0) {
                  return { type: "failed", error: "这个账号下没有可用的 Chatbox AI license" }
                }
                const key = keys[0]
                let instanceId = ""
                try {
                  const activated = await activateLicense(key, deviceName())
                  instanceId = String(activated?.instanceId || "")
                } catch {
                  // 激活失败不阻塞登录：网关不强制 Instance-Id（2026-11-03 实测）
                }
                let profile = null
                try {
                  profile = await userProfile(tokens.accessToken)
                } catch {
                  profile = null
                }
                return {
                  type: "success",
                  access: key,
                  refresh: "",
                  expires: 0,
                  accountId: email,
                  uid: String(profile?.id || ""),
                  instanceId,
                  metadata: { source: "email-login" },
                }
              },
            }
          },
        },
      ],

      // ═══ ③ 续期 ═════════════════════════════════════════════════
      /**
       * license key 长期有效、不轮换；`expires: 0` 的账号 magpie 也永不续期。
       * 保留这个钩子是为了契约完整：返回 undefined = 不续期，原凭据全部保留。
       */
      async refresh(auth) {
        if (!auth?.access) return undefined
        return undefined
      },

      // ═══ ④ 请求接管 ═════════════════════════════════════════════
      /**
       * 每个账号跑一次（登录态变化后会重跑）。
       * 返回的字段：baseURL / apiKey / headers / fetch（HOOKS 六）。
       *
       * magpie 自动按 npm 包加 `Authorization: Bearer <apiKey>`；
       * 我们在这里再显式设一次（fetch 里），避免宿主版本差异。
       */
      async loader(getAuth, provider) {
        const auth = await getAuth()
        if (!auth) return {}
        return {
          // ⚠ 不写 baseURL：每个模型的 api.url 指向自己那条网关
          //   （openai / openai-responses / anthropic / google-ai-studio）。
          //   loader.baseURL 的优先级高于 model.api，写了就把四条网关压成一条。
          apiKey: auth.access || "",
          headers: auth.instanceId ? { "Instance-Id": String(auth.instanceId) } : {},
          fetch: createChatFetch(getAuth),
        }
      },

      // ═══ ⑤ 额度 ═════════════════════════════════════════════════
      /**
       * 卡片进度条（HOOKS 十一）：free 计划每天 10000 token，0 点重置。
       * 窗口由 src/license.mjs 构造 —— 写错会抛 QuotaShapeError，而不是静默坏掉。
       */
      async usage(getAuth, provider) {
        const auth = await getAuth()
        if (!auth?.access) return { error: "未登录", windows: [] }

        const cacheKey = keyOf(auth)
        if (!cacheKey) return { error: "未登录", windows: [] }

        let detail
        try {
          detail = await usageCache.read(cacheKey, () => licenseDetail(auth.access))
        } catch (e) {
          // 上游失败 → 让卡片显示原因。抛出去 magpie 只会记成「读取失败」，用户看不到原因。
          return { error: String(e?.message || e), windows: [] }
        }
        return usageFromDetail(detail)
      },

      // ═══ ⑥ 签到 ═════════════════════════════════════════════════
      async checkin(getAuth) {
        const auth = await getAuth()
        if (!auth) return { outcome: "failed", message: "未登录" }
        return {
          outcome: "inactive",
          message: `${PROVIDER_NAME} 没有每日签到：免费额度每天 0 点自动重置`,
        }
      },
    },

    // ═══ ⑦ 每账号的模型目录 ═════════════════════════════════════════
    /**
     * 三态降级（AGENTS 坑 17）：
     *   ① model_list 整个失败  → 退回上次快照，再退回静态表（不返回空表）
     *   ② 成功但单条缺字段     → 不列（src/models.mjs 里处理）
     *   ③ 登录失效（401）      → 抛 signIn: "expired"
     */
    provider: {
      id: PROVIDER,

      async models(provider, { auth } = {}) {
        const fallback = fallbackModels()
        const licenseKey = String(auth?.access || auth?.key || "")
        if (!licenseKey) return fallback

        try {
          const data = await modelList(licenseKey)
          const built = buildModels(data)
          if (!built) return snapshotModels({ siteId: SITE, account: keyOf(auth) }) || fallback
          saveSnapshot(built.models, { siteId: SITE, account: keyOf(auth) })
          return built.models
        } catch (e) {
          if (e?.status === 401 || e?.status === 403) {
            throw Object.assign(new Error(e.message || "Chatbox AI 登录已失效"), { signIn: "expired" })
          }
          return snapshotModels({ siteId: SITE, account: keyOf(auth) }) || fallback
        }
      },
    },

    // ═══ ⑧ 每请求加头 ═══════════════════════════════════════════════
    "chat.headers": async (input, output) => {
      const id = input?.model?.providerID ?? input?.provider?.info?.id
      if (id !== PROVIDER) return
      if (input?.sessionID) output.headers["chatbox-session-id"] = String(input.sessionID).slice(0, 128)
    },
  }
}

// 供测试引用（⚠ 入口文件不要导出 helper 函数，否则会被当插件调用）
export const _internal = {
  PROVIDER,
  PROVIDER_NAME,
  BASE,
  SDK,
  MODELS,
  staticModels,
  readLocalLicense,
  configCandidates,
  licenseKeysOf,
  deviceName,
  keyOf,
}
