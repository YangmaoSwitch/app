//! Turn catalog quotas into limits that can be enforced locally.
//!
//! Only `requests` and token units can be counted locally. Other units
//! (points, neurons, money) are left to the provider; the gateway still stops
//! on the provider's 402/429.

use chrono::{DateTime, Datelike, Duration, NaiveTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};

use crate::catalog::Quota;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
    Requests,
    Tokens,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Window {
    /// Sliding window of `seconds`.
    Rolling { seconds: i64 },
    /// Calendar period that resets at `hh:mm` in `tz`.
    Calendar { period: CalendarPeriod, hour: u32, minute: u32, tz: String },
    /// Counted from the moment the account was added.
    OneTime,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CalendarPeriod {
    Day,
    Week,
    Month,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Limit {
    pub unit: Unit,
    /// Cap after the safety margin is applied.
    pub cap: f64,
    /// Original amount from the catalog.
    pub amount: f64,
    pub window: Window,
    pub label: String,
}

impl Window {
    /// Start of the window containing `now`. `since` is used for one-time windows.
    pub fn start(&self, now: DateTime<Utc>, since: DateTime<Utc>) -> DateTime<Utc> {
        match self {
            Window::Rolling { seconds } => now - Duration::seconds(*seconds),
            Window::OneTime => since,
            Window::Calendar { period, hour, minute, tz } => {
                let tz: Tz = tz.parse().unwrap_or(chrono_tz::UTC);
                let local = now.with_timezone(&tz);
                let reset = NaiveTime::from_hms_opt(*hour, *minute, 0).unwrap_or(NaiveTime::MIN);
                let mut date = local.date_naive();
                if local.time() < reset {
                    date = date.pred_opt().unwrap_or(date);
                }
                let date = match period {
                    CalendarPeriod::Day => date,
                    CalendarPeriod::Week => date - Duration::days(date.weekday().num_days_from_monday() as i64),
                    CalendarPeriod::Month => date.with_day(1).unwrap_or(date),
                };
                tz.from_local_datetime(&date.and_time(reset))
                    .earliest()
                    .map(|d| d.with_timezone(&Utc))
                    .unwrap_or(now)
            }
        }
    }

    /// When the window containing `now` ends (None for one-time windows).
    pub fn next_reset(&self, now: DateTime<Utc>, since: DateTime<Utc>) -> Option<DateTime<Utc>> {
        match self {
            Window::Rolling { .. } => None,
            Window::OneTime => None,
            Window::Calendar { period, tz, .. } => {
                let start = self.start(now, since);
                let tz: Tz = tz.parse().unwrap_or(chrono_tz::UTC);
                let local = start.with_timezone(&tz);
                let next = match period {
                    CalendarPeriod::Day => local + Duration::days(1),
                    CalendarPeriod::Week => local + Duration::days(7),
                    CalendarPeriod::Month => {
                        let (y, m) = if local.month() == 12 { (local.year() + 1, 1) } else { (local.year(), local.month() + 1) };
                        tz.with_ymd_and_hms(y, m, 1, local.hour_of(), local.minute_of(), 0).earliest()?
                    }
                };
                Some(next.with_timezone(&Utc))
            }
        }
    }
}

trait HourMinute {
    fn hour_of(&self) -> u32;
    fn minute_of(&self) -> u32;
}

impl<T: chrono::Timelike> HourMinute for T {
    fn hour_of(&self) -> u32 {
        self.hour()
    }
    fn minute_of(&self) -> u32 {
        self.minute()
    }
}

/// Parse `"00:00 UTC"`, `"08:00 Asia/Shanghai"` or `"rolling"`.
fn parse_reset(reset: Option<&str>) -> Option<(u32, u32, String)> {
    let r = reset?.trim();
    if r.eq_ignore_ascii_case("rolling") {
        return None;
    }
    let (time, tz) = r.split_once(' ').unwrap_or((r, "UTC"));
    let (h, m) = time.split_once(':')?;
    Some((h.parse().ok()?, m.parse().ok()?, tz.trim().to_string()))
}

fn window_for(q: &Quota) -> Option<Window> {
    let rolling = |s: i64| Some(Window::Rolling { seconds: s });
    let reset = parse_reset(q.reset.as_deref());
    let is_rolling = q.reset.as_deref().map(|r| r.eq_ignore_ascii_case("rolling")).unwrap_or(false);
    match q.period.as_str() {
        "second" => rolling(1),
        "minute" => rolling(60),
        "hour" => rolling(3600),
        "one-time" => Some(Window::OneTime),
        p @ ("day" | "week" | "month") => {
            let secs = match p {
                "day" => 86_400,
                "week" => 7 * 86_400,
                _ => 30 * 86_400,
            };
            if is_rolling {
                return rolling(secs);
            }
            let (hour, minute, tz) = reset.unwrap_or((0, 0, "UTC".into()));
            let period = match p {
                "day" => CalendarPeriod::Day,
                "week" => CalendarPeriod::Week,
                _ => CalendarPeriod::Month,
            };
            Some(Window::Calendar { period, hour, minute, tz })
        }
        _ => None,
    }
}

fn unit_for(q: &Quota) -> Option<Unit> {
    match q.unit.as_str() {
        "requests" => Some(Unit::Requests),
        "tokens" | "input_tokens" | "output_tokens" => Some(Unit::Tokens),
        _ => None,
    }
}

/// Derive enforceable limits. When several quotas share unit and window
/// (e.g. different tiers behind a `condition`), the smallest one wins.
/// `margin` is the fraction of the free quota we allow ourselves to use (0..=1).
pub fn derive(quotas: &[Quota], margin: f64) -> Vec<Limit> {
    let margin = margin.clamp(0.05, 1.0);
    let mut out: Vec<Limit> = Vec::new();
    for q in quotas {
        let (Some(unit), Some(window), Some(amount)) = (unit_for(q), window_for(q), q.amount) else {
            continue;
        };
        if amount <= 0.0 {
            continue;
        }
        // At least one request must stay usable, so for very small amounts (e.g. 1) the margin cannot apply;
        // the label says so instead of pretending a safety margin exists.
        let cap = (amount * margin).floor().max(1.0);
        let mut label = format!("{} {} / {}", amount, q.unit, q.period);
        if margin < 1.0 && cap >= amount {
            label.push_str("（数量太小，按全额限量）");
        }
        if let Some(existing) = out.iter_mut().find(|l| l.unit == unit && l.window == window) {
            if amount < existing.amount {
                *existing = Limit { unit, cap, amount, window, label };
            }
        } else {
            out.push(Limit { unit, cap, amount, window, label });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn q(unit: &str, amount: f64, period: &str, reset: Option<&str>) -> Quota {
        Quota {
            unit: unit.into(),
            amount: Some(amount),
            period: period.into(),
            reset: reset.map(Into::into),
            scope: "account".into(),
            models: None,
            condition: None,
            expires_days: None,
            note: None,
            evidence: "https://example.com".into(),
        }
    }

    #[test]
    fn smallest_tier_wins_and_margin_applies() {
        let limits = derive(
            &[
                q("requests", 20.0, "minute", Some("rolling")),
                q("requests", 50.0, "day", Some("00:00 UTC")),
                q("requests", 1000.0, "day", Some("00:00 UTC")),
                q("points", 5.0, "day", None),
            ],
            0.9,
        );
        assert_eq!(limits.len(), 2);
        let day = limits.iter().find(|l| matches!(l.window, Window::Calendar { .. })).unwrap();
        assert_eq!(day.amount, 50.0);
        assert_eq!(day.cap, 45.0);
    }

    #[test]
    fn tiny_amount_is_labelled() {
        let l = derive(&[q("requests", 1.0, "one-time", None)], 0.9);
        assert_eq!(l[0].cap, 1.0);
        assert!(l[0].label.contains("按全额"));
        let l = derive(&[q("requests", 10.0, "day", None)], 0.9);
        assert_eq!(l[0].cap, 9.0);
        assert!(!l[0].label.contains("按全额"));
    }

    #[test]
    fn calendar_window_respects_timezone() {
        let w = Window::Calendar { period: CalendarPeriod::Day, hour: 0, minute: 0, tz: "Asia/Shanghai".into() };
        // 2026-11-19 15:30 UTC is 23:30 in Shanghai; the day started at 16:00 UTC the previous day.
        let now = Utc.with_ymd_and_hms(2026, 11, 19, 15, 30, 0).unwrap();
        assert_eq!(w.start(now, now), Utc.with_ymd_and_hms(2026, 11, 18, 16, 0, 0).unwrap());
        assert_eq!(w.next_reset(now, now), Some(Utc.with_ymd_and_hms(2026, 11, 19, 16, 0, 0).unwrap()));
        // 16:30 UTC is already the next Shanghai day.
        let later = Utc.with_ymd_and_hms(2026, 11, 19, 16, 30, 0).unwrap();
        assert_eq!(w.start(later, later), Utc.with_ymd_and_hms(2026, 11, 19, 16, 0, 0).unwrap());
    }

    #[test]
    fn pacific_reset() {
        let w = Window::Calendar { period: CalendarPeriod::Day, hour: 0, minute: 0, tz: "America/Los_Angeles".into() };
        let now = Utc.with_ymd_and_hms(2026, 11, 19, 7, 0, 0).unwrap(); // 23:00 PST on the 18th
        assert_eq!(w.start(now, now), Utc.with_ymd_and_hms(2026, 11, 18, 8, 0, 0).unwrap());
    }

    #[test]
    fn month_window() {
        let w = Window::Calendar { period: CalendarPeriod::Month, hour: 0, minute: 0, tz: "UTC".into() };
        let now = Utc.with_ymd_and_hms(2026, 12, 19, 7, 0, 0).unwrap();
        assert_eq!(w.start(now, now), Utc.with_ymd_and_hms(2026, 12, 1, 0, 0, 0).unwrap());
        assert_eq!(w.next_reset(now, now), Some(Utc.with_ymd_and_hms(2027, 1, 1, 0, 0, 0).unwrap()));
    }
}
