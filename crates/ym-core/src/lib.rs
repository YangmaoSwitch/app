//! YangmaoSwitch core.
//!
//! * [`catalog`] – types for the public quota catalog.
//! * [`limits`] – turns catalog quotas into enforceable local limits.
//! * [`ledger`] – local SQLite usage ledger.
//! * [`accounts`] – the user's own accounts (keys live in the OS keychain, not here).
//! * [`gateway`] – local OpenAI-compatible gateway that enforces the limits.
//! * [`oauth`] – OAuth PKCE (loopback) helpers.

pub mod accounts;
pub mod anthropic;
pub mod catalog;
pub mod gateway;
pub mod ledger;
pub mod limits;
pub mod oauth;
