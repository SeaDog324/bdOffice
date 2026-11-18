//! Session-less archive commands backing the streaming save channel: the
//! TypeScript gateway generates patched entry contents, this module reads
//! individual entries and reassembles the package. Untouched entries are
//! copied as raw compressed bytes, so preservation holds by construction.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

use crate::SidecarError;
use crate::stream_patch::{read_patch_program, stream_patch_entry};
use crate::xml_util::copy_entry_bounded;

const MAX_ENTRY_COUNT: usize = 10_000;
/// Cap on a single decompressed entry handed to the patching layer. The
/// archive itself has no size limit — only entries the gateway edits must
/// fit in memory.
// Densely styled worksheets can exceed 256 MiB as XML while remaining
// ordinary workbooks on disk (the 88k-row suppliers fixture is ~307 MiB).
// Keep a finite anti-bomb / memory bound, but allow that real-world case.
// 500 MiB, not 512: the host patches entries as JavaScript strings, and
// V8's maximum string length is 536,870,888 bytes — an entry between that
// and 512 MiB would pass a 512 MiB cap and then fail to materialize.
pub(crate) const MAX_EXTRACTED_ENTRY_BYTES: u64 = 500 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    pub name: String,
    pub crc32: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedEntry {
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryContent {
    pub name: String,
    pub content_path: PathBuf,
}

/// An existing entry rewritten in a streaming pass: `patch_path` holds the
/// JSON cell-upsert program (see `stream_patch`). Used for parts above the
/// host's string-patching cap.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StreamPatchEntry {
    pub name: String,
    pub patch_path: PathBuf,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArchiveResult {
    pub before_entries: Vec<ArchiveEntry>,
    pub after_entries: Vec<ArchiveEntry>,
}

pub fn archive_manifest(path: &Path) -> Result<Vec<ArchiveEntry>, SidecarError> {
    let mut archive = open_validated(path)?;
    manifest_of(&mut archive)
}

/// Streams each entry through the XML parser and reports which ones contain
/// `needle` in their decoded text nodes. Constant memory: entity references
/// are decoded (openpyxl writes CJK as `&#NNNN;`), consecutive text events
/// accumulate until the enclosing element closes, and oversized runs keep a
/// sliding tail. Lets the gateway skip rewriting entries too large to patch
/// when they cannot reference the edited sheet.
pub fn scan_entries_for_text(
    path: &Path,
    names: &[String],
    needle: &str,
) -> Result<Vec<String>, SidecarError> {
    if needle.is_empty() {
        return Err(SidecarError::InvalidRequest(
            "Scan needle must not be empty.".into(),
        ));
    }
    let mut archive = open_validated(path)?;
    let mut matches = Vec::new();
    for name in names {
        let entry = crate::zip_entry(&mut archive, name)
            .map_err(|_| SidecarError::Workbook(format!("Workbook is missing {name}.")))?;
        if entry_text_contains(entry, needle)? {
            matches.push(name.clone());
        }
    }
    Ok(matches)
}

fn entry_text_contains(entry: impl std::io::Read, needle: &str) -> Result<bool, SidecarError> {
    use quick_xml::events::Event;
    // Text runs are searched when the element closes; the tail keeps needle
    // matches alive across the accumulation cap.
    const RUN_CAP: usize = 1 << 20;
    let mut reader = quick_xml::Reader::from_reader(std::io::BufReader::new(entry));
    let mut buf = Vec::new();
    let mut run = String::new();
    loop {
        let event = reader
            .read_event_into(&mut buf)
            .map_err(|error| SidecarError::Workbook(error.to_string()))?;
        match event {
            Event::Text(text) => {
                let decoded = text
                    .decode()
                    .map_err(|error| SidecarError::Workbook(error.to_string()))?;
                run.push_str(&decoded);
            }
            Event::GeneralRef(reference) => {
                run.push_str(&crate::general_ref_text(&reference)?);
            }
            Event::Eof => return Ok(run.contains(needle)),
            _ => {
                if run.contains(needle) {
                    return Ok(true);
                }
                run.clear();
            }
        }
        if run.len() > RUN_CAP {
            if run.contains(needle) {
                return Ok(true);
            }
            let keep = needle.len().saturating_mul(4).min(run.len());
            let mut cut = run.len() - keep;
            while !run.is_char_boundary(cut) {
                cut += 1;
            }
            run.drain(..cut);
        }
        buf.clear();
    }
}

pub fn read_entries_to_dir(
    path: &Path,
    names: &[String],
    output_dir: &Path,
) -> Result<Vec<ExtractedEntry>, SidecarError> {
    if !output_dir.is_dir() {
        return Err(SidecarError::InvalidRequest(
            "Entry output directory does not exist.".into(),
        ));
    }
    let mut archive = open_validated(path)?;
    let mut extracted = Vec::with_capacity(names.len());
    for (index, name) in names.iter().enumerate() {
        let mut entry = crate::zip_entry(&mut archive, name)
            .map_err(|_| SidecarError::Workbook(format!("Workbook is missing {name}.")))?;
        let declared = entry.size();
        if declared > MAX_EXTRACTED_ENTRY_BYTES {
            return Err(SidecarError::Workbook(format!(
                "Entry {name} is {declared} bytes uncompressed, above the {MAX_EXTRACTED_ENTRY_BYTES} byte patch limit."
            )));
        }
        let output_path = output_dir.join(format!("entry-{index}.bin"));
        let mut output = BufWriter::new(File::create(&output_path)?);
        copy_entry_bounded(&mut entry, declared, MAX_EXTRACTED_ENTRY_BYTES, &mut output)?;
        output.flush()?;
        extracted.push(ExtractedEntry {
            name: name.clone(),
            path: output_path,
        });
    }
    Ok(extracted)
}

pub fn save_archive(
    source_path: &Path,
    target_path: &Path,
    replacements: &[EntryContent],
    removals: &[String],
    additions: &[EntryContent],
    stream_patches: &[StreamPatchEntry],
) -> Result<SaveArchiveResult, SidecarError> {
    if crate::canonicalize(source_path)? == crate::canonicalize(target_path).unwrap_or_default() {
        return Err(SidecarError::InvalidRequest(
            "Save target must differ from the source archive.".into(),
        ));
    }
    let mut archive = open_validated(source_path)?;
    let before_entries = manifest_of(&mut archive)?;
    let source_names: HashSet<&str> = before_entries
        .iter()
        .map(|entry| entry.name.as_str())
        .collect();
    validate_edit_sets(&source_names, replacements, removals, additions, stream_patches)?;

    let replacement_by_name: std::collections::HashMap<&str, &EntryContent> = replacements
        .iter()
        .map(|item| (item.name.as_str(), item))
        .collect();
    let stream_patch_by_name: std::collections::HashMap<&str, &StreamPatchEntry> = stream_patches
        .iter()
        .map(|item| (item.name.as_str(), item))
        .collect();
    let removal_set: HashSet<&str> = removals.iter().map(String::as_str).collect();

    let target_file = File::create(target_path)?;
    let mut writer = ZipWriter::new(target_file);
    let names = canonical_names(&archive);
    for (index, name) in names.into_iter().enumerate() {
        let Some(name) = name else { continue };
        if removal_set.contains(name.as_str()) {
            continue;
        }
        match (replacement_by_name.get(name.as_str()), stream_patch_by_name.get(name.as_str())) {
            (Some(replacement), _) => write_entry(&mut writer, &name, &replacement.content_path)?,
            (None, Some(patched)) => {
                let program = read_patch_program(&patched.patch_path)?;
                let options = SimpleFileOptions::default()
                    .compression_method(CompressionMethod::Deflated)
                    .large_file(true);
                writer.start_file(name.as_str(), options)?;
                let entry = archive.by_index(index)?;
                stream_patch_entry(entry, &mut writer, &program)?;
            }
            (None, None) => writer.raw_copy_file_rename(archive.by_index_raw(index)?, &name)?,
        }
    }
    for addition in additions {
        write_entry(&mut writer, &addition.name, &addition.content_path)?;
    }
    let target_file = writer.finish()?;
    sync_best_effort(&target_file)?;

    let mut saved = ZipArchive::new(File::open(target_path)?)?;
    Ok(SaveArchiveResult {
        before_entries,
        after_entries: manifest_of(&mut saved)?,
    })
}

/// SMB mounts on macOS answer `F_FULLFSYNC` with ENOTSUP, and some cloud-sync
/// or network filesystems refuse fsync outright. The bytes are already
/// written, so a refused flush only weakens power-loss durability and must
/// not fail the save (mirrors the Node writer's tolerated codes).
pub(crate) fn sync_best_effort(file: &File) -> io::Result<()> {
    match file.sync_all() {
        Err(error) if is_tolerated_sync_error(&error) => Ok(()),
        result => result,
    }
}

// ENOTSUP is `Uncategorized` in std on macOS, so match the errno directly.
#[cfg(target_os = "macos")]
const TOLERATED_SYNC_ERRNOS: [i32; 2] = [45, 78]; // ENOTSUP, ENOSYS
#[cfg(target_os = "linux")]
const TOLERATED_SYNC_ERRNOS: [i32; 2] = [95, 38]; // EOPNOTSUPP, ENOSYS
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
const TOLERATED_SYNC_ERRNOS: [i32; 0] = [];

fn is_tolerated_sync_error(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::Unsupported
            | io::ErrorKind::InvalidInput
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::ResourceBusy
    ) || error
        .raw_os_error()
        .is_some_and(|raw| TOLERATED_SYNC_ERRNOS.contains(&raw))
}

