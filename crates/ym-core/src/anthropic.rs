//! Anthropic Messages <-> OpenAI Chat Completions conversion, used when the
//! upstream only speaks the OpenAI protocol.

use std::collections::HashMap;

use serde_json::{json, Map, Value};

fn text_of(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::String(s) => vec![json!({"type": "text", "text": s})],
        Value::Array(a) => a.clone(),
        _ => vec![],
    }
}

/// Anthropic `/v1/messages` request -> OpenAI `/chat/completions` request.
pub fn request_to_openai(req: &Value, model: &str) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(system) = req.get("system") {
        let s = text_of(system);
        if !s.is_empty() {
            messages.push(json!({"role": "system", "content": s}));
        }
    }
    for m in req.get("messages").and_then(Value::as_array).cloned().unwrap_or_default() {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("user");
        let content = m.get("content").cloned().unwrap_or(Value::Null);
        if role == "assistant" {
            let mut text = String::new();
            let mut calls = Vec::new();
            for b in blocks(&content) {
                match b.get("type").and_then(Value::as_str) {
                    Some("text") => text.push_str(b.get("text").and_then(Value::as_str).unwrap_or("")),
                    Some("tool_use") => calls.push(json!({
                        "id": b.get("id").cloned().unwrap_or(Value::Null),
                        "type": "function",
                        "function": {
                            "name": b.get("name").cloned().unwrap_or(Value::Null),
                            "arguments": b.get("input").map(|i| i.to_string()).unwrap_or_else(|| "{}".into()),
                        }
                    })),
                    _ => {}
                }
            }
            let mut msg = json!({"role": "assistant", "content": if text.is_empty() && !calls.is_empty() { Value::Null } else { Value::String(text) }});
            if !calls.is_empty() {
                msg["tool_calls"] = Value::Array(calls);
            }
            messages.push(msg);
        } else {
            let mut parts = Vec::new();
            for b in blocks(&content) {
                match b.get("type").and_then(Value::as_str) {
                    Some("tool_result") => messages.push(json!({
                        "role": "tool",
                        "tool_call_id": b.get("tool_use_id").cloned().unwrap_or(Value::Null),
                        "content": text_of(b.get("content").unwrap_or(&Value::Null)),
                    })),
                    Some("text") => parts.push(json!({"type": "text", "text": b.get("text").cloned().unwrap_or(Value::Null)})),
                    Some("image") => {
                        let src = b.get("source").cloned().unwrap_or(Value::Null);
                        let url = match src.get("type").and_then(Value::as_str) {
                            Some("base64") => format!(
                                "data:{};base64,{}",
                                src.get("media_type").and_then(Value::as_str).unwrap_or("image/png"),
                                src.get("data").and_then(Value::as_str).unwrap_or("")
                            ),
                            _ => src.get("url").and_then(Value::as_str).unwrap_or("").to_string(),
                        };
                        parts.push(json!({"type": "image_url", "image_url": {"url": url}}));
                    }
                    _ => {}
                }
            }
            if !parts.is_empty() {
                let content = if parts.iter().all(|p| p["type"] == "text") {
                    Value::String(parts.iter().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("\n"))
                } else {
                    Value::Array(parts)
                };
                messages.push(json!({"role": "user", "content": content}));
            }
        }
    }

    let mut out = Map::new();
    out.insert("model".into(), json!(model));
    out.insert("messages".into(), Value::Array(messages));
    for (from, to) in [("max_tokens", "max_tokens"), ("temperature", "temperature"), ("top_p", "top_p"), ("stop_sequences", "stop")] {
        if let Some(v) = req.get(from) {
            out.insert(to.into(), v.clone());
        }
    }
    if req.get("stream").and_then(Value::as_bool) == Some(true) {
        out.insert("stream".into(), json!(true));
        out.insert("stream_options".into(), json!({"include_usage": true}));
    }
    if let Some(tools) = req.get("tools").and_then(Value::as_array) {
        let tools: Vec<Value> = tools
            .iter()
            .filter(|t| t.get("input_schema").is_some())
            .map(|t| {
                json!({"type": "function", "function": {
                    "name": t.get("name"),
                    "description": t.get("description").cloned().unwrap_or(json!("")),
                    "parameters": t.get("input_schema"),
                }})
            })
            .collect();
        if !tools.is_empty() {
            out.insert("tools".into(), Value::Array(tools));
        }
    }
    if let Some(tc) = req.get("tool_choice") {
        let v = match tc.get("type").and_then(Value::as_str) {
            Some("any") => json!("required"),
            Some("none") => json!("none"),
            Some("tool") => json!({"type": "function", "function": {"name": tc.get("name")}}),
            _ => json!("auto"),
        };
        out.insert("tool_choice".into(), v);
    }
    Value::Object(out)
}

