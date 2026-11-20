import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { api, AccountStatus, GITHUB_SUBMIT, Submission, SubmissionKind } from "./api";

/** What the dialog is about, when opened from a model or platform. */
export interface SubmitPrefill {
  kind?: SubmissionKind;
  target?: string;
  title?: string;
  pageUrl?: string;
}

const KINDS: [SubmissionKind, string][] = [
  ["correction", "纠错"],
  ["new_provider", "新平台"],
  ["new_model", "新模型或新额度"],
  ["other", "其他"],
];
const STATUS: Record<Submission["status"], string> = { open: "待处理", accepted: "已采纳", rejected: "未采纳", done: "已上线" };
const ERRORS: Record<string, string> = {
  unavailable: "账号系统还在准备中。",
  bad_email: "邮箱格式不对。",
  too_soon: "请稍后再获取验证码。",
  rate_limited: "操作太频繁，请稍后再试。",
  mail_failed: "邮件发送失败，请稍后再试。",
  code_expired: "验证码已失效，请重新获取。",
  code_wrong: "验证码不对。",
  not_signed_in: "请先登录。",
  banned: "这个账号已不能提交。",
  github_failed: "GitHub 登录没有完成。",
  invalid: "请检查填写的内容。",
  network: "连不上服务器，请稍后再试。",
};
const errText = (e: unknown) => ERRORS[String(e)] ?? String(e);
const when = (t: number) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(t * 1000));

