//! Model routes from the model square data (`models.json`): which provider serves
//! which model under which id, and how good the model is. Used by the gateway for
//! `model: "auto"` (best free model first) and for model names that several
//! providers serve under different ids.

use serde_json::Value;

/// Model name that lets the gateway pick the model.
pub const AUTO: &str = "auto";

#[derive(Debug, Clone)]
pub struct Offer {
    pub provider: String,
    /// Model id on that provider.
    pub model: String,
    /// `free` (no quota) rather than `quota` (free allowance).
    pub free: bool,
}

#[derive(Debug, Clone)]
pub struct Route {
    /// Canonical id, e.g. `deepseek/deepseek-v4.1-flash`.
    pub id: String,
    pub name: String,
    pub quality: f64,
    pub tools: bool,
    pub vision: bool,
    /// Free and free-allowance offers only; paid offers are never routed to.
    pub offers: Vec<Offer>,
}

impl Route {
    /// Whether a requested model name refers to this model.
    pub fn matches(&self, name: &str) -> bool {
        let n = name.trim().to_ascii_lowercase();
        n == self.id.to_ascii_lowercase()
            || n == self.name.to_ascii_lowercase()
            || self.id.rsplit('/').next().is_some_and(|s| s.eq_ignore_ascii_case(&n))
            || self.offers.iter().any(|o| o.model.eq_ignore_ascii_case(&n))
    }
}

/// Routes with at least one free offer, best quality first.
pub fn parse(v: &Value) -> Vec<Route> {
    let mut out: Vec<Route> = v
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let mut offers: Vec<Offer> = m
                .get("offers")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|o| {
                    let access = o.get("access").and_then(Value::as_str)?;
                    if access != "free" && access != "quota" {
                        return None;
                    }
                    Some(Offer {
                        provider: o.get("provider")?.as_str()?.to_string(),
                        model: o.get("model")?.as_str()?.to_string(),
                        free: access == "free",
                    })
                })
                .collect();
            if offers.is_empty() {
                return None;
            }
            // Unlimited free offers before free allowances.
            offers.sort_by_key(|o| !o.free);
            let id = m.get("id")?.as_str()?.to_string();
            Some(Route {
                name: m.get("name").and_then(Value::as_str).unwrap_or(&id).to_string(),
                id,
                quality: m.get("quality").and_then(Value::as_f64).unwrap_or(0.0),
                tools: m.get("tools").and_then(Value::as_bool).unwrap_or(false),
                vision: m
                    .get("input_modalities")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.iter().any(|x| x.as_str() == Some("image"))),
                offers,
            })
        })
        .collect();
    out.sort_by(|a, b| b.quality.partial_cmp(&a.quality).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// What a request needs from the model.
#[derive(Debug, Clone, Copy, Default)]
pub struct Needs {
    pub tools: bool,
    pub vision: bool,
}

impl Needs {
    /// Read from an OpenAI- or Claude-format request body.
    pub fn of(req: &Value) -> Self {
        let tools = req.get("tools").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
        let vision = req.get("messages").and_then(Value::as_array).is_some_and(|msgs| {
            msgs.iter().any(|m| {
                m.get("content").and_then(Value::as_array).is_some_and(|parts| {
                    parts.iter().any(|p| matches!(p.get("type").and_then(Value::as_str), Some("image_url" | "image" | "input_image")))
                })
            })
        });
        Self { tools, vision }
    }

    pub fn met_by(&self, r: &Route) -> bool {
        (!self.tools || r.tools) && (!self.vision || r.vision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_free_offers_by_quality() {
        let v = json!({"models": [
            {"id": "a/low", "name": "Low", "quality": 10, "tools": true, "input_modalities": ["text"],
             "offers": [{"provider": "p", "model": "low", "access": "free"}]},
            {"id": "a/paid", "name": "Paid", "quality": 99, "offers": [{"provider": "p", "model": "paid", "access": "paid"}]},
            {"id": "a/high", "name": "High", "quality": 80, "input_modalities": ["text", "image"],
             "offers": [{"provider": "q", "model": "high-x", "access": "quota"}, {"provider": "p", "model": "high", "access": "free"}]}
        ]});
        let r = parse(&v);
        assert_eq!(r.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["a/high", "a/low"]);
        assert_eq!(r[0].offers[0].provider, "p"); // free before quota
        assert!(r[0].matches("High") && r[0].matches("high-x") && r[0].matches("A/HIGH") && !r[0].matches("low"));
        let needs = Needs::of(&json!({"tools": [{}], "messages": []}));
        assert!(!needs.met_by(&r[0]) && needs.met_by(&r[1]));
        let needs = Needs::of(&json!({"messages": [{"role": "user", "content": [{"type": "image_url"}]}]}));
        assert!(needs.met_by(&r[0]) && !needs.met_by(&r[1]));
    }
}