fn stop_reason(finish: Option<&str>) -> &'static str {
    match finish {
        Some("length") => "max_tokens",
        Some("tool_calls") | Some("function_call") => "tool_use",
        _ => "end_turn",
    }
}

/// OpenAI chat completion response -> Anthropic message.
pub fn response_from_openai(resp: &Value, model: &str) -> Value {
    let choice = resp.pointer("/choices/0").cloned().unwrap_or(Value::Null);
    let msg = choice.get("message").cloned().unwrap_or(Value::Null);
    let mut content = Vec::new();
    let text = text_of(msg.get("content").unwrap_or(&Value::Null));
    if !text.is_empty() {
        content.push(json!({"type": "text", "text": text}));
    }
    for c in msg.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default() {
        let args = c.pointer("/function/arguments").and_then(Value::as_str).unwrap_or("{}");
        content.push(json!({
            "type": "tool_use",
            "id": c.get("id").cloned().unwrap_or(json!("toolu_0")),
            "name": c.pointer("/function/name").cloned().unwrap_or(Value::Null),
            "input": serde_json::from_str::<Value>(args).unwrap_or(json!({})),
        }));
    }
    json!({
        "id": format!("msg_{}", resp.get("id").and_then(Value::as_str).unwrap_or("yangmao")),
        "type": "message",
        "role": "assistant",
        "model": model,
        "content": content,
        "stop_reason": stop_reason(choice.get("finish_reason").and_then(Value::as_str)),
        "stop_sequence": null,
        "usage": {
            "input_tokens": resp.pointer("/usage/prompt_tokens").and_then(Value::as_u64).unwrap_or(0),
            "output_tokens": resp.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(0),
        }
    })
}

fn event(kind: &str, data: Value) -> String {
    format!("event: {kind}\ndata: {data}\n\n")
}

/// Converts an OpenAI chat-completion SSE stream into Anthropic SSE events.
pub struct StreamConverter {
    model: String,
    id: String,
    started: bool,
    open: Option<(usize, bool)>, // (block index, is_text)
    next: usize,
    tools: HashMap<u64, usize>,
    stop: Option<String>,
    pub input_tokens: u64,
    pub output_tokens: u64,
}

impl StreamConverter {
    pub fn new(model: &str) -> Self {
        Self { model: model.into(), id: "msg_yangmao".into(), started: false, open: None, next: 0, tools: HashMap::new(), stop: None, input_tokens: 0, output_tokens: 0 }
    }

    fn start(&mut self, out: &mut Vec<String>) {
        if !self.started {
            self.started = true;
            out.push(event(
                "message_start",
                json!({"type": "message_start", "message": {"id": self.id, "type": "message", "role": "assistant", "model": self.model,
                    "content": [], "stop_reason": null, "stop_sequence": null, "usage": {"input_tokens": 0, "output_tokens": 0}}}),
            ));
        }
    }

    fn close(&mut self, out: &mut Vec<String>) {
        if let Some((i, _)) = self.open.take() {
            out.push(event("content_block_stop", json!({"type": "content_block_stop", "index": i})));
        }
    }

    /// Feed one parsed OpenAI chunk.
    pub fn feed(&mut self, chunk: &Value) -> Vec<String> {
        let mut out = Vec::new();
        if let Some(id) = chunk.get("id").and_then(Value::as_str) {
            if !self.started {
                self.id = format!("msg_{id}");
            }
        }
        self.start(&mut out);
        if let Some(u) = chunk.get("usage").filter(|u| !u.is_null()) {
            self.input_tokens = u.get("prompt_tokens").and_then(Value::as_u64).unwrap_or(self.input_tokens);
            self.output_tokens = u.get("completion_tokens").and_then(Value::as_u64).unwrap_or(self.output_tokens);
        }
        let Some(choice) = chunk.pointer("/choices/0") else { return out };
        let delta = choice.get("delta").cloned().unwrap_or(Value::Null);
        if let Some(t) = delta.get("content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            if !matches!(self.open, Some((_, true))) {
                self.close(&mut out);
                let i = self.next;
                self.next += 1;
                self.open = Some((i, true));
                out.push(event("content_block_start", json!({"type": "content_block_start", "index": i, "content_block": {"type": "text", "text": ""}})));
            }
            let i = self.open.unwrap().0;
            out.push(event("content_block_delta", json!({"type": "content_block_delta", "index": i, "delta": {"type": "text_delta", "text": t}})));
        }
        for tc in delta.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default() {
            let idx = tc.get("index").and_then(Value::as_u64).unwrap_or(0);
            let block = match self.tools.get(&idx) {
                Some(b) => *b,
                None => {
                    self.close(&mut out);
                    let i = self.next;
                    self.next += 1;
                    self.tools.insert(idx, i);
                    self.open = Some((i, false));
                    out.push(event(
                        "content_block_start",
                        json!({"type": "content_block_start", "index": i, "content_block": {"type": "tool_use",
                            "id": tc.get("id").cloned().unwrap_or(json!(format!("toolu_{idx}"))),
                            "name": tc.pointer("/function/name").cloned().unwrap_or(json!("")), "input": {}}}),
                    ));
                    i
                }
            };
            if let Some(args) = tc.pointer("/function/arguments").and_then(Value::as_str).filter(|a| !a.is_empty()) {
                out.push(event("content_block_delta", json!({"type": "content_block_delta", "index": block, "delta": {"type": "input_json_delta", "partial_json": args}})));
            }
        }
        if let Some(f) = choice.get("finish_reason").and_then(Value::as_str) {
            self.stop = Some(stop_reason(Some(f)).into());
        }
        out
    }

    pub fn finish(&mut self) -> Vec<String> {
        let mut out = Vec::new();
        self.start(&mut out);
        self.close(&mut out);
        out.push(event(
            "message_delta",
            json!({"type": "message_delta", "delta": {"stop_reason": self.stop.clone().unwrap_or_else(|| "end_turn".into()), "stop_sequence": null},
                "usage": {"input_tokens": self.input_tokens, "output_tokens": self.output_tokens}}),
        ));
        out.push(event("message_stop", json!({"type": "message_stop"})));
        out
    }
}