fn write_entry(
    writer: &mut ZipWriter<File>,
    name: &str,
    content_path: &Path,
) -> Result<(), SidecarError> {
    let content = fs::read(content_path)?;
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .large_file(content.len() as u64 >= u64::from(u32::MAX));
    writer.start_file(name, options)?;
    writer.write_all(&content)?;
    Ok(())
}

fn validate_edit_sets(
    source_names: &HashSet<&str>,
    replacements: &[EntryContent],
    removals: &[String],
    additions: &[EntryContent],
    stream_patches: &[StreamPatchEntry],
) -> Result<(), SidecarError> {
    let mut seen: HashSet<&str> = HashSet::new();
    let edited = replacements
        .iter()
        .map(|item| item.name.as_str())
        .chain(removals.iter().map(String::as_str))
        .chain(additions.iter().map(|item| item.name.as_str()))
        .chain(stream_patches.iter().map(|item| item.name.as_str()));
    for name in edited {
        if !seen.insert(name) {
            return Err(SidecarError::InvalidRequest(format!(
                "Entry {name} appears in more than one edit set."
            )));
        }
        if !is_safe_entry_name(name) {
            return Err(SidecarError::InvalidRequest(format!(
                "Entry {name} has an unsafe archive path."
            )));
        }
    }
    for replacement in replacements {
        if !source_names.contains(replacement.name.as_str()) {
            return Err(SidecarError::InvalidRequest(format!(
                "Cannot replace missing entry {}.",
                replacement.name
            )));
        }
    }
    for removal in removals {
        if !source_names.contains(removal.as_str()) {
            return Err(SidecarError::InvalidRequest(format!(
                "Cannot remove missing entry {removal}."
            )));
        }
    }
    for addition in additions {
        if source_names.contains(addition.name.as_str()) {
            return Err(SidecarError::InvalidRequest(format!(
                "Cannot add entry {} — it already exists.",
                addition.name
            )));
        }
    }
    for patched in stream_patches {
        if !source_names.contains(patched.name.as_str()) {
            return Err(SidecarError::InvalidRequest(format!(
                "Cannot stream-patch missing entry {}.",
                patched.name
            )));
        }
    }
    if source_names.len() + additions.len() > MAX_ENTRY_COUNT {
        return Err(SidecarError::InvalidRequest(
            "Saving would exceed the archive entry limit.".into(),
        ));
    }
    Ok(())
}

