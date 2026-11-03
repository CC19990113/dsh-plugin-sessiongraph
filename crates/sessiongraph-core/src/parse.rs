//! Extract the searchable conversation out of one session log.
//!
//! Mirrors `packages/sessions/src/parse.ts` field for field: the first line is a flat session
//! header, later lines are events, and what is indexed is the readable conversation — a human's own
//! messages, the model's visible text (never its reasoning), tool invocations (name and arguments,
//! never results), and the session's final title. Injected context arrives as `user/message` events
//! too, so the `data.source.kind === 'user'` check is what keeps it out of the index; on a real
//! machine those injections outnumber real human messages by more than an order of magnitude.
//!
//! Parsing is tolerant per line: a truncated or corrupt line is skipped rather than failing the
//! session, because an interrupted append must cost one event, not the conversation.

use serde_json::Value;

use crate::decode::decompress_session_log;

/// Bounds applied while normalizing one session's entries.
#[derive(Debug, Clone, Copy)]
pub struct ParseLimits {
    /// Longest message text stored whole; longer text is clipped.
    pub max_entry_chars: usize,
    /// Longest tool invocation text (name plus arguments) stored whole.
    pub tool_call_chars: usize,
}

/// One searchable entry extracted from a session log.
#[derive(Debug, Clone)]
pub struct ParsedEntry {
    /// Event sequence number inside the session.
    pub seq: i64,
    /// Event timestamp, epoch milliseconds.
    pub time: i64,
    /// Turn the entry belongs to, when the event records one.
    pub turn: Option<i64>,
    /// What the entry is: `user`, `assistant`, `tool`, or `title`.
    pub kind: &'static str,
    /// Entry text, already bounded by the parse limits.
    pub text: String,
    /// True when the stored text is a clipped prefix.
    pub clipped: bool,
}

/// One session log, normalized for the index.
#[derive(Debug, Clone)]
pub struct ParsedSession {
    /// Session id exactly as the header records it (`session-…` or bare uuid, never rewritten).
    pub id: String,
    /// Working directory the session ran in.
    pub cwd: String,
    /// Epoch milliseconds of the session's first event.
    pub created_at: i64,
    /// Epoch milliseconds of the session's last event.
    pub last_at: i64,
    /// Final session title, when the log records one.
    pub title: Option<String>,
    /// Parent session id when this session was delegated from another.
    pub parent_session: Option<String>,
    /// Session origin label (`user`, `subagent`, …), when recorded.
    pub origin: Option<String>,
    /// Agent preset the session ran under, when recorded.
    pub agent_preset: Option<String>,
    /// Number of turns the session contains.
    pub turns: i64,
    /// Searchable entries in chronological order (the title entry last).
    pub entries: Vec<ParsedEntry>,
}

/// Parse one session log from its raw compressed bytes.
pub fn parse_session_log(
    buffer: &[u8],
    fallback_id: &str,
    limits: &ParseLimits,
) -> Result<ParsedSession, String> {
    let raw = decompress_session_log(buffer)?;
    // Node's `Buffer.toString('utf8')` replaces an ill-formed sequence with U+FFFD; lossy
    // conversion is the same policy, and a real log is valid UTF-8 anyway.
    Ok(parse_jsonl(&String::from_utf8_lossy(&raw), fallback_id, limits))
}

