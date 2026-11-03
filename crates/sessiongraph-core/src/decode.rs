//! Decompress one session log.
//!
//! A harness log is **not** one zstd stream: the file is appended one complete frame per write, so
//! a real 234KB log holds 113 frames and a decompressor that stops at the first frame's end yields
//! 292 bytes of a 1.6GB corpus. The frame layout is walked exactly (RFC 8878 header and block
//! headers), which is why a magic-byte sequence *inside* a compressed block cannot split a frame
//! wrongly; the magic scan remains as a fallback for a layout this walker refuses, exactly as
//! `packages/sessions/src/parse.ts` does it.

/// zstd frame magic, as read little-endian from the first four bytes.
const ZSTD_MAGIC: u32 = 0xfd2f_b528;

/// The same magic as bytes, for the fallback scanner.
const ZSTD_MAGIC_BYTES: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

/// Mask and value identifying a zstd skippable frame (`0x184D2A50 … 0x184D2A5F`).
const ZSTD_SKIPPABLE_MASK: u32 = 0xffff_fff0;
const ZSTD_SKIPPABLE_MAGIC: u32 = 0x184d_2a50;

/// Frame-content-size field widths in bytes, indexed by the 2-bit flag minus one.
const CONTENT_SIZE_BYTES: [usize; 3] = [2, 4, 8];

/// Dictionary-id field widths in bytes, indexed by the 2-bit flag.
const DICTIONARY_ID_BYTES: [usize; 4] = [0, 1, 2, 4];

/// Byte widths of a zstd block header and of the checksum trailer.
const BLOCK_HEADER_BYTES: usize = 3;
const CHECKSUM_BYTES: usize = 4;

/// Decompress a session log, one zstd frame at a time.
///
/// Tries the exact frame walker first and falls back to a magic scan when the file does not start
/// at a frame boundary or the walker meets a layout it cannot describe — a readable index is worth
/// more than a stricter parser.
pub fn decompress_session_log(buffer: &[u8]) -> Result<Vec<u8>, String> {
    if buffer.len() >= 4 && u32::from_le_bytes(buffer[0..4].try_into().unwrap()) == ZSTD_MAGIC {
        if let Ok(out) = decompress_by_walking_frames(buffer) {
            return Ok(out);
        }
    }
    decompress_by_magic(buffer)
}

/// Walk every zstd frame in `buffer` and decompress each one.
fn decompress_by_walking_frames(buffer: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(buffer.len().saturating_mul(4));
    let mut at = 0usize;
    while at < buffer.len() {
        let magic = read_u32_le(buffer, at)?;
        let end = frame_end(buffer, at)?;
        if end <= at {
            return Err(format!("zstd frame at byte {at} does not advance"));
        }
        if magic & ZSTD_SKIPPABLE_MASK != ZSTD_SKIPPABLE_MAGIC {
            decode_frame(&buffer[at..end], &mut out)?;
        }
        at = end;
    }
    Ok(out)
}

/// Decompress by scanning for frame magics and decoding each slice.
fn decompress_by_magic(buffer: &[u8]) -> Result<Vec<u8>, String> {
    let mut offsets = Vec::new();
    let mut at = 0usize;
    while at + 4 <= buffer.len() {
        if buffer[at..at + 4] == ZSTD_MAGIC_BYTES {
            offsets.push(at);
            at += 4;
        } else {
            at += 1;
        }
    }
    if offsets.is_empty() {
        return Err("session log is not a zstd stream".to_owned());
    }
    let mut out = Vec::with_capacity(buffer.len().saturating_mul(4));
    for (index, start) in offsets.iter().copied().enumerate() {
        let end = offsets.get(index + 1).copied().unwrap_or(buffer.len());
        decode_frame(&buffer[start..end], &mut out)?;
    }
    Ok(out)
}

