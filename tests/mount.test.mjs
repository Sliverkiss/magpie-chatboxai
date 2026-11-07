// tests/mount.test.mjs —— 入口 / 九钩子挂载契约
//
// 结构参照 magpie-loomy-auth/tests/mount.test.mjs（MIT），针对本插件：
//   ① 入口只导出一个函数（magpie 会把每个函数导出都当插件工厂调用）
//   ② _internal 是对象（helper 不暴露成插件）
//   ③ 九项钩子齐全
//   ④ config() 未登录也有模型（否则卡片显示 "0 models"）
//   ⑤ loader() 给 apiKey / fetch，且**不给 baseURL**（否则四条网关会被压成一条）
//   ⑥ provider.models 未登录返回静态表
//   ⑦ usage 未登录给 error 而不是伪造 0
//
// 全部离线；不需要 magpie 进程、不需要凭据。
// 跑法：node --test tests/mount.test.mjs

import test from "node:test"
import assert from "node:assert/strict"

import * as entry from "../index.mjs"
import { _internal } from "../index.mjs"
import { usage, usageWindow } from "../src/quota.mjs"

const { ChatboxAiAuthPlugin } = entry

test("入口只导出一个函数（插件工厂）", () => {
  const functions = Object.entries(entry)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key)
  assert.deepEqual(functions, ["ChatboxAiAuthPlugin"])
})

test("_internal 是对象，helper 不暴露成顶层函数导出", () => {
  assert.equal(typeof _internal, "object")
  assert.equal(typeof _internal.PROVIDER, "string")
  assert.equal(_internal.PROVIDER, "chatbox-ai")
  assert.equal(typeof _internal.staticModels, "function")
  assert.ok(Array.isArray(_internal.MODELS))
  assert.equal(typeof _internal.readLocalLicense, "function")
  assert.equal(typeof _internal.licenseKeysOf, "function")
})

test("九项钩子齐全", async () => {
  const plugin = await ChatboxAiAuthPlugin({ client: {}, directory: undefined })
  assert.equal(typeof plugin.config, "function")
  assert.ok(plugin.auth && typeof plugin.auth === "object")
  assert.equal(plugin.auth.provider, _internal.PROVIDER)
  assert.equal(typeof plugin.auth.refresh, "function")
  assert.equal(typeof plugin.auth.loader, "function")
  assert.equal(typeof plugin.auth.usage, "function")
  assert.equal(typeof plugin.auth.checkin, "function")
  assert.ok(Array.isArray(plugin.auth.methods) && plugin.auth.methods.length >= 1)
  assert.equal(typeof plugin.auth.methods[0].authorize, "function")
  assert.equal(typeof plugin.provider.models, "function")
  assert.equal(typeof plugin["chat.headers"], "function")
  assert.equal(plugin.provider.id, _internal.PROVIDER)
  assert.ok(plugin.auth.icon?.startsWith("data:image/"), "图标必须内嵌（外部 URL 在 git 源下不渲染）")
  assert.ok(Number.isInteger(plugin.auth.maxConcurrency) && plugin.auth.maxConcurrency >= 1)
})

test("三条登录路都在：本机导入 / 粘贴 key / 邮箱验证码", async () => {
  const plugin = await ChatboxAiAuthPlugin({ client: {} })
  const labels = plugin.auth.methods.map((m) => m.label)
  assert.equal(labels.length, 3)
  assert.ok(labels.some((l) => l.includes("本机")))
  assert.ok(labels.some((l) => l.includes("粘贴")))
  assert.ok(labels.some((l) => l.includes("邮箱")))
  for (const method of plugin.auth.methods) {
    assert.equal(method.type, "oauth")
    assert.equal(method.authorize.constructor.name, "AsyncFunction")
  }
})

