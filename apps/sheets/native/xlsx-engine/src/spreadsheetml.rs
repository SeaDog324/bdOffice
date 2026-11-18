//! SpreadsheetML 2003 import: Excel's "XML Spreadsheet", a single XML file in
//! the `urn:schemas-microsoft-com:office:spreadsheet` namespace. Excel sniffs
//! content over extension and opens one happily even when it is named `.xls`,
//! so these files reach the legacy-import path and used to die there as an
//! unreadable container.
//!
//! Values, formulas, merges, column widths, hidden sheets, and named ranges are
//! carried over. Styles are not: the source expresses them through a
//! workbook-wide `Style` table that this importer does not read, so a converted
//! workbook shows its values in a default face rather than the original's.

use std::collections::HashSet;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use roxmltree::{Document, Node};

use crate::SidecarError;
use crate::convert::ConvertResult;
use crate::xlsx_package::{
    SheetSpec, cell_reference, escape_xml, iso_serial, worksheet_document, write_package,
};

/// The namespace every SpreadsheetML element sits in. It is bound both as the
/// default namespace and behind the conventional `ss:` prefix.
const NAMESPACE: &str = "urn:schemas-microsoft-com:office:spreadsheet";

/// Excel hangs workbook-level options off the worksheet in this namespace —
/// notably the `Visible` element that says a sheet is hidden, because the
/// SpreadsheetML schema gives `<Worksheet>` no attribute for it.
const EXCEL_NAMESPACE: &str = "urn:schemas-microsoft-com:office:excel";

const MAX_ROW: u32 = 1_048_576;
const MAX_COLUMN: u32 = 16_384;

/// How far into a file the identifying strings can still turn up. The workbook
/// declaration is in the first handful of lines, but some generators put a long
/// comment or an XML map ahead of it.
const PROBE_BYTES: usize = 8192;

/// Whether these leading bytes are an XML spreadsheet rather than some other
/// file that happens to carry a legacy extension.
pub(crate) fn looks_like_spreadsheetml(head: &[u8]) -> bool {
    let text = String::from_utf8_lossy(head);
    text.contains(NAMESPACE) || text.contains("<Workbook") || text.contains("<ss:Workbook")
}

/// The same question asked of a path, which is what the importer asks when
/// calamine has already refused the file.
pub(crate) fn probe(source: &Path) -> bool {
    let Ok(mut file) = File::open(source) else {
        return false;
    };
    let mut head = [0u8; PROBE_BYTES];
    let Ok(read) = file.read(&mut head) else {
        return false;
    };
    looks_like_spreadsheetml(&head[..read])
}

pub(crate) fn convert_to_xlsx(source: &Path, target: &Path) -> Result<ConvertResult, SidecarError> {
    let mut xml = String::new();
    File::open(source)?.read_to_string(&mut xml)?;
    let document = Document::parse(&xml).map_err(|error| {
        SidecarError::Workbook(format!("The XML spreadsheet is malformed: {error}"))
    })?;
    let root = document.root_element();
    if !is_element(root, "Workbook") {
        return Err(SidecarError::Workbook(
            "This is not an XML spreadsheet: its root element is not a Workbook.".into(),
        ));
    }

    let mut sheets = Vec::new();
    let mut sheet_xmls = Vec::new();
    let mut cells = 0usize;
    for worksheet in root.children() {
        if !is_element(worksheet, "Worksheet") {
            continue;
        }
        let name = attribute(worksheet, "Name")
            .map(str::to_string)
            .unwrap_or_else(|| format!("Sheet{}", sheets.len() + 1));
        let state = worksheet_state(worksheet);
        let parsed = parse_worksheet(worksheet);
        cells += parsed.cells;
        sheets.push(SheetSpec { name, state });
        sheet_xmls.push(parsed.xml);
    }
    if sheets.is_empty() {
        return Err(SidecarError::Workbook(
            "The XML spreadsheet has no worksheets.".into(),
        ));
    }

    write_package(
        target,
        &sheets,
        &defined_names(root),
        &sheet_xmls,
        &[],
        crate::xlsx_package::STYLES_XML,
    )?;
    Ok(ConvertResult {
        sheets: sheets.len(),
        cells,
    })
}

