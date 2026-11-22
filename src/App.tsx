import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BarChart3,
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Gift,
  House,
  KeyRound,
  MessageSquarePlus,
  LayoutGrid,
  X,
  Play,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Server,
  Trash2,
  Zap,
} from "lucide-react";
import TitleBar, { isMac } from "./TitleBar";
import SubmitDialog, { SubmitPrefill } from "./Submit";
import { ModelLogo, ProviderLogo } from "./logos";
import { api, Account, AccountUsage, Catalog, GatewayInfo, LimitUsage, ModelEntry, ModelSquare, SquareModel, Offer, Access, modelKey, quotaShort, priceText, ProviderModels, OVERAGE, Provider, quotaParts, quotaText, REQUIRES, UsageRow } from "./api";

type Page = "home" | "catalog" | "models" | "accounts" | "usage" | "connect";
type ModelsPreset = { sort?: SortKey; access?: "all" | "free"; open?: string };
type SortKey = "heat" | "new" | "platforms";

/** Opens the submit / report dialog, optionally about a given platform or model. */
const SubmitCtx = createContext<(p?: SubmitPrefill) => void>(() => {});
type Notify = (ok: boolean, text: string) => void;

const PAGES: { id: Page; label: string; icon: typeof Gift }[] = [
  { id: "home", label: "首页", icon: House },
  { id: "models", label: "模型广场", icon: LayoutGrid },
  { id: "catalog", label: "供应商", icon: Server },
  { id: "accounts", label: "我的账号", icon: KeyRound },
  { id: "usage", label: "用量", icon: BarChart3 },
  { id: "connect", label: "接入工具", icon: Plug },
];

const initialPage = (): Page => {
  const h = window.location.hash.slice(1) as Page;
  return PAGES.some((p) => p.id === h) ? h : "home";
};

