//! IronCalc-backed formula recalculation with a session-resident model cache.
//!
//! The first request for a workbook loads it into IronCalc's model; later
//! requests reuse that model and only apply the edits that changed, so a
//! debounced keystroke pays evaluate() instead of a full file import. The
//! cache invalidates itself when the file on disk changes (mtime+size) and
//! rebuilds when the edit set shrinks (an undo must restore file content the
//! model no longer has). The caller stays fail-soft: any load or evaluation
//! problem (including panics from IronCalc's strict importer) surfaces as a
//! normal sidecar error and the renderer keeps showing cached values.

use std::collections::HashMap;
use std::io::Read;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use ironcalc::base::Model;
use ironcalc::base::types::{Cell, CellType, FormulaValue, SpillValue};
use serde::{Deserialize, Serialize};

use crate::rels_normalize::load_model;
use crate::{CellRange, SidecarError};

pub const MAX_RECALC_EDITS: usize = 10_000;
pub const MAX_RECALC_READ_CELLS: usize = 20_000;
/// Resident models are large (the whole workbook's cell graph); the sidecar
/// serves one document, so two covers the active file plus one recently
/// closed-and-reopened neighbour.
const MAX_RESIDENT_MODELS: usize = 2;
/// Source files above this size (compressed bytes) count as heavy for the
/// residency rule in `evict_beyond_cap`.
const HEAVY_SOURCE_BYTES: u64 = 8_000_000;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcEdit {
    pub sheet: String,
    /// 0-based coordinates on the wire (IronCalc itself is 1-based).
    pub row: u32,
    pub column: u32,
    /// User input: `=SUM(A1:A3)`, `42`, `text`; empty clears.
    pub input: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcRead {
    pub sheet: String,
    pub range: CellRange,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcCell {
    pub sheet: String,
    pub row: u32,
    pub column: u32,
    /// Display string after evaluation (number formats applied).
    pub formatted: String,
    /// Raw numeric value when the cell evaluates to a number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<f64>,
    /// Raw boolean when the cell evaluates to a boolean (`=A1>3`): the cache
    /// for one is `t="b"` with the numeric 0/1, not the text `TRUE`/`FALSE`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boolean: Option<bool>,
    /// The engine typed the result as an error (`#DIV/0!`), as opposed to a
    /// formula whose text result merely spells one (`="#N/A"`).
    pub is_error: bool,
    pub is_formula: bool,
}

/// Why a requested stale-cache audit came back without an answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AuditSkipReason {
    /// The workbook uses the 1904 date system (`<workbookPr date1904="1"/>`).
    /// IronCalc 0.9.1 has no date1904 handling — nothing in the engine reads
    /// the flag — so every date result it computes is 1462 days away from the
    /// value Excel cached. Comparing the two would overwrite correct caches.
    #[serde(rename = "date1904")]
    Date1904,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecalcResult {
    pub cells: Vec<RecalcCell>,
    /// True when a resident model served this request (no file re-import).
    pub cached: bool,
    /// Formula cells whose computed value differs from the cached `<v>` the
    /// file carried on import. Only present when the request asked for it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale: Option<Vec<RecalcCell>>,
    /// Spill cells of a dynamic or CSE array formula whose cached `<v>` no
    /// longer matches what the anchor computes. They carry no formula of
    /// their own, so a caller cannot refresh them in place: this list is for
    /// reporting, not for patching.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_spill_cells: Option<Vec<RecalcCell>>,
    /// Formula and spill cells whose cache was kept although the engine now
    /// computes an error: the audit never downgrades a usable cache to an
    /// engine error (RATE/TEXT-style engine gaps), but a changed input can
    /// legitimately turn a dependent into `#DIV/0!`/`#N/A`, so these caches
    /// may be wrong. They were not refreshed — a caller may not claim the
    /// cached values are current while this list is non-empty.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stale_unrefreshed: Option<Vec<RecalcCell>>,
    /// Set when the audit was requested but deliberately skipped; `stale` and
    /// `stale_spill_cells` are then absent and the caches were not checked.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audit_skipped: Option<AuditSkipReason>,
}

type EditKey = (String, u32, u32);

struct ResidentModel {
    model: Model<'static>,
    mtime: SystemTime,
    size: u64,
    /// Edits already in the model, keyed by cell; a request whose edit set no
    /// longer covers these keys forces a rebuild (only the file knows the
    /// original content of a reverted cell).
    applied: HashMap<EditKey, String>,
    last_used: u64,
}

#[derive(Default)]
pub struct RecalcCache {
    entries: HashMap<PathBuf, ResidentModel>,
    tick: u64,
}

impl RecalcCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Drop the model for a path whose bytes are about to change (save) or
    /// whose session closed.
    pub fn purge(&mut self, path: &Path) {
        self.entries.remove(&cache_key(path));
    }

    fn evict_beyond_cap(&mut self) {
        while self.entries.len() > MAX_RESIDENT_MODELS {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.last_used)
                .map(|(path, _)| path.clone())
            else {
                return;
            };
            self.entries.remove(&oldest);
        }
        // Heavy sources import into models that dwarf everything else in the
        // process (a 31MB workbook's model holds ~1.2GB resident); keep at
        // most one of those — the most recently used.
        loop {
            let mut heavy: Vec<(PathBuf, u64)> = self
                .entries
                .iter()
                .filter(|(_, entry)| entry.size > HEAVY_SOURCE_BYTES)
                .map(|(path, entry)| (path.clone(), entry.last_used))
                .collect();
            if heavy.len() <= 1 {
                return;
            }
            heavy.sort_by_key(|(_, last_used)| *last_used);
            let Some((oldest, _)) = heavy.first() else {
                return;
            };
            self.entries.remove(&oldest.clone());
        }
    }
}

