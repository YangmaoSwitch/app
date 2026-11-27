// Sample data for reviewing the UI in a plain browser (`npm run dev`, then open
// http://localhost:1420/#catalog). Never used inside the desktop app.
import snapshot from "../src-tauri/catalog.snapshot.json";
import square from "../src-tauri/models.snapshot.json";
import type { Account, AccountUsage, UsageRow } from "./api";

const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const nextMidnightUtc = () => {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.toISOString();
};

const accounts: Account[] = [
  { id: "openrouter", provider_id: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", enabled: true, margin: 0.9, added_at: iso(now - 3 * 864e5), models: ["deepseek/deepseek-v4-flash:free", "qwen/qwen3.8-27b:free", "z-ai/glm-5.3-flash:free"], model_suffix: ":free" },
  { id: "siliconflow", provider_id: "siliconflow", label: "硅基流动", base_url: "https://api.siliconflow.cn/v1", enabled: true, margin: 0.9, added_at: iso(now - 864e5), models: ["THUDM/GLM-Z1-9B", "tencent/Hunyuan-MT-7B", "BAAI/bge-m3"] },
  { id: "aihubmix", provider_id: "aihubmix", label: "AiHubMix", base_url: "https://aihubmix.com/v1", enabled: false, margin: 0.8, added_at: iso(now - 2 * 864e5), models: ["glm-5.3-flash"] },
];

const usage: AccountUsage[] = [
  {
    account_id: "openrouter", label: "OpenRouter", enabled: true, blocked_until: null, blocked_reason: null, today_requests: 38, today_tokens: 61240,
    limits: [
      { label: "20 requests / minute", unit: "requests", used: 2, cap: 18, amount: 20, resets_at: null },
      { label: "50 requests / day", unit: "requests", used: 38, cap: 45, amount: 50, resets_at: nextMidnightUtc() },
    ],
  },
  { account_id: "siliconflow", label: "硅基流动", enabled: true, blocked_until: null, blocked_reason: null, today_requests: 12, today_tokens: 18400, limits: [] },
  {
    account_id: "aihubmix", label: "AiHubMix", enabled: false, blocked_until: iso(now + 40 * 60e3), blocked_reason: "平台返回 429", today_requests: 9, today_tokens: 220500,
    limits: [
      { label: "100 requests / day", unit: "requests", used: 9, cap: 80, amount: 100, resets_at: nextMidnightUtc() },
      { label: "1000000 tokens / day", unit: "tokens", used: 220500, cap: 800000, amount: 1000000, resets_at: nextMidnightUtc() },
    ],
  },
];

const models = ["deepseek/deepseek-v4-flash:free", "qwen/qwen3.8-27b:free", "THUDM/GLM-Z1-9B", "glm-5.3-flash"];
const log: UsageRow[] = Array.from({ length: 59 }, (_, i) => {
  const acct = ["openrouter", "openrouter", "siliconflow", "aihubmix"][i % 4];
  const ts = now - i * 23 * 60e3 - (i % 5) * 97e3;
  return { account_id: acct, ts, model: models[i % 4], status: i === 3 ? 429 : 200, prompt_tokens: 600 + ((i * 137) % 2400), completion_tokens: 120 + ((i * 53) % 900) };
});

export async function mockInvoke(cmd: string, _args?: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case "get_catalog":
      return snapshot;
    case "get_model_square":
      return square;
    case "list_accounts":
      return accounts;
    case "usage":
      return usage;
    case "recent_requests":
      return log;
    case "hourly_usage":
      return Array.from({ length: 24 }, (_, i) => log.filter((r) => r.ts > now - (24 - i) * 3600e3 && r.ts <= now - (23 - i) * 3600e3).length);
    case "app_info":
      return { version: "0.1.1", commit: "preview", bundled_data: (square as { generated_at?: string }).generated_at?.slice(0, 10) ?? null };
    case "gateway_info":
    case "set_port":
    case "set_api_key":
      return { running: true, base_url: "http://127.0.0.1:17890", port: 17890, api_key: "ym-3f9a0c27d18e4b6a90c1f2e7d5a8b3c4e6f1", error: null };
    case "account_status":
      return { available: true, github: true, user: null };
    case "account_send_code":
      return { resend_after: 60 };
    case "account_verify":
      return { id: 1, email: String(_args?.email ?? ""), github_login: null, name: null, admin: false };
    case "my_submissions":
      return [];
    case "list_models":
      return accounts.filter((a) => a.enabled).flatMap((a) => a.models.map((m) => ({ id: m, accounts: [a.id] })));
    case "routed_models":
      return accounts.filter((a) => a.enabled).slice(0, 3).map((a, i) => ({ id: ["DeepSeek V4.1 Flash", "GLM 5.3 Flash", "Qwen3.8 27B"][i], accounts: [a.id] }));
    case "test_account":
      return "连接正常（HTTP 200）";
    default:
      return null;
  }
}