/// Parse the decompressed JSONL text of one session log.
pub fn parse_jsonl(text: &str, fallback_id: &str, limits: &ParseLimits) -> ParsedSession {
    let first_line = text
        .split('\n')
        .enumerate()
        .find(|(_, line)| !line.trim().is_empty())
        .map(|(index, _)| index);

    let mut header: Option<Value> = None;
    let mut start = 0usize;
    if let Some(index) = first_line {
        let record = text.split('\n').nth(index).and_then(parse_record);
        if record
            .as_ref()
            .and_then(|record| record.get("type"))
            .and_then(Value::as_str)
            == Some("session")
        {
            header = record;
            start = index + 1;
        } else {
            start = index;
        }
    }

    let id = header
        .as_ref()
        .and_then(|header| string_field(header, "id"))
        .unwrap_or(fallback_id)
        .to_owned();
    let mut created_at = header
        .as_ref()
        .and_then(|header| number_field(header, "createdAt"))
        .unwrap_or(0);
    let parent_session = header
        .as_ref()
        .and_then(|header| string_field(header, "parentSession"))
        .map(str::to_owned);
    let origin = header
        .as_ref()
        .and_then(|header| string_field(header, "origin"))
        .map(str::to_owned);
    let agent_preset = header
        .as_ref()
        .and_then(|header| string_field(header, "agentPreset"))
        .map(str::to_owned);
    let cwd = header
        .as_ref()
        .and_then(|header| string_field(header, "cwd"))
        .unwrap_or_default()
        .to_owned();

    let mut entries: Vec<ParsedEntry> = Vec::new();
    let mut title: Option<String> = None;
    let mut title_seq = 0i64;
    let mut title_time = 0i64;
    let mut first_event_time: Option<i64> = None;
    let mut last_at = created_at;
    let mut turns = 0i64;

    for line in text.split('\n').skip(start) {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Some(record) = parse_record(line) else {
            continue;
        };

        let seq = number_field(&record, "seq").unwrap_or(0);
        let time = number_field(&record, "time");
        if let Some(time) = time {
            first_event_time.get_or_insert(time);
            if time > last_at {
                last_at = time;
            }
        }
        let event_time = time.unwrap_or(last_at);

        match record.get("type").and_then(Value::as_str).unwrap_or("") {
            "turn/start" => turns += 1,
            "session/title" => {
                let data = record.get("data");
                if let Some(next) = data.and_then(|data| string_field(data, "title")) {
                    if !next.trim().is_empty() {
                        title = Some(next.to_owned());
                        title_seq = seq;
                        title_time = event_time;
                    }
                }
            }
            "user/message" => {
                let data = record.get("data");
                let kind = data
                    .and_then(|data| data.get("source"))
                    .and_then(|source| string_field(source, "kind"));
                if kind != Some("user") {
                    continue;
                }
                let text = text_blocks(data.and_then(|data| data.get("content")));
                if !text.is_empty() {
                    push_entry(
                        &mut entries,
                        "user",
                        text,
                        seq,
                        event_time,
                        data.and_then(|data| number_field(data, "turn")),
                        limits.max_entry_chars,
                    );
                }
            }
            "assistant/message" => {
                let data = record.get("data");
                let blocks = data
                    .and_then(|data| data.get("message"))
                    .and_then(|message| message.get("content"))
                    .and_then(Value::as_array);
                let Some(blocks) = blocks else {
                    continue;
                };
                for block in blocks {
                    if string_field(block, "type") != Some("text") {
                        continue;
                    }
                    let Some(text) = string_field(block, "text") else {
                        continue;
                    };
                    if text.trim().is_empty() {
                        continue;
                    }
                    push_entry(
                        &mut entries,
                        "assistant",
                        text.to_owned(),
                        seq,
                        event_time,
                        data.and_then(|data| number_field(data, "turn")),
                        limits.max_entry_chars,
                    );
                }
            }
            "tool/call" => {
                let data = record.get("data");
                let name = data
                    .and_then(|data| string_field(data, "name"))
                    .unwrap_or_default();
                let args = argument_text(data.and_then(|data| data.get("arguments")));
                let text = if args.is_empty() {
                    name.to_owned()
                } else {
                    format!("{name} {args}")
                };
                if text.trim().is_empty() {
                    continue;
                }
                push_entry(
                    &mut entries,
                    "tool",
                    text,
                    seq,
                    event_time,
                    data.and_then(|data| number_field(data, "turn")),
                    limits.tool_call_chars,
                );
            }
            _ => {}
        }
    }

    if created_at == 0 {
        if let Some(time) = first_event_time {
            created_at = time;
        }
    }
    if last_at < created_at {
        last_at = created_at;
    }
    if let Some(title) = &title {
        let (text, clipped) = clip_text(title, limits.max_entry_chars);
        entries.push(ParsedEntry {
            seq: title_seq,
            time: title_time,
            turn: None,
            kind: "title",
            text,
            clipped,
        });
    }

    ParsedSession {
        id,
        cwd,
        created_at,
        last_at,
        title,
        parent_session,
        origin,
        agent_preset,
        turns,
        entries,
    }
}