export default function SubmitDialog({ prefill, onClose, notify }: { prefill: SubmitPrefill; onClose: () => void; notify: (ok: boolean, text: string) => void }) {
  const [st, setSt] = useState<AccountStatus | null>(null);
  const [tab, setTab] = useState<"new" | "mine">("new");
  useEffect(() => {
    api.accountStatus().then(setSt).catch(() => setSt({ available: false, github: false, user: null }));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const who = st?.user ? st.user.email ?? (st.user.github_login ? `GitHub @${st.user.github_login}` : st.user.name) : "";
  return (
    <div className="modal" onClick={onClose}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="submit-title" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <div style={{ flex: 1, minWidth: 0 }}>
            <h3 id="submit-title">提交 / 纠错</h3>
            <p>提交新平台、新模型，或指出目录里的错误。登录后提交，我们核实后上架或更正。</p>
          </div>
          <button className="icon-btn" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        {st === null && <p className="muted">正在加载…</p>}
        {st && !st.available && (
          <>
            <p>账号系统还在准备中，暂时可以在 GitHub 上提交（需要 GitHub 账号）。</p>
            <div className="dialog-actions">
              <span className="spacer" />
              <button className="btn primary" onClick={() => api.openUrl(GITHUB_SUBMIT)}>
                在 GitHub 上提交
              </button>
            </div>
          </>
        )}
        {st?.available && !st.user && <SignIn github={st.github} onSignedIn={(user) => setSt({ ...st, user })} />}
        {st?.available && st.user && (
          <>
            <div className="signed-in">
              <span className="muted">已登录：{who}</span>
              <button
                className="btn link"
                onClick={async () => {
                  await api.accountLogout();
                  setSt({ ...st, user: null });
                }}
              >
                退出登录
              </button>
            </div>
            <div className="segmented" role="tablist" aria-label="提交">
              <button role="tab" aria-selected={tab === "new"} onClick={() => setTab("new")}>
                新提交
              </button>
              <button role="tab" aria-selected={tab === "mine"} onClick={() => setTab("mine")}>
                我的提交
              </button>
            </div>
            {tab === "new" ? (
              <SubmitForm
                prefill={prefill}
                onDone={() => {
                  notify(true, "已提交，感谢。处理结果会显示在“我的提交”里。");
                  setTab("mine");
                }}
              />
            ) : (
              <Mine />
            )}
          </>
        )}
      </div>
    </div>
  );
}

function SignIn({ github, onSignedIn }: { github: boolean; onSignedIn: (u: NonNullable<AccountStatus["user"]>) => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [wait, setWait] = useState(0);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (wait <= 0) return;
    const t = window.setTimeout(() => setWait(wait - 1), 1000);
    return () => window.clearTimeout(t);
  }, [wait]);
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  return (
    <form
      className="signin"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!/^\d{6}$/.test(code.trim())) return setErr(ERRORS.code_wrong);
        setBusy(true);
        setErr("");
        try {
          onSignedIn(await api.accountVerify(email.trim(), code.trim()));
        } catch (x) {
          setErr(errText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>邮箱</span>
        <div className="row">
          <input type="email" name="email" autoComplete="email" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
          <button
            type="button"
            className="btn"
            disabled={!emailOk || wait > 0}
            onClick={async () => {
              setErr("");
              try {
                const r = await api.accountSendCode(email.trim());
                setWait(r.resend_after ?? 60);
              } catch (x) {
                setErr(errText(x));
              }
            }}
          >
            {wait > 0 ? `${wait} 秒后可重发` : "发送验证码"}
          </button>
        </div>
      </label>
      <label className="field">
        <span>验证码</span>
        <input inputMode="numeric" autoComplete="one-time-code" name="code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="6 位数字" />
      </label>
      {err && <p className="danger-text" role="alert">{err}</p>}
      <div className="dialog-actions">
        {github && (
          <button
            type="button"
            className="btn"
            onClick={async () => {
              setErr("");
              try {
                onSignedIn(await api.accountGithub());
              } catch (x) {
                setErr(errText(x));
              }
            }}
          >
            用 GitHub 登录
          </button>
        )}
        <span className="spacer" />
        <button type="submit" className="btn primary" disabled={busy || !emailOk || code.length !== 6}>
          {busy ? "正在登录…" : "登录"}
        </button>
      </div>
    </form>
  );
}

function SubmitForm({ prefill, onDone }: { prefill: SubmitPrefill; onDone: () => void }) {
  const [kind, setKind] = useState<SubmissionKind>(prefill.kind ?? "correction");
  const [target, setTarget] = useState(prefill.target ?? "");
  const [title, setTitle] = useState(prefill.title ?? "");
  const [body, setBody] = useState("");
  const [evidence, setEvidence] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const evidenceOk = !evidence.trim() || /^https?:\/\/\S+$/.test(evidence.trim());
  return (
    <form
      className="submit-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!evidenceOk) return setErr("官方依据链接要以 http:// 或 https:// 开头。");
        setBusy(true);
        setErr("");
        try {
          await api.submit({
            kind,
            target: target.trim() || null,
            title: title.trim(),
            body: body.trim(),
            evidence_url: evidence.trim() || null,
            page_url: prefill.pageUrl ?? null,
            lang: "zh",
          });
          onDone();
        } catch (x) {
          setErr(errText(x));
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span>类型</span>
        <select className="select" value={kind} onChange={(e) => setKind(e.target.value as SubmissionKind)}>
          {KINDS.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>对象（平台或模型）</span>
        <input className="mono" value={target} maxLength={200} onChange={(e) => setTarget(e.target.value)} placeholder="例如 siliconflow 或 deepseek/deepseek-v4.1-flash" />
      </label>
      <label className="field">
        <span>标题</span>
        <input value={title} maxLength={120} required onChange={(e) => setTitle(e.target.value)} placeholder="一句话说明" />
      </label>
      <label className="field">
        <span>详细说明</span>
        <textarea value={body} maxLength={5000} required rows={5} onChange={(e) => setBody(e.target.value)} placeholder="额度、条件、哪里不对……" />
      </label>
      <label className="field">
        <span>官方依据链接</span>
        <input type="url" className="mono" value={evidence} maxLength={500} onChange={(e) => setEvidence(e.target.value)} placeholder="https://…" />
      </label>
      {err && <p className="danger-text" role="alert">{err}</p>}
      <div className="dialog-actions">
        <span className="spacer" />
        <button type="submit" className="btn primary" disabled={busy || !title.trim() || !body.trim()}>
          {busy ? "正在提交…" : "提交"}
        </button>
      </div>
    </form>
  );
}

function Mine() {
  const [list, setList] = useState<Submission[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api.mySubmissions().then(setList).catch((x) => setErr(errText(x)));
  }, []);
  if (err) return <p className="danger-text">{err}</p>;
  if (!list) return <p className="muted">正在加载…</p>;
  if (list.length === 0) return <p className="muted">还没有提交。</p>;
  return (
    <ul className="mine">
      {list.map((s) => (
        <li key={s.id}>
          <div className="mine-head">
            <b>{s.title}</b>
            <span className={`mtag ${s.status === "done" || s.status === "accepted" ? "ok" : s.status === "open" ? "blue" : ""}`}>{STATUS[s.status]}</span>
          </div>
          <span className="muted small">
            {KINDS.find(([k]) => k === s.kind)?.[1]}
            {s.target ? ` · ${s.target}` : ""} · {when(s.created_at)}
          </span>
          {s.admin_note && <p className="small">回复：{s.admin_note}</p>}
        </li>
      ))}
    </ul>
  );
}