/// How Excel hides a worksheet: `<WorksheetOptions>` (Excel's own namespace)
/// carries `<Visible>SheetHidden</Visible>` — or `SheetVeryHidden`, the state
/// even the tab menu will not undo. Anything else is a visible sheet.
fn worksheet_state(worksheet: Node) -> Option<&'static str> {
    let in_excel_namespace = |node: &Node| {
        matches!(
            node.tag_name().namespace(),
            None | Some(NAMESPACE) | Some(EXCEL_NAMESPACE)
        )
    };
    let options = worksheet
        .children()
        .find(|node| node.is_element() && node.tag_name().name() == "WorksheetOptions")?;
    let visible = options.children().find(|node| {
        node.is_element() && node.tag_name().name() == "Visible" && in_excel_namespace(node)
    })?;
    match visible.text()?.trim() {
        "SheetHidden" => Some("hidden"),
        "SheetVeryHidden" => Some("veryHidden"),
        _ => None,
    }
}

/// One built worksheet: the part to zip, and how many cells it carries.
struct ParsedSheet {
    xml: String,
    cells: usize,
}

/// A row as the source described it, kept until every row is in so the
/// `<cols>` element can be placed and the dimension measured.
struct RowRecord {
    index: u32,
    height: Option<f64>,
    hidden: bool,
    cells: Vec<(u32, String)>,
}