/// Append one bounded entry, unless its text is blank.
fn push_entry(
    entries: &mut Vec<ParsedEntry>,
    kind: &'static str,
    text: String,
    seq: i64,
    time: i64,
    turn: Option<i64>,
    max_chars: usize,
) {
    if text.trim().is_empty() {
        return;
    }
    let (text, clipped) = clip_text(&text, max_chars);
    entries.push(ParsedEntry {
        seq,
        time,
        turn,
        kind,
        text,
        clipped,
    });
}

/// Bound one text to the configured character cap.
///
/// The cap counts UTF-16 code units, because the TS indexer's `text.length` and `text.slice` are
/// UTF-16 based: a message ending at the cap must be clipped identically on both sides. A
/// surrogate pair that would straddle the boundary is dropped whole rather than split (a Rust
/// `String` cannot hold the lone surrogate TS would produce).
pub fn clip_text(text: &str, max_chars: usize) -> (String, bool) {
    if text.encode_utf16().count() <= max_chars {
        return (text.to_owned(), false);
    }
    let mut taken = 0usize;
    let mut end = 0usize;
    for (index, character) in text.char_indices() {
        let width = character.len_utf16();
        if taken + width > max_chars {
            break;
        }
        taken += width;
        end = index + character.len_utf8();
    }
    (text[..end].to_owned(), true)
}

/// Concatenate the text blocks of a message's content array.
fn text_blocks(content: Option<&Value>) -> String {
    let Some(blocks) = content.and_then(Value::as_array) else {
        return String::new();
    };
    let parts: Vec<&str> = blocks
        .iter()
        .filter(|block| string_field(block, "type") == Some("text"))
        .filter_map(|block| string_field(block, "text"))
        .filter(|text| !text.is_empty())
        .collect();
    parts.join("\n")
}

/// Render a tool call's arguments for indexing.
fn argument_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        None | Some(Value::Null) => String::new(),
        Some(value) => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// Parse one JSONL line into a JSON object, tolerating a corrupt line.
fn parse_record(line: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(line).ok()?;
    value.is_object().then_some(value)
}

/// Read a string field from a value that may not be an object.
fn string_field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

/// Read a finite numeric field, truncated to an integer for storage.
fn number_field(value: &Value, key: &str) -> Option<i64> {
    let value = value.get(key)?;
    if let Some(integer) = value.as_i64() {
        return Some(integer);
    }
    let float = value.as_f64()?;
    float.is_finite().then_some(float as i64)
}

#[cfg(test)]
mod tests {
    use super::{clip_text, parse_jsonl, ParseLimits};

    const LIMITS: ParseLimits = ParseLimits {
        max_entry_chars: 4_000,
        tool_call_chars: 2_000,
    };

    #[test]
    fn reads_header_fields_and_final_title() {
        let log = [
            r#"{"type":"session","version":4,"id":"abc","createdAt":100,"cwd":"/tmp/proj","origin":"subagent","agentPreset":"standard"}"#,
            r#"{"type":"session/title","seq":2,"time":120,"data":{"title":"first"}}"#,
            r#"{"type":"turn/start","seq":3,"time":130,"data":{"turn":1}}"#,
            r#"{"type":"session/title","seq":4,"time":140,"data":{"title":"final"}}"#,
        ]
        .join("\n");
        let session = parse_jsonl(&log, "fallback", &LIMITS);
        assert_eq!(session.id, "abc");
        assert_eq!(session.cwd, "/tmp/proj");
        assert_eq!(session.created_at, 100);
        assert_eq!(session.last_at, 140);
        assert_eq!(session.title.as_deref(), Some("final"));
        assert_eq!(session.origin.as_deref(), Some("subagent"));
        assert_eq!(session.agent_preset.as_deref(), Some("standard"));
        assert_eq!(session.turns, 1);
        let titles: Vec<_> = session.entries.iter().filter(|entry| entry.kind == "title").collect();
        assert_eq!(titles.len(), 1);
        assert_eq!(titles[0].seq, 4);
        assert_eq!(titles[0].text, "final");
    }

