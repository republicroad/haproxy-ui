/**
 * Minimal i18n: flat key dictionaries with English fallback and {param}
 * interpolation. No provider, no reactivity — switching the language
 * reloads the page (settings live in localStorage under "hui-lang").
 *
 * Conventions:
 *  - keys are the English source strings themselves (en dictionary maps
 *    key -> key), so English needs no lookup entries and missing zh-CN
 *    translations degrade to English.
 */

export type Lang = "en" | "zh-CN"

const LANG_KEY = "hui-lang"

export function getLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === "zh-CN" ? "zh-CN" : "en"
  } catch {
    return "en"
  }
}

export function setLang(lang: Lang): void {
  try {
    localStorage.setItem(LANG_KEY, lang)
  } catch {
    // private mode — toggle just won't persist
  }
}

const zhCN: Record<string, string> = {
  // navigation
  "Overview": "概览",
  "Nodes": "节点",
  "Users": "用户",
  "API tokens": "API 令牌",
  "Sign out": "退出登录",
  "Signed out": "已退出登录",
  // login
  "Sign in to HAProxy UI": "登录 HAProxy UI",
  "Use the credentials configured via HAPROXY_UI_USER / HAPROXY_UI_PASS":
    "使用 HAPROXY_UI_USER / HAPROXY_UI_PASS 配置的凭据",
  "Sign in with SSO": "通过 SSO 登录",
  "or with a local account": "或使用本地账号",
  "Username": "用户名",
  "Password": "密码",
  "Signing in…": "登录中…",
  "Sign in": "登录",
  "No password configured?": "未配置密码？",
  "Go to the dashboard": "前往控制台",
  // overview
  "HAProxy fleet at a glance": "HAProxy 集群总览",
  "Up": "在线",
  "Down": "离线",
  "Unknown": "未知",
  "Fleet health": "集群健康",
  "Loading…": "加载中…",
  // nodes page
  "Register node": "注册节点",
  "Export nodes": "导出节点",
  "Import nodes": "导入节点",
  "Compare": "对比",
  "Filter nodes…": "筛选节点…",
  // users page
  "Admin access required.": "需要管理员权限。",
  "Create user": "创建用户",
  "Active sessions": "活跃会话",
  "Database backups": "数据库备份",
  "Backup now": "立即备份",
  // tokens page
  "full access": "完全访问",
  "read-only": "只读",
  // common
  "Delete": "删除",
  "Edit": "编辑",
  "Close": "关闭",
  "Cancel": "取消",
  "Save": "保存",
  "Refresh": "刷新",
  "yes": "是",
}

const dictionaries: Record<Lang, Record<string, string> | null> = {
  en: null, // English is the key itself
  "zh-CN": zhCN,
}

export function t(
  key: string,
  params?: Record<string, string | number>,
): string {
  let out = dictionaries[getLang()]?.[key] ?? key
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      out = out.replaceAll(`{${k}}`, String(v))
    }
  }
  return out
}