test("config() 未登录也声明了模型，且 modalities / 五个 input 布尔都在", async () => {
  const plugin = await ChatboxAiAuthPlugin({ client: {} })
  const cfg = {}
  await plugin.config(cfg)
  const models = cfg.provider?.[_internal.PROVIDER]?.models
  assert.ok(models && Object.keys(models).length > 0, "config.models 不能为空（铁律 1）")
  for (const [id, model] of Object.entries(models)) {
    assert.equal(model.id, id)
    // config 路径读的是 modalities，不是 capabilities；只写后者等于没写。
    assert.ok(Array.isArray(model.modalities.input) && model.modalities.input.length > 0, `${id}.modalities.input 必须给`)
    assert.deepEqual(model.modalities.output, ["text"])
    // HOOKS 十一之三只规定了 capabilities.input 的五个模态键；output 不发明字段
    for (const key of ["text", "image", "audio", "video", "pdf"]) {
      assert.equal(typeof model.capabilities.input[key], "boolean", `${id}.capabilities.input.${key} 必须是布尔`)
    }
    assert.equal(typeof model.capabilities.output.text, "boolean", `${id}.capabilities.output.text 必须是布尔`)
    // 协议由 api.npm 决定，不是 apiStyle
    assert.ok(
      ["@ai-sdk/openai-compatible", "@ai-sdk/openai", "@ai-sdk/anthropic", "@ai-sdk/google"].includes(model.api.npm),
      `${id}.api.npm 必须是 magpie 认的四个包之一`,
    )
  }
})

test("loader() 给 apiKey / fetch，但不给 baseURL；未登录返回空对象", async () => {
  const plugin = await ChatboxAiAuthPlugin({ client: {} })
  const out = await plugin.auth.loader(async () => ({ type: "oauth", access: "license-key", instanceId: "inst-1" }), {
    id: "chatbox-ai",
  })
  assert.equal(typeof out.fetch, "function")
  assert.equal(out.apiKey, "license-key")
  assert.equal(out.baseURL, undefined, "loader.baseURL 会把四条网关压成一条，不能给")
  assert.equal(out.headers["Instance-Id"], "inst-1")

  const empty = await plugin.auth.loader(async () => null, { id: "chatbox-ai" })
  assert.deepEqual(empty, {})
})

test("provider.models：未登录返回静态模型表；条目 API 字段完整", async () => {
  const plugin = await ChatboxAiAuthPlugin({ client: {} })
  const models = await plugin.provider.models({}, { auth: null })
  assert.ok(models && Object.keys(models).length > 0)
  for (const [id, model] of Object.entries(models)) {
    assert.equal(model.id, id)
    assert.ok(model.api.url.startsWith("https://api.chatboxai.app/gateway/"))
  }
})

test("usage 构造器可用：至少造一条参与路由的窗口", () => {
  const value = usage({
    plan: "Test",
    windows: [usageWindow({ name: "今日额度", used: 37, span: 86_400, resetsAt: "2026-10-30T12:00:00Z" })],
  })
  assert.equal(typeof value.plan, "string")
  assert.equal(value.windows.length, 1)
  assert.equal(Number.isFinite(value.windows[0].used), true)
})

test("usage() 未登录给出 error 而不是伪造 0", async () => {
  const plugin = await ChatboxAiAuthPlugin({ client: {} })
  const anonymous = await plugin.auth.usage(async () => null, { id: "chatbox-ai" })
  assert.equal(anonymous.error, "未登录")
  assert.deepEqual(anonymous.windows, [])
})

test("chat.headers 只给本 provider 的请求加头", async () => {
  const plugin = await ChatboxAiAuthPlugin({ client: {} })
  const mine = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: _internal.PROVIDER }, sessionID: "sess-1" }, mine)
  assert.equal(mine.headers["chatbox-session-id"], "sess-1")

  const other = { headers: {} }
  await plugin["chat.headers"]({ model: { providerID: "other" }, sessionID: "sess-1" }, other)
  assert.deepEqual(other.headers, {})
})

test("auth.refresh 对长期 license 不做续期（返回 undefined = 保留原凭据）", async () => {
  const plugin = await ChatboxAiAuthPlugin({ client: {} })
  assert.equal(await plugin.auth.refresh({ type: "oauth", access: "key" }, { id: "chatbox-ai" }), undefined)
})