/// Cache keys are canonicalized: sessions store the canonical workbook path
/// (open() resolves it) while recalc requests carry the renderer's raw path,
/// and on macOS temp files those differ (/var vs /private/var) — a raw key
/// would make the close/save purge miss the resident model.
fn cache_key(path: &Path) -> PathBuf {
    crate::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

pub fn recalc_cells(
    cache: &mut RecalcCache,
    path: &Path,
    edits: &[RecalcEdit],
    reads: &[RecalcRead],
) -> Result<RecalcResult, SidecarError> {
    recalc_cells_reporting(cache, path, edits, reads, false)
}

/// [`recalc_cells`] with an optional stale-cache audit: with `report_stale`
/// the result lists every formula cell whose computed value differs from the
/// cached `<v>` the file carried on import, plus the array spill cells it
/// cannot refresh. The audit compares against values only an import stages, so
/// it always works on a fresh model (`cached: false`) — unless it is skipped,
/// which for now means a `date1904` workbook (`audit_skipped`), where the
/// engine's date results cannot be trusted against the file's caches.
pub fn recalc_cells_reporting(
    cache: &mut RecalcCache,
    path: &Path,
    edits: &[RecalcEdit],
    reads: &[RecalcRead],
    report_stale: bool,
) -> Result<RecalcResult, SidecarError> {
    if edits.len() > MAX_RECALC_EDITS {
        return Err(SidecarError::InvalidRequest(format!(
            "Too many recalc edits (limit {MAX_RECALC_EDITS})."
        )));
    }
    let read_cells: usize = reads
        .iter()
        .map(|read| {
            let rows = read.range.end_row.saturating_sub(read.range.start_row) + 1;
            let columns = read
                .range
                .end_column
                .saturating_sub(read.range.start_column)
                + 1;
            rows.saturating_mul(columns)
        })
        .sum();
    if read_cells > MAX_RECALC_READ_CELLS {
        return Err(SidecarError::InvalidRequest(format!(
            "Recalc read exceeds {MAX_RECALC_READ_CELLS} cells."
        )));
    }
    // An edit can only leave a cached formula value stale when the workbook
    // holds formulas at all. Finding that out by importing costs seconds on a
    // formula-free data workbook, so scan the worksheet parts first.
    if report_stale && reads.is_empty() && !workbook_has_formulas(path)? {
        return Ok(RecalcResult {
            cells: Vec::new(),
            cached: false,
            stale: Some(Vec::new()),
            stale_spill_cells: Some(Vec::new()),
            stale_unrefreshed: Some(Vec::new()),
            audit_skipped: None,
        });
    }
    // IronCalc 0.9.1 ignores workbookPr@date1904, so on a 1904-system workbook
    // every date it computes is 1462 days from the file's cache. The audit
    // would compare those caches against a wrong answer and overwrite values
    // Excel wrote correctly; skip it and tell the caller the caches were not
    // checked. Reads still run: the caller asked for values, not for the audit.
    let audit_skipped = if report_stale && workbook_uses_1904_dates(path)? {
        Some(AuditSkipReason::Date1904)
    } else {
        None
    };
    let report_stale = report_stale && audit_skipped.is_none();

    let metadata = std::fs::metadata(path).map_err(|error| SidecarError::Io(error.to_string()))?;
    let mtime = metadata
        .modified()
        .map_err(|error| SidecarError::Io(error.to_string()))?;
    let size = metadata.len();

    let key = cache_key(path);
    // Take the entry out while working on it: a panic or error mid-apply
    // leaves the model in an unknown state, and a removed entry can never be
    // reused by the next request.
    let resident = cache.entries.remove(&key).filter(|entry| {
        entry.mtime == mtime
            && entry.size == size
            && entry.applied.keys().all(|key| {
                edits
                    .iter()
                    .any(|edit| edit.sheet == key.0 && edit.row == key.1 && edit.column == key.2)
            })
    });
    // The audit compares against the caches the import staged; a resident
    // model has already evaluated them away.
    let resident = if report_stale { None } else { resident };
    let cached = resident.is_some();

    // IronCalc's importer is strict and can panic on non-Excel producers
    // (missing cellStyles, whitespace nodes); contain that to this request.
    let (entry, cells, stale_audit) = catch_unwind(AssertUnwindSafe(|| {
        run(resident, path, mtime, size, edits, reads, report_stale)
    }))
    .map_err(|_| {
        SidecarError::Workbook("The formula engine could not process this workbook.".into())
    })??;

    cache.tick += 1;
    let mut entry = entry;
    entry.last_used = cache.tick;
    cache.entries.insert(key, entry);
    cache.evict_beyond_cap();

    let (stale, stale_spill_cells, stale_unrefreshed) = match stale_audit {
        Some(audit) => (
            Some(audit.cells),
            Some(audit.spill_cells),
            Some(audit.unrefreshed),
        ),
        None => (None, None, None),
    };
    Ok(RecalcResult {
        cells,
        cached,
        stale,
        stale_spill_cells,
        stale_unrefreshed,
        audit_skipped,
    })
}

/// What the fresh import's staged caches no longer agree with: formula cells
/// (patchable on save), array spill cells (report only, see `RecalcResult`)
/// and the cells whose cache was kept against an engine error
/// (`unrefreshed`, also report only).
struct StaleAudit {
    cells: Vec<RecalcCell>,
    spill_cells: Vec<RecalcCell>,
    unrefreshed: Vec<RecalcCell>,
}

fn run(
    resident: Option<ResidentModel>,
    path: &Path,
    mtime: SystemTime,
    size: u64,
    edits: &[RecalcEdit],
    reads: &[RecalcRead],
    report_stale: bool,
) -> Result<(ResidentModel, Vec<RecalcCell>, Option<StaleAudit>), SidecarError> {
    let mut entry = match resident {
        Some(entry) => entry,
        None => {
            let mut model = load_model(path)?;
            requote_bare_sheet_names(&mut model);
            pin_unparsable_formulas(&mut model);
            ResidentModel {
                model,
                mtime,
                size,
                applied: HashMap::new(),
                last_used: 0,
            }
        }
    };

    // The staged `<v>` values are the file's own caches: they only exist
    // before the first evaluation replaces them with the engine's results.
    let cached_values = report_stale.then(|| snapshot_cached_values(&entry.model));

    let mut dirty = false;
    for edit in edits {
        let key = (edit.sheet.clone(), edit.row, edit.column);
        if entry.applied.get(&key) == Some(&edit.input) {
            continue;
        }
        let sheet = sheet_index(&entry.model, &edit.sheet)?;
        entry
            .model
            .set_user_input(
                sheet,
                edit.row as i32 + 1,
                edit.column as i32 + 1,
                edit.input.clone(),
            )
            .map_err(|error| {
                SidecarError::Workbook(format!("Formula engine rejected an edit: {error}"))
            })?;
        entry.applied.insert(key, edit.input.clone());
        dirty = true;
    }
    if dirty || entry.last_used == 0 {
        entry.model.evaluate();
    }

    let mut cells = Vec::new();
    for read in reads {
        let sheet = sheet_index(&entry.model, &read.sheet)?;
        for row in read.range.start_row..=read.range.end_row {
            for column in read.range.start_column..=read.range.end_column {
                let row_1 = row as i32 + 1;
                let column_1 = column as i32 + 1;
                let formatted = entry
                    .model
                    .get_formatted_cell_value(sheet, row_1, column_1)
                    .unwrap_or_default();
                let formula = entry
                    .model
                    .get_cell_formula(sheet, row_1, column_1)
                    .ok()
                    .flatten();
                let is_formula = formula.is_some();
                if formatted.is_empty() && !is_formula {
                    continue;
                }
                // Known engine gap where the file's cached value beats the
                // error: RATE's Newton solver dies near -100% where Excel
                // converges (#185).
                if formatted == "#NUM!" {
                    if let Some(text) = &formula {
                        if text.to_uppercase().contains("RATE(") {
                            continue;
                        }
                    }
                }
                let number = raw_number(&entry.model, sheet, row_1, column_1);
                let boolean = raw_boolean(&entry.model, sheet, row_1, column_1);
                let is_error = matches!(
                    entry.model.get_cell_type(sheet, row_1, column_1),
                    Ok(CellType::ErrorValue)
                );
                cells.push(RecalcCell {
                    sheet: read.sheet.clone(),
                    row: row as u32,
                    column: column as u32,
                    formatted,
                    number,
                    boolean,
                    is_error,
                    is_formula,
                });
            }
        }
    }
    let stale = cached_values.map(|cached| stale_cached_values(&entry.model, cached));
    Ok((entry, cells, stale))
}

/// IronCalc writes a sheet name that needs quoting without its quotes when it
/// converts an imported formula to R1C1: `name_needs_quoting`
/// (`expressions/utils`) lists only `()'$,;-+{}` and space, so a name holding
/// an `&` — `R&D`, `P&L` — slips through. The stored `R&D!R[-17]C[0]` never
/// parses again, and every reference to that sheet is lost along with
/// everything that depends on it.
///
/// Put the quotes back and re-parse. The text is the engine's own R1C1 and
/// the sheet is one of this workbook's, so this restores what the file said
/// rather than guessing at it: a formula is rewritten only when it already
/// failed to parse and only when the quoted form parses cleanly.
fn requote_bare_sheet_names(model: &mut Model) {
    use std::sync::Arc;

    use ironcalc::base::expressions::lexer::LexerMode;
    use ironcalc::base::expressions::parser::{
        Node, new_parser_english, static_analysis::StaticResult,
    };
    use ironcalc::base::expressions::types::CellReferenceRC;

    let names: Vec<String> = model
        .workbook
        .worksheets
        .iter()
        .map(|worksheet| worksheet.name.clone())
        .collect();
    let mut parser = new_parser_english(
        names.clone(),
        model.workbook.get_defined_names_with_scope(),
        model.workbook.tables.clone(),
    );
    parser.set_lexer_mode(LexerMode::R1C1);

    for (sheet, worksheet) in model.workbook.worksheets.iter_mut().enumerate() {
        let Some(parsed) = model.parsed_formulas.get_mut(sheet) else {
            continue;
        };
        // Stored R1C1 is not tied to a cell, so the sheet is the whole
        // context — the same one `Model::parse_formulas` uses.
        let context = CellReferenceRC {
            sheet: worksheet.name.clone(),
            row: 1,
            column: 1,
        };
        for (index, formula) in worksheet.shared_formulas.iter_mut().enumerate() {
            if !matches!(
                parsed.get(index),
                Some((node, _)) if matches!(node.as_ref(), Node::ParseErrorKind { .. })
            ) {
                continue;
            }
            let Some(quoted) = quote_bare_sheet_names(formula, &names) else {
                continue;
            };
            let node = parser.parse(&quoted, &context);
            if matches!(node, Node::ParseErrorKind { .. }) {
                continue;
            }
            // `run_static_analysis_on_node` is crate-private, so the repaired
            // node carries `Unknown`: evaluation then assumes nothing about
            // arrays or implicit intersection, which is the right reading for
            // a formula that failed to parse a moment ago.
            parsed[index] = (Arc::new(node), StaticResult::Unknown);
            *formula = quoted;
        }
    }
}

/// Wraps every bare `Name!` reference to one of `names` in quotes, doubling
/// any `'` inside the name as Excel does. Returns None when there was nothing
/// to quote. Text literals and already-quoted names are copied through
/// untouched, so a formula that merely spells a sheet name inside a string is
/// left alone.
fn quote_bare_sheet_names(formula: &str, names: &[String]) -> Option<String> {
    let mut out = String::with_capacity(formula.len());
    let mut index = 0;
    let mut in_text = false;
    let mut in_quoted_name = false;
    let mut changed = false;
    while index < formula.len() {
        let Some(char) = formula[index..].chars().next() else {
            break;
        };
        if in_text || in_quoted_name {
            // A doubled quote toggles off and straight back on, which lands
            // in the same state an escape should leave us in.
            if char == '"' && in_text {
                in_text = false;
            } else if char == '\'' && in_quoted_name {
                in_quoted_name = false;
            }
            out.push(char);
            index += char.len_utf8();
            continue;
        }
        if char == '"' || char == '\'' {
            if char == '"' {
                in_text = true;
            } else {
                in_quoted_name = true;
            }
            out.push(char);
            index += char.len_utf8();
            continue;
        }
        // Longest wins: "R&D" must not shadow "R&D Notes".
        let matched = names
            .iter()
            .filter(|name| !name.is_empty() && formula[index..].starts_with(&format!("{name}!")))
            .max_by_key(|name| name.len());
        if let Some(name) = matched
            && !continues_a_sheet_name(&formula[..index])
        {
            out.push('\'');
            out.push_str(&name.replace('\'', "''"));
            out.push_str("'!");
            index += name.len() + 1;
            changed = true;
            continue;
        }
        out.push(char);
        index += char.len_utf8();
    }
    changed.then_some(out)
}

enum PinnedValue {
    Number(f64),
    Text(String),
    Bool(bool),
}

/// IronCalc cannot parse external-workbook references (`[1]Sheet1!A1`):
/// such a formula evaluates to #ERROR! and the error cascades through every
/// dependent. Excel keeps the cached values when the linked workbook is
/// unreachable, so pin those cells to the value the file carries and let the
/// dependents compute against it. The renderer never sees the cell as a
/// formula afterwards, so its own cached copy stays on screen.
///
/// A formula still naming a sheet of *this* workbook after
/// `requote_bare_sheet_names` has had its turn is excluded: the data is in
/// the file, so a parse failure there is an engine gap, not an unreachable
/// source, and the cached value is not an answer — a file written without
/// cached values (openpyxl writes an empty `<v/>`) imports as zero, which
/// would pin a number nobody computed. Those cells keep their #ERROR!,
/// which the renderer already declines to display.
/// Also the pin behind the external-links update pass
/// (`external_links::update_external_link_values`): its throwaway model must
/// keep the same caches standing so rewritten cells' dependents compute
/// against them instead of cascading #ERROR!.
pub(crate) fn pin_unparsable_formulas(model: &mut Model) {
    use ironcalc::base::expressions::parser::Node;
    let names: Vec<String> = model
        .workbook
        .worksheets
        .iter()
        .map(|worksheet| worksheet.name.clone())
        .collect();
    let mut pins = Vec::new();
    for (sheet, worksheet) in model.workbook.worksheets.iter().enumerate() {
        let Some(parsed) = model.parsed_formulas.get(sheet) else {
            continue;
        };
        for (row, column, cell) in worksheet.sheet_data.cells() {
            let (formula, value) = match cell.as_ref() {
                Cell::CellFormula {
                    f,
                    v: FormulaValue::Number(v),
                    ..
                } => (*f, PinnedValue::Number(*v)),
                Cell::CellFormula {
                    f,
                    v: FormulaValue::Text(v),
                    ..
                } => (*f, PinnedValue::Text(v.clone())),
                Cell::CellFormula {
                    f,
                    v: FormulaValue::Boolean(v),
                    ..
                } => (*f, PinnedValue::Bool(*v)),
                _ => continue,
            };
            let unparsable = matches!(
                parsed.get(formula as usize),
                Some((node, _)) if matches!(node.as_ref(), Node::ParseErrorKind { .. })
            );
            let text = worksheet
                .shared_formulas
                .get(formula as usize)
                .map(String::as_str)
                .unwrap_or_default();
            if references_a_sheet_of_this_workbook(text, &names) {
                continue;
            }
            // 0.9.x parses an external-workbook reference instead of leaving a
            // parse error behind, and evaluation of it still lands on #REF!:
            // the cached value is the only truth for those cells either way.
            if !(unparsable || references_an_external_workbook(text)) {
                continue;
            }
            pins.push((sheet as u32, row, column, value));
        }
    }
    for (sheet, row, column, value) in pins {
        // A pin that fails leaves the cell as it was: #ERROR! on that cell,
        // which the renderer already declines to display.
        let _ = match value {
            PinnedValue::Number(number) => {
                model.update_cell_with_number(sheet, row, column, number)
            }
            PinnedValue::Text(text) => model.update_cell_with_text(sheet, row, column, &text),
            PinnedValue::Bool(flag) => model.update_cell_with_bool(sheet, row, column, flag),
        };
    }
}

/// True when the formula text carries a bare `Name!` reference to one of the
/// workbook's own sheets. The prefix test rejects the external-workbook forms
/// (`[1]Sheet1!A1`, `'[1]Sheet1'!A1`) and any longer name that merely ends in
/// this one.
fn references_a_sheet_of_this_workbook(formula: &str, names: &[String]) -> bool {
    let code = blank_text_literals(formula);
    names.iter().any(|name| {
        !name.is_empty()
            && code
                .match_indices(&format!("{name}!"))
                .any(|(at, _)| at == 0 || !continues_a_sheet_name(&code[..at]))
    })
}

/// True when the formula reads from another workbook — `[1]Sheet1!A1` or
/// `'[1]Sheet1'!A1`. IronCalc resolves no external data whether the
/// reference parses or not, so the file's cached value is the only truth.
/// A digits-only `[N]` is not enough on its own — an R1C1 offset brackets a
/// number too (`C[0]`) — so the bracket must be followed by a sheet name
/// and `!` to count as a workbook index. A name with spaces or CJK
/// characters only appears quoted, and Excel forbids `[` inside a sheet
/// name, so a `'` right before the bracket is always the external form.
pub(crate) fn references_an_external_workbook(formula: &str) -> bool {
    let code = blank_text_literals(formula);
    let bytes = code.as_bytes();
    for (at, byte) in bytes.iter().enumerate() {
        if *byte != b'[' {
            continue;
        }
        let mut end = at + 1;
        while end < bytes.len() && bytes[end].is_ascii_digit() {
            end += 1;
        }
        if end == at + 1 || end >= bytes.len() || bytes[end] != b']' {
            continue;
        }
        // `'[1]Sheet Name'!A1` — the opening quote precedes the bracket, so
        // the sheet name runs to the closing quote: spaces, CJK, anything
        if at > 0 && bytes[at - 1] == b'\'' {
            let mut close = end + 1;
            while close < bytes.len() && bytes[close] != b'\'' {
                close += 1;
            }
            if bytes.get(close + 1) == Some(&b'!') {
                return true;
            }
            continue;
        }
        let mut after = end + 1;
        if bytes.get(after) == Some(&b'\'') {
            after += 1;
        }
        let name_start = after;
        // word characters, or any non-ASCII byte: a CJK sheet name needs no
        // quotes (`[1]<cjk-name>!A1`), while a space does and lands in the branch above
        while after < bytes.len()
            && (bytes[after].is_ascii_alphanumeric()
                || bytes[after] == b'_'
                || bytes[after] >= 0x80)
        {
            after += 1;
        }
        if after > name_start && bytes.get(after) == Some(&b'\'') {
            after += 1;
        }
        if bytes.get(after) == Some(&b'!') {
            return true;
        }
    }
    false
}

/// The formula with every `"..."` literal replaced by spaces of the same byte
/// length, so a sheet name mentioned inside text does not count as a reference
/// and byte offsets still line up with the original. Also the span gate for
/// the external-links rewrite: a `[1]Sheet!A1` inside a string literal is
/// text, never a span to inline.
pub(crate) fn blank_text_literals(formula: &str) -> String {
    let mut out = String::with_capacity(formula.len());
    let mut in_text = false;
    for char in formula.chars() {
        if char == '"' {
            in_text = !in_text;
            out.push(char);
        } else if in_text {
            out.extend(std::iter::repeat_n(' ', char.len_utf8()));
        } else {
            out.push(char);
        }
    }
    out
}

fn continues_a_sheet_name(before: &str) -> bool {
    match before.chars().next_back() {
        // ']' closes an external-workbook index, '\'' closes a quoted name
        // (which parses fine and never reaches here), '!' a 3-D range.
        Some(']') | Some('\'') | Some('!') => true,
        Some(char) => char.is_alphanumeric() || char == '_' || char == '.',
        None => false,
    }
}

fn sheet_index(model: &Model, name: &str) -> Result<u32, SidecarError> {
    model
        .workbook
        .worksheets
        .iter()
        .position(|worksheet| worksheet.name == name)
        .map(|index| index as u32)
        .ok_or_else(|| SidecarError::InvalidRequest(format!("Unknown sheet: {name}")))
}

fn raw_number(model: &Model, sheet: u32, row: i32, column: i32) -> Option<f64> {
    use ironcalc::base::cell::CellValue;
    match model.get_cell_value_by_index(sheet, row, column) {
        Ok(CellValue::Number(value)) => Some(value),
        _ => None,
    }
}

fn raw_boolean(model: &Model, sheet: u32, row: i32, column: i32) -> Option<bool> {
    use ironcalc::base::cell::CellValue;
    match model.get_cell_value_by_index(sheet, row, column) {
        Ok(CellValue::Boolean(value)) => Some(value),
        _ => None,
    }
}

/// A formula cell's identity and the cached `<v>` the file carried,
/// captured before the model evaluates it away. Array-formula anchors carry
/// their cached value the same way regular formulas do.
struct CachedFormula {
    sheet: usize,
    row: i32,
    column: i32,
    value: FormulaValue,
}

/// A spill cell — a member of a dynamic or CSE array formula that has no
/// formula of its own — and the value the file cached for it.
struct CachedSpill {
    sheet: usize,
    row: i32,
    column: i32,
    value: SpillValue,
}

struct CachedValues {
    formulas: Vec<CachedFormula>,
    spills: Vec<CachedSpill>,
}

fn snapshot_cached_values(model: &Model) -> CachedValues {
    let mut formulas = Vec::new();
    let mut spills = Vec::new();
    for (sheet, worksheet) in model.workbook.worksheets.iter().enumerate() {
        for (row, column, cell) in worksheet.sheet_data.cells() {
            match cell.as_ref() {
                Cell::CellFormula { v, .. } | Cell::ArrayFormula { v, .. } => {
                    formulas.push(CachedFormula {
                        sheet,
                        row,
                        column,
                        value: v.clone(),
                    });
                }
                Cell::SpillCell { v, .. } => spills.push(CachedSpill {
                    sheet,
                    row,
                    column,
                    value: v.clone(),
                }),
                _ => {}
            }
        }
    }
    CachedValues { formulas, spills }
}

fn worksheet_cell<'a>(
    model: &'a Model<'a>,
    sheet: usize,
    row: i32,
    column: i32,
) -> Option<std::borrow::Cow<'a, Cell>> {
    model
        .workbook
        .worksheets
        .get(sheet)
        .and_then(|worksheet| worksheet.cell(row, column))
}