fn is_safe_entry_name(name: &str) -> bool {
    !name.is_empty() && canonical_entry_name(name).as_deref() == Some(name)
}

pub(crate) fn resolve_relationship_target(
    source_path: &str,
    target: &str,
) -> Result<String, SidecarError> {
    let target = target.trim();
    let target = target
        .split_once('#')
        .map(|(path, _)| path)
        .unwrap_or(target);
    let decoded = crate::xml_util::decode_uri_path(target)?;
    if decoded.is_empty()
        || decoded.contains('\0')
        || decoded.starts_with("//")
        || decoded.starts_with('\\')
        || has_uri_scheme(&decoded)
    {
        return Err(SidecarError::Workbook(
            "OOXML relationship target is malformed or unsafe.".into(),
        ));
    }
    let source = source_path.replace('\\', "/");
    let mut parts: Vec<String> = if decoded.starts_with('/') {
        Vec::new()
    } else {
        let mut source_parts: Vec<&str> = source
            .split('/')
            .filter(|segment| !segment.is_empty() && *segment != ".")
            .collect();
        source_parts.pop();
        source_parts.into_iter().map(str::to_owned).collect()
    };
    for segment in decoded.replace('\\', "/").split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return Err(SidecarError::Workbook(
                        "OOXML relationship escapes the package.".into(),
                    ));
                }
            }
            value => parts.push(value.to_owned()),
        }
    }
    if parts.is_empty() {
        return Err(SidecarError::Workbook(
            "OOXML relationship target is malformed or unsafe.".into(),
        ));
    }
    Ok(parts.join("/"))
}