/// Decompress exactly one frame into `out`, reusing the destination allocation.
fn decode_frame(frame: &[u8], out: &mut Vec<u8>) -> Result<(), String> {
    let mut decoder =
        zstd::stream::read::Decoder::new(frame).map_err(|error| format!("zstd: {error}"))?;
    std::io::copy(&mut decoder, out).map_err(|error| format!("zstd: {error}"))?;
    Ok(())
}

/// Compute where the zstd frame beginning at `start` ends, from its header and block headers alone.
fn frame_end(buffer: &[u8], start: usize) -> Result<usize, String> {
    let magic = read_u32_le(buffer, start)?;
    if magic & ZSTD_SKIPPABLE_MASK == ZSTD_SKIPPABLE_MAGIC {
        let payload = read_u32_le(buffer, start + 4)? as usize;
        return start
            .checked_add(8)
            .and_then(|value| value.checked_add(payload))
            .ok_or_else(|| format!("zstd skippable frame at byte {start} overflows"));
    }
    if magic != ZSTD_MAGIC {
        return Err(format!("unexpected zstd magic at byte {start}"));
    }

    let mut at = start + 4;
    let descriptor = read_u8(buffer, at)?;
    at += 1;
    let content_size_flag = descriptor >> 6;
    let single_segment = (descriptor >> 5) & 1 == 1;
    let checksum = (descriptor >> 2) & 1 == 1;
    let dictionary_flag = descriptor & 0x03;

    if !single_segment {
        at += 1;
    }
    at += DICTIONARY_ID_BYTES[dictionary_flag as usize];
    at += if content_size_flag == 0 {
        usize::from(single_segment)
    } else {
        CONTENT_SIZE_BYTES[(content_size_flag - 1) as usize]
    };

    loop {
        let header = read_u24_le(buffer, at)?;
        at += BLOCK_HEADER_BYTES;
        let last_block = header & 0x01 == 1;
        let block_type = (header >> 1) & 0x03;
        let block_size = (header >> 3) as usize;
        match block_type {
            // raw and compressed blocks carry a payload; an RLE block carries one byte.
            0 | 2 => at += block_size,
            1 => at += 1,
            _ => return Err("reserved zstd block type".to_owned()),
        }
        if last_block {
            break;
        }
    }
    if checksum {
        at += CHECKSUM_BYTES;
    }
    if at > buffer.len() {
        return Err("truncated zstd frame".to_owned());
    }
    Ok(at)
}

fn read_u32_le(buffer: &[u8], at: usize) -> Result<u32, String> {
    let slice = buffer
        .get(at..at + 4)
        .ok_or_else(|| format!("truncated zstd frame header at byte {at}"))?;
    Ok(u32::from_le_bytes(slice.try_into().unwrap()))
}

fn read_u8(buffer: &[u8], at: usize) -> Result<u8, String> {
    buffer
        .get(at)
        .copied()
        .ok_or_else(|| format!("truncated zstd frame header at byte {at}"))
}

fn read_u24_le(buffer: &[u8], at: usize) -> Result<u32, String> {
    let slice = buffer
        .get(at..at + BLOCK_HEADER_BYTES)
        .ok_or_else(|| format!("truncated zstd frame body at byte {at}"))?;
    Ok(u32::from(slice[0]) | (u32::from(slice[1]) << 8) | (u32::from(slice[2]) << 16))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(payload: &[u8]) -> Vec<u8> {
        zstd::encode_all(payload, 3).expect("compress")
    }

    #[test]
    fn decodes_one_frame() {
        let raw = frame(b"hello world");
        assert_eq!(decompress_session_log(&raw).unwrap(), b"hello world");
    }

    #[test]
    fn decodes_many_frames_appended() {
        let mut log = Vec::new();
        log.extend_from_slice(&frame(b"first\n"));
        log.extend_from_slice(&frame(b"second\n"));
        log.extend_from_slice(&frame(b"third\n"));
        assert_eq!(decompress_session_log(&log).unwrap(), b"first\nsecond\nthird\n");
    }

    #[test]
    fn rejects_non_zstd_input() {
        assert!(decompress_session_log(b"not zstd at all").is_err());
    }
}
