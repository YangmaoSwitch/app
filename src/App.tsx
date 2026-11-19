import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Gift,
  KeyRound,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Zap,
} from "lucide-react";
import { api, Account, AccountUsage, Catalog, OVERAGE, Provider, quotaShort, quotaText, REQUIRES, UsageRow } from "./api";

type Page = "catalog" | "accounts" | "usage" | "connect";
type Notify = (ok: boolean, text: string) => void;

const PAGES: { id: Page; label: string; icon: typeof Gift; desc: string }[] = [
  { id: "catalog", label: "免费额度", icon: Gift, desc: "各平台大模型免费额度" },
  { id: "accounts", label: "我的账号", icon: KeyRound, desc: "Key 只存在本机系统钥匙串" },
  { id: "usage", label: "用量统计", icon: BarChart3, desc: "本机记账，按免费额度限量" },
  { id: "connect", label: "接入工具", icon: Plug, desc: "在其他工具里使用本机入口" },
];

export default function App() {
  const [page, setPage] = useState<Page>("catalog");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [gw, setGw] = useState<{ running: boolean; base_url: string | null } | null>(null);
  const [todayReq, setTodayReq] = useState(0);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async () => setAccounts(await api.accounts()), []);
  const notify: Notify = (ok, text) => {
    setToast({ ok, text });
    window.setTimeout(() => setToast(null), 5000);
  };

  useEffect(() => {
    api.catalog().then(setCatalog).catch((e) => notify(false, String(e)));
    api.gateway().then(setGw);
    reload();
    const t = window.setInterval(() => api.usage().then((u) => setTodayReq(u.reduce((s, x) => s + x.today_requests, 0))), 5000);
    return () => window.clearInterval(t);
  }, [reload]);

  const current = PAGES.find((p) => p.id === page)!;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.png" alt="" />
          <span>
            羊毛<b>switch</b>
          </span>
        </div>
        <nav>
          {PAGES.map((p) => (
            <button key={p.id} className={page === p.id ? "nav-item active" : "nav-item"} onClick={() => setPage(p.id)}>
              <p.icon size={18} />
              <span>{p.label}</span>
              {p.id === "accounts" && accounts.length > 0 && <em>{accounts.length}</em>}
              {p.id === "usage" && <em>今日 {todayReq}</em>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={gw?.running ? "dot on" : "dot"} />
          {gw?.running ? <>本机入口运行中 <code>{gw.base_url?.replace("http://", "").replace("/v1", "")}</code></> : "本机入口未启动"}
        </div>
      </aside>

      <section className="main">
        <header className="topbar">
          <current.icon size={22} className="topbar-icon" />
          <h1>{current.label}</h1>
          <span className="sub">{current.desc}</span>
          <div className="spacer" />
          {page === "catalog" && (
            <button
              className="btn"
              onClick={async () => {
                try {
                  setCatalog(await api.catalog(true));
                  notify(true, "目录已更新");
                } catch (e) {
                  notify(false, `更新失败：${e}`);
                }
              }}
            >
              <RefreshCw size={15} /> 更新目录
            </button>
          )}
          {page === "accounts" && (
            <button className="btn primary" onClick={() => setPage("catalog")}>
              <Plus size={16} /> 添加账号
            </button>
          )}
        </header>
        <div className="content">
          {page === "catalog" && (
            <CatalogPage
              catalog={catalog}
              accounts={accounts}
              notify={notify}
              onAdded={async (a) => {
                await reload();
                notify(true, `已添加账号 ${a.id}，Key 已存入系统钥匙串`);
              }}
            />
          )}
          {page === "accounts" && <AccountsPage accounts={accounts} catalog={catalog} onChange={reload} notify={notify} />}
          {page === "usage" && <UsagePage />}
          {page === "connect" && <ConnectPage accounts={accounts} catalog={catalog} baseUrl={gw?.base_url ?? null} notify={notify} />}
        </div>
      </section>
      {toast && <div className={`toast ${toast.ok ? "ok" : "err"}`}>{toast.text}</div>}
    </div>
  );
}

/* ---------- shared bits ---------- */

const AVATAR_COLORS = ["#f97316", "#3b82f6", "#10b981", "#8b5cf6", "#ef4444", "#0ea5e9", "#eab308", "#14b8a6", "#ec4899", "#6366f1"];
function Avatar({ name, id }: { name: string; id: string }) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const color = AVATAR_COLORS[h % AVATAR_COLORS.length];
  const ch = /[\u4e00-\u9fa5]/.test(name) ? name[0] : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  return (
    <div className="avatar" style={{ color, background: `${color}14`, borderColor: `${color}33` }}>
      {ch}
    </div>
  );
}

function Segmented<T extends string>(props: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="segmented">
      {props.options.map(([v, label]) => (
        <button key={v} className={props.value === v ? "on" : ""} onClick={() => props.onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

function IconBtn(props: { title: string; onClick: () => void; children: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <button className={props.danger ? "icon-btn danger" : "icon-btn"} title={props.title} onClick={props.onClick} disabled={props.disabled}>
      {props.children}
    </button>
  );
}

const providerName = (p: Provider) => p.name_zh ?? p.name;

/* ---------- 免费额度 ---------- */

function CatalogPage(props: { catalog: Catalog | null; accounts: Account[]; notify: Notify; onAdded: (a: Account) => void }) {
  const [region, setRegion] = useState<"all" | "cn" | "global">("all");
  const [apiOnly, setApiOnly] = useState(true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);

  const list = useMemo(() => {
    const ps = props.catalog?.providers ?? [];
    const text = q.trim().toLowerCase();
    return ps
      .filter((p) => (region === "all" || p.region === region) && (!apiOnly || p.api_usable))
      .filter((p) => !text || `${p.name} ${p.name_zh ?? ""} ${p.summary ?? ""} ${p.tags.join(" ")} ${(p.api?.free_models ?? []).join(" ")}`.toLowerCase().includes(text))
      .sort((a, b) => Number(b.onboarding.level === "L3") - Number(a.onboarding.level === "L3") || Number(a.status !== "verified") - Number(b.status !== "verified"));
  }, [props.catalog, region, apiOnly, q]);

  if (!props.catalog) return <p className="muted">正在加载目录…</p>;

  const connect = async () => {
    setBusy(true);
    try {
      props.onAdded(await api.connectOpenRouter());
    } catch (e) {
      props.notify(false, `授权失败：${e}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="filters">
        <Segmented value={region} onChange={setRegion} options={[["all", "全部"], ["cn", "国内"], ["global", "海外"]]} />
        <div className="search">
          <Search size={15} />
          <input placeholder="搜索平台、模型、标签" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={apiOnly} onChange={(e) => setApiOnly(e.target.checked)} /> 只看能当 API 用的
        </label>
        <span className="muted small push">
          {list.length} 个平台 · 目录更新于 {props.catalog.generated_at?.slice(0, 10) ?? "—"}
        </span>
      </div>

      <div className="rows">
        {list.map((p) => {
          const owned = props.accounts.filter((a) => a.provider_id === p.id).length;
          const expanded = open === p.id;
          const oneClick = p.onboarding.level === "L3" && p.id === "openrouter";
          return (
            <div key={p.id} className={expanded ? "row expanded" : "row"}>
              <div className="row-main" onClick={() => setOpen(expanded ? null : p.id)}>
                <Avatar name={providerName(p)} id={p.id} />
                <div className="row-title">
                  <div className="name">
                    {providerName(p)}
                    {p.status !== "verified" && <span className="tag warn">待核实</span>}
                    {p.overage === "auto_paid" && <span className="tag danger">用完自动付费</span>}
                    {owned > 0 && <span className="tag ok">已添加</span>}
                  </div>
                  <div className="desc">{p.summary ?? p.homepage}</div>
                </div>
                <div className="row-stats">
                  {p.quotas.slice(0, 2).map((x, i) => (
                    <div key={i}>{quotaShort(x)}</div>
                  ))}
                </div>
                <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                  {oneClick ? (
                    <button className="btn primary sm" disabled={busy} onClick={connect}>
                      <Zap size={14} /> {busy ? "等待授权…" : "一键开通"}
                    </button>
                  ) : (
                    p.api_usable && (
                      <button className="btn sm" onClick={() => setAdding(p)}>
                        <Plus size={14} /> 添加 Key
                      </button>
                    )
                  )}
                  <IconBtn title="去注册" onClick={() => api.openUrl(p.signup.url)}>
                    <ExternalLink size={17} />
                  </IconBtn>
                  <IconBtn title="详情" onClick={() => setOpen(expanded ? null : p.id)}>
                    <ChevronDown size={18} className={expanded ? "flip" : ""} />
                  </IconBtn>
                </div>
              </div>
              {expanded && (
                <div className="row-detail">
                  <div className="kv">
                    <span>免费额度</span>
                    <ul>
                      {p.quotas.map((x, i) => (
                        <li key={i}>
                          {quotaText(x)}{" "}
                          <a onClick={() => api.openUrl(x.evidence)}>官方依据</a>
                        </li>
                      ))}
                    </ul>
                    <span>注册要求</span>
                    <div>{p.signup.requires.map((r) => REQUIRES[r] ?? r).join("、") || "—"}{p.signup.notes ? `（${p.signup.notes}）` : ""}</div>
                    {p.signup.regions_blocked.length > 0 && (
                      <>
                        <span>不支持地区</span>
                        <div>{p.signup.regions_blocked.join("、")}</div>
                      </>
                    )}
                    <span>额度用完后</span>
                    <div className={p.overage === "auto_paid" ? "danger-text" : ""}>{OVERAGE[p.overage]}</div>
                    {p.api && (
                      <>
                        <span>接口</span>
                        <div className="mono">{p.api.base_url}</div>
                      </>
                    )}
                    {(p.api?.free_models?.length ?? 0) > 0 && (
                      <>
                        <span>免费模型</span>
                        <div>{p.api!.free_models.join("、")}</div>
                      </>
                    )}
                    {p.terms.length > 0 && (
                      <>
                        <span>条款要点</span>
                        <ul>
                          {p.terms.map((t, i) => (
                            <li key={i}>
                              <a onClick={() => api.openUrl(t.url)}>{t.point}</a>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    <span>最后核实</span>
                    <div>{p.last_verified}</div>
                  </div>
                  <div className="detail-actions">
                    <button className="btn" onClick={() => api.openUrl(p.signup.url)}>
                      <ExternalLink size={14} /> 去注册
                    </button>
                    {p.onboarding.key_page && (
                      <button className="btn" onClick={() => api.openUrl(p.onboarding.key_page!)}>
                        <KeyRound size={14} /> 打开 Key 页
                      </button>
                    )}
                    {p.api_usable && (
                      <button className="btn" onClick={() => setAdding(p)}>
                        <Plus size={14} /> 粘贴 Key
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {adding && (
        <AddKeyDialog
          p={adding}
          onClose={() => setAdding(null)}
          onAdded={(a) => {
            setAdding(null);
            props.onAdded(a);
          }}
        />
      )}
    </>
  );
}

function AddKeyDialog(props: { p: Provider; onClose: () => void; onAdded: (a: Account) => void }) {
  const { p } = props;
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(p.api?.base_url ?? "");
  const [err, setErr] = useState("");
  const pattern = p.onboarding.key_pattern ? new RegExp(p.onboarding.key_pattern) : null;
  const mismatch = pattern && key.trim() !== "" && !pattern.test(key.trim());
  return (
    <div className="modal" onClick={props.onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <Avatar name={providerName(p)} id={p.id} />
          <div>
            <h3>添加 {providerName(p)} 的 Key</h3>
            <p className="muted small">Key 只保存在本机系统钥匙串里，不会上传。</p>
          </div>
        </div>
        <label>
          API Key
          <input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="粘贴平台上创建的 Key" />
        </label>
        {mismatch && <p className="warn-text">这个 Key 的格式和 {p.name} 不太一样，确认没有贴错？</p>}
        <label>
          接口地址
          <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        {baseUrl.includes("ACCOUNT_ID") && <p className="warn-text">请把地址里的 ACCOUNT_ID 换成你的账户 ID。</p>}
        {err && <p className="danger-text">{err}</p>}
        <div className="dialog-actions">
          {p.onboarding.key_page && (
            <button className="btn ghost" onClick={() => api.openUrl(p.onboarding.key_page!)}>
              <ExternalLink size={14} /> 去平台创建 Key
            </button>
          )}
          <div className="spacer" />
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!key.trim()}
            onClick={async () => {
              try {
                props.onAdded(await api.addAccount(p.id, key, baseUrl !== p.api?.base_url ? baseUrl : undefined));
              } catch (e) {
                setErr(String(e));
              }
            }}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 我的账号 ---------- */

function remainingText(u: AccountUsage | undefined): { text: string; low: boolean }[] {
  if (!u) return [];
  return u.limits.slice(0, 2).map((l) => {
    const left = Math.max(0, 1 - l.used / l.cap);
    const period = l.label.split(" / ")[1] ?? "";
    const name = { minute: "每分钟", day: "今日", month: "本月", "one-time": "总额", hour: "每小时", week: "本周", second: "每秒" }[period] ?? "";
    return { text: `${name}剩余 ${Math.round(left * 100)}%`, low: left < 0.2 };
  });
}

function AccountsPage(props: { accounts: Account[]; catalog: Catalog | null; onChange: () => void; notify: Notify }) {
  const [usage, setUsage] = useState<AccountUsage[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    api.usage().then(setUsage);
  }, [props.accounts]);

  if (props.accounts.length === 0)
    return (
      <div className="empty">
        <KeyRound size={36} />
        <p>还没有账号</p>
        <p className="muted small">去“免费额度”里一键开通，或在平台注册后粘贴 Key。</p>
      </div>
    );

  return (
    <div className="rows">
      {props.accounts.map((a) => {
        const u = usage.find((x) => x.account_id === a.id);
        const expanded = open === a.id;
        return (
          <div key={a.id} className={`row ${a.enabled ? "" : "disabled"} ${expanded ? "expanded" : ""}`}>
            <div className="row-main" onClick={() => setOpen(expanded ? null : a.id)}>
              <Avatar name={a.label} id={a.provider_id} />
              <div className="row-title">
                <div className="name">
                  {a.label} <code className="tag plain">{a.id}</code>
                  {u?.blocked_until && <span className="tag danger">平台限流中</span>}
                  {!a.enabled && <span className="tag">已停用</span>}
                </div>
                <div className="desc mono">{a.base_url}</div>
              </div>
              <div className="row-stats">
                {remainingText(u).map((r, i) => (
                  <div key={i} className={r.low ? "danger-text" : ""}>
                    {r.text}
                  </div>
                ))}
                {u && u.limits.length === 0 && <div className="muted">以平台计量为准</div>}
              </div>
              <div className="row-actions" onClick={(e) => e.stopPropagation()}>
                <IconBtn
                  title="测试连接"
                  onClick={async () => {
                    try {
                      props.notify(true, await api.testAccount(a.id));
                    } catch (e) {
                      props.notify(false, String(e));
                    }
                  }}
                >
                  <Play size={17} />
                </IconBtn>
                <label className="switch" title={a.enabled ? "停用" : "启用"}>
                  <input
                    type="checkbox"
                    checked={a.enabled}
                    onChange={async (e) => {
                      await api.setEnabled(a.id, e.target.checked);
                      props.onChange();
                    }}
                  />
                  <span />
                </label>
                <IconBtn title="更多" onClick={() => setOpen(expanded ? null : a.id)}>
                  <ChevronDown size={18} className={expanded ? "flip" : ""} />
                </IconBtn>
              </div>
            </div>
            {expanded && (
              <div className="row-detail">
                <div className="kv">
                  <span>本地上限</span>
                  <div>
                    用免费额度的
                    <select
                      value={a.margin}
                      onChange={async (e) => {
                        await api.setMargin(a.id, Number(e.target.value));
                        props.onChange();
                      }}
                    >
                      {[0.5, 0.7, 0.8, 0.9, 0.95, 1].map((m) => (
                        <option key={m} value={m}>
                          {Math.round(m * 100)}%
                        </option>
                      ))}
                    </select>
                    ，留出余量避免超额
                  </div>
                  <span>模型名写法</span>
                  <div className="mono">{a.id}/&lt;平台上的模型名&gt;</div>
                  <span>添加时间</span>
                  <div>{new Date(a.added_at).toLocaleString()}</div>
                </div>
                <div className="detail-actions">
                  <div className="spacer" />
                  <button
                    className="btn danger"
                    onClick={async () => {
                      if (!window.confirm(`删除账号 ${a.id}？本机保存的 Key 和用量记录会一起删除。`)) return;
                      await api.removeAccount(a.id);
                      props.onChange();
                    }}
                  >
                    <Trash2 size={14} /> 删除账号
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ---------- 用量统计 ---------- */

function UsagePage() {
  const [rows, setRows] = useState<AccountUsage[]>([]);
  const [log, setLog] = useState<UsageRow[]>([]);
  const [tab, setTab] = useState<"limits" | "log">("limits");
  useEffect(() => {
    const load = () => {
      api.usage().then(setRows);
      api.recentRequests(100).then(setLog);
    };
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, []);

  const req = rows.reduce((s, r) => s + r.today_requests, 0);
  const tok = rows.reduce((s, r) => s + r.today_tokens, 0);
  const blocked = rows.filter((r) => r.blocked_until).length;
  const near = rows.filter((r) => r.limits.some((l) => l.used / l.cap >= 0.8)).length;

  return (
    <>
      <div className="stats">
        <div className="stat">
          <span>近 24 小时请求</span>
          <b>{req.toLocaleString()}</b>
        </div>
        <div className="stat">
          <span>近 24 小时 Tokens</span>
          <b>{tok >= 1e6 ? `${(tok / 1e6).toFixed(2)}M` : tok >= 1e3 ? `${(tok / 1e3).toFixed(1)}K` : tok}</b>
        </div>
        <div className="stat">
          <span>接近上限的账号</span>
          <b className={near ? "warn-text" : ""}>{near}</b>
        </div>
        <div className="stat">
          <span>被平台限流</span>
          <b className={blocked ? "danger-text" : ""}>{blocked}</b>
        </div>
      </div>

      <div className="tabs">
        <button className={tab === "limits" ? "on" : ""} onClick={() => setTab("limits")}>
          额度进度
        </button>
        <button className={tab === "log" ? "on" : ""} onClick={() => setTab("log")}>
          请求日志
        </button>
      </div>

      {tab === "limits" &&
        (rows.length === 0 ? (
          <p className="muted">还没有账号。</p>
        ) : (
          <div className="rows">
            {rows.map((u) => (
              <div className="row" key={u.account_id}>
                <div className="row-main static">
                  <Avatar name={u.label} id={u.account_id} />
                  <div className="row-title">
                    <div className="name">
                      {u.label} <code className="tag plain">{u.account_id}</code>
                      {u.blocked_until && <span className="tag danger">暂停到 {new Date(u.blocked_until).toLocaleTimeString()}</span>}
                    </div>
                    <div className="desc">
                      近 24 小时 {u.today_requests} 次 · {u.today_tokens.toLocaleString()} tokens
                    </div>
                  </div>
                </div>
                <div className="bars">
                  {u.limits.length === 0 && <p className="muted small">这个平台的额度单位（积分、余额等）无法在本机计数，以平台返回为准。</p>}
                  {u.limits.map((l, i) => {
                    const pct = Math.min(100, (l.used / l.cap) * 100);
                    return (
                      <div className="bar-row" key={i}>
                        <div className="bar-label">
                          <span>{l.label}</span>
                          <span className="muted">
                            {l.used.toLocaleString()} / {l.cap.toLocaleString()}
                            {l.resets_at && ` · ${new Date(l.resets_at).toLocaleString()} 重置`}
                          </span>
                        </div>
                        <div className="bar">
                          <div className={`fill ${pct >= 100 ? "full" : pct >= 80 ? "high" : ""}`} style={{ width: `${pct}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}

      {tab === "log" && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>时间</th>
                <th>账号</th>
                <th>模型</th>
                <th className="num">状态</th>
                <th className="num">输入</th>
                <th className="num">输出</th>
              </tr>
            </thead>
            <tbody>
              {log.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted center">
                    还没有请求
                  </td>
                </tr>
              )}
              {log.map((r, i) => (
                <tr key={i}>
                  <td>{new Date(r.ts).toLocaleTimeString()}</td>
                  <td>
                    <code>{r.account_id}</code>
                  </td>
                  <td className="mono">{r.model}</td>
                  <td className={`num ${r.status && r.status >= 400 ? "danger-text" : ""}`}>{r.status ?? "进行中"}</td>
                  <td className="num">{r.prompt_tokens.toLocaleString()}</td>
                  <td className="num">{r.completion_tokens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ---------- 接入工具 ---------- */

function CopyField({ label, value, notify }: { label: string; value: string; notify: Notify }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-field">
      <span>{label}</span>
      <code>{value}</code>
      <button
        className="icon-btn"
        title="复制"
        onClick={async () => {
          await navigator.clipboard.writeText(value);
          setDone(true);
          notify(true, `已复制 ${label}`);
          window.setTimeout(() => setDone(false), 1500);
        }}
      >
        {done ? <Check size={16} /> : <Copy size={16} />}
      </button>
    </div>
  );
}

function ConnectPage(props: { accounts: Account[]; catalog: Catalog | null; baseUrl: string | null; notify: Notify }) {
  const base = props.baseUrl ?? "http://127.0.0.1:17890/v1";
  const ex = props.accounts[0];
  const free = ex && props.catalog?.providers.find((p) => p.id === ex.provider_id)?.api?.free_models?.[0];
  const model = ex ? `${ex.id}/${free ?? "<模型名>"}` : "<账号>/<模型名>";
  return (
    <div className="connect">
      <div className="panel">
        <h3>OpenAI 兼容入口</h3>
        <p className="muted">
          只监听本机 127.0.0.1。羊毛switch 用你自己的 Key 直接请求平台，在本机记账并按额度限量，不经过任何第三方服务器。
        </p>
        <CopyField label="Base URL" value={base} notify={props.notify} />
        <CopyField label="API Key" value="yangmao" notify={props.notify} />
        <CopyField label="模型名" value={model} notify={props.notify} />
        <p className="muted small">API Key 随意填写，真正的 Key 由本机钥匙串提供。模型名的斜杠前是“我的账号”里的账号名，后面是平台上的模型名。</p>
      </div>
      <div className="panel">
        <h3>常见工具</h3>
        <ul className="howto">
          <li>
            <b>Cherry Studio</b>：设置 → 模型服务 → 添加提供商（类型 OpenAI），填上面的 Base URL 和 API Key，再添加模型名。
          </li>
          <li>
            <b>Cline / Roo Code</b>：API Provider 选 OpenAI Compatible，填 Base URL、API Key 和模型名。
          </li>
          <li>
            <b>任何 OpenAI SDK</b>：把 <code>base_url</code> 设为上面的地址即可。
          </li>
        </ul>
      </div>
      <div className="panel">
        <h3>curl 测试</h3>
        <pre>{`curl ${base}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`}</pre>
        <p className="muted small">到达本地上限时返回 HTTP 429，错误码 local_quota_reached。</p>
      </div>
    </div>
  );
}