/// One reported stale cell in wire coordinates (0-based row/column, like
/// `reads`), with the engine's current display value.
fn stale_cell(model: &Model, sheet: usize, row: i32, column: i32, is_formula: bool) -> RecalcCell {
    let sheet_index = sheet as u32;
    RecalcCell {
        sheet: model.workbook.worksheets[sheet].name.clone(),
        // IronCalc coordinates are 1-based; the wire is 0-based like `reads`.
        row: (row - 1) as u32,
        column: (column - 1) as u32,
        formatted: model
            .get_formatted_cell_value(sheet_index, row, column)
            .unwrap_or_default(),
        number: raw_number(model, sheet_index, row, column),
        boolean: raw_boolean(model, sheet_index, row, column),
        is_error: matches!(
            model.get_cell_type(sheet_index, row, column),
            Ok(CellType::ErrorValue)
        ),
        is_formula,
    }
}

/// The cells whose evaluated value disagrees with the cached `<v>` the file
/// carried. Cells pinned to their cache (external-workbook references) are
/// value cells by the time this runs, so they are left alone.
fn stale_cached_values(model: &Model, cached: CachedValues) -> StaleAudit {
    let mut cells = Vec::new();
    let mut unrefreshed = Vec::new();
    for entry in cached.formulas {
        let Some(cell) = worksheet_cell(model, entry.sheet, entry.row, entry.column) else {
            continue;
        };
        let computed = match cell.as_ref() {
            Cell::CellFormula { v, .. } | Cell::ArrayFormula { v, .. } => v,
            // The cell changed kind while evaluating (pinned to a constant,
            // dropped from an array): there is no computed value to compare.
            _ => continue,
        };
        if formula_values_agree(&entry.value, computed) {
            continue;
        }
        // Never downgrade a usable cache to an engine error. IronCalc errors
        // where Excel does not — RATE()'s Newton solver near -100% (#185) is
        // one case, TEXT() with a format code the engine cannot parse
        // another — and replacing the file's value with #NUM!/#VALUE! would
        // destroy a cache Excel computed correctly. The reverse (a cached
        // error that now computes) stays reportable. The cache is kept, but
        // the cell is listed as unrefreshed: a changed input legitimately
        // turns dependents into #DIV/0!/#N/A, so the kept cache may be wrong
        // and the caller may not claim the cached values are current.
        if is_error_value(computed) && !is_error_value(&entry.value) {
            unrefreshed.push(stale_cell(
                model,
                entry.sheet,
                entry.row,
                entry.column,
                true,
            ));
            continue;
        }
        // An unevaluated cell has no answer to write; the file's cache stays.
        if matches!(computed, FormulaValue::Unevaluated) {
            continue;
        }
        cells.push(stale_cell(
            model,
            entry.sheet,
            entry.row,
            entry.column,
            true,
        ));
    }
    let mut spill_cells = Vec::new();
    for entry in cached.spills {
        let Some(cell) = worksheet_cell(model, entry.sheet, entry.row, entry.column) else {
            continue;
        };
        let Cell::SpillCell { v, .. } = cell.as_ref() else {
            continue;
        };
        if spill_values_agree(&entry.value, v) {
            continue;
        }
        // Same rule as formula cells: a spill the engine turns into an error
        // keeps the value Excel spilled there, and is listed as unrefreshed
        // for the same reason.
        if matches!(v, SpillValue::Error(_)) && !matches!(entry.value, SpillValue::Error(_)) {
            unrefreshed.push(stale_cell(
                model,
                entry.sheet,
                entry.row,
                entry.column,
                false,
            ));
            continue;
        }
        // A spill cell carries no `<f>` of its own, so the caller's
        // cached-value patch cannot rewrite it; the caller reports it instead.
        spill_cells.push(stale_cell(
            model,
            entry.sheet,
            entry.row,
            entry.column,
            false,
        ));
    }
    StaleAudit {
        cells,
        spill_cells,
        unrefreshed,
    }
}