fn has_uri_scheme(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    for character in characters {
        if character == ':' {
            return true;
        }
        if !(character.is_ascii_alphanumeric() || matches!(character, '+' | '-' | '.')) {
            return false;
        }
    }
    false
}

/// The package-relative form of a ZIP entry name: '\' separators, a leading
/// '/', `./` and empty segments are producer quirks Excel tolerates
/// (genoffice#196 shipped `/xl/workbook.xml`). None only when the name
/// escapes the package root, which is the one case worth rejecting since
/// entries are never extracted onto the filesystem.
pub(crate) fn canonical_entry_name(raw: &str) -> Option<String> {
    if raw.contains('\0') {
        return None;
    }
    let mut segments: Vec<&str> = Vec::new();
    for segment in raw.split(['/', '\\']) {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            segment => segments.push(segment),
        }
    }
    let mut name = segments.join("/");
    if raw.ends_with(['/', '\\']) && !name.is_empty() {
        name.push('/');
    }
    Some(name)
}

pub(crate) fn validate_entries(archive: &mut ZipArchive<File>) -> Result<(), SidecarError> {
    if archive.len() > MAX_ENTRY_COUNT {
        return Err(SidecarError::Workbook(
            "Workbook contains too many ZIP entries.".into(),
        ));
    }
    for index in 0..archive.len() {
        let entry = archive.by_index_raw(index)?;
        let safe = entry
            .name()
            .ok()
            .and_then(|name| canonical_entry_name(&name))
            .is_some();
        if !safe {
            return Err(SidecarError::Workbook(
                "Workbook contains an unsafe ZIP path.".into(),
            ));
        }
    }
    Ok(())
}

fn open_validated(path: &Path) -> Result<ZipArchive<File>, SidecarError> {
    let mut archive = ZipArchive::new(File::open(path)?)?;
    validate_entries(&mut archive)?;
    Ok(archive)
}

/// Canonical name of every entry, first occurrence winning when two raw
/// names collapse to the same canonical one (matches `zip_entry` lookup).
fn canonical_names(archive: &ZipArchive<File>) -> Vec<Option<String>> {
    let mut seen = HashSet::new();
    (0..archive.len())
        .map(|index| {
            let raw = archive.name_for_index(index)?.ok()?;
            let name = canonical_entry_name(&raw)?;
            (!name.is_empty() && seen.insert(name.clone())).then_some(name)
        })
        .collect()
}

fn manifest_of(archive: &mut ZipArchive<File>) -> Result<Vec<ArchiveEntry>, SidecarError> {
    let names = canonical_names(archive);
    let mut entries = Vec::with_capacity(archive.len());
    for (index, name) in names.into_iter().enumerate() {
        let Some(name) = name.filter(|name| !name.ends_with('/')) else {
            continue;
        };
        let entry = archive.by_index_raw(index)?;
        entries.push(ArchiveEntry {
            name,
            crc32: entry.crc32(),
            compressed_size: entry.compressed_size(),
            uncompressed_size: entry.size(),
        });
    }
    entries.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(entries)
}