fn parse_worksheet(worksheet: Node) -> ParsedSheet {
    let Some(table) = worksheet.children().find(|node| is_element(*node, "Table")) else {
        return ParsedSheet {
            xml: worksheet_document("A1:A1", "", "", ""),
            cells: 0,
        };
    };

    let mut columns = Vec::new();
    let mut next_column = 0u32;
    for column in table.children().filter(|node| is_element(*node, "Column")) {
        if let Some(index) = measure(column, "Index")
            && (1.0..=f64::from(MAX_COLUMN)).contains(&index)
        {
            next_column = index as u32 - 1;
        }
        let first = next_column;
        // A `Span` covers the columns the writer left out after this one, so
        // the next implied index sits past the span, not one column over.
        let column_span = span(column, "Span");
        next_column = first
            .saturating_add(1)
            .saturating_add(column_span)
            .min(MAX_COLUMN);

        let width = measure(column, "Width").filter(|value| *value > 0.0);
        let hidden = flag(column, "Hidden");
        if width.is_none() && !hidden {
            continue;
        }
        let width = width
            .map(|value| format!(r#" width="{value}""#))
            .unwrap_or_default();
        let hidden = if hidden { r#" hidden="1""# } else { "" };
        columns.push(format!(
            r#"<col min="{}" max="{}"{width}{hidden}/>"#,
            first + 1,
            (first + column_span).min(MAX_COLUMN - 1) + 1
        ));
    }

    let mut merges: Vec<String> = Vec::new();
    let mut rows: Vec<RowRecord> = Vec::new();
    let mut next_row = 0u32;
    for row_node in table.children().filter(|node| is_element(*node, "Row")) {
        if let Some(index) = measure(row_node, "Index")
            && (1.0..=f64::from(MAX_ROW)).contains(&index)
        {
            next_row = index as u32 - 1;
        }
        let index = next_row;
        // Rows Excel left out because they repeat this one's height or style
        // are spelled `Span` on the row before them, and the next written row
        // lands past the span.
        let row_span = span(row_node, "Span");
        next_row = index
            .saturating_add(1)
            .saturating_add(row_span)
            .min(MAX_ROW);

        let mut next_cell_column = 0u32;
        let mut cells: Vec<(u32, String)> = Vec::new();
        for cell_node in row_node.children().filter(|node| is_element(*node, "Cell")) {
            if let Some(value) = measure(cell_node, "Index")
                && (1.0..=f64::from(MAX_COLUMN)).contains(&value)
            {
                next_cell_column = value as u32 - 1;
            }
            let column = next_cell_column;
            let across = span(cell_node, "MergeAcross");
            let down = span(cell_node, "MergeDown");
            // The cells a merge covers are not written out either: a following
            // cell without an Index starts past the merge, not one column over.
            next_cell_column = column
                .saturating_add(across)
                .saturating_add(1)
                .min(MAX_COLUMN);
            if across > 0 || down > 0 {
                merges.push(format!(
                    "{}:{}",
                    cell_reference(index, column),
                    cell_reference(
                        index.saturating_add(down).min(MAX_ROW - 1),
                        column.saturating_add(across).min(MAX_COLUMN - 1),
                    )
                ));
            }

            if let Some(xml) = cell_xml(index, column, cell_node) {
                cells.push((column, xml));
            }
        }
        rows.push(RowRecord {
            index,
            height: measure(row_node, "Height").filter(|value| *value > 0.0),
            hidden: flag(row_node, "Hidden"),
            cells,
        });
    }

    // A merged area covers cells the source may also have spelled out; two
    // contents in one visible box is a file Excel offers to repair.
    let merged = covered_cells(&merges);
    let mut written: HashSet<u64> = HashSet::new();
    let mut sheet_data = String::new();
    let mut min = (u32::MAX, u32::MAX);
    let mut max = (0u32, 0u32);
    let mut count = 0usize;
    for row in &rows {
        let mut line = String::new();
        for (column, xml) in &row.cells {
            if merged.contains(&(row.index, *column)) && !is_anchor(&merges, row.index, *column) {
                continue;
            }
            if !written.insert(position(row.index, *column)) {
                continue;
            }
            line.push_str(xml);
            min.0 = min.0.min(row.index);
            min.1 = min.1.min(*column);
            max.0 = max.0.max(row.index);
            max.1 = max.1.max(*column);
            count += 1;
        }
        // xlsx says nothing about an empty row unless it carries a height or a
        // hidden flag, which is also all the source could have set on one.
        if line.is_empty() && row.height.is_none() && !row.hidden {
            continue;
        }
        let height = row
            .height
            .map(|value| format!(r#" ht="{value}""#))
            .unwrap_or_default();
        let hidden = if row.hidden { r#" hidden="1""# } else { "" };
        sheet_data.push_str(&format!(
            r#"<row r="{}"{height}{hidden}>{line}</row>"#,
            row.index + 1
        ));
    }

    let columns_xml = if columns.is_empty() {
        String::new()
    } else {
        format!("<cols>{}</cols>", columns.concat())
    };
    let tail = if merges.is_empty() {
        String::new()
    } else {
        format!(
            r#"<mergeCells count="{}">{}</mergeCells>"#,
            merges.len(),
            merges
                .iter()
                .map(|area| format!(r#"<mergeCell ref="{area}"/>"#))
                .collect::<String>()
        )
    };
    let dimension = if min.0 == u32::MAX {
        "A1:A1".to_string()
    } else {
        format!(
            "{}:{}",
            cell_reference(min.0, min.1),
            cell_reference(max.0, max.1)
        )
    };

    ParsedSheet {
        xml: worksheet_document(&dimension, &columns_xml, &sheet_data, &tail),
        cells: count,
    }
}

fn position(row: u32, column: u32) -> u64 {
    u64::from(row) * u64::from(MAX_COLUMN) + u64::from(column)
}

/// Every cell inside a merge record, anchor included.
fn covered_cells(merges: &[String]) -> HashSet<(u32, u32)> {
    let mut covered = HashSet::new();
    for area in merges {
        let Some((start, end)) = area.split_once(':') else {
            continue;
        };
        let (Some((top, left)), Some((bottom, right))) =
            (parse_reference(start), parse_reference(end))
        else {
            continue;
        };
        for row in top..=bottom.min(top + 4095) {
            for column in left..=right.min(left + 4095) {
                covered.insert((row, column));
            }
        }
    }
    covered
}

/// The top-left cell of a merge record is the one that keeps its content.
fn is_anchor(merges: &[String], row: u32, column: u32) -> bool {
    merges.iter().any(|area| {
        area.split_once(':')
            .is_none_or(|(start, _)| parse_reference(start) == Some((row, column)))
    })
}

/// `A1` or `$A$1` as a 0-based pair.
fn parse_reference(text: &str) -> Option<(u32, u32)> {
    let text = text.trim().replace('$', "");
    let letters = text.chars().take_while(char::is_ascii_alphabetic).count();
    if letters == 0 {
        return None;
    }
    let mut column = 0u32;
    for letter in text[..letters].chars() {
        column = column * 26 + u32::from(letter.to_ascii_uppercase()) - u32::from('A') + 1;
    }
    let row: u32 = text[letters..].parse().ok()?;
    if row == 0 {
        return None;
    }
    Some((row - 1, column - 1))
}

/// `A1`, `$A1`, `A$1` or `$A$1`: each axis keeps its own lock.
fn mixed_cell_reference(
    row: u32,
    row_absolute: bool,
    column: u32,
    column_absolute: bool,
) -> String {
    let plain = cell_reference(row, column);
    let digits = plain.trim_start_matches(|c: char| c.is_ascii_alphabetic());
    let letters = &plain[..plain.len() - digits.len()];
    format!(
        "{}{letters}{}{digits}",
        if column_absolute { "$" } else { "" },
        if row_absolute { "$" } else { "" }
    )
}

/// Builds the `<c>` element, or `None` when the cell holds neither a value nor
/// a formula.
fn cell_xml(row: u32, column: u32, node: Node) -> Option<String> {
    let reference = cell_reference(row, column);
    let data = node.children().find(|child| is_element(*child, "Data"));
    let formula = attribute(node, "Formula").and_then(|text| r1c1_to_a1(text, row, column));
    let formula_xml = formula
        .map(|text| format!("<f>{}</f>", escape_xml(&text)))
        .unwrap_or_default();

    let Some(data) = data else {
        if formula_xml.is_empty() {
            return None;
        }
        return Some(format!(r#"<c r="{reference}">{formula_xml}</c>"#));
    };
    let text = text_content(data);
    let kind = attribute(data, "Type").unwrap_or("String");

    let body = match kind {
        "Number" => match text.trim().parse::<f64>() {
            Ok(number) => format!(r#"<c r="{reference}">{formula_xml}<v>{number}</v></c>"#),
            // a number the source wrote as text is still text here
            Err(_) => text_cell(&reference, &formula_xml, &text),
        },
        "Boolean" => format!(
            r#"<c r="{reference}" t="b">{formula_xml}<v>{}</v></c>"#,
            if is_truthy(&text) { 1 } else { 0 }
        ),
        "DateTime" => match iso_serial(text.trim()) {
            // the two date styles this importer writes: short and date+time
            Some(serial) => {
                let style = if serial.fract() == 0.0 { 1 } else { 2 };
                format!(r#"<c r="{reference}" s="{style}">{formula_xml}<v>{serial}</v></c>"#)
            }
            // a date that will not land on the serial line stays text, which is
            // still better than a confidently wrong year
            None => text_cell(&reference, &formula_xml, &text),
        },
        "Error" => format!(
            r#"<c r="{reference}" t="e">{formula_xml}<v>{}</v></c>"#,
            escape_xml(text.trim())
        ),
        _ => text_cell(&reference, &formula_xml, &text),
    };
    Some(body)
}

fn text_cell(reference: &str, formula_xml: &str, text: &str) -> String {
    format!(
        r#"<c r="{reference}" t="inlineStr">{formula_xml}<is><t xml:space="preserve">{}</t></is></c>"#,
        escape_xml(text)
    )
}

/// All text under a node, concatenated. A `Data` element carrying inline font
/// tags holds its text in grandchildren, and Excel shows those words plain.
fn text_content(node: Node) -> String {
    let mut text = String::new();
    for descendant in node.descendants() {
        if descendant.is_text() {
            text.push_str(descendant.text().unwrap_or_default());
        }
    }
    text
}

/// SpreadsheetML writes every reference in R1C1, so `=SUM(R[-1]C:R[-1]C[2])`
/// has to be respelled before OOXML will take it. A whole row or column — a
/// bare `R` or `C`, or one carrying a coordinate like `R1` or `C[-5]` — is not
/// something this translates, and neither is anything the scanner cannot read
/// as a complete `R<row>C<column>` pair; in every such case `None` leaves the
/// cell holding only its cached value rather than a formula Excel would offer
/// to repair.
fn r1c1_to_a1(formula: &str, row: u32, column: u32) -> Option<String> {
    let body = formula.trim().trim_start_matches('=');
    if body.is_empty() {
        return None;
    }
    translate(body.as_bytes(), row, column, true)
}

/// A workbook-scoped named range must be absolute: with no cell of its own to
/// be relative to, a relative reference would name a different place per use.
fn named_range_to_a1(refers_to: &str) -> Option<String> {
    let body = refers_to.trim().trim_start_matches('=');
    if body.is_empty() {
        return None;
    }
    translate(body.as_bytes(), 0, 0, false)
}

fn translate(body: &[u8], row: u32, column: u32, relative_allowed: bool) -> Option<String> {
    let mut out = String::with_capacity(body.len());
    let mut index = 0;
    while index < body.len() {
        // A quoted literal passes through untouched: "R1C1" is text, not a reference.
        if body[index] == b'"' {
            let mut cursor = index + 1;
            while cursor < body.len() {
                if body[cursor] == b'"' {
                    if body.get(cursor + 1) == Some(&b'"') {
                        cursor += 2;
                        continue;
                    }
                    break;
                }
                cursor += 1;
            }
            if cursor >= body.len() {
                return None;
            }
            out.push_str(std::str::from_utf8(&body[index..=cursor]).ok()?);
            index = cursor + 1;
            continue;
        }
        match reference_at(body, index, row, column, relative_allowed) {
            Ok(Some((length, reference))) => {
                out.push_str(&reference);
                index += length;
                continue;
            }
            // A reference this importer cannot spell. Passing the R1C1 token
            // through would leave a formula Excel cannot read at all, which is
            // worse than keeping the cell's cached value.
            Err(()) => return None,
            Ok(None) => {}
        }
        if is_bare_axis_token(body, index) {
            // A whole row or column (`SUM(R)`) has no A1 cell reference to
            // become, and is refused for the same reason.
            return None;
        }
        // Anything that is not part of a reference is copied one scalar at a
        // time so multi-byte text inside the formula survives.
        let width = utf8_width(body[index]);
        out.push_str(std::str::from_utf8(&body[index..index + width]).ok()?);
        index += width;
    }
    Some(out)
}

/// Reads one `R<row>C<column>` reference at `start`.
///
/// `Ok(Some(..))` is a reference that has been respelled, `Ok(None)` says
/// this position does not open one, and `Err(())` says it does open one that
/// has no A1 spelling — which the caller must not paper over by copying the
/// R1C1 token through. `Err` also covers the axis forms: `R<n>` standing alone
/// names a whole row and `C<n>` a whole column (`=SUM(R1)` sums row 1, not the
/// cell R1), and an A1 has no spelling for those that keeps the meaning.
fn reference_at(
    body: &[u8],
    start: usize,
    row: u32,
    column: u32,
    relative_allowed: bool,
) -> Result<Option<(usize, String)>, ()> {
    // `ROUND(` and `CORREL(` both open with a letter that could be mistaken for
    // a row token, so the character in front has to rule that out.
    if start > 0 && is_identifier_byte(body[start - 1]) {
        return Ok(None);
    }
    if body.get(start) == Some(&b'C') {
        let (_, _, after_column) = coordinate(body, start + 1).ok_or(())?;
        // `C5` or `C[-1]` is a whole-column axis reference, not the cell C5.
        if after_column > start + 1 {
            return Err(());
        }
        return Ok(None);
    }
    if body.get(start) != Some(&b'R') {
        return Ok(None);
    }
    let (row_value, row_absolute, after_row) = coordinate(body, start + 1).ok_or(())?;
    if body.get(after_row) != Some(&b'C') {
        // `R1` or `R[-1]` with no column token behind it names a whole row.
        if after_row > start + 1 {
            return Err(());
        }
        // A bare `R` opening something else entirely (`ROUND(`).
        return Ok(None);
    }
    let (column_value, column_absolute, after_column) = coordinate(body, after_row + 1).ok_or(())?;
    if body
        .get(after_column)
        .is_some_and(|next| is_identifier_byte(*next))
    {
        return Ok(None);
    }
    if !relative_allowed && (!row_absolute || !column_absolute) {
        // A named range has no cell of its own to be relative to.
        return Err(());
    }
    let target_row = resolve(row_value, row_absolute, row, MAX_ROW).ok_or(())?;
    let target_column = resolve(column_value, column_absolute, column, MAX_COLUMN).ok_or(())?;
    let spelled = mixed_cell_reference(target_row, row_absolute, target_column, column_absolute);
    Ok(Some((after_column - start, spelled)))
}

/// Turns a coordinate into a 0-based index. `5` is row 5 outright; `[-2]` is
/// two rows up from wherever the formula sits.
fn resolve(value: i64, absolute: bool, current: u32, limit: u32) -> Option<u32> {
    let index = if absolute {
        if value < 1 || value > i64::from(limit) {
            return None;
        }
        value - 1
    } else {
        i64::from(current) + value
    };
    if index < 0 || index >= i64::from(limit) {
        return None;
    }
    Some(index as u32)
}

/// Reads `5` or `[-2]` at `at`, reporting the value, whether it was absolute,
/// and where the token ends. A coordinate with neither — the bare `C` of
/// `R[-1]C` — is the current row or column, an offset of zero.
fn coordinate(body: &[u8], at: usize) -> Option<(i64, bool, usize)> {
    if body.get(at) == Some(&b'[') {
        let mut cursor = at + 1;
        let negative = match body.get(cursor) {
            Some(b'-') => {
                cursor += 1;
                true
            }
            Some(b'+') => {
                cursor += 1;
                false
            }
            _ => false,
        };
        let start = cursor;
        while matches!(body.get(cursor), Some(byte) if byte.is_ascii_digit()) {
            cursor += 1;
        }
        if cursor == start || body.get(cursor) != Some(&b']') {
            return None;
        }
        let magnitude: i64 = std::str::from_utf8(&body[start..cursor])
            .ok()?
            .parse()
            .ok()?;
        return Some((
            if negative { -magnitude } else { magnitude },
            false,
            cursor + 1,
        ));
    }
    let mut cursor = at;
    while matches!(body.get(cursor), Some(byte) if byte.is_ascii_digit()) {
        cursor += 1;
    }
    if cursor == at {
        return Some((0, false, at));
    }
    let value: i64 = std::str::from_utf8(&body[at..cursor]).ok()?.parse().ok()?;
    Some((value, true, cursor))
}

/// A letter, digit, or one of the characters A1 references are built from.
/// Anything else can legitimately sit next to a reference token.
fn is_identifier_byte(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'$' | b'_' | b'[' | b']')
}

/// A lone `R` or `C` standing for a whole row or column. The same letter
/// inside a name is not one — `ROUND(` and `CORREL(` both open with a token
/// character on both sides of it.
fn is_bare_axis_token(body: &[u8], index: usize) -> bool {
    if !matches!(body.get(index), Some(b'R') | Some(b'C')) {
        return false;
    }
    let before = index == 0 || !is_identifier_byte(body[index - 1]);
    let after = match body.get(index + 1) {
        Some(byte) => !is_identifier_byte(*byte),
        None => true,
    };
    before && after
}

fn utf8_width(byte: u8) -> usize {
    match byte {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// The workbook-scoped `<Names>`, as ready-made `<definedName>` elements.
fn defined_names(root: Node) -> String {
    let Some(names) = root.children().find(|node| is_element(*node, "Names")) else {
        return String::new();
    };
    let mut out = String::new();
    for entry in names
        .children()
        .filter(|node| is_element(*node, "NamedRange"))
    {
        let Some(name) = attribute(entry, "Name") else {
            continue;
        };
        let Some(target) = attribute(entry, "RefersTo").and_then(named_range_to_a1) else {
            continue;
        };
        // Excel's own bookkeeping ranges (`_xlnm.Print_Area`,
        // `_FilterDatabase`) mean nothing once the file has become a fresh
        // workbook; a user's `_tax` is not one of those and stays.
        if name.starts_with("_xlnm") || name == "_FilterDatabase" {
            continue;
        }
        let hidden = if flag(entry, "Hidden") {
            r#" hidden="1""#
        } else {
            ""
        };
        out.push_str(&format!(
            r#"<definedName name="{}"{hidden}>{}</definedName>"#,
            escape_xml(name),
            escape_xml(&target)
        ));
    }
    out
}

/// True for an element in the SpreadsheetML namespace, or in no namespace at
/// all — files written without an `xmlns` still carry the same element names.
fn is_element(node: Node, local: &str) -> bool {
    node.is_element()
        && node.tag_name().name() == local
        && matches!(node.tag_name().namespace(), None | Some(NAMESPACE))
}

/// Reads an attribute by local name. SpreadsheetML writers use `ss:` on some
/// attributes and leave the prefix off others, and the prefix never changes the
/// local name.
fn attribute<'a, 'i>(node: Node<'a, 'i>, name: &str) -> Option<&'a str> {
    node.attributes()
        .find(|attribute| attribute.name() == name)
        .map(|attribute| attribute.value())
}

fn measure(node: Node, name: &str) -> Option<f64> {
    attribute(node, name)?.trim().parse().ok()
}

fn flag(node: Node, name: &str) -> bool {
    attribute(node, name).is_some_and(is_truthy)
}

/// A merge span, as a cell count. A fractional or negative value names nothing.
fn span(node: Node, name: &str) -> u32 {
    measure(node, name)
        .filter(|value| *value >= 1.0 && *value <= f64::from(MAX_ROW))
        .map(|value| value as u32)
        .unwrap_or(0)
}

fn is_truthy(text: &str) -> bool {
    matches!(text.trim(), "1" | "true" | "True" | "TRUE")
}
