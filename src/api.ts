import { invoke as tauriInvoke } from "@tauri-apps/api/core";

/** Outside Tauri (plain browser preview) use local sample data, so the UI can be reviewed in a browser. */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (inTauri) return tauriInvoke<T>(cmd, args);
  const { mockInvoke } = await import("./preview");
  return (await mockInvoke(cmd, args)) as T;
}

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
  api?: { protocol: string[]; base_url: string; free_models?: string[]; free_model_rule?: string; models?: string[]; models_url?: string; models_access?: "free" | "quota" };
  signup: { url: string; requires: string[]; regions_blocked?: string[]; notes?: string };
  quotas: Quota[];
  overage: "blocked" | "auto_paid" | "manual" | "unknown";
  onboarding: { level: "L1" | "L2" | "L3"; key_page?: string; key_pattern?: string; oauth?: unknown };
  terms?: { point: string; url: string }[];
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
  models: string[];
  model_suffix?: string | null;
  anthropic_base_url?: string | null;
}

export interface GatewayInfo {
  running: boolean;
  base_url: string | null;
  port: number;
  api_key: string;
  error: string | null;
}

export interface ModelEntry {
  id: string;
  accounts: string[];
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

export interface SquareModel {
  id: string;
  name: string;
  vendor: string | null;
  description: string;
  context_length: number | null;
  input_modalities: string[];
  tools: boolean | null;
  reasoning: boolean | null;
  created: string | null;
  hugging_face_id: string | null;
  description_source: string | null;
  offers: Offer[];
  /** popularity score: OpenRouter daily tokens, number of free platforms, recency */
  heat?: number;
  openrouter_tokens_day?: number | null;
}

/** free = free model, quota = counted against the platform's free quota/credits, paid = paid only,
 *  account = not in the catalog data but listed by one of your own accounts. */
export type Access = "free" | "quota" | "paid" | "account";
export interface Price {
  input: number;
  output: number;
}
export interface Offer {
  provider: string;
  model: string;
  access?: Access;
  /** USD per million tokens */
  price?: Price | null;
  /** first day this free / free-quota offer was seen (YYYY-MM-DD) */
  since?: string;
}
export interface ProviderModels {
  total: number;
  free: number;
  quota: number;
  paid: number;
  models: { model: string; access: "free" | "quota" | "paid"; price: Price | null }[];
}
/** "$0.45 / $1.34" per million input / output tokens */
export const priceText = (p?: Price | null) => (p ? `$${+p.input.toFixed(3)} / $${+p.output.toFixed(3)}` : "");

/** Normalized model name used to match the same model across platforms (same rule as the catalog build). */
export function modelKey(id: string): string {
  const last = id.split("/").pop() ?? id;
  return last.split(":")[0].toLowerCase().replace(/[\s_.]+/g, "-");
}

export interface ModelSquare {
  generated_at: string;
  /** offers dated on this day were already listed when tracking started */
  baseline?: string;
  providers?: Record<string, ProviderModels>;
  models: SquareModel[];
}

export interface UsageRow {
  account_id: string;
  ts: number;
  model: string | null;
  status: number | null;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface AccountUser {
  id: number;
  email: string | null;
  github_login: string | null;
  name: string | null;
  admin: boolean;
}
export interface AccountStatus {
  available: boolean;
  github: boolean;
  user: AccountUser | null;
}
export type SubmissionKind = "correction" | "new_provider" | "new_model" | "other";
export interface NewSubmission {
  kind: SubmissionKind;
  target?: string | null;
  title: string;
  body: string;
  evidence_url?: string | null;
  page_url?: string | null;
  lang: "zh" | "en";
}
export interface Submission extends NewSubmission {
  id: number;
  status: "open" | "accepted" | "rejected" | "done";
  admin_note: string | null;
  created_at: number;
  updated_at: number;
}
/** Where users without an account can still submit (needs a GitHub account). */
export const GITHUB_SUBMIT = "https://github.com/YangmaoSwitch/catalog/issues/new/choose";

export const api = {
  accountStatus: () => invoke<AccountStatus>("account_status"),
  accountSendCode: (email: string) => invoke<{ resend_after?: number }>("account_send_code", { email, lang: "zh" }),
  accountVerify: (email: string, code: string) => invoke<AccountUser>("account_verify", { email, code }),
  accountGithub: () => invoke<AccountUser>("account_github"),
  accountLogout: () => invoke<void>("account_logout"),
  submit: (entry: NewSubmission) => invoke<Submission>("submit_entry", { entry }),
  mySubmissions: () => invoke<Submission[]>("my_submissions"),
  modelSquare: (refresh = false) => invoke<ModelSquare>("get_model_square", { refresh }),
  recentRequests: (limit = 100) => invoke<UsageRow[]>("recent_requests", { limit }),
  catalog: (refresh = false) => invoke<Catalog>("get_catalog", { refresh }),
  accounts: () => invoke<Account[]>("list_accounts"),
  addAccount: (providerId: string, key: string, baseUrl?: string) =>
    invoke<Account>("add_account", { providerId, key, baseUrl: baseUrl || null }),
  removeAccount: (id: string) => invoke<void>("remove_account", { id }),
  setEnabled: (id: string, enabled: boolean) => invoke<void>("set_enabled", { id, enabled }),
  setMargin: (id: string, margin: number) => invoke<void>("set_margin", { id, margin }),
  testAccount: (id: string) => invoke<string>("test_account", { id }),
  usage: () => invoke<AccountUsage[]>("usage"),
  gateway: () => invoke<GatewayInfo>("gateway_info"),
  setPort: (port: number) => invoke<GatewayInfo>("set_port", { port }),
  setApiKey: (key: string | null) => invoke<GatewayInfo>("set_api_key", { key }),
  models: () => invoke<ModelEntry[]>("list_models"),
  refreshModels: (id: string) => invoke<number>("refresh_models", { id }),
  moveAccount: (id: string, delta: number) => invoke<void>("move_account", { id, delta }),
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

const PER: Record<string, string> = { second: "秒", minute: "分钟", hour: "小时", day: "天", week: "周", month: "月", "one-time": "一次性" };

/** Split a quota into a big number and a small unit line, e.g. {num: "50", unit: "次 / 天"}. */
export function quotaParts(q: Quota): { num: string; unit: string } {
  const unit = UNIT[q.unit] ?? q.unit;
  const per = q.period === "one-time" ? "一次性" : `${unit} / ${PER[q.period] ?? q.period}`;
  if (q.amount == null) return { num: "—", unit: q.period === "one-time" ? unit : `${unit} / ${PER[q.period] ?? q.period}` };
  const n = q.amount >= 1e8 ? `${q.amount / 1e8}亿` : q.amount >= 1e4 ? `${q.amount / 1e4}万` : q.amount.toLocaleString("zh-CN");
  return { num: n, unit: q.period === "one-time" ? `${unit} · ${per}` : per };
}

/** Short form for list rows, e.g. "每天 50 次". */
export function quotaShort(q: Quota): string {
  const period = PERIOD[q.period] ?? q.period;
  const unit = UNIT[q.unit] ?? q.unit;
  if (q.amount == null) return `${period}限额见平台`;
  const n = q.amount >= 10000 ? `${(q.amount / 10000).toLocaleString("zh-CN")} 万` : q.amount.toLocaleString("zh-CN");
  return `${period} ${n} ${unit}`;
}

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
