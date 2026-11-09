//! Parse one OpenAI Codex rollout log into the index's normalized shape.
//!
//! Mirrors `packages/sessions/src/codex.ts` rule for rule, because the two engines write one index
//! and a search must not rank the same question differently depending on which one built it. A
//! Codex log is zstd JSONL whose lines are *envelopes* (`{ timestamp, ordinal, type, payload }`)
//! rather than the flat events DSH writes, so the DSH parser cannot read one — but what gets
//! indexed is deliberately the same: the human's own text, the model's visible reply, and tool
//! invocations.
//!
//! Three Codex-specific rules are load-bearing and none of them is optional:
//!
//! - `session_meta` is the conversation's identity (`session_id`, `cwd`, `timestamp`,
//!   `originator`); without it the id falls back to the rollout filename's uuid.
//! - `developer` messages carry Codex's entire instruction set. Indexing them would make the
//!   system prompt the best-matching document in the corpus.
//! - `user` messages are not always a human: Codex ships `<environment_context>…` and friends
//!   through the same role, so those blocks are stripped and a message that reduces to nothing is
//!   dropped rather than stored as an empty question.
//!
//! A rollout carries no title. Codex records thread names in `~/.codex/session_index.jsonl`; the run
//! reads that once and passes the map in, so this module stays a pure function of its bytes.
//!
//! ## Timestamps
//!
//! The envelope's `timestamp` is ISO-8601 (`2026-03-27T01:58:23.430Z`). This build has no date
//! crate, so [`parse_iso_millis`] implements the shape the corpus actually uses — verified across
//! 96 746 envelopes on this machine, one shape only — plus a numeric offset, which `Date.parse` on
//! the TypeScript side would also accept. An unparseable timestamp is simply absent, exactly as
//! `Number.isFinite(Date.parse(…))` treats it.

use std::path::Path;

use serde_json::Value;

use crate::decode::decompress_session_log;
use crate::parse::{clip_text, number_field, parse_record, push_entry, string_field, ParseLimits, ParsedEntry, ParsedSession};

/// Injected-context blocks Codex ships through the `user` role, as (opening, closing) tag pairs.
///
/// Stripped rather than skipped wholesale: one record can legitimately carry an environment block
/// *and* the question that followed it, and dropping the whole record would lose the question. The
/// list is deliberately short and literal — a tag this module does not know stays in the text,
/// which is a better failure than deleting text that turned out to be the user's own.
const INJECTED_BLOCKS: [(&str, &str); 4] = [
    ("<environment_context>", "</environment_context>"),
    ("<user_instructions>", "</user_instructions>"),
    ("<permissions instructions>", "</permissions instructions>"),
    ("<turn_aborted>", "</turn_aborted>"),
];

/// Parse one rollout log from its raw compressed bytes.
///
/// `Err` carries a decompression failure, for the same reason [`crate::parse::parse_session_log`]
/// returns one: a corrupt or foreign file must be reported in the run's `failed` list, never
/// indexed as a silently empty conversation.
pub fn parse_codex_log(
    buffer: &[u8],
    fallback_id: &str,
    limits: &ParseLimits,
    titles: &std::collections::HashMap<String, String>,
) -> Result<ParsedSession, String> {
    let raw = decompress_session_log(buffer)?;
    // Node's `Buffer.toString('utf8')` replaces an ill-formed sequence with U+FFFD; lossy
    // conversion is the same policy, and a real rollout is valid UTF-8 anyway.
    Ok(parse_codex_lines(&String::from_utf8_lossy(&raw), fallback_id, limits, titles))
}

