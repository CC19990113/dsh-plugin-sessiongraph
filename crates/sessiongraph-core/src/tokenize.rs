//! The bigram tokenizer, byte-for-byte the same rules as `packages/service/src/tokenize.ts`.
//!
//! The store tokenizes a query on read and the indexer tokenizes an entry on write, so a one-rule
//! drift between them produces an index that silently cannot answer its own queries. Hence this
//! module mirrors the TS implementation literally:
//!
//! - a run of CJK ideographs becomes overlapping two-character tokens (`广告点击` → `广告 告点 点击`),
//!   and a single-character run stays one token;
//! - a run of ASCII letters and digits becomes ONE lower-case token, truncated past 64 characters;
//!   `_` is deliberately not part of the run, so `codegraph_index` writes `codegraph` and `index`;
//! - every other character is a separator and produces nothing;
//! - tokens keep document order, duplicates included.

/// Longest Latin/digit run kept as one token before it is truncated.
const MAX_LATIN_TOKEN_LENGTH: usize = 64;

/// A CJK ideograph, including the extension-A block and the compatibility block.
///
/// The TS regex is `/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/` with no `u` flag, so it matches
/// only these BMP ranges; an astral ideograph is not a CJK run character on either side.
fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xf900..=0xfaff)
}

/// A Latin letter or digit: the TS `[A-Za-z0-9]` class, ASCII only.
fn is_latin(c: char) -> bool {
    c.is_ascii_alphanumeric()
}

/// Tokenize text into the stream written to `entry_fts.tokens` and compared against a query.
pub fn tokenize(text: &str) -> Vec<String> {
    if text.is_empty() {
        return Vec::new();
    }
    let mut tokens = Vec::new();
    let mut iter = text.char_indices().peekable();
    while let Some((start, first)) = iter.next() {
        if is_cjk(first) {
            let mut end = start + first.len_utf8();
            while let Some(&(next_at, next)) = iter.peek() {
                if !is_cjk(next) {
                    break;
                }
                end = next_at + next.len_utf8();
                iter.next();
            }
            let run: Vec<char> = text[start..end].chars().collect();
            if run.len() == 1 {
                tokens.push(run[0].to_string());
            } else {
                for pair in run.windows(2) {
                    tokens.push([pair[0], pair[1]].iter().collect());
                }
            }
        } else if is_latin(first) {
            let mut end = start + first.len_utf8();
            while let Some(&(next_at, next)) = iter.peek() {
                if !is_latin(next) {
                    break;
                }
                end = next_at + next.len_utf8();
                iter.next();
            }
            let token = text[start..end].to_ascii_lowercase();
            if token.len() > MAX_LATIN_TOKEN_LENGTH {
                tokens.push(token[..MAX_LATIN_TOKEN_LENGTH].to_owned());
            } else {
                tokens.push(token);
            }
        }
    }
    tokens
}

/// Join tokens the way the `entry_fts.tokens` column stores them.
pub fn joined(text: &str) -> String {
    tokenize(text).join(" ")
}

#[cfg(test)]
mod tests {
    use super::{tokenize, MAX_LATIN_TOKEN_LENGTH};

    fn tokens(text: &str) -> Vec<String> {
        tokenize(text)
    }

    #[test]
    fn expands_chinese_runs_to_overlapping_bigrams() {
        assert_eq!(tokens("广告点击"), vec!["广告", "告点", "点击"]);
        assert_eq!(tokens("广告"), vec!["广告"]);
        assert_eq!(tokens("广"), vec!["广"]);
    }

    #[test]
    fn keeps_latin_runs_whole_and_lower_case() {
        assert_eq!(tokens("广告SDK"), vec!["广告", "sdk"]);
        assert_eq!(tokens("UPPER"), vec!["upper"]);
        assert_eq!(tokens("广告Click"), vec!["广告", "click"]);
    }

    #[test]
    fn splits_on_underscore_like_fts5_unicode61() {
        assert_eq!(tokens("codegraph_index"), vec!["codegraph", "index"]);
        assert_eq!(tokens("adx_admin_backend"), vec!["adx", "admin", "backend"]);
    }

    #[test]
    fn keeps_document_order_across_mixed_runs() {
        assert_eq!(
            tokens("我今天在改广告SDK"),
            vec!["我今", "今天", "天在", "在改", "改广", "广告", "sdk"]
        );
        assert_eq!(tokens("a广b"), vec!["a", "广", "b"]);
    }

    #[test]
    fn drops_separators_and_empty_input() {
        assert_eq!(tokens(""), Vec::<String>::new());
        assert_eq!(tokens("  ,。!? \t\n"), Vec::<String>::new());
        assert_eq!(tokens("--广告--"), vec!["广告"]);
    }

    #[test]
    fn truncates_overlong_latin_tokens_to_64() {
        let long = "a".repeat(MAX_LATIN_TOKEN_LENGTH + 10);
        let got = tokens(&long);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].len(), MAX_LATIN_TOKEN_LENGTH);
    }
}