    #[test]
    fn indexes_only_human_user_messages() {
        let log = [
            r#"{"type":"session","id":"abc","createdAt":1}"#,
            r#"{"type":"user/message","seq":1,"time":10,"data":{"source":{"kind":"runtime-context"},"content":[{"type":"text","text":"injected"}]}}"#,
            r#"{"type":"user/message","seq":2,"time":11,"data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello"},{"type":"text","text":"world"}]}}"#,
        ]
        .join("\n");
        let session = parse_jsonl(&log, "fallback", &LIMITS);
        assert_eq!(session.entries.len(), 1);
        assert_eq!(session.entries[0].kind, "user");
        assert_eq!(session.entries[0].text, "hello\nworld");
    }

    #[test]
    fn indexes_assistant_text_blocks_but_not_reasoning() {
        let log = [
            r#"{"type":"session","id":"abc","createdAt":1}"#,
            r#"{"type":"assistant/message","seq":5,"time":50,"data":{"turn":2,"message":{"content":[{"type":"reasoning","text":"secret"},{"type":"text","text":"visible"},{"type":"tool-call","name":"x"}]}}}"#,
        ]
        .join("\n");
        let session = parse_jsonl(&log, "fallback", &LIMITS);
        assert_eq!(session.entries.len(), 1);
        assert_eq!(session.entries[0].kind, "assistant");
        assert_eq!(session.entries[0].text, "visible");
        assert_eq!(session.entries[0].turn, Some(2));
    }

    #[test]
    fn clips_entry_and_tool_text_at_the_configured_cap() {
        let long = "x".repeat(50);
        let log = [
            r#"{"type":"session","id":"abc","createdAt":1}"#.to_owned(),
            format!(
                r#"{{"type":"user/message","seq":1,"time":10,"data":{{"source":{{"kind":"user"}},"content":[{{"type":"text","text":"{long}"}}]}}}}"#
            ),
            format!(
                r#"{{"type":"tool/call","seq":2,"time":11,"data":{{"name":"tool","arguments":"{long}"}}}}"#
            ),
        ]
        .join("\n");
        let limits = ParseLimits {
            max_entry_chars: 20,
            tool_call_chars: 10,
        };
        let session = parse_jsonl(&log, "fallback", &limits);
        assert_eq!(session.entries[0].text.len(), 20);
        assert!(session.entries[0].clipped);
        // The name and arguments are one entry, clipped together to the tool-call cap.
        assert_eq!(session.entries[1].text, "tool xxxxx");
        assert!(session.entries[1].clipped);
    }

    #[test]
    fn skips_corrupt_lines() {
        let log = [
            r#"{"type":"session","id":"abc","createdAt":1}"#,
            "{not json",
            r#"{"type":"turn/start","seq":1,"time":10,"data":{}}"#,
        ]
        .join("\n");
        let session = parse_jsonl(&log, "fallback", &LIMITS);
        assert_eq!(session.turns, 1);
    }

    #[test]
    fn falls_back_to_the_session_directory_name() {
        let log = r#"{"type":"turn/start","seq":1,"time":10,"data":{}}"#;
        let session = parse_jsonl(log, "dir-name", &LIMITS);
        assert_eq!(session.id, "dir-name");
        assert_eq!(session.created_at, 10);
        assert_eq!(session.last_at, 10);
    }

    #[test]
    fn clipping_counts_utf16_units() {
        // Four CJK characters are four UTF-16 units; a cap of 2 keeps two.
        assert_eq!(clip_text("广告点击", 2), ("广告".to_owned(), true));
        // An emoji is two UTF-16 units, so a cap of 3 cannot split it.
        assert_eq!(clip_text("a😀b", 3), ("a😀".to_owned(), true));
        assert_eq!(clip_text("abc", 3), ("abc".to_owned(), false));
    }
}
