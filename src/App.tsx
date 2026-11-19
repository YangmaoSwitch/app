import { ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
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
import { api, Account, AccountUsage, Catalog, GatewayInfo, LimitUsage, ModelEntry, OVERAGE, Provider, quotaParts, quotaText, REQUIRES, UsageRow } from "./api";

type Page = "catalog" | "accounts" | "usage" | "connect";
type Notify = (ok: boolean, text: string) => void;

const PAGES: { id: Page; label: string; icon: typeof Gift }[] = [
  { id: "catalog", label: "免费额度", icon: Gift },
  { id: "accounts", label: "我的账号", icon: KeyRound },
  { id: "usage", label: "用量", icon: BarChart3 },
  { id: "connect", label: "接入工具", icon: Plug },
];

const initialPage = (): Page => {
  const h = window.location.hash.slice(1) as Page;
  return PAGES.some((p) => p.id === h) ? h : "catalog";
};

export default function App() {
  const [page, setPage] = useState<Page>(initialPage);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<AccountUsage[]>([]);
  const [gw, setGw] = useState<GatewayInfo | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async () => setAccounts(await api.accounts()), []);
  const notify: Notify = useCallback((ok, text) => {
    setToast({ ok, text });
    window.setTimeout(() => setToast(null), 4500);
  }, []);

  useEffect(() => {
    api.catalog().then(setCatalog).catch((e) => notify(false, String(e)));
    api.gateway().then(setGw);
    reload();
    const load = () => api.usage().then(setUsage);
    load();
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, [reload, notify]);

  const go = (p: Page) => {
    setPage(p);
    window.history.replaceState(null, "", `#${p}`);
  };

  const today = usage.reduce((s, u) => s + u.today_requests, 0);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="/icon.png" alt="" />
          <span>羊毛switch</span>
        </div>
        <nav aria-label="主导航">
          {PAGES.map((p) => (
            <button key={p.id} className="nav-item" aria-current={page === p.id ? "page" : undefined} onClick={() => go(p.id)}>
              <p.icon size={17} strokeWidth={2} />
              <span>{p.label}</span>
              {p.id === "accounts" && accounts.length > 0 && <em className="num">{accounts.length}</em>}
              {p.id === "usage" && today > 0 && <em className="num">{today}</em>}
            </button>
          ))}
        </nav>
        <GatewayCard gw={gw} notify={notify} />
      </aside>

      <main className="main">
        {page === "catalog" && (
          <CatalogPage
            catalog={catalog}
            accounts={accounts}
            notify={notify}
            onRefresh={async () => {
              try {
                setCatalog(await api.catalog(true));
                notify(true, "目录已更新");
              } catch (e) {
                notify(false, `更新失败：${e}`);
              }
            }}
            onAdded={async (a) => {
              await reload();
              notify(true, `已添加 ${a.label}，Key 已存入系统钥匙串`);
            }}
          />
        )}
        {page === "accounts" && <AccountsPage accounts={accounts} usage={usage} onChange={reload} notify={notify} onBrowse={() => go("catalog")} />}
        {page === "usage" && <UsagePage usage={usage} />}
        {page === "connect" && <ConnectPage accounts={accounts} gw={gw} onGw={setGw} notify={notify} />}
      </main>

      {toast && (
        <div className={`toast ${toast.ok ? "" : "err"}`} role="status">
          {toast.ok ? <Check size={16} /> : <AlertTriangle size={16} />}
          {toast.text}
        </div>
      )}
    </div>
  );
}

/* ---------- shared ---------- */

function GatewayCard({ gw, notify }: { gw: GatewayInfo | null; notify: Notify }) {
  return (
    <div className="gateway">
      <div className="gateway-head">
        <span className={gw?.running ? "dot on" : "dot"} />
        {gw?.running ? "本机入口运行中" : gw?.error ? "端口被占用" : "本机入口未启动"}
      </div>
      {gw?.base_url && (
        <button
          className="gateway-url"
          title="复制 Base URL"
          onClick={async () => {
            await navigator.clipboard.writeText(`${gw.base_url}/v1`);
            notify(true, "已复制 OpenAI Base URL");
          }}
        >
          <span className="mono">{gw.base_url.replace("http://", "")}</span>
          <Copy size={13} />
        </button>
      )}
    </div>
  );
}