/// Parse the decompressed JSONL lines of one rollout log.
pub fn parse_codex_lines(
    text: &str,
    fallback_id: &str,
    limits: &ParseLimits,
    titles: &std::collections::HashMap<String, String>,
) -> ParsedSession {
    let mut meta: Option<Value> = None;
    let mut model: Option<String> = None;
    let mut turn_seq = 0i64;
    let mut last_turn_id: Option<String> = None;
    let mut last_at = 0i64;
    let mut first_at: Option<i64> = None;
    let mut entries: Vec<ParsedEntry> = Vec::new();

    for line in text.split('\n') {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(record) = parse_record(line) else {
            continue;
        };

        let time = time_field(&record);
        if let Some(time) = time {
            // Earliest wins rather than first-seen: a rollout is normally monotonic, but the envelope
            // on a `session_meta` line carries its own timestamp that can precede the first real
            // event, and a session's start is the earliest instant any line names.
            if first_at.is_none_or(|first| time < first) {
                first_at = Some(time);
            }
            if time > last_at {
                last_at = time;
            }
        }
        let seq = number_field(&record, "ordinal").unwrap_or(0);
        let payload = record.get("payload").filter(|value| value.is_object());

        match string_field(&record, "type").unwrap_or("") {
            "session_meta" => meta = payload.cloned(),
            "turn_context" => {
                let Some(payload) = payload else {
                    continue;
                };
                let turn_id = string_field(payload, "turn_id");
                if let Some(turn_id) = turn_id {
                    if last_turn_id.as_deref() != Some(turn_id) {
                        turn_seq += 1;
                        last_turn_id = Some(turn_id.to_owned());
                    }
                }
                if model.is_none() {
                    model = string_field(payload, "model").map(str::to_owned);
                }
            }
            "response_item" => collect_response_item(
                &mut entries,
                payload,
                seq,
                time.unwrap_or(last_at),
                turn_seq,
                limits,
            ),
            // `event_msg` (token counts, task bookkeeping), `compacted` (a handoff summary another
            // model wrote) and anything a newer Codex adds are not the user's conversation.
            _ => {}
        }
    }

    let created_at = match &meta {
        None => first_at.unwrap_or(0),
        Some(meta) => time_field(meta).or(first_at).unwrap_or(0),
    };
    let id = meta
        .as_ref()
        .and_then(|meta| string_field(meta, "session_id"))
        .unwrap_or(fallback_id)
        .to_owned();
    let title = titles
        .get(&id)
        .map(|title| title.trim())
        .filter(|title| !title.is_empty())
        .map(str::to_owned);
    if let Some(title) = &title {
        let (text, clipped) = clip_text(title, limits.max_entry_chars);
        entries.push(ParsedEntry {
            seq: 0,
            time: last_at,
            turn: None,
            kind: "title",
            text,
            clipped,
        });
    }

    ParsedSession {
        id,
        cwd: meta
            .as_ref()
            .and_then(|meta| string_field(meta, "cwd"))
            .unwrap_or_default()
            .to_owned(),
        created_at,
        last_at: last_at.max(created_at),
        title,
        parent_session: None,
        // Codex records what launched it (`Codex Desktop`, `codex_cli_rs`) rather than a DSH-style
        // origin label; keeping the raw value is what lets a caller tell an IDE session from a CLI one.
        origin: meta
            .as_ref()
            .and_then(|meta| string_field(meta, "originator"))
            .map(str::to_owned),
        // Codex has no agent presets. The model each turn ran on is the closest equivalent and is
        // what a caller filtering by "which model was this conversation with" actually needs.
        agent_preset: model,
        turns: turn_seq,
        entries,
    }
}

/// Lift one `response_item` envelope into entries.
fn collect_response_item(
    entries: &mut Vec<ParsedEntry>,
    payload: Option<&Value>,
    seq: i64,
    time: i64,
    turn: i64,
    limits: &ParseLimits,
) {
    let Some(payload) = payload else {
        return;
    };
    match string_field(payload, "type").unwrap_or("") {
        "message" => {
            let role = string_field(payload, "role").unwrap_or("");
            // The instruction set and the environment block arrive as messages: see the module note.
            if role == "developer" {
                return;
            }
            let text = message_text(payload.get("content"));
            if role == "user" {
                let clean = strip_injected(&text);
                if clean.is_empty() {
                    return;
                }
                push_entry(
                    entries,
                    "user",
                    clean,
                    seq,
                    time,
                    Some(turn),
                    limits.max_entry_chars,
                );
            } else if role == "assistant" {
                if text.trim().is_empty() {
                    return;
                }
                push_entry(
                    entries,
                    "assistant",
                    text,
                    seq,
                    time,
                    Some(turn),
                    limits.max_entry_chars,
                );
            }
        }
        "function_call" => {
            let name = string_field(payload, "name").unwrap_or("");
            let text = call_text(name, string_field(payload, "arguments"));
            if !text.is_empty() {
                push_entry(entries, "tool", text, seq, time, Some(turn), limits.tool_call_chars);
            }
        }
        "custom_tool_call" => {
            let name = string_field(payload, "name").unwrap_or("");
            // `custom_tool_call` carries its payload as `input` (a patch body, a shell script), not
            // as JSON.
            let text = call_text(name, string_field(payload, "input"));
            if !text.is_empty() {
                push_entry(entries, "tool", text, seq, time, Some(turn), limits.tool_call_chars);
            }
        }
        "web_search_call" => {
            let action = payload.get("action").filter(|value| value.is_object());
            let query = optional_string(action, "query")
                .map(str::to_owned)
                .unwrap_or_else(|| string_list(action.and_then(|action| action.get("queries"))).join(" "));
            if query.trim().is_empty() {
                return;
            }
            push_entry(
                entries,
                "tool",
                format!("web_search {query}"),
                seq,
                time,
                Some(turn),
                limits.tool_call_chars,
            );
        }
        // `reasoning` and every `*_output` record: the model's private thinking and tool results,
        // both of which the DSH parser also excludes.
        _ => {}
    }
}

