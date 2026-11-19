import { useCallback, useEffect, useMemo, useState } from "react";
import { api, Account, AccountUsage, Catalog, OVERAGE, Provider, quotaText, REQUIRES } from "./api";

type Tab = "catalog" | "accounts" | "usage" | "connect";

export default function App() {
  const [tab, setTab] = useState<Tab>("catalog");
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = useCallback(async () => {
    setAccounts(await api.accounts());
  }, []);

  useEffect(() => {
    api.catalog().then(setCatalog).catch((e) => setMsg({ ok: false, text: String(e) }));
    reload();
  }, [reload]);

  const notify = (ok: boolean, text: string) => {
    setMsg({ ok, text });
    window.setTimeout(() => setMsg(null), 6000);
  };

  return (
    <div className="app">
      <header>
        <div className="brand">
          羊毛<span>switch</span>
        </div>
        <nav>
          {(
            [
              ["catalog", "免费额度目录"],
              ["accounts", "我的账号"],
              ["usage", "用量"],
              ["connect", "接入工具"],
            ] as [Tab, string][]
          ).map(([t, label]) => (
            <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </nav>
      </header>
      {msg && <div className={`toast ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}
      <main>
        {tab === "catalog" && (
          <CatalogView
            catalog={catalog}
            accounts={accounts}
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
              notify(true, `已添加账号 ${a.id}，Key 已存入系统钥匙串`);
            }}
            onError={(e) => notify(false, e)}
          />
        )}
        {tab === "accounts" && <AccountsView accounts={accounts} onChange={reload} notify={notify} />}
        {tab === "usage" && <UsageView />}
        {tab === "connect" && <ConnectView accounts={accounts} catalog={catalog} />}
      </main>
    </div>
  );
}

function CatalogView(props: {
  catalog: Catalog | null;
  accounts: Account[];
  onRefresh: () => void;
  onAdded: (a: Account) => void;
  onError: (e: string) => void;
}) {
  const [region, setRegion] = useState<"all" | "global" | "cn">("all");
  const [apiOnly, setApiOnly] = useState(true);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState<Provider | null>(null);

  const list = useMemo(() => {
    const ps = props.catalog?.providers ?? [];
    return ps.filter(
      (p) =>
        (region === "all" || p.region === region) &&
        (!apiOnly || p.api_usable) &&
        (q === "" || `${p.name} ${p.name_zh ?? ""} ${p.summary ?? ""} ${p.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())),
    );
  }, [props.catalog, region, apiOnly, q]);

  if (!props.catalog) return <p className="muted">正在加载目录…</p>;

  return (
    <>
      <div className="toolbar">
        <input placeholder="搜索平台、模型、标签" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={region} onChange={(e) => setRegion(e.target.value as typeof region)}>
          <option value="all">全部地区</option>
          <option value="cn">国内</option>
          <option value="global">海外</option>
        </select>
        <label>
          <input type="checkbox" checked={apiOnly} onChange={(e) => setApiOnly(e.target.checked)} /> 只看能当 API 用的
        </label>
        <span className="muted">
          共 {list.length} 个 · 目录更新于 {props.catalog.generated_at?.slice(0, 10) ?? "—"}
        </span>
        <button onClick={props.onRefresh}>更新目录</button>
      </div>
      <div className="grid">
        {list.map((p) => (
          <ProviderCard
            key={p.id}
            p={p}
            owned={props.accounts.filter((a) => a.provider_id === p.id).length}
            onAdd={() => setAdding(p)}
            onConnected={props.onAdded}
            onError={props.onError}
          />
        ))}
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

function ProviderCard(props: {
  p: Provider;
  owned: number;
  onAdd: () => void;
  onConnected: (a: Account) => void;
  onError: (e: string) => void;
}) {
  const { p } = props;
  const [busy, setBusy] = useState(false);
  const oneClick = p.onboarding.level === "L3" && p.id === "openrouter";
  return (
    <div className="card">
      <div className="card-head">
        <h3>{p.name_zh ?? p.name}</h3>
        <span className={`badge ${p.region}`}>{p.region === "cn" ? "国内" : "海外"}</span>
        {p.status !== "verified" && <span className="badge warn">待核实</span>}
        {props.owned > 0 && <span className="badge ok">已添加 {props.owned}</span>}
      </div>
      {p.summary && <p className="summary">{p.summary}</p>}
      <ul className="quotas">
        {p.quotas.map((q, i) => (
          <li key={i}>
            <a href="#" onClick={(e) => (e.preventDefault(), api.openUrl(q.evidence))} title="官方依据">
              {quotaText(q)}
            </a>
          </li>
        ))}
      </ul>
      <div className="meta">
        <span>注册：{p.signup.requires.map((r) => REQUIRES[r] ?? r).join("、") || "—"}</span>
        <span className={p.overage === "auto_paid" ? "danger" : ""}>超额：{OVERAGE[p.overage]}</span>
        {p.signup.regions_blocked.length > 0 && <span>不支持：{p.signup.regions_blocked.join("、")}</span>}
      </div>
      {p.terms.length > 0 && (
        <ul className="terms">
          {p.terms.map((t, i) => (
            <li key={i}>
              <a href="#" onClick={(e) => (e.preventDefault(), api.openUrl(t.url))}>
                {t.point}
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        {oneClick && (
          <button
            className="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                props.onConnected(await api.connectOpenRouter());
              } catch (e) {
                props.onError(`授权失败：${e}`);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "等待浏览器授权…" : "一键开通"}
          </button>
        )}
        <button onClick={() => api.openUrl(p.signup.url)}>去注册</button>
        {p.onboarding.key_page && <button onClick={() => api.openUrl(p.onboarding.key_page!)}>打开 Key 页</button>}
        {p.api_usable && <button onClick={props.onAdd}>粘贴 Key</button>}
      </div>
      <div className="foot muted">最后核实 {p.last_verified}</div>
    </div>
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
        <h3>添加 {p.name_zh ?? p.name} 的 Key</h3>
        <p className="muted">Key 只保存在本机系统钥匙串里，不会上传。</p>
        <label>
          API Key
          <input type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} />
        </label>
        {mismatch && <p className="warn-text">这个 Key 的格式和 {p.name} 不太一样，确认没有贴错？</p>}
        <label>
          接口地址
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        </label>
        {baseUrl.includes("ACCOUNT_ID") && <p className="warn-text">请把地址里的 ACCOUNT_ID 换成你的账户 ID。</p>}
        {err && <p className="danger">{err}</p>}
        <div className="actions">
          <button onClick={props.onClose}>取消</button>
          <button
            className="primary"
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

function AccountsView(props: { accounts: Account[]; onChange: () => void; notify: (ok: boolean, t: string) => void }) {
  if (props.accounts.length === 0) return <p className="muted">还没有账号。去“免费额度目录”里开通或粘贴 Key。</p>;
  return (
    <table className="table">
      <thead>
        <tr>
          <th>账号</th>
          <th>平台</th>
          <th>接口地址</th>
          <th>额度使用比例</th>
          <th>启用</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {props.accounts.map((a) => (
          <tr key={a.id}>
            <td>
              <code>{a.id}</code>
            </td>
            <td>{a.label}</td>
            <td className="mono small">{a.base_url}</td>
            <td>
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
            </td>
            <td>
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={async (e) => {
                  await api.setEnabled(a.id, e.target.checked);
                  props.onChange();
                }}
              />
            </td>
            <td className="row-actions">
              <button
                onClick={async () => {
                  try {
                    props.notify(true, await api.testAccount(a.id));
                  } catch (e) {
                    props.notify(false, String(e));
                  }
                }}
              >
                测试
              </button>
              <button
                className="danger"
                onClick={async () => {
                  if (!window.confirm(`删除账号 ${a.id}？本机保存的 Key 和用量记录会一起删除。`)) return;
                  await api.removeAccount(a.id);
                  props.onChange();
                }}
              >
                删除
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function UsageView() {
  const [rows, setRows] = useState<AccountUsage[]>([]);
  useEffect(() => {
    const load = () => api.usage().then(setRows);
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, []);
  if (rows.length === 0) return <p className="muted">还没有账号。</p>;
  return (
    <div className="usage">
      {rows.map((u) => (
        <div className="card" key={u.account_id}>
          <div className="card-head">
            <h3>
              <code>{u.account_id}</code> {u.label}
            </h3>
            {!u.enabled && <span className="badge warn">已停用</span>}
            {u.blocked_until && (
              <span className="badge danger">
                暂停到 {new Date(u.blocked_until).toLocaleString()}（{u.blocked_reason}）
              </span>
            )}
          </div>
          <p className="muted">
            近 24 小时：{u.today_requests} 次请求，{u.today_tokens.toLocaleString()} tokens
          </p>
          {u.limits.length === 0 && <p className="muted">这个平台的额度无法在本机计数（如积分、余额），以平台返回为准。</p>}
          {u.limits.map((l, i) => {
            const pct = Math.min(100, (l.used / l.cap) * 100);
            return (
              <div className="bar-row" key={i}>
                <div className="bar-label">
                  {l.label} · 本地上限 {l.cap.toLocaleString()} · 已用 {l.used.toLocaleString()}
                  {l.resets_at && ` · ${new Date(l.resets_at).toLocaleString()} 重置`}
                </div>
                <div className="bar">
                  <div className={`fill ${pct >= 100 ? "full" : pct >= 80 ? "high" : ""}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ConnectView(props: { accounts: Account[]; catalog: Catalog | null }) {
  const [gw, setGw] = useState<{ running: boolean; base_url: string | null } | null>(null);
  useEffect(() => {
    api.gateway().then(setGw);
  }, []);
  const example = props.accounts[0];
  const free = example && props.catalog?.providers.find((p) => p.id === example.provider_id)?.api?.free_models?.[0];
  const model = example ? `${example.id}/${free ?? "<模型名>"}` : "<账号>/<模型名>";
  return (
    <div className="connect">
      <h2>在其他工具里使用</h2>
      <p>
        羊毛switch 在本机运行一个 OpenAI 兼容的入口，只监听 127.0.0.1。它用你自己的 Key 直接请求平台，并在本机记账、按额度限量，不经过任何第三方服务器。
      </p>
      <dl>
        <dt>Base URL</dt>
        <dd>
          <code>{gw?.base_url ?? "未启动"}</code>
        </dd>
        <dt>API Key</dt>
        <dd>任意填写，例如 <code>yangmao</code>（真正的 Key 由本机钥匙串提供）</dd>
        <dt>模型名</dt>
        <dd>
          <code>{model}</code>：斜杠前是“我的账号”里的账号名，后面是平台上的模型名
        </dd>
      </dl>
      <h3>curl 示例</h3>
      <pre>{`curl ${gw?.base_url ?? "http://127.0.0.1:17890/v1"}/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`}</pre>
      <p className="muted">本地上限默认是免费额度的 90%，可在“我的账号”里调整。到达上限时返回 HTTP 429，错误码 local_quota_reached。</p>
    </div>
  );
}
