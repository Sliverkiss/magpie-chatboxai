// src/local.mjs —— 复用本机 Chatbox 客户端的登录态（免登录路）
//
// Chatbox 桌面端把 license key 明文存在 `%APPDATA%/xyz.chatboxapp.app/config.json`
// 的 `settings.licenseKey`，同文件的 `settings.licenseInstances` 是
// `{ <licenseKey>: <instanceId> }`。插件**只读**，不写客户端目录。
//
// 三条边界（实测 + 契约）：
//   ① 文件不存在 / 不是 JSON / 没有 licenseKey → 返回 null，不抛
//   ② licenseInstances 里没有这个 key 的 instance 也照样可用（网关不校验，
//      2026-11-03 实测去掉 Instance-Id 仍 200），只是少一个头
//   ③ 邮箱来自 `settings.lastSelectedLicenseByUser`（{ email: licenseKey }）——
//      取不到就返回空串，卡片回退供应商名，绝不编造

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** Chatbox 的 userData 目录名（Electron app name） */
export const APP_DIR = "xyz.chatboxapp.app"

/** license key 的形状：小写 uuid，例如 `00000000-0000-4000-8000-000000000000` */
export const LICENSE_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** 可能的 config.json 位置（按命中概率排序） */
export function configCandidates() {
  const home = os.homedir()
  const out = []
  if (process.env.CHATBOX_CONFIG_DIR) {
    out.push(path.join(process.env.CHATBOX_CONFIG_DIR, "config.json"))
  }
  if (process.platform === "win32") {
    const roaming = process.env.APPDATA || path.join(home, "AppData", "Roaming")
    out.push(path.join(roaming, APP_DIR, "config.json"))
    out.push(path.join(home, "AppData", "Roaming", APP_DIR, "config.json"))
  } else if (process.platform === "darwin") {
    out.push(path.join(home, "Library", "Application Support", APP_DIR, "config.json"))
  } else {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(home, ".config")
    out.push(path.join(xdg, APP_DIR, "config.json"))
  }
  out.push(path.join(home, `.${APP_DIR}`, "config.json"))
  return out
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""))
  } catch {
    return null
  }
}

/** 从一份 config.json 里取出插件要的四件事 */
export function licenseFromConfig(data) {
  const settings = data?.settings
  const licenseKey = typeof settings?.licenseKey === "string" ? settings.licenseKey.trim() : ""
  if (!LICENSE_KEY_RE.test(licenseKey)) return null
  const instances = settings?.licenseInstances
  const instanceId = instances && typeof instances === "object" ? String(instances[licenseKey] || "") : ""
  const byEmail = settings?.lastSelectedLicenseByUser
  let email = ""
  if (byEmail && typeof byEmail === "object") {
    for (const [candidate, value] of Object.entries(byEmail)) {
      if (value === licenseKey && candidate.includes("@")) {
        email = candidate
        break
      }
    }
  }
  return {
    licenseKey,
    instanceId,
    email,
    plan: typeof settings?.licensePlanName === "string" ? settings.licensePlanName : "",
    expired: settings?.hasExpiredLicense === true,
    activation: typeof settings?.licenseActivationMethod === "string" ? settings.licenseActivationMethod : "",
  }
}

/** 扫一遍候选路径；找到第一个可用的就返回 { ...license, file } */
export function readLocalLicense() {
  for (const file of configCandidates()) {
    const found = licenseFromConfig(readJson(file))
    if (found) return { ...found, file }
  }
  return null
}