/// Concatenate a Codex message's text blocks.
///
/// Codex content blocks are typed `input_text` (what the user sent) and `output_text` (what the
/// model replied); a block of any other type — an image reference, a future addition — is skipped
/// rather than stringified.
fn message_text(content: Option<&Value>) -> String {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return String::new();
    };
    let parts: Vec<&str> = blocks
        .iter()
        .filter_map(|block| {
            let kind = string_field(block, "type")?;
            if kind != "input_text" && kind != "output_text" {
                return None;
            }
            let text = string_field(block, "text")?;
            (!text.is_empty()).then_some(text)
        })
        .collect();
    parts.join("\n")
}

/// Render one tool invocation for indexing as `name arguments`, or just the name.
fn call_text(name: &str, argument: Option<&str>) -> String {
    match argument {
        Some(argument) if !argument.is_empty() => format!("{name} {argument}"),
        _ => name.to_owned(),
    }
}

/// Remove the injected context blocks Codex ships through the `user` role, then trim.
///
/// Applied per tag and non-greedily: a closing tag that never arrives leaves the text untouched,
/// which is a better failure than deleting everything after an opening tag.
fn strip_injected(text: &str) -> String {
    let mut clean = text.to_owned();
    for (open, close) in INJECTED_BLOCKS {
        loop {
            let Some(start) = clean.find(open) else {
                break;
            };
            let after_open = start + open.len();
            let Some(offset) = clean[after_open..].find(close) else {
                break;
            };
            let end = after_open + offset + close.len();
            clean.replace_range(start..end, "");
        }
    }
    clean.trim().to_owned()
}

/// The id to record when a rollout carries no `session_meta`.
///
/// Codex names its files `rollout-<iso>-<uuid>.jsonl.zst`, so the uuid survives even a truncated
/// log — which matters because a conversation whose first line is missing would otherwise be
/// indexed under a filename that changes the moment it is archived.
pub fn codex_fallback_id(file_path: &Path) -> String {
    let name = file_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let stem = name.strip_suffix(".jsonl.zst").unwrap_or(&name);
    trailing_uuid(stem).unwrap_or(stem).to_owned()
}

/// The uuid a rollout filename ends with, if it ends with one.
fn trailing_uuid(text: &str) -> Option<&str> {
    // `text.get` rather than an index: the tail of a non-ASCII filename is not a char boundary, and
    // a panic here would take down a whole index run over a badly named file.
    let tail = text.get(text.len().checked_sub(36)?..)?;
    let mut at = 0usize;
    for (index, width) in [8usize, 4, 4, 4, 12].into_iter().enumerate() {
        if index > 0 {
            if tail.as_bytes().get(at) != Some(&b'-') {
                return None;
            }
            at += 1;
        }
        let end = at + width;
        if !tail[at..end].bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return None;
        }
        at = end;
    }
    Some(tail)
}

/// Read a string field from an optional record.
fn optional_string<'a>(value: Option<&'a Value>, key: &str) -> Option<&'a str> {
    value.and_then(|value| string_field(value, key))
}

/// Join an array of strings, ignoring entries that are not strings.
fn string_list(value: Option<&Value>) -> Vec<&str> {
    match value.and_then(Value::as_array) {
        Some(items) => items.iter().filter_map(Value::as_str).collect(),
        None => Vec::new(),
    }
}

/// Read a record's ISO-8601 `timestamp` as epoch milliseconds.
fn time_field(record: &Value) -> Option<i64> {
    parse_iso_millis(string_field(record, "timestamp")?)
}

