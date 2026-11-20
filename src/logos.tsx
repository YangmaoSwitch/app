/** Brand logos (public/logos, from LobeHub Icons and Simple Icons). Same mapping as the website. */
import type { SquareModel } from "./api";

const PROVIDER_LOGOS: Record<string, string> = {
  aihubmix: "aihubmix-color", "aliyun-bailian": "bailian-color", "amd-radeon-cloud": "amd", "cloudflare-workers-ai": "workersai-color",
  cohere: "cohere-color", "google-ai-studio": "aistudio", groq: "groq", modelscope: "modelscope-color", "nvidia-nim": "nvidia-color",
  opencode: "opencode", openrouter: "openrouter", siliconflow: "siliconcloud-color", "tencent-hunyuan": "hunyuan-color",
  "volcengine-ark": "volcengine-color", "zhipu-bigmodel": "zhipu-color", qiniu: "qiniu-color",
};
const MODEL_LOGOS: [RegExp, string][] = [
  [/qwen|qwq|qvq|tongyi/, "qwen-color"], [/deepseek/, "deepseek-color"], [/\bglm|zhipu|z\.ai|zai-org|chatglm|cogview/, "zhipu-color"],
  [/kimi|moonshot/, "kimi-color"], [/minimax/, "minimax-color"], [/gemma/, "gemma-color"], [/gemini/, "gemini-color"],
  [/nemotron|nvidia/, "nvidia-color"], [/mimo|xiaomi/, "xiaomimimo"], [/llama|\bmeta\b/, "meta-color"],
  [/mistral|magistral|devstral|codestral/, "mistral-color"], [/\bstep|stepfun/, "stepfun-color"], [/ernie|baidu|paddle/, "wenxin-color"],
  [/hunyuan|tencent|\bhy\d/, "hunyuan-color"], [/doubao|seed|bytedance/, "doubao-color"], [/\bling\b|\bring\b|inclusionai/, "ling-color"],
  [/longcat|meituan/, "longcat-color"], [/intern|shanghai_ai/, "internlm-color"], [/cohere|command|\baya\b|north-/, "cohere-color"],
  [/gpt|openai/, "openai"], [/claude|anthropic/, "anthropic"], [/baai|bge/, "baai"], [/google/, "google-color"],
];

/** Provider id of an account id such as "openrouter" or "openrouter-2". */
const providerOf = (id: string) => (PROVIDER_LOGOS[id] ? id : id.replace(/-\d+$/, ""));

function Logo({ file, size }: { file: string; size: number }) {
  return (
    <div className="avatar logo" style={{ width: size, height: size }} aria-hidden>
      <img src={`/logos/${file}.svg`} alt="" width={size * 0.62} height={size * 0.62} />
    </div>
  );
}

export function ProviderLogo({ id, size = 40 }: { id: string; size?: number }) {
  return <Logo file={PROVIDER_LOGOS[providerOf(id)] ?? "generic"} size={size} />;
}

export function ModelLogo({ m, size = 40 }: { m: SquareModel; size?: number }) {
  const text = `${m.vendor ?? ""} ${m.id} ${m.name}`.toLowerCase();
  return <Logo file={MODEL_LOGOS.find(([r]) => r.test(text))?.[1] ?? "generic"} size={size} />;
}