fn is_error_value(value: &FormulaValue) -> bool {
    matches!(value, FormulaValue::Error { .. })
}

fn spill_values_agree(cached: &SpillValue, computed: &SpillValue) -> bool {
    match (cached, computed) {
        (SpillValue::Number(a), SpillValue::Number(b)) => numbers_agree(*a, *b),
        (SpillValue::Text(a), SpillValue::Text(b)) => a == b,
        (SpillValue::Boolean(a), SpillValue::Boolean(b)) => a == b,
        (SpillValue::Error(a), SpillValue::Error(b)) => a == b,
        _ => false,
    }
}

fn formula_values_agree(cached: &FormulaValue, computed: &FormulaValue) -> bool {
    match (cached, computed) {
        (FormulaValue::Number(a), FormulaValue::Number(b)) => numbers_agree(*a, *b),
        (FormulaValue::Text(a), FormulaValue::Text(b)) => a == b,
        (FormulaValue::Boolean(a), FormulaValue::Boolean(b)) => a == b,
        (FormulaValue::Error { ei: a, .. }, FormulaValue::Error { ei: b, .. }) => a == b,
        _ => false,
    }
}

/// Excel keeps at most 15 significant digits in a cached `<v>`; two doubles
/// that agree there are the same cached number. Without this tolerance an
/// unrelated formula whose result Excel rounded would be rewritten on every
/// edit over the last bits of an f64.
fn numbers_agree(a: f64, b: f64) -> bool {
    if a == b {
        return true;
    }
    if a.is_nan() && b.is_nan() {
        return true;
    }
    if !a.is_finite() || !b.is_finite() {
        return false;
    }
    (a - b).abs() <= a.abs().max(b.abs()) * 1e-13
}