/// Rough token estimate for `/v1/messages/count_tokens`.
pub fn estimate_tokens(req: &Value) -> u64 {
    let mut n = 0usize;
    for k in ["system", "messages", "tools"] {
        if let Some(v) = req.get(k) {
            n += v.to_string().chars().count();
        }
    }
    (n as u64 / 3).max(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_request_with_tools() {
        let req = json!({
            "model": "m", "max_tokens": 100, "system": [{"type": "text", "text": "sys"}], "stream": true,
            "tools": [{"name": "get", "description": "d", "input_schema": {"type": "object"}}],
            "messages": [
                {"role": "user", "content": "hi"},
                {"role": "assistant", "content": [{"type": "text", "text": "ok"}, {"type": "tool_use", "id": "t1", "name": "get", "input": {"a": 1}}]},
                {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "t1", "content": [{"type": "text", "text": "42"}]}]}
            ]
        });
        let o = request_to_openai(&req, "up");
        assert_eq!(o["model"], "up");
        assert_eq!(o["messages"][0]["role"], "system");
        assert_eq!(o["messages"][2]["tool_calls"][0]["function"]["arguments"], "{\"a\":1}");
        assert_eq!(o["messages"][3]["role"], "tool");
        assert_eq!(o["messages"][3]["content"], "42");
        assert_eq!(o["tools"][0]["function"]["name"], "get");
        assert_eq!(o["stream_options"]["include_usage"], true);
    }

    #[test]
    fn converts_response() {
        let r = json!({"id": "x", "choices": [{"finish_reason": "tool_calls", "message": {"content": "a",
            "tool_calls": [{"id": "c", "function": {"name": "f", "arguments": "{\"q\":2}"}}]}}], "usage": {"prompt_tokens": 3, "completion_tokens": 4}});
        let m = response_from_openai(&r, "m");
        assert_eq!(m["stop_reason"], "tool_use");
        assert_eq!(m["content"][1]["input"]["q"], 2);
        assert_eq!(m["usage"]["output_tokens"], 4);
    }

    #[test]
    fn converts_stream() {
        let mut c = StreamConverter::new("m");
        let mut all = Vec::new();
        all.extend(c.feed(&json!({"id": "1", "choices": [{"delta": {"content": "he"}}]})));
        all.extend(c.feed(&json!({"choices": [{"delta": {"content": "llo"}}]})));
        all.extend(c.feed(&json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "t", "function": {"name": "f", "arguments": "{\"a\""}}]}}]})));
        all.extend(c.feed(&json!({"choices": [{"delta": {"tool_calls": [{"index": 0, "function": {"arguments": ":1}"}}]}, "finish_reason": "tool_calls"}]})));
        all.extend(c.feed(&json!({"choices": [], "usage": {"prompt_tokens": 5, "completion_tokens": 6}})));
        all.extend(c.finish());
        let s = all.join("");
        assert!(s.starts_with("event: message_start"));
        assert_eq!(s.matches("event: content_block_start").count(), 2);
        assert_eq!(s.matches("event: content_block_stop").count(), 2);
        assert!(s.contains("\"stop_reason\":\"tool_use\""));
        assert!(s.contains("\"output_tokens\":6"));
        assert!(s.trim_end().ends_with("{\"type\":\"message_stop\"}"));
    }
}