export default function App() {
  const [page, setPage] = useState<Page>(initialPage);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [usage, setUsage] = useState<AccountUsage[]>([]);
  const [gw, setGw] = useState<GatewayInfo | null>(null);
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);
  const [submit, setSubmit] = useState<SubmitPrefill | null>(null);
  const [preset, setPreset] = useState<ModelsPreset>({});

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

  const go = (p: Page, mp: ModelsPreset = {}) => {
    setPreset(mp);
    setPage(p);
    window.history.replaceState(null, "", `#${p}`);
  };

  const today = usage.reduce((s, u) => s + u.today_requests, 0);

  return (
    <SubmitCtx.Provider value={(p) => setSubmit(p ?? {})}>
    <div className={isMac ? "shell mac" : "shell"}>
      <aside className="sidebar">
        <div className="sidebar-drag" data-tauri-drag-region />
        <div className="brand" data-tauri-drag-region>
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
        <button className="nav-item submit-entry" onClick={() => setSubmit({})}>
          <MessageSquarePlus size={17} strokeWidth={2} />
          <span>提交 / 纠错</span>
        </button>
        <GatewayCard gw={gw} notify={notify} />
      </aside>

      <TitleBar />
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
        {page === "home" && <HomePage catalog={catalog} notify={notify} onModels={(mp) => go("models", mp)} onProviders={() => go("catalog")} />}
        {page === "models" && <ModelsPage key={JSON.stringify(preset)} preset={preset} catalog={catalog} accounts={accounts} notify={notify} onOpenProvider={() => go("catalog")} />}
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
      {submit && <SubmitDialog prefill={submit} onClose={() => setSubmit(null)} notify={notify} />}
    </div>
    </SubmitCtx.Provider>
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

/* ---------- Providers ---------- */

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

  // rank by the catalog score: quality of the models each provider serves free, weighted by how lasting the access is
  const [square, setSquare] = useState<ModelSquare | null>(null);
  useEffect(() => {
    api.modelSquare().then(setSquare).catch(() => setSquare(null));
  }, []);
  const ranked = [...list].sort(byProviderRank(square));
  const groups: [string, Provider[]][] = [
    ["国内供应商", ranked.filter((p) => p.region === "cn")],
    ["海外供应商", ranked.filter((p) => p.region === "global")],
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
        title="供应商"
        sub={
          props.catalog ? (
            <>
              收录 <b className="num">{all.length}</b> 个供应商，你已添加 <b className="num">{added.size}</b> 个 · 目录更新于 {props.catalog.generated_at?.slice(0, 10)}
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
          <input placeholder="搜索供应商或模型，如 DeepSeek" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={apiOnly} onChange={(e) => setApiOnly(e.target.checked)} />
          <span className="track" />
          只看能当 API 用的
        </label>
      </div>

      {list.length === 0 && props.catalog && <div className="empty small-empty">没有符合条件的供应商。换个关键词，或者切到“全部”。</div>}

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
                      <ProviderLogo id={p.id} />
                      <div className="item-title">
                        <div className="name">
                          {pname(p)}
                          {added.has(p.id) && <span className="chip ok">已添加</span>}
                          {p.ended ? (
                            <span className="chip" title={`免费活动已于 ${p.ended} 下线`}>已下线</span>
                          ) : (
                            p.status !== "verified" && <span className="chip warn">待核实</span>
                          )}
                        </div>
                        <div className="desc">{p.summary ?? p.homepage}</div>
                      </div>
                      <div className="quotas">
                        {p.quotas.every((x) => x.amount == null) && (
                          <div className="quota">
                            <b className="dim">见供应商</b>
                            <span>限额按供应商公布</span>
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
                          <span className="risk" title="免费额度用完后会自动转为付费，记得在供应商开启“用完即停”">
                            <AlertTriangle size={15} />
                          </span>
                        )}
                        {oneClick && added.has(p.id) ? (
                          <button className="btn" disabled title="已开通。供应商条款不允许一人多个账号">
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
  const openSubmit = useContext(SubmitCtx);
  return (
    <div className="detail">
      {p.overage === "auto_paid" && (
        <div className="notice danger">
          <AlertTriangle size={16} /> 免费额度用完后会自动转为付费。添加前先在供应商控制台开启“用完即停”之类的保护。
        </div>
      )}
      {p.ended && <p className="muted">这个免费活动已于 {p.ended} 下线，条目保留供参考。</p>}
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
        {(p.signup.regions_blocked?.length ?? 0) > 0 && (
          <>
            <dt>不支持地区</dt>
            <dd>{p.signup.regions_blocked!.join("、")}</dd>
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
        <dt>模型</dt>
        <dd>
          <ProviderModelList pid={p.id} />
        </dd>
        {(p.terms?.length ?? 0) > 0 && (
          <>
            <dt>条款要点</dt>
            <dd>
              <ul>
                {p.terms!.map((t, i) => (
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
        <button className="btn link" onClick={() => openSubmit({ kind: "correction", target: p.id, title: `${pname(p)}：` })}>
          纠错
        </button>
      </div>
    </div>
  );
}

/** The platform's model list maintained on the server: free / covered by the free quota / paid, with list prices. */
function ProviderModelList({ pid }: { pid: string }) {
  const [pm, setPm] = useState<ProviderModels | null | undefined>(undefined);
  const [tab, setTab] = useState<"free" | "quota" | "paid">("free");
  const [all, setAll] = useState(false);
  useEffect(() => {
    api.modelSquare().then((d) => {
      const x = d.providers?.[pid] ?? null;
      setPm(x);
      if (x) setTab(x.free ? "free" : x.quota ? "quota" : "paid");
    }).catch(() => setPm(null));
  }, [pid]);
  if (pm === undefined) return <span className="muted">正在加载…</span>;
  if (!pm || pm.total === 0) return <span className="muted">暂无模型列表，欢迎提交。</span>;
  const rows = pm.models.filter((m) => m.access === tab);
  const shown = all ? rows : rows.slice(0, 12);
  return (
    <div className="pmodels">
      <Segmented
        label="模型类别"
        value={tab}
        onChange={(v) => {
          setTab(v);
          setAll(false);
        }}
        options={[
          ["free", "免费", pm.free],
          ["quota", "用免费额度", pm.quota],
          ["paid", "付费", pm.paid],
        ]}
      />
      {rows.length === 0 ? (
        <span className="muted small">没有这一类模型。</span>
      ) : (
        <ul className="pmodel-list">
          {shown.map((m) => (
            <li key={m.model}>
              <code>{m.model}</code>
              {m.price && (m.price.input > 0 || m.price.output > 0) && <span className="muted small num">{priceText(m.price)}</span>}
            </li>
          ))}
        </ul>
      )}
      {rows.length > shown.length && (
        <a className="small" onClick={() => setAll(true)}>
          展开全部 {rows.length} 个
        </a>
      )}
      {tab !== "free" && rows.some((m) => m.price) && <span className="muted small">价格为每百万输入 / 输出 tokens 的美元标价，仅供参考。</span>}
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
          <ProviderLogo id={p.id} size={44} />
          <div>
            <h3 id="add-key-title">添加 {pname(p)}</h3>
            <p>Key 只保存在这台电脑的系统钥匙串里。</p>
          </div>
        </div>
        <label className="field">
          <span>API Key</span>
          <input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="粘贴在供应商上创建的 Key" />
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
              还没有 Key？去供应商创建
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

/* ---------- 模型广场 ---------- */

const ctxText = (n: number | null) => (n == null ? null : n >= 1e6 ? `${+(n / 1048576).toFixed(1)}M` : `${Math.round(n / 1024)}K`);
const isNew = (d: string | null) => !!d && Date.now() - new Date(d).getTime() < 21 * 864e5;

function modelTags(m: SquareModel): { text: string; tone?: string }[] {
  const t: { text: string; tone?: string }[] = [];
  if (m.description_source) t.push({ text: "对话", tone: "blue" });
  if (m.input_modalities.includes("image")) t.push({ text: "视觉" });
  if (m.input_modalities.includes("video")) t.push({ text: "视频理解" });
  if (m.input_modalities.includes("audio")) t.push({ text: "音频" });
  if (m.tools) t.push({ text: "工具调用" });
  if (m.reasoning) t.push({ text: "推理模型" });
  const c = ctxText(m.context_length);
  if (c) t.push({ text: c });
  return t;
}

/** The quota that applies to an offer: free models use the model-specific limit, free-quota offers the general quota or credits. */
const pickQuota = (p: Provider, access?: Access) =>
  (access === "quota" ? p.quotas.find((q) => !q.models) : p.quotas.find((q) => !!q.models)) ?? p.quotas[0];

const ACCESS: Record<Access, { text: string; tone: string }> = {
  free: { text: "免费模型", tone: "ok" },
  quota: { text: "用免费额度", tone: "blue" },
  paid: { text: "付费", tone: "" },
  account: { text: "你的账号可用", tone: "ok" },
};

/** Catalog ranking of providers: score from the server (free models x3, renewing free quota x1, one-time gift x0.3),
 *  unverified entries last. */
const byProviderRank = (sq: ModelSquare | null) => (a: Provider, b: Provider) =>
  Number(a.status !== "verified") - Number(b.status !== "verified") ||
  (sq?.providers?.[b.id]?.score ?? 0) - (sq?.providers?.[a.id]?.score ?? 0) ||
  a.name.localeCompare(b.name);

const daysAgo = (d?: string | null) => (d ? Math.floor((Date.now() - new Date(d.slice(0, 10)).getTime()) / 864e5) : Infinity);

function HomePage(props: { catalog: Catalog | null; notify: Notify; onModels: (p: ModelsPreset) => void; onProviders: () => void }) {
  const [data, setData] = useState<ModelSquare | null>(null);
  useEffect(() => {
    api.modelSquare().then(setData).catch((e) => props.notify(false, String(e)));
  }, []);
  const provider = (id: string) => props.catalog?.providers.find((x) => x.id === id);
  const pName = (id: string) => {
    const p = provider(id);
    return p ? pname(p) : id;
  };
  if (!data) return <PageHead title="首页" sub="正在加载…" />;
  const models = [...data.models].sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0));
  const ROW = 4;
  const hot = models.slice(0, ROW);
  const fresh = models.filter((m) => daysAgo(m.created) <= 45).sort((a, b) => (b.created ?? "").localeCompare(a.created ?? "")).slice(0, ROW);
  const forever = models.filter((m) => m.offers.some((o) => o.access === "free")).slice(0, ROW);
  // recommended providers: those serving models for free or on a free quota, in the catalog's order
  const score = new Map<string, number>();
  for (const m of models) for (const o of m.offers) if (o.access !== "paid" && provider(o.provider)) score.set(o.provider, (score.get(o.provider) ?? 0) + (m.heat ?? 0));
  const topProviders = (props.catalog?.providers ?? []).filter((p) => score.has(p.id)).sort(byProviderRank(data)).slice(0, ROW).map((p) => p.id);

  const card = (m: SquareModel) => (
    <button key={m.id} className="mcard" onClick={() => props.onModels({ open: m.id })}>
      <div className="mcard-head">
        <ModelLogo m={m} size={34} />
        <div className="mcard-title">
          <b>{m.vendor ? `${m.vendor} / ${m.name}` : m.name}</b>
          <span>
            {m.offers.length > 2 ? `${m.offers.slice(0, 2).map((o) => pName(o.provider)).join("、")} 等 ${m.offers.length} 个供应商` : m.offers.map((o) => pName(o.provider)).join("、")}
          </span>
        </div>
      </div>
      <div className="mtags">
        <span className={`mtag ${ACCESS[m.offers[0].access ?? "free"].tone}`}>{ACCESS[m.offers[0].access ?? "free"].text}</span>
        {modelTags(m)
          .filter((t) => t.text !== "对话")
          .map((t, i) => (
            <span key={i} className="mtag">
              {t.text}
            </span>
          ))}
      </div>
    </button>
  );
  const pcard = (id: string) => {
    const p = provider(id)!;
    const pm = data.providers?.[id];
    return (
      <button key={id} className="mcard" onClick={props.onProviders}>
        <div className="mcard-head">
          <ProviderLogo id={id} size={34} />
          <div className="mcard-title">
            <b>{pname(p)}</b>
            <span>{pm ? `模型 ${pm.total} 个（免费 ${pm.free} · 用免费额度 ${pm.quota}）` : ""}</span>
          </div>
        </div>
        <p className="mcard-desc">{p.quotas[0] ? quotaText(p.quotas[0]) : ""}</p>
      </button>
    );
  };
  const section = (title: string, sub: string, more: () => void, body: ReactNode) => (
    <section className="home-sec">
      <div className="sec-head">
        <div>
          <h2>{title}</h2>
          <p>{sub}</p>
        </div>
        <button className="btn link" onClick={more}>
          查看全部
        </button>
      </div>
      <div className="model-grid one-row">{body}</div>
    </section>
  );
  return (
    <>
      <PageHead
        title="首页"
        sub={
          <>
            <b className="num">{models.length}</b> 个可以免费调用的模型 · 更新于 {data.generated_at.slice(0, 10)}
          </>
        }
      />
      {section("免费好模型", "先看能否长期免费用，再看下载量、供应商数和发布时间", () => props.onModels({ sort: "heat" }), hot.map(card))}
      {section("推荐供应商", "按免费提供的模型排序，长期免费的权重最高", props.onProviders, topProviders.map(pcard))}
      {fresh.length > 0 && section("新模型", "最近 45 天上线、可以免费调用的模型", () => props.onModels({ sort: "new" }), fresh.map(card))}
      {section("不限期免费", "供应商列为免费模型、不消耗额度（通常有限速），以供应商公布为准", () => props.onModels({ access: "free" }), forever.map(card))}
    </>
  );
}

function ModelsPage(props: { preset: ModelsPreset; catalog: Catalog | null; accounts: Account[]; notify: Notify; onOpenProvider: () => void }) {
  const openSubmit = useContext(SubmitCtx);
  const [data, setData] = useState<ModelSquare | null>(null);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "vision" | "tools" | "reasoning">("all");
  const [access, setAccess] = useState<"all" | "free">(props.preset.access ?? "all");
  const [sort, setSort] = useState<SortKey>(props.preset.sort ?? "heat");
  const [provider, setProvider] = useState("all");
  const [open, setOpen] = useState<SquareModel | null>(null);
  const [mine, setMine] = useState<ModelEntry[]>([]);
  useEffect(() => {
    api
      .modelSquare()
      .then((d) => {
        setData(d);
        if (props.preset.open) setOpen(d.models.find((m) => m.id === props.preset.open) ?? null);
      })
      .catch((e) => props.notify(false, String(e)));
  }, []);
  useEffect(() => {
    api.models().then(setMine).catch(() => setMine([]));
  }, [props.accounts]);

  const pName = (id: string) => {
    const p = props.catalog?.providers.find((x) => x.id === id);
    return p ? pname(p) : id;
  };
  const owned = new Set(props.accounts.filter((a) => a.enabled).map((a) => a.provider_id));
  // Add the platforms of your own accounts whose model list contains the model, even if the catalog data doesn't.
  const models = useMemo(() => {
    const provOf = new Map(props.accounts.map((a) => [a.id, a.provider_id]));
    const byKey = new Map<string, Offer[]>();
    for (const e of mine)
      for (const acc of e.accounts) {
        const p = provOf.get(acc);
        if (!p) continue;
        const k = modelKey(e.id);
        byKey.set(k, [...(byKey.get(k) ?? []), { provider: p, model: e.id, access: "account" }]);
      }
    return (data?.models ?? []).map((m) => {
      const extra = (byKey.get(modelKey(m.id)) ?? []).filter((o, i, a) => !m.offers.some((x) => x.provider === o.provider) && a.findIndex((y) => y.provider === o.provider) === i);
      return extra.length ? { ...m, offers: [...m.offers, ...extra] } : m;
    });
  }, [data, mine, props.accounts]);
  const providers = Array.from(new Set(models.flatMap((m) => m.offers.map((o) => o.provider))));
  const text = q.trim().toLowerCase();
  const list = models.filter(
    (m) =>
      (access === "all" || m.offers.some((o) => o.access === "free")) &&
      (provider === "all" || m.offers.some((o) => o.provider === provider)) &&
      (kind === "all" || (kind === "vision" && m.input_modalities.includes("image")) || (kind === "tools" && m.tools) || (kind === "reasoning" && m.reasoning)) &&
      (!text || `${m.name} ${m.vendor ?? ""} ${m.id} ${m.description}`.toLowerCase().includes(text)),
  );
  // default order is the catalog ranking: quality x how freely the model can be used
  if (sort === "new") list.sort((a, b) => (b.created ?? "").localeCompare(a.created ?? ""));
  else if (sort === "platforms") list.sort((a, b) => b.offers.length - a.offers.length || (b.heat ?? 0) - (a.heat ?? 0));
  else list.sort((a, b) => (b.heat ?? 0) - (a.heat ?? 0));

  return (
    <>
      <PageHead
        title="模型广场"
        sub={data ? <>可以免费调用的模型 <b className="num">{models.length}</b> 个 · 更新于 {data.generated_at.slice(0, 10)}</> : "正在加载…"}
      >
        <button
          className="btn"
          onClick={async () => {
            try {
              setData(await api.modelSquare(true));
              props.notify(true, "模型列表已更新");
            } catch (e) {
              props.notify(false, `更新失败：${e}`);
            }
          }}
        >
          <RefreshCw size={15} /> 更新
        </button>
      </PageHead>
      <div className="toolbar">
        <label className="search">
          <Search size={15} />
          <input placeholder="搜索模型名称" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <Segmented
          label="能力"
          value={kind}
          onChange={setKind}
          options={[
            ["all", "全部"],
            ["vision", "视觉"],
            ["tools", "工具调用"],
            ["reasoning", "推理"],
          ]}
        />
        <select className="select" value={access} onChange={(e) => setAccess(e.target.value as "all" | "free")} aria-label="调用方式">
          <option value="all">全部方式</option>
          <option value="free">只看免费模型</option>
        </select>
        <select className="select" value={provider} onChange={(e) => setProvider(e.target.value)} aria-label="供应商">
          <option value="all">全部供应商</option>
          {providers.map((p) => (
            <option key={p} value={p}>
              {pName(p)}
            </option>
          ))}
        </select>
        <select className="select" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="排序">
          <option value="heat">推荐</option>
          <option value="new">最新上线</option>
          <option value="platforms">供应商最多</option>
        </select>
      </div>

      {list.length === 0 && data && <div className="empty small-empty">没有符合条件的模型。</div>}
      <div className="model-grid">
        {list.map((m) => {
          const ready = m.offers.some((o) => o.access !== "paid" && owned.has(o.provider));
          return (
            <button key={m.id} className="mcard" onClick={() => setOpen(m)}>
              {isNew(m.created) && <span className="ribbon">New</span>}
              <div className="mcard-head">
                <ModelLogo m={m} size={34} />
                <div className="mcard-title">
                  <b>{m.vendor ? `${m.vendor} / ${m.name}` : m.name}</b>
                  <span>
                    {m.offers.length > 2
                      ? `${m.offers.slice(0, 2).map((o) => pName(o.provider)).join("、")} 等 ${m.offers.length} 个供应商`
                      : m.offers.map((o) => pName(o.provider)).join("、")}
                  </span>
                </div>
              </div>
              <p className="mcard-desc">{m.description || "暂无介绍。"}</p>
              <div className="mtags">
                {ready && <span className="mtag ok">可直接用</span>}
                {modelTags(m).map((t, i) => (
                  <span key={i} className={`mtag ${t.tone ?? ""}`}>
                    {t.text}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>

      {open && (
        <div className="modal" onClick={() => setOpen(null)}>
          <div className="dialog wide" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-head">
              <ModelLogo m={open} size={44} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <h3>{open.name}</h3>
                <p>{open.vendor ?? pName(open.offers[0].provider)}</p>
              </div>
              <button className="btn link" onClick={() => openSubmit({ kind: "correction", target: open.id, title: `${open.name}：` })}>
                纠错
              </button>
              <IconBtn label="关闭" onClick={() => setOpen(null)}>
                <X size={18} />
              </IconBtn>
            </div>
            {open.description && (
              <p className="mdesc">
                {open.description}
                {open.description_source && <span className="muted small">（简介来自 {open.description_source}）</span>}
              </p>
            )}
            <div className="mtags">
              {modelTags(open).map((t, i) => (
                <span key={i} className={`mtag ${t.tone ?? ""}`}>
                  {t.text}
                </span>
              ))}
            </div>
            <dl className="kv">
              {open.context_length && (
                <>
                  <dt>上下文</dt>
                  <dd className="num">{open.context_length.toLocaleString()} tokens</dd>
                </>
              )}
              <dt>输入</dt>
              <dd>{open.input_modalities.map((x) => ({ text: "文本", image: "图片", video: "视频", audio: "音频", file: "文件" })[x] ?? x).join("、")}</dd>
              {open.created && (
                <>
                  <dt>上线时间</dt>
                  <dd className="num">{open.created}</dd>
                </>
              )}
              {open.hugging_face_id && (
                <>
                  <dt>开源权重</dt>
                  <dd>
                    <a onClick={() => api.openUrl(`https://huggingface.co/${open.hugging_face_id}`)}>{open.hugging_face_id}</a>
                  </dd>
                </>
              )}
            </dl>
            <div className="offers">
              <h4>
                提供这个模型的供应商 <span className="muted num">{open.offers.length}</span>
              </h4>
              {open.offers.map((o) => {
                const p = props.catalog?.providers.find((x) => x.id === o.provider);
                const acc = ACCESS[o.access ?? "free"];
                const q = o.access !== "paid" && p?.quotas.length ? quotaShort(pickQuota(p, o.access)) : null;
                return (
                <div className="offer" key={o.provider}>
                  <ProviderLogo id={o.provider} size={30} />
                  <div className="offer-main">
                    <b>
                      {pName(o.provider)} <span className={`mtag ${acc.tone}`}>{acc.text}</span>
                    </b>
                    <code>{o.model}</code>
                    {(q || (o.price && (o.price.input > 0 || o.price.output > 0))) && (
                      <span className="muted small">
                        {[q, o.price && (o.price.input > 0 || o.price.output > 0) ? `标价 ${priceText(o.price)} 每百万 tokens` : null].filter(Boolean).join(" · ")}
                      </span>
                    )}
                  </div>
                  {o.access === "paid" ? null : owned.has(o.provider) ? (
                    <button
                      className="btn"
                      onClick={async () => {
                        await navigator.clipboard.writeText(o.model);
                        props.notify(true, `已复制模型名 ${o.model}`);
                      }}
                    >
                      <Copy size={15} /> 复制模型名
                    </button>
                  ) : (
                    <button
                      className="btn primary"
                      onClick={() => {
                        setOpen(null);
                        props.onOpenProvider();
                      }}
                    >
                      去开通
                    </button>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </>
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
          <p>在“供应商”里一键开通 OpenRouter，或者去供应商注册后粘贴 Key。</p>
          <button className="btn primary" onClick={props.onBrowse}>
            浏览供应商
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
                  <ProviderLogo id={a.provider_id} />
                  <div className="item-title">
                    <div className="name">
                      {a.label}
                      <code className="chip plain">{a.id}</code>
                      {u?.blocked_until && <span className="chip danger">供应商限流到 {new Date(u.blocked_until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>}
                      {!a.enabled && <span className="chip">已停用</span>}
                    </div>
                    <div className="desc">
                      <span className="mono">{a.base_url}</span> · {a.models.length > 0 ? `${a.models.length} 个模型` : "模型列表未获取"}
                      {a.model_suffix ? `（只用 ${a.model_suffix} 结尾的免费模型）` : ""}
                    </div>
                  </div>
                  <div className="meters">
                    {u && u.limits.length > 0 ? u.limits.slice(0, 2).map((l, i) => <Meter key={i} l={l} compact />) : <span className="muted small">按供应商计量</span>}
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
                      <dd className="mono">{a.id}/&lt;供应商上的模型名&gt;</dd>
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
      <PageHead title="用量" sub="在这台电脑上记账，按每个供应商的免费额度限量。" />
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
            <span>被供应商限流</span>
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
                  <ProviderLogo id={u.account_id} size={36} />
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
                  {u.limits.length === 0 && <p className="muted small">这个供应商按积分或余额计量，没法在本机精确计数，以供应商返回为准。</p>}
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
  const model = models[0]?.id ?? "供应商上的模型名";
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
              <CopyRow label="模型名" value={model} hint="直接用供应商上的模型名，见下方列表" notify={props.notify} />
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
              <p className="muted small">羊毛switch 只做转发，不转换格式：Claude 接口的请求只会发给提供原生 Claude 接口的供应商（目前有智谱、硅基流动、AMD Radeon Cloud）。所选模型的供应商没有 Claude 接口时会直接报错，请改用 OpenAI 接口。</p>
            </>
          )}
        </section>

        <section className="panel">
          <h3>
            可用模型 <span className="muted num">{models.length}</span>
          </h3>
          <p className="muted small">
            多个账号都有同一个模型时，按“我的账号”里的顺序使用，前一个到上限或被供应商限流就自动换下一个。想固定用某个账号，模型名写成 <code>账号/模型名</code>。
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