/// True when any worksheet part carries a `<f>` element. A stale-cache audit
/// needs the workbook imported; scanning the deflated worksheet parts first
/// lets a formula-free workbook skip that import entirely.
fn workbook_has_formulas(path: &Path) -> Result<bool, SidecarError> {
    let file = std::fs::File::open(path).map_err(|error| SidecarError::Io(error.to_string()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        SidecarError::Workbook(format!(
            "The formula engine could not read the workbook archive: {error}"
        ))
    })?;
    let mut names = Vec::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| {
            SidecarError::Workbook(format!(
                "The formula engine could not read the workbook archive: {error}"
            ))
        })?;
        let Some(name) = entry.name().ok().map(|name| name.into_owned()) else {
            continue;
        };
        if name.starts_with("xl/worksheets/") && name.ends_with(".xml") {
            names.push(name);
        }
    }
    for name in names {
        let mut entry = archive.by_name(&name).map_err(|error| {
            SidecarError::Workbook(format!("The formula engine could not read {name}: {error}"))
        })?;
        if part_has_formula(&mut entry)? {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Streaming `<f>` / `<f ` / `<f/` scan: a worksheet XML can be hundreds of
/// MB, and only the presence of a formula matters. The three-byte window
/// carries across chunks and does not match `<filter`, `<formula1` or
/// `<firstFooter`.
fn part_has_formula(part: &mut impl Read) -> Result<bool, SidecarError> {
    let mut buffer = [0u8; 64 * 1024];
    let mut window = [0u8; 3];
    loop {
        let read = part
            .read(&mut buffer)
            .map_err(|error| SidecarError::Io(error.to_string()))?;
        if read == 0 {
            return Ok(false);
        }
        for &byte in &buffer[..read] {
            window = [window[1], window[2], byte];
            if window[0] == b'<' && window[1] == b'f' && matches!(window[2], b'>' | b' ' | b'/') {
                return Ok(true);
            }
        }
    }
}

/// True when `xl/workbook.xml` declares the 1904 date system
/// (`<workbookPr date1904="1"/>`). IronCalc 0.9.1 has no date1904 support —
/// nothing in the engine reads the flag — so every date result it computes is
/// 1462 days away from the value Excel cached.
///
/// The workbook part is a small metadata part, and parsing it with the read
/// path's own `read_sheet_declarations` keeps this flag's interpretation
/// (`1`/`true`, namespaced documents) byte-for-byte consistent with the
/// renderer's.
fn workbook_uses_1904_dates(path: &Path) -> Result<bool, SidecarError> {
    let file = std::fs::File::open(path).map_err(|error| SidecarError::Io(error.to_string()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| {
        SidecarError::Workbook(format!(
            "The formula engine could not read the workbook archive: {error}"
        ))
    })?;
    let (_, _, _, date_1904) = crate::workbook::read_sheet_declarations(&mut archive)?;
    Ok(date_1904)
}