/// Parse an ISO-8601 date-time into epoch milliseconds.
///
/// The accepted shape is `YYYY-MM-DDTHH:MM:SS[.fff…](Z|±HH:MM)`, which is what Codex writes and
/// what `Date.parse` resolves to the same instant. A fraction is truncated to milliseconds, because
/// that is all a JavaScript date can carry — the two engines must store the same number.
fn parse_iso_millis(raw: &str) -> Option<i64> {
    let bytes = raw.as_bytes();
    let digit = |at: usize| -> Option<i64> {
        bytes
            .get(at)
            .filter(|byte| byte.is_ascii_digit())
            .map(|byte| i64::from(byte - b'0'))
    };
    let two = |at: usize| -> Option<i64> { Some(digit(at)? * 10 + digit(at + 1)?) };

    let year = digit(0)? * 1000 + digit(1)? * 100 + digit(2)? * 10 + digit(3)?;
    if bytes.get(4) != Some(&b'-') {
        return None;
    }
    let month = two(5)?;
    if bytes.get(7) != Some(&b'-') {
        return None;
    }
    let day = two(8)?;
    if !matches!(bytes.get(10), Some(b'T' | b't')) {
        return None;
    }
    let hour = two(11)?;
    if bytes.get(13) != Some(&b':') {
        return None;
    }
    let minute = two(14)?;
    if bytes.get(16) != Some(&b':') {
        return None;
    }
    let second = two(17)?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    if hour > 23 || minute > 59 || second > 59 {
        return None;
    }

    let mut at = 19usize;
    let mut millis = 0i64;
    if bytes.get(at) == Some(&b'.') {
        at += 1;
        let start = at;
        while bytes.get(at).is_some_and(|byte| byte.is_ascii_digit()) {
            at += 1;
        }
        if at == start {
            return None;
        }
        // Truncated, not rounded: `Date.parse` keeps the first three digits and drops the rest.
        for (index, byte) in raw[start..at].bytes().take(3).enumerate() {
            millis += i64::from(byte - b'0') * 10i64.pow(2 - index as u32);
        }
    }

    let offset_seconds = match bytes.get(at) {
        Some(b'Z' | b'z') => {
            at += 1;
            0
        }
        Some(sign @ (b'+' | b'-')) => {
            let direction = if *sign == b'-' { -1 } else { 1 };
            at += 1;
            let hours = two(at)?;
            at += 2;
            if bytes.get(at) == Some(&b':') {
                at += 1;
            }
            let minutes = two(at)?;
            at += 2;
            direction * (hours * 3600 + minutes * 60)
        }
        // No zone at all: `Date.parse` would read it as local time, which a pure string parser
        // cannot know. Reading it as UTC keeps the ordering right on a machine whose logs are all
        // written in one zone, and no Codex envelope omits the zone.
        None => 0,
        _ => return None,
    };
    if !raw[at..].trim().is_empty() {
        return None;
    }

    let days = days_from_civil(year, month, day);
    let seconds = days
        .checked_mul(86_400)?
        .checked_add(hour * 3600 + minute * 60 + second - offset_seconds)?;
    seconds.checked_mul(1000)?.checked_add(millis)
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's civil-from-days,
/// inverted) — the arithmetic `Date.UTC` performs.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::path::Path;

    use super::{codex_fallback_id, parse_codex_lines, parse_iso_millis, strip_injected};
    use crate::parse::ParseLimits;

    const LIMITS: ParseLimits = ParseLimits {
        max_entry_chars: 4_000,
        tool_call_chars: 2_000,
    };

    /// Build the thread-name table a run would read from `session_index.jsonl`.
    fn titles(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(id, title)| ((*id).to_owned(), (*title).to_owned()))
            .collect()
    }

    /// One envelope line, so a fixture reads like the file it came from.
    fn envelope(time: &str, ordinal: i64, kind: &str, payload: &str) -> String {
        format!(r#"{{"timestamp":"{time}","ordinal":{ordinal},"type":"{kind}","payload":{payload}}}"#)
    }

    #[test]
    fn reads_meta_turns_and_the_visible_conversation() {
        let log = [
            // The envelope timestamp is later than the meta's own; `created_at` must take the meta's,
            // exactly as the TypeScript parser does.
            envelope(
                "2026-03-27T09:26:55.703Z",
                0,
                "session_meta",
                r#"{"session_id":"abc","cwd":"/tmp/proj","timestamp":"2026-03-27T09:26:43.746Z","originator":"Codex Desktop","base_instructions":{"text":"must not be indexed"}}"#,
            ),
            envelope("2026-03-27T09:26:55.710Z", 1, "turn_context", r#"{"turn_id":"t1","model":"gpt-5"}"#),
            envelope(
                "2026-03-27T09:26:57.000Z",
                2,
                "response_item",
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"改一下广告 SDK"}]}"#,
            ),
            envelope(
                "2026-03-27T09:27:00.000Z",
                3,
                "response_item",
                r#"{"type":"message","role":"assistant","content":[{"type":"output_text","text":"好"}]}"#,
            ),
        ]
        .join("\n");

        let session = parse_codex_lines(&log, "fallback", &LIMITS, &titles(&[("abc", " 广告调试 ")]));
        assert_eq!(session.id, "abc");
        assert_eq!(session.cwd, "/tmp/proj");
        assert_eq!(session.created_at, 1_774_603_603_746);
        assert_eq!(session.last_at, 1_774_603_620_000);
        assert_eq!(session.title.as_deref(), Some("广告调试"));
        assert_eq!(session.origin.as_deref(), Some("Codex Desktop"));
        assert_eq!(session.agent_preset.as_deref(), Some("gpt-5"));
        assert_eq!(session.turns, 1);
        assert_eq!(session.parent_session, None);

        let texts: Vec<(&str, &str)> = session
            .entries
            .iter()
            .map(|entry| (entry.kind, entry.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            vec![
                ("user", "改一下广告 SDK"),
                ("assistant", "好"),
                ("title", "广告调试"),
            ]
        );
        // The title entry carries the run's last instant, not the meta's timestamp.
        assert_eq!(session.entries[2].time, 1_774_603_620_000);
        assert_eq!(session.entries[2].seq, 0);
        assert_eq!(session.entries[0].seq, 2);
        assert_eq!(session.entries[0].turn, Some(1));
    }

    #[test]
    fn skips_developer_reasoning_outputs_and_bookkeeping() {
        let log = [
            envelope(
                "2026-03-27T09:26:55.703Z",
                0,
                "session_meta",
                r#"{"session_id":"abc","cwd":"/w","timestamp":"2026-03-27T09:26:55.703Z"}"#,
            ),
            envelope(
                "2026-03-27T09:26:56.000Z",
                1,
                "response_item",
                r#"{"type":"message","role":"developer","content":[{"type":"input_text","text":"<permissions instructions>full instruction set"}]}"#,
            ),
            envelope(
                "2026-03-27T09:26:57.000Z",
                2,
                "response_item",
                r#"{"type":"reasoning","summary":[{"type":"summary_text","text":"private thinking"}]}"#,
            ),
            envelope(
                "2026-03-27T09:26:58.000Z",
                3,
                "response_item",
                r#"{"type":"function_call_output","call_id":"c1","output":"tool result"}"#,
            ),
            envelope("2026-03-27T09:26:59.000Z", 4, "event_msg", r#"{"type":"token_count"}"#),
            envelope("2026-03-27T09:27:00.000Z", 5, "compacted", r#"{"message":"handoff"}"#),
        ]
        .join("\n");

        let session = parse_codex_lines(&log, "fallback", &LIMITS, &HashMap::new());
        assert!(session.entries.is_empty());
        assert_eq!(session.created_at, 1_774_603_615_703);
    }

    #[test]
    fn strips_injected_context_and_drops_messages_that_reduce_to_nothing() {
        let log = [
            envelope(
                "2026-03-27T09:26:55.703Z",
                0,
                "session_meta",
                r#"{"session_id":"abc","cwd":"/w"}"#,
            ),
            envelope(
                "2026-03-27T09:26:56.000Z",
                1,
                "response_item",
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>\n  <cwd>/w</cwd>\n</environment_context>"}]}"#,
            ),
            // An environment block *and* the question in one record: the question must survive.
            envelope(
                "2026-03-27T09:26:57.000Z",
                2,
                "response_item",
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<user_instructions>rules</user_instructions>\n真正的提问"}]}"#,
            ),
            envelope(
                "2026-03-27T09:26:58.000Z",
                3,
                "response_item",
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"<turn_aborted>\n  aborted\n</turn_aborted>"}]}"#,
            ),
        ]
        .join("\n");

        let session = parse_codex_lines(&log, "fallback", &LIMITS, &HashMap::new());
        let texts: Vec<&str> = session.entries.iter().map(|entry| entry.text.as_str()).collect();
        assert_eq!(texts, vec!["真正的提问"]);
    }

    #[test]
    fn renders_the_three_tool_call_shapes() {
        let log = [
            envelope(
                "2026-03-27T09:26:55.703Z",
                0,
                "session_meta",
                r#"{"session_id":"abc","cwd":"/w"}"#,
            ),
            envelope(
                "2026-03-27T09:26:56.000Z",
                1,
                "response_item",
                r#"{"type":"function_call","name":"shell","arguments":"{\"command\":[\"ls\"]}"}"#,
            ),
            envelope(
                "2026-03-27T09:26:57.000Z",
                2,
                "response_item",
                r#"{"type":"custom_tool_call","name":"apply_patch","input":"*** Begin Patch"}"#,
            ),
            envelope(
                "2026-03-27T09:26:58.000Z",
                3,
                "response_item",
                r#"{"type":"web_search_call","action":{"type":"search","query":"广告 SDK"}}"#,
            ),
            // A search recorded as a list of queries rather than one string.
            envelope(
                "2026-03-27T09:26:59.000Z",
                4,
                "response_item",
                r#"{"type":"web_search_call","action":{"queries":["one","two"]}}"#,
            ),
            // A call with no arguments is its name alone, mirroring the TypeScript `callText`.
            envelope(
                "2026-03-27T09:27:00.000Z",
                5,
                "response_item",
                r#"{"type":"function_call","name":"noop"}"#,
            ),
        ]
        .join("\n");

        let session = parse_codex_lines(&log, "fallback", &LIMITS, &HashMap::new());
        let texts: Vec<(&str, &str)> = session
            .entries
            .iter()
            .map(|entry| (entry.kind, entry.text.as_str()))
            .collect();
        assert_eq!(
            texts,
            vec![
                ("tool", "shell {\"command\":[\"ls\"]}"),
                ("tool", "apply_patch *** Begin Patch"),
                ("tool", "web_search 广告 SDK"),
                ("tool", "web_search one two"),
                ("tool", "noop"),
            ]
        );
    }

    #[test]
    fn clips_entry_and_tool_text_at_the_configured_cap() {
        let long = "x".repeat(50);
        let log = [
            envelope(
                "2026-03-27T09:26:55.703Z",
                0,
                "session_meta",
                r#"{"session_id":"abc","cwd":"/w"}"#,
            ),
            envelope(
                "2026-03-27T09:26:56.000Z",
                1,
                "response_item",
                &format!(r#"{{"type":"message","role":"user","content":[{{"type":"input_text","text":"{long}"}}]}}"#),
            ),
            envelope(
                "2026-03-27T09:26:57.000Z",
                2,
                "response_item",
                &format!(r#"{{"type":"function_call","name":"tool","arguments":"{long}"}}"#),
            ),
        ]
        .join("\n");
        let limits = ParseLimits {
            max_entry_chars: 20,
            tool_call_chars: 10,
        };

        let session = parse_codex_lines(&log, "fallback", &limits, &HashMap::new());
        assert_eq!(session.entries[0].text.len(), 20);
        assert!(session.entries[0].clipped);
        // The name and arguments are one entry, clipped together to the tool-call cap.
        assert_eq!(session.entries[1].text, "tool xxxxx");
        assert!(session.entries[1].clipped);
    }

    #[test]
    fn falls_back_to_the_rollout_filename_and_the_earliest_timestamp() {
        // No `session_meta` at all: a truncated log still has an id and a start, and the start is the
        // earliest envelope rather than the first one seen.
        let log = [
            envelope(
                "2026-03-27T09:26:57.000Z",
                1,
                "response_item",
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"later"}]}"#,
            ),
            envelope(
                "2026-03-27T09:26:56.000Z",
                2,
                "response_item",
                r#"{"type":"message","role":"user","content":[{"type":"input_text","text":"earlier"}]}"#,
            ),
        ]
        .join("\n");

        let session = parse_codex_lines(&log, "rollout-uuid", &LIMITS, &HashMap::new());
        assert_eq!(session.id, "rollout-uuid");
        assert_eq!(session.cwd, "");
        assert_eq!(session.created_at, 1_774_603_616_000);
        assert_eq!(session.last_at, 1_774_603_617_000);
        assert_eq!(session.origin, None);
        assert_eq!(session.agent_preset, None);
        // A message with no `turn_context` belongs to turn 0, which is what the TS parser records.
        assert_eq!(session.entries[0].turn, Some(0));
    }

    #[test]
    fn counts_one_turn_per_distinct_turn_id() {
        let log = [
            envelope("2026-03-27T09:26:55.000Z", 0, "turn_context", r#"{"turn_id":"t1","model":"a"}"#),
            envelope("2026-03-27T09:26:56.000Z", 1, "turn_context", r#"{"turn_id":"t1","model":"b"}"#),
            envelope("2026-03-27T09:26:57.000Z", 2, "turn_context", r#"{"turn_id":"t2","model":"c"}"#),
        ]
        .join("\n");

        let session = parse_codex_lines(&log, "fallback", &LIMITS, &HashMap::new());
        assert_eq!(session.turns, 2);
        // The first model wins: `model ??= …` in the TS parser.
        assert_eq!(session.agent_preset.as_deref(), Some("a"));
    }

    #[test]
    fn skips_corrupt_lines_and_lines_that_are_not_envelopes() {
        let log = [
            "{not json".to_owned(),
            "[1,2,3]".to_owned(),
            envelope("2026-03-27T09:26:56.000Z", 1, "turn_context", r#"{"turn_id":"t1"}"#),
            String::new(),
        ]
        .join("\n");

        let session = parse_codex_lines(&log, "fallback", &LIMITS, &HashMap::new());
        assert_eq!(session.id, "fallback");
        assert_eq!(session.turns, 1);
        assert!(session.entries.is_empty());
    }

    #[test]
    fn injects_no_title_entry_when_the_table_has_none() {
        let log = envelope("2026-03-27T09:26:56.000Z", 1, "turn_context", r#"{"turn_id":"t1"}"#);
        let session = parse_codex_lines(&log, "fallback", &LIMITS, &titles(&[("other", "别的会话")]));
        assert_eq!(session.title, None);
        assert!(session.entries.is_empty());
    }

    #[test]
    fn parses_every_timestamp_shape_the_corpus_uses() {
        assert_eq!(parse_iso_millis("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_iso_millis("2026-03-27T01:58:23.430Z"), Some(1_774_576_703_430));
        // `Date.parse` keeps milliseconds and drops the rest of the fraction.
        assert_eq!(parse_iso_millis("2026-03-17T10:54:08.464583Z"), Some(1_773_744_848_464));
        assert_eq!(parse_iso_millis("1970-01-01T08:00:00+08:00"), Some(0));
        assert_eq!(parse_iso_millis("1969-12-31T23:00:00-01:00"), Some(0));
        assert_eq!(parse_iso_millis("2026-03-27T09:26:55Z"), Some(1_774_603_615_000));
        assert_eq!(parse_iso_millis("2026-13-01T00:00:00Z"), None);
        assert_eq!(parse_iso_millis("2026-03-27"), None);
        assert_eq!(parse_iso_millis("not a timestamp"), None);
        assert_eq!(parse_iso_millis(""), None);
    }

    #[test]
    fn strips_injected_blocks_without_eating_the_rest() {
        assert_eq!(strip_injected("  <turn_aborted>\n  x\n</turn_aborted>  "), "");
        assert_eq!(
            strip_injected("<environment_context>a</environment_context>问题"),
            "问题"
        );
        // An opening tag with no closing one is left alone rather than truncating the message.
        assert_eq!(strip_injected("a <environment_context> b"), "a <environment_context> b");
    }

    #[test]
    fn derives_the_fallback_id_from_the_rollout_filename() {
        let id = codex_fallback_id(Path::new(
            "/w/rollout-2026-03-27T09-58-12-019d2d03-6b7c-7f50-94f2-0df2a1c99a49.jsonl.zst",
        ));
        assert_eq!(id, "019d2d03-6b7c-7f50-94f2-0df2a1c99a49");
        assert_eq!(
            codex_fallback_id(Path::new("/w/rollout-broken.jsonl.zst")),
            "rollout-broken"
        );
        assert_eq!(codex_fallback_id(Path::new("/w/广告.jsonl.zst")), "广告");
    }
}
