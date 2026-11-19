import { invoke } from "@tauri-apps/api/core";

export interface Quota {
  unit: string;
  amount: number | null;
  period: string;
  reset?: string;
  scope: string;
  models?: string;
  condition?: string;
  expires_days?: number;
  note?: string;
  evidence: string;
}

export interface Provider {
  id: string;
  name: string;
  name_zh?: string;
  homepage: string;
  region: "global" | "cn";
  api_usable: boolean;
  status: string;
  last_verified: string;
  summary?: string;
  api?: { protocol: string[]; base_url: string; free_models: string[]; free_model_rule?: string };
  signup: { url: string; requires: string[]; regions_blocked: string[]; notes?: string };
  quotas: Quota[];
  overage: "blocked" | "auto_paid" | "manual" | "unknown";
  onboarding: { level: "L1" | "L2" | "L3"; key_page?: string; key_pattern?: string; oauth?: unknown };
  terms: { point: string; url: string }[];
  tags: string[];
}

export interface Catalog {
  version: number;
  generated_at?: string;
  providers: Provider[];
}

export interface Account {
  id: string;
  provider_id: string;
  label: string;
  base_url: string;
  enabled: boolean;
  margin: number;
  added_at: string;
}

export interface LimitUsage {
  label: string;
  unit: "requests" | "tokens";
  used: number;
  cap: number;
  amount: number;
  resets_at: string | null;
}

export interface AccountUsage {
  account_id: string;
  label: string;
  enabled: boolean;
  blocked_until: string | null;
  blocked_reason: string | null;
  limits: LimitUsage[];
  today_requests: number;
  today_tokens: number;
}

export const api = {
  catalog: (refresh = false) => invoke<Catalog>("get_catalog", { refresh }),
  accounts: () => invoke<Account[]>("list_accounts"),
  addAccount: (providerId: string, key: string, baseUrl?: string) =>
    invoke<Account>("add_account", { providerId, key, baseUrl: baseUrl || null }),
  removeAccount: (id: string) => invoke<void>("remove_account", { id }),
  setEnabled: (id: string, enabled: boolean) => invoke<void>("set_enabled", { id, enabled }),
  setMargin: (id: string, margin: number) => invoke<void>("set_margin", { id, margin }),
  testAccount: (id: string) => invoke<string>("test_account", { id }),
  usage: () => invoke<AccountUsage[]>("usage"),
  gateway: () => invoke<{ running: boolean; base_url: string | null }>("gateway_info"),
  connectOpenRouter: () => invoke<Account>("connect_openrouter"),
  openUrl: (url: string) => invoke<void>("open_url", { url }),
};

const UNIT: Record<string, string> = {
  requests: "次",
  tokens: "tokens",
  input_tokens: "输入 tokens",
  output_tokens: "输出 tokens",
  credits: "额度",
  points: "积分",
  neurons: "Neurons",
  usd: "美元",
  cny: "元",
};
const PERIOD: Record<string, string> = {
  second: "每秒",
  minute: "每分钟",
  hour: "每小时",
  day: "每天",
  week: "每周",
  month: "每月",
  "one-time": "一次性",
};
export const REQUIRES: Record<string, string> = {
  email: "邮箱",
  phone: "手机号",
  phone_cn: "大陆手机号",
  card: "信用卡",
  real_name: "实名",
  company: "企业认证",
  github: "GitHub 账号",
  google: "Google 账号",
  cloud_account: "云账号",
};
export const OVERAGE: Record<string, string> = {
  blocked: "用完即停",
  auto_paid: "用完自动转付费",
  manual: "需手动开通付费",
  unknown: "未知",
};

export function quotaText(q: Quota): string {
  const period = PERIOD[q.period] ?? q.period;
  const unit = UNIT[q.unit] ?? q.unit;
  const parts = [
    q.amount == null ? `${period}有上限（按${unit}计，数值见平台页面）` : `${period} ${q.amount.toLocaleString("zh-CN")} ${unit}`,
  ];
  if (q.models) parts.push(q.models);
  if (q.condition) parts.push(q.condition);
  if (q.reset && q.reset !== "rolling") parts.push(`${q.reset} 重置`);
  if (q.expires_days) parts.push(`${q.expires_days} 天有效`);
  return parts.join(" · ");
}