function PageHead(props: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{props.title}</h1>
        {props.sub && <p>{props.sub}</p>}
      </div>
      <div className="page-actions">{props.children}</div>
    </header>
  );
}

const AVATAR = ["#c2410c", "#1d4ed8", "#047857", "#6d28d9", "#b91c1c", "#0369a1", "#a16207", "#0f766e", "#be185d", "#4338ca"];
function Avatar({ name, seed, size = 40 }: { name: string; seed: string; size?: number }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const color = AVATAR[h % AVATAR.length];
  const ch = /[\u4e00-\u9fa5]/.test(name[0]) ? name[0] : name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2);
  return (
    <div className="avatar" style={{ color, background: `${color}12`, width: size, height: size }} aria-hidden>
      {ch}
    </div>
  );
}

function Segmented<T extends string>(props: { value: T; options: [T, string, number?][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="tablist" aria-label={props.label}>
      {props.options.map(([v, label, n]) => (
        <button key={v} role="tab" aria-selected={props.value === v} onClick={() => props.onChange(v)}>
          {label}
          {n !== undefined && <span className="num">{n}</span>}
        </button>
      ))}
    </div>
  );
}

function IconBtn(props: { label: string; onClick: () => void; children: ReactNode; tone?: "danger" }) {
  return (
    <button className={`icon-btn ${props.tone ?? ""}`} title={props.label} aria-label={props.label} onClick={props.onClick}>
      {props.children}
    </button>
  );
}

const pname = (p: Provider) => p.name_zh ?? p.name;

/* ---------- 免费额度 ---------- */

function CatalogPage(props: { catalog: Catalog | null; accounts: Account[]; notify: Notify; onRefresh: () => void; onAdded: (a: Account) => void }) {
  const [region, setRegion] = useState<"all" | "cn" | "global">("all");
  const [apiOnly, setApiOnly] = useState(true);
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState<Provider | null>(null);
  const [busy, setBusy] = useState(false);

  const all = props.catalog?.providers ?? [];
  const base = all.filter((p) => !apiOnly || p.api_usable);
  const text = q.trim().toLowerCase();
  const list = useMemo(
    () =>
      base
        .filter((p) => region === "all" || p.region === region)
        .filter((p) => !text || `${p.name} ${p.name_zh ?? ""} ${p.summary ?? ""} ${p.tags.join(" ")} ${(p.api?.free_models ?? []).join(" ")}`.toLowerCase().includes(text)),
    [base, region, text],
  );

  const groups: [string, Provider[]][] = [
    ["国内平台", list.filter((p) => p.region === "cn")],
    ["海外平台", list.filter((p) => p.region === "global")],
  ];

  const connect = async () => {
    setBusy(true);
    try {
      props.onAdded(await api.connectOpenRouter());
    } catch (e) {
      props.notify(false, `授权没有完成：${e}`);
    } finally {
      setBusy(false);
    }
  };

  const added = new Set(props.accounts.map((a) => a.provider_id));

  return (
    <>
      <PageHead
        title="免费额度"
        sub={
          props.catalog ? (
            <>
              收录 <b className="num">{all.length}</b> 个平台，你已添加 <b className="num">{added.size}</b> 个 · 目录更新于 {props.catalog.generated_at?.slice(0, 10)}
            </>
          ) : (
            "正在加载目录…"
          )
        }
      >
        <button className="btn" onClick={props.onRefresh}>
          <RefreshCw size={15} /> 更新目录
        </button>
      </PageHead>

      <div className="toolbar">
        <Segmented
          label="地区"
          value={region}
          onChange={setRegion}
          options={[
            ["all", "全部", base.length],
            ["cn", "国内", base.filter((p) => p.region === "cn").length],
            ["global", "海外", base.filter((p) => p.region === "global").length],
          ]}
        />
        <label className="search">
          <Search size={15} />
          <input placeholder="搜索平台或模型，如 DeepSeek" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={apiOnly} onChange={(e) => setApiOnly(e.target.checked)} />
          <span className="track" />
          只看能当 API 用的
        </label>
      </div>

      {list.length === 0 && props.catalog && <div className="empty small-empty">没有符合条件的平台。换个关键词，或者切到“全部”。</div>}

      {groups.map(([title, ps]) =>
        ps.length === 0 ? null : (
          <section key={title} className="group">
            <h2>
              {title} <span className="num">{ps.length}</span>
            </h2>
            <div className="list">
              {ps.map((p) => {
                const expanded = open === p.id;
                const oneClick = p.onboarding.level === "L3" && p.id === "openrouter";
                return (
                  <div key={p.id} className="item" data-open={expanded || undefined}>
                    <div className="item-main" onClick={() => setOpen(expanded ? null : p.id)}>
                      <Avatar name={pname(p)} seed={p.id} />
                      <div className="item-title">
                        <div className="name">
                          {pname(p)}
                          {added.has(p.id) && <span className="chip ok">已添加</span>}
                          {p.status !== "verified" && <span className="chip warn">待核实</span>}
                        </div>
                        <div className="desc">{p.summary ?? p.homepage}</div>
                      </div>
                      <div className="quotas">
                        {p.quotas.every((x) => x.amount == null) && (
                          <div className="quota">
                            <b className="dim">见平台</b>
                            <span>限额按平台公布</span>
                          </div>
                        )}
                        {p.quotas.filter((x) => x.amount != null).slice(0, 2).map((x, i) => {
                          const { num, unit } = quotaParts(x);
                          return (
                            <div className="quota" key={i} title={quotaText(x)}>
                              <b className="num">{num}</b>
                              <span>{unit}</span>
                            </div>
                          );
                        })}
                      </div>
                      <div className="item-actions" onClick={(e) => e.stopPropagation()}>
                        {p.overage === "auto_paid" && (
                          <span className="risk" title="免费额度用完后会自动转为付费，记得在平台开启“用完即停”">
                            <AlertTriangle size={15} />
                          </span>
                        )}
                        {oneClick && added.has(p.id) ? (
                          <button className="btn" disabled title="已开通。平台条款不允许一人多个账号">
                            <Check size={15} /> 已开通
                          </button>
                        ) : oneClick ? (
                          <button className="btn primary" disabled={busy} onClick={connect}>
                            <Zap size={15} /> {busy ? "等待浏览器授权" : "一键开通"}
                          </button>
                        ) : p.api_usable ? (
                          <button className="btn" onClick={() => setAdding(p)}>
                            <Plus size={15} /> 添加 Key
                          </button>
                        ) : null}
                        <IconBtn label={`去 ${pname(p)} 注册`} onClick={() => api.openUrl(p.signup.url)}>
                          <ExternalLink size={16} />
                        </IconBtn>
                        <IconBtn label={expanded ? "收起" : "详情"} onClick={() => setOpen(expanded ? null : p.id)}>
                          <ChevronDown size={17} className={expanded ? "flip" : ""} />
                        </IconBtn>
                      </div>
                    </div>
                    {expanded && <ProviderDetail p={p} onAdd={() => setAdding(p)} />}
                  </div>
                );
              })}
            </div>
          </section>
        ),
      )}

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

function ProviderDetail({ p, onAdd }: { p: Provider; onAdd: () => void }) {
  return (
    <div className="detail">
      {p.overage === "auto_paid" && (
        <div className="notice danger">
          <AlertTriangle size={16} /> 免费额度用完后会自动转为付费。添加前先在平台控制台开启“用完即停”之类的保护。
        </div>
      )}
      <dl className="kv">
        <dt>免费额度</dt>
        <dd>
          <ul>
            {p.quotas.map((x, i) => (
              <li key={i}>
                {quotaText(x)}
                {x.note && <span className="muted">（{x.note}）</span>}{" "}
                <a onClick={() => api.openUrl(x.evidence)}>官方依据</a>
              </li>
            ))}
          </ul>
        </dd>
        <dt>注册要求</dt>
        <dd>
          {p.signup.requires.map((r) => REQUIRES[r] ?? r).join("、") || "—"}
          {p.signup.notes && <span className="muted">（{p.signup.notes}）</span>}
        </dd>
        {p.signup.regions_blocked.length > 0 && (
          <>
            <dt>不支持地区</dt>
            <dd>{p.signup.regions_blocked.join("、")}</dd>
          </>
        )}
        <dt>额度用完后</dt>
        <dd className={p.overage === "auto_paid" ? "danger-text" : ""}>{OVERAGE[p.overage]}</dd>
        {p.api && (
          <>
            <dt>接口地址</dt>
            <dd className="mono">{p.api.base_url}</dd>
          </>
        )}
        {(p.api?.free_models?.length ?? 0) > 0 && (
          <>
            <dt>免费模型</dt>
            <dd>{p.api!.free_models.join("、")}</dd>
          </>
        )}
        {p.terms.length > 0 && (
          <>
            <dt>条款要点</dt>
            <dd>
              <ul>
                {p.terms.map((t, i) => (
                  <li key={i}>
                    <a onClick={() => api.openUrl(t.url)}>{t.point}</a>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>最后核实</dt>
        <dd className="num">{p.last_verified}</dd>
      </dl>
      <div className="detail-actions">
        <button className="btn" onClick={() => api.openUrl(p.signup.url)}>
          <ExternalLink size={15} /> 去注册
        </button>
        {p.onboarding.key_page && (
          <button className="btn" onClick={() => api.openUrl(p.onboarding.key_page!)}>
            <KeyRound size={15} /> 打开 Key 页面
          </button>
        )}
        {p.api_usable && (
          <button className="btn" onClick={onAdd}>
            <Plus size={15} /> 粘贴 Key
          </button>
        )}
      </div>
    </div>
  );
}

function AddKeyDialog(props: { p: Provider; onClose: () => void; onAdded: (a: Account) => void }) {
  const { p } = props;
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(p.api?.base_url ?? "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const pattern = p.onboarding.key_pattern ? new RegExp(p.onboarding.key_pattern) : null;
  const mismatch = pattern && key.trim() !== "" && !pattern.test(key.trim());
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);
  return (
    <div className="modal" onClick={props.onClose}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="add-key-title" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <Avatar name={pname(p)} seed={p.id} size={44} />
          <div>
            <h3 id="add-key-title">添加 {pname(p)}</h3>
            <p>Key 只保存在这台电脑的系统钥匙串里。</p>
          </div>
        </div>
        <label className="field">
          <span>API Key</span>
          <input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="粘贴在平台上创建的 Key" />
          {mismatch && <small className="warn-text">格式和 {p.name} 的 Key 不太一样，确认没有贴错。</small>}
        </label>
        <label className="field">
          <span>接口地址</span>
          <input className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          {baseUrl.includes("ACCOUNT_ID") && <small className="warn-text">把地址里的 ACCOUNT_ID 换成你的账户 ID。</small>}
        </label>
        {err && <p className="danger-text">{err}</p>}
        <div className="dialog-actions">
          {p.onboarding.key_page && (
            <button className="btn link" onClick={() => api.openUrl(p.onboarding.key_page!)}>
              还没有 Key？去平台创建
            </button>
          )}
          <span className="spacer" />
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button
            className="btn primary"
            disabled={!key.trim() || saving}
            onClick={async () => {
              setSaving(true);
              try {
                props.onAdded(await api.addAccount(p.id, key, baseUrl !== p.api?.base_url ? baseUrl : undefined));
              } catch (e) {
                setErr(String(e));
              } finally {
                setSaving(false);
              }
            }}
          >
            保存 Key
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------- 我的账号 ---------- */

const PERIOD_NAME: Record<string, string> = { second: "每秒", minute: "每分钟", hour: "每小时", day: "今日", week: "本周", month: "本月", "one-time": "总额" };

function Meter({ l, compact }: { l: LimitUsage; compact?: boolean }) {
  const pct = Math.min(100, (l.used / l.cap) * 100);
  const period = l.label.split(" / ")[1] ?? "";
  const tone = pct >= 100 ? "full" : pct >= 80 ? "high" : "";
  return (
    <div className={`meter ${compact ? "compact" : ""}`}>
      <div className="meter-label">
        <span>
          {PERIOD_NAME[period] ?? period}
          {l.unit === "tokens" ? " Token" : ""}
        </span>
        <span className="num">
          {fmt(l.used)} / {fmt(l.cap)}
        </span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${tone}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

const fmt = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(2)}M` : n >= 1e4 ? `${+(n / 1e3).toFixed(1)}K` : n.toLocaleString());

function AccountsPage(props: { accounts: Account[]; usage: AccountUsage[]; onChange: () => void; notify: Notify; onBrowse: () => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHead title="我的账号" sub="Key 保存在系统钥匙串里，这里只记录账号和用量。">
        <button className="btn primary" onClick={props.onBrowse}>
          <Plus size={15} /> 添加账号
        </button>
      </PageHead>
      {props.accounts.length === 0 ? (
        <div className="empty">
          <KeyRound size={28} />
          <h3>还没有账号</h3>
          <p>在“免费额度”里一键开通 OpenRouter，或者去平台注册后粘贴 Key。</p>
          <button className="btn primary" onClick={props.onBrowse}>
            浏览免费额度
          </button>
        </div>
      ) : (
        <div className="list">
          {props.accounts.map((a) => {
            const u = props.usage.find((x) => x.account_id === a.id);
            const expanded = open === a.id;
            return (
              <div key={a.id} className="item" data-open={expanded || undefined} data-off={!a.enabled || undefined}>
                <div className="item-main" onClick={() => setOpen(expanded ? null : a.id)}>
                  <Avatar name={a.label} seed={a.provider_id} />
                  <div className="item-title">
                    <div className="name">
                      {a.label}
                      <code className="chip plain">{a.id}</code>
                      {u?.blocked_until && <span className="chip danger">平台限流到 {new Date(u.blocked_until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
                      {!a.enabled && <span className="chip">已停用</span>}
                    </div>
                    <div className="desc">
                      <span className="mono">{a.base_url}</span> · {a.models.length > 0 ? `${a.models.length} 个模型` : "模型列表未获取"}
                      {a.model_suffix ? `（只用 ${a.model_suffix} 结尾的免费模型）` : ""}
                    </div>
                  </div>
                  <div className="meters">
                    {u && u.limits.length > 0 ? u.limits.slice(0, 2).map((l, i) => <Meter key={i} l={l} compact />) : <span className="muted small">按平台计量</span>}
                  </div>
                  <div className="item-actions" onClick={(e) => e.stopPropagation()}>
                    <IconBtn
                      label="测试连接"
                      onClick={async () => {
                        try {
                          props.notify(true, await api.testAccount(a.id));
                        } catch (e) {
                          props.notify(false, String(e));
                        }
                      }}
                    >
                      <Play size={16} />
                    </IconBtn>
                    <label className="toggle bare" title={a.enabled ? "停用这个账号" : "启用这个账号"}>
                      <input
                        type="checkbox"
                        checked={a.enabled}
                        aria-label="启用"
                        onChange={async (e) => {
                          await api.setEnabled(a.id, e.target.checked);
                          props.onChange();
                        }}
                      />
                      <span className="track" />
                    </label>
                    <IconBtn label={expanded ? "收起" : "设置"} onClick={() => setOpen(expanded ? null : a.id)}>
                      <ChevronDown size={17} className={expanded ? "flip" : ""} />
                    </IconBtn>
                  </div>
                </div>
                {expanded && (
                  <div className="detail">
                    <dl className="kv">
                      <dt>本地上限</dt>
                      <dd>
                        用到免费额度的
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
                        就停，留出余量
                      </dd>
                      <dt>模型名</dt>
                      <dd className="mono">{a.id}/&lt;平台上的模型名&gt;</dd>
                      <dt>使用顺序</dt>
                      <dd>
                        多个账号都有同一个模型时，按列表顺序使用，前一个用完自动换下一个。
                        <button className="btn sm-inline" onClick={async () => { await api.moveAccount(a.id, -1); props.onChange(); }}>上移</button>
                        <button className="btn sm-inline" onClick={async () => { await api.moveAccount(a.id, 1); props.onChange(); }}>下移</button>
                      </dd>
                      <dt>模型</dt>
                      <dd>
                        {a.models.length > 0 ? <span className="mono small">{a.models.slice(0, 8).join("、")}{a.models.length > 8 ? ` 等 ${a.models.length} 个` : ""}</span> : <span className="muted">还没有获取，点右上方的“测试连接”获取</span>}
                      </dd>
                      <dt>添加时间</dt>
                      <dd className="num">{new Date(a.added_at).toLocaleString()}</dd>
                    </dl>
                    <div className="detail-actions">
                      <span className="spacer" />
                      <button
                        className="btn danger"
                        onClick={async () => {
                          if (!window.confirm(`删除 ${a.label}（${a.id}）？这台电脑上保存的 Key 和用量记录会一起删除。`)) return;
                          await api.removeAccount(a.id);
                          props.onChange();
                        }}
                      >
                        <Trash2 size={15} /> 删除账号
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

/* ---------- 用量 ---------- */

function HourlyChart({ log }: { log: UsageRow[] }) {
  const now = Date.now();
  const buckets = Array.from({ length: 24 }, (_, i) => {
    const end = now - (23 - i) * 3600e3;
    return { end, n: log.filter((r) => r.ts > end - 3600e3 && r.ts <= end).length };
  });
  const max = Math.max(1, ...buckets.map((b) => b.n));
  return (
    <div className="chart" role="img" aria-label="近 24 小时每小时请求数">
      {buckets.map((b, i) => (
        <div key={i} className={i === 23 ? "chart-col now" : "chart-col"} title={`${new Date(b.end).getHours()}:00 前一小时：${b.n} 次`}>
          <div className="chart-bar" style={{ height: `${(b.n / max) * 100}%` }} />
        </div>
      ))}
      <div className="chart-axis">
        <span>24 小时前</span>
        <span>12 小时前</span>
        <span>现在</span>
      </div>
    </div>
  );
}

function UsagePage({ usage }: { usage: AccountUsage[] }) {
  const [log, setLog] = useState<UsageRow[]>([]);
  const [tab, setTab] = useState<"limits" | "log">("limits");
  useEffect(() => {
    const load = () => api.recentRequests(500).then(setLog);
    load();
    const t = window.setInterval(load, 4000);
    return () => window.clearInterval(t);
  }, []);

  const req = usage.reduce((s, r) => s + r.today_requests, 0);
  const tok = usage.reduce((s, r) => s + r.today_tokens, 0);
  const near = usage.filter((r) => r.limits.some((l) => l.used / l.cap >= 0.8)).length;
  const blocked = usage.filter((r) => r.blocked_until).length;

  return (
    <>
      <PageHead title="用量" sub="在这台电脑上记账，按每个平台的免费额度限量。" />
      <div className="summary">
        <div className="figures">
          <div>
            <span>近 24 小时请求</span>
            <b className="num">{req.toLocaleString()}</b>
          </div>
          <div>
            <span>近 24 小时 tokens</span>
            <b className="num">{fmt(tok)}</b>
          </div>
          <div>
            <span>接近上限</span>
            <b className={`num ${near ? "warn-text" : ""}`}>{near}</b>
          </div>
          <div>
            <span>被平台限流</span>
            <b className={`num ${blocked ? "danger-text" : ""}`}>{blocked}</b>
          </div>
        </div>
        <HourlyChart log={log} />
      </div>

      <Segmented
        label="视图"
        value={tab}
        onChange={setTab}
        options={[
          ["limits", "额度进度"],
          ["log", "请求记录"],
        ]}
      />

      {tab === "limits" &&
        (usage.length === 0 ? (
          <div className="empty small-empty">还没有账号，添加后这里会显示每个账号的额度进度。</div>
        ) : (
          <div className="list spaced">
            {usage.map((u) => (
              <div key={u.account_id} className="item static">
                <div className="item-main">
                  <Avatar name={u.label} seed={u.account_id} size={36} />
                  <div className="item-title">
                    <div className="name">
                      {u.label} <code className="chip plain">{u.account_id}</code>
                      {u.blocked_until && <span className="chip danger">{u.blocked_reason}</span>}
                    </div>
                    <div className="desc">
                      近 24 小时 <span className="num">{u.today_requests}</span> 次，<span className="num">{fmt(u.today_tokens)}</span> tokens
                    </div>
                  </div>
                </div>
                <div className="meters-wide">
                  {u.limits.length === 0 && <p className="muted small">这个平台按积分或余额计量，没法在本机精确计数，以平台返回为准。</p>}
                  {u.limits.map((l, i) => (
                    <div key={i}>
                      <Meter l={l} />
                      {l.resets_at && <small className="muted">{new Date(l.resets_at).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 重置</small>}
                    </div>
                  ))}
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
                <th className="r">状态</th>
                <th className="r">输入</th>
                <th className="r">输出</th>
              </tr>
            </thead>
            <tbody>
              {log.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted center">
                    还没有请求。在其他工具里接入本机入口后，请求会出现在这里。
                  </td>
                </tr>
              )}
              {log.slice(0, 200).map((r, i) => (
                <tr key={i}>
                  <td className="num">{new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</td>
                  <td>{r.account_id}</td>
                  <td className="mono">{r.model}</td>
                  <td className="r">
                    <span className={`status ${r.status && r.status >= 400 ? "bad" : r.status ? "good" : ""}`}>{r.status ?? "进行中"}</span>
                  </td>
                  <td className="r num">{r.prompt_tokens.toLocaleString()}</td>
                  <td className="r num">{r.completion_tokens.toLocaleString()}</td>
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

function CopyRow({ label, value, hint, notify, mono = true, children }: { label: string; value: string; hint?: ReactNode; notify: Notify; mono?: boolean; children?: ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <div className="copy-row">
      <div>
        <span className="copy-label">{label}</span>
        <code className={mono ? "" : "plain"}>{value}</code>
        {hint && <small className="muted">{hint}</small>}
      </div>
      <div className="copy-actions">
        {children}
        <button
          className="btn"
          onClick={async () => {
            await navigator.clipboard.writeText(value);
            setDone(true);
            notify(true, `已复制${label}`);
            window.setTimeout(() => setDone(false), 1500);
          }}
        >
          {done ? <Check size={15} /> : <Copy size={15} />} {done ? "已复制" : "复制"}
        </button>
      </div>
    </div>
  );
}

function ConnectPage(props: { accounts: Account[]; gw: GatewayInfo | null; onGw: (g: GatewayInfo) => void; notify: Notify }) {
  const gw = props.gw;
  const [models, setModels] = useState<ModelEntry[]>([]);
  const [port, setPort] = useState("");
  const [editKey, setEditKey] = useState<string | null>(null);
  const [tool, setTool] = useState<"openai" | "claude">("openai");
  useEffect(() => {
    api.models().then(setModels);
  }, [props.accounts]);
  useEffect(() => {
    if (gw) setPort(String(gw.port));
  }, [gw?.port]);
  if (!gw) return null;

  const root = gw.base_url ?? `http://127.0.0.1:${gw.port}`;
  const model = models[0]?.id ?? "平台上的模型名";
  const envPs = `$env:ANTHROPIC_BASE_URL="${root}"\n$env:ANTHROPIC_AUTH_TOKEN="${gw.api_key}"\n$env:ANTHROPIC_MODEL="${model}"\n$env:ANTHROPIC_DEFAULT_HAIKU_MODEL="${model}"\nclaude`;
  const envSh = `export ANTHROPIC_BASE_URL=${root}\nexport ANTHROPIC_AUTH_TOKEN=${gw.api_key}\nexport ANTHROPIC_MODEL=${model}\nexport ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}\nclaude`;

  return (
    <>
      <PageHead title="接入工具" sub="其他工具通过本机入口使用你的免费额度，OpenAI 和 Claude 两种接口都支持。" />
      <div className="connect">
        {gw.error && (
          <div className="notice danger">
            <AlertTriangle size={16} /> {gw.error}
          </div>
        )}
        <section className="panel">
          <h3>本机入口</h3>
          <div className="copy-row">
            <div>
              <span className="copy-label">端口</span>
              <span className="port-edit">
                <span className="mono muted">127.0.0.1:</span>
                <input className="mono" value={port} inputMode="numeric" onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))} />
              </span>
              <small className="muted">只监听本机，局域网和外网都访问不到。改端口后，已接入的工具也要跟着改。</small>
            </div>
            <div className="copy-actions">
              <button
                className="btn"
                disabled={port === String(gw.port) && gw.running}
                onClick={async () => {
                  try {
                    props.onGw(await api.setPort(Number(port)));
                    props.notify(true, `本机入口已切换到端口 ${port}`);
                  } catch (e) {
                    props.notify(false, String(e));
                  }
                }}
              >
                应用
              </button>
            </div>
          </div>
          {editKey === null ? (
            <CopyRow label="API Key" value={gw.api_key} hint="首次启动时随机生成，工具里填它才能访问本机入口" notify={props.notify}>
              <button className="btn" onClick={() => setEditKey(gw.api_key)}>
                自定义
              </button>
              <button
                className="btn"
                onClick={async () => {
                  if (!window.confirm("重新生成后，已接入的工具需要换成新的 Key。继续？")) return;
                  props.onGw(await api.setApiKey(null));
                  props.notify(true, "已生成新的 API Key");
                }}
              >
                <RefreshCw size={15} /> 重新生成
              </button>
            </CopyRow>
          ) : (
            <div className="copy-row">
              <div>
                <span className="copy-label">API Key</span>
                <input className="mono key-input" autoFocus value={editKey} onChange={(e) => setEditKey(e.target.value)} />
                <small className="muted">至少 8 个字符</small>
              </div>
              <div className="copy-actions">
                <button className="btn" onClick={() => setEditKey(null)}>
                  取消
                </button>
                <button
                  className="btn primary"
                  onClick={async () => {
                    try {
                      props.onGw(await api.setApiKey(editKey));
                      setEditKey(null);
                      props.notify(true, "API Key 已更新");
                    } catch (e) {
                      props.notify(false, String(e));
                    }
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h3>在工具里填写</h3>
            <Segmented
              label="接口类型"
              value={tool}
              onChange={setTool}
              options={[
                ["openai", "OpenAI 接口"],
                ["claude", "Claude 接口"],
              ]}
            />
          </div>
          {tool === "openai" ? (
            <>
              <CopyRow label="Base URL" value={`${root}/v1`} hint="Cherry Studio、Cline、OpenAI SDK 等" notify={props.notify} />
              <CopyRow label="API Key" value={gw.api_key} notify={props.notify} />
              <CopyRow label="模型名" value={model} hint="直接用平台上的模型名，见下方列表" notify={props.notify} />
            </>
          ) : (
            <>
              <CopyRow label="Base URL" value={root} hint="Claude Code、Anthropic SDK 等；不带 /v1" notify={props.notify} />
              <CopyRow label="API Key" value={gw.api_key} hint="填在 ANTHROPIC_AUTH_TOKEN 或 x-api-key" notify={props.notify} />
              <CopyRow label="Claude Code" value={envPs} mono hint="PowerShell 里粘贴运行；macOS / Linux 用右侧按钮复制" notify={props.notify}>
                <button
                  className="btn"
                  onClick={async () => {
                    await navigator.clipboard.writeText(envSh);
                    props.notify(true, "已复制 macOS / Linux 命令");
                  }}
                >
                  macOS / Linux
                </button>
              </CopyRow>
              <p className="muted small">平台不支持 Claude 接口时，羊毛switch 会在本机把请求转换成 OpenAI 格式再发出去，工具调用（function calling）和流式输出都能用。</p>
            </>
          )}
        </section>

        <section className="panel">
          <h3>
            可用模型 <span className="muted num">{models.length}</span>
          </h3>
          <p className="muted small">
            多个账号都有同一个模型时，按“我的账号”里的顺序使用，前一个到上限或被平台限流就自动换下一个。想固定用某个账号，模型名写成 <code>账号/模型名</code>。
          </p>
          {models.length === 0 ? (
            <div className="empty small-empty">还没有可用模型。先添加账号，再在“我的账号”里点“测试连接”获取模型列表。</div>
          ) : (
            <div className="model-list">
              {models.map((m) => (
                <button
                  key={m.id}
                  className="model"
                  title="点击复制模型名"
                  onClick={async () => {
                    await navigator.clipboard.writeText(m.id);
                    props.notify(true, `已复制 ${m.id}`);
                  }}
                >
                  <span className="mono">{m.id}</span>
                  <span className="muted small">{m.accounts.join("、")}</span>
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  );
}
