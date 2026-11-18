//! Legacy-format import: reads an .xls or .ods (anything calamine understands)
//! and writes a minimal .xlsx with values, formulas, and date number formats.
//! What the binary layer of an .xls holds beyond cells comes along too — the
//! drawing group's embedded pictures with their anchors, merges, column
//! widths, hand-set row heights, and the cell formatting — fonts, fills,
//! borders, alignment, number formats (see `xls_biff`, `xls_styles` and
//! `escher`). Charts and conditional formats are not carried over — the
//! converted file is a fresh workbook, not a byte-preserving edit. ODF arrives in its own reference
//! dialect, so formulas go through `odf::translate_formula` first and any
//! that cannot be proven correct keep only their cached result.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use calamine::{Data, Dimensions, Reader, Sheets, open_workbook_auto};

use crate::SidecarError;
use crate::escher::{self, Blip, BlipKind};
use crate::spreadsheetml;
use crate::xls_biff::{self, XlsSheetBinary};
use crate::xls_styles::XlsStyles;
use crate::xlsx_package::{
    STYLES_XML, SheetArt, SheetSpec, cell_reference, escape_xml, iso_serial, worksheet_document,
    write_package,
};

/// `s` indices the converter wrote: per cell, per row, and the column spans.
#[derive(Default)]
struct SheetStyles {
    cells: HashMap<(u32, u32), u16>,
    rows: HashMap<u32, u16>,
}

pub struct ConvertResult {
    pub sheets: usize,
    pub cells: usize,
}

/// Why the reader refused a file, when the refusal is about the container and
/// a friendlier sentence helps. `None` keeps the reader's own error.
///
/// Legacy workbooks are OLE2/CFB containers; a file that starts with anything
/// else was renamed rather than exported. Excel sniffs content over extension
/// and opens plenty of those happily, so the reader's `Invalid OLE (signature
/// ...)` tells the person holding the file nothing they can act on.
///
/// An XML spreadsheet is not one of these: genoffice#2044 reads it directly,
/// and this only has to speak about files no reader should open at all.
fn unreadable_container_hint(source: &Path) -> Option<String> {
    let mut head = [0u8; 1024];
    let read = File::open(source).ok()?.read(&mut head).ok()?;
    let head = &head[..read];
    if head.starts_with(&[0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]) {
        // a real CFB container: whatever is wrong inside is the reader's to explain
        return None;
    }
    let text = String::from_utf8_lossy(head);
    let trimmed = text.trim_start_matches('\u{FEFF}').trim_start();
    if !trimmed.starts_with("<?xml") && !trimmed.starts_with('<') {
        return None;
    }
    let first_line = trimmed.lines().next().unwrap_or("").trim();
    let first_line = if first_line.chars().count() > 60 {
        let cut: String = first_line.chars().take(60).collect();
        format!("{cut}…")
    } else {
        first_line.to_string()
    };
    Some(format!(
        "This file is not a workbook container: its content is text or XML rather than \
         an Excel/ODF package, and it begins with \"{first_line}\"."
    ))
}

pub fn convert_to_xlsx(source: &Path, target: &Path) -> Result<ConvertResult, SidecarError> {
    let mut workbook = match open_workbook_auto(source) {
        Ok(workbook) => workbook,
        Err(error) => {
            // Excel opens an XML spreadsheet saved under a legacy name by
            // sniffing content rather than extension, so one reaches here with
            // nothing in its header for calamine to go on. The SpreadsheetML
            // importer is the only reader that can still make sense of it;
            // the container hint below covers everything left over.
            if spreadsheetml::probe(source) {
                return spreadsheetml::convert_to_xlsx(source, target);
            }
            return Err(SidecarError::Workbook(
                match unreadable_container_hint(source) {
                    Some(hint) => hint,
                    None => format!("Unable to read the workbook: {error}"),
                },
            ));
        }
    };
    let names: Vec<String> = workbook.sheet_names().to_vec();
    if names.is_empty() {
        return Err(SidecarError::Workbook("The workbook has no sheets.".into()));
    }
    // The binary layer only exists for real .xls containers; ODF and XML
    // spreadsheets convert without it.
    let binary = xls_biff::read_xls_binary(source);

    let mut sheet_xmls: Vec<String> = Vec::new();
    let mut cells = 0usize;
    for (index, name) in names.iter().enumerate() {
        let range = workbook
            .worksheet_range(name)
            .map_err(|error| SidecarError::Workbook(format!("Sheet {name}: {error}")))?;
        let formulas = workbook.worksheet_formula(name).ok();
        let mut formula_map: HashMap<(u32, u32), String> = HashMap::new();
        if let Some(formula_range) = formulas {
            let (start_row, start_col) = formula_range.start().unwrap_or((0, 0));
            for (row, column, formula) in formula_range.used_cells() {
                if formula.is_empty() {
                    continue;
                }
                // An ODF formula with no provably-correct A1 spelling keeps only
                // its cached result: `of:=[.A1]` is not an OOXML token sequence,
                // and Excel answers one with a repair prompt.
                let Some(translated) = crate::odf::translate_formula(formula) else {
                    continue;
                };
                formula_map.insert(
                    (start_row + row as u32, start_col + column as u32),
                    translated,
                );
            }
        }
        let sheet_binary = binary.as_ref().and_then(|b| b.sheets.get(index));
        let styles = binary.as_ref().map(|b| &b.styles);
        let columns = match (sheet_binary, styles) {
            (Some(sheet), Some(styles)) => cols_xml(sheet, styles),
            _ => String::new(),
        };
        let sheet_styles = match (sheet_binary, styles) {
            (Some(sheet), Some(styles)) => sheet_styles(sheet, styles),
            _ => SheetStyles::default(),
        };
        let heights = match sheet_binary {
            Some(sheet) => sheet
                .row_heights
                .iter()
                .map(|(row, twips, custom)| (*row, (*twips, *custom)))
                .collect(),
            None => HashMap::new(),
        };
        let mut tail = match &mut workbook {
            Sheets::Xls(reader) => {
                merges_xml(&reader.merge_cells_by_sheet_name(name).unwrap_or_default())
            }
            _ => String::new(),
        };
        if sheet_binary.is_some_and(|sheet| sheet.drawing.is_some()) {
            // the drawing part is written beside this sheet, always rId1 there
            tail.push_str(r#"<drawing r:id="rId1"/>"#);
        }
        let (xml, sheet_cells) = worksheet_xml(
            &range,
            &formula_map,
            &columns,
            &tail,
            &heights,
            &sheet_styles,
        );
        cells += sheet_cells;
        sheet_xmls.push(xml);
    }

    let mut media_names: HashMap<usize, String> = HashMap::new();
    let art: Vec<Option<SheetArt>> = names
        .iter()
        .enumerate()
        .map(|(index, _)| {
            let binary = binary.as_ref()?;
            let sheet = binary.sheets.get(index)?;
            let drawing = sheet.drawing.as_ref()?;
            sheet_art(sheet, drawing, &binary.blips, &mut media_names)
        })
        .collect();

    let sheets: Vec<SheetSpec> = names
        .iter()
        .map(|name| SheetSpec {
            name: name.clone(),
            state: None,
        })
        .collect();
    let styles_xml = match &binary {
        Some(binary) if !binary.styles.is_empty() => binary.styles.styles_xml(),
        _ => STYLES_XML.to_string(),
    };
    write_package(target, &sheets, "", &sheet_xmls, &art, &styles_xml)?;
    Ok(ConvertResult {
        sheets: names.len(),
        cells,
    })
}

/// `<mergeCells>` for the ranges calamine reports, or nothing at zero.
fn merges_xml(merges: &[Dimensions]) -> String {
    if merges.is_empty() {
        return String::new();
    }
    let cells: String = merges
        .iter()
        .map(|range| {
            format!(
                r#"<mergeCell ref="{}:{}"/>"#,
                cell_reference(range.start.0, range.start.1),
                cell_reference(range.end.0, range.end.1),
            )
        })
        .collect();
    format!(
        r#"<mergeCells count="{}">{cells}</mergeCells>"#,
        merges.len()
    )
}

/// `<cols>` from the sheet's COLINFO entries. LibreOffice echoes the sheet's
/// default width as one span covering every column; a span that wide is the
/// default, not a custom width, and goes back out only through the anchor
/// arithmetic.
fn cols_xml(sheet: &XlsSheetBinary, styles: &XlsStyles) -> String {
    let custom: Vec<_> = sheet
        .col_infos
        .iter()
        .filter(|(_, last, _)| *last < 100)
        .collect();
    if custom.is_empty() {
        return String::new();
    }
    let entries: String = custom
        .iter()
        .map(|(first, last, width)| {
            let style = sheet
                .col_styles
                .iter()
                .find(|(f, l, _)| f == first && l == last)
                .and_then(|(_, _, ixfe)| styles.cell_style(*ixfe))
                .map(|s| format!(r#" style="{s}""#))
                .unwrap_or_default();
            format!(
                r#"<col min="{}" max="{}" width="{:.2}" customWidth="1"{style}/>"#,
                first + 1,
                (*last).min(16383) + 1,
                f64::from(*width) / 256.0,
            )
        })
        .collect();
    format!("<cols>{entries}</cols>")
}

/// Every `s` the sheet's records ask for, resolved against the XF table. The
/// general XF (index 15 in a Excel-written file, 0 in a bare one) is the
/// default and stays implicit, so untouched cells do not pick up an `s`.
fn sheet_styles(sheet: &XlsSheetBinary, styles: &XlsStyles) -> SheetStyles {
    let mut out = SheetStyles::default();
    let default = default_xf(styles);
    for (row, col, ixfe) in &sheet.cell_styles {
        if *ixfe == default {
            continue;
        }
        if let Some(s) = styles.cell_style(*ixfe) {
            out.cells.insert((u32::from(*row), u32::from(*col)), s);
        }
    }
    for (row, ixfe) in &sheet.row_styles {
        if *ixfe == default {
            continue;
        }
        if let Some(s) = styles.cell_style(*ixfe) {
            out.rows.insert(u32::from(*row), s);
        }
    }
    out
}

/// The cell XF Excel hands unformatted cells: the first XF that is not a
/// style XF — index 15 in Excel's own files, where 0–14 are style XFs.
fn default_xf(styles: &XlsStyles) -> u16 {
    styles
        .xfs
        .iter()
        .position(|xf| !xf.is_style)
        .map_or(0, |index| index as u16)
}

/// The width of one column in characters of the default font, for the anchor
/// arithmetic: a custom COLINFO entry when one covers it, else the wide
/// default span, else the spec's 8.43.
fn col_width_chars(sheet: &XlsSheetBinary, column: u16) -> f64 {
    let mut default = 8.43;
    for (first, last, width) in &sheet.col_infos {
        let chars = f64::from(*width) / 256.0;
        if *last >= 100 {
            default = chars;
        } else if column >= *first && column <= *last {
            return chars;
        }
    }
    default
}

/// Column width in pixels under Calibri-11 metrics — the same 7 px per
/// character the workbook DSL's width ops use.
fn col_px(sheet: &XlsSheetBinary, column: u16) -> f64 {
    (col_width_chars(sheet, column) * 7.0).round() + 5.0
}

/// Row height in pixels: twips → points → pixels at 96 dpi. Rows the file
/// describes carry their own height; the rest get the 12.75 pt default.
fn row_px(sheet: &XlsSheetBinary, row: u16) -> f64 {
    let twips = sheet
        .row_heights
        .iter()
        .find(|(candidate, _, _)| *candidate == row)
        .map(|(_, twips, _)| *twips)
        .unwrap_or(255);
    f64::from(twips) / 15.0
}

fn px_to_emu(px: f64) -> i64 {
    (px * 9525.0).round() as i64
}

/// The drawing part of one sheet: every picture the Escher stream holds, as a
/// twoCellAnchor over the sheet's own column widths and row heights. Pictures
/// with an unsupported blip format, an out-of-range BSE index or an edge
/// sentinel in the anchor are left out.
fn sheet_art(
    sheet: &XlsSheetBinary,
    drawing: &[u8],
    blips: &[Blip],
    media_names: &mut HashMap<usize, String>,
) -> Option<SheetArt> {
    let pictures = escher::parse_pictures(drawing);
    let mut anchors_xml = String::new();
    let mut rels_xml = String::new();
    let mut media: Vec<(String, Vec<u8>)> = Vec::new();
    let mut rel_count = 0usize;
    let mut rel_of_blip: HashMap<usize, usize> = HashMap::new();
    for (position, picture) in pictures.iter().enumerate() {
        let [col_l, dx_l, row_t, dy_t, col_r, dx_r, row_b, dy_b] = picture.anchor;
        if col_r == u16::MAX || row_b == u16::MAX {
            // "runs to the sheet's edge" — an extent the cell grid cannot name
            continue;
        }
        let blip_index = match picture.blip.checked_sub(1) {
            Some(index) if (index as usize) < blips.len() => index as usize,
            _ => continue,
        };
        let blip = &blips[blip_index];
        if blip.bytes.is_empty() || matches!(blip.kind, BlipKind::Other) {
            continue;
        }
        let rel = match rel_of_blip.get(&blip_index) {
            Some(rel) => *rel,
            None => {
                rel_count += 1;
                let rel = rel_count;
                // the media map carries the bare file name (the drawing's
                // relationship target); the package part gets the media path
                let name = match media_names.get(&blip_index) {
                    Some(name) => name.clone(),
                    None => {
                        let name =
                            format!("image{}.{}", media_names.len() + 1, blip.kind.extension());
                        media_names.insert(blip_index, name.clone());
                        media.push((format!("xl/media/{name}"), blip.bytes.clone()));
                        name
                    }
                };
                rels_xml.push_str(&format!(
                    r#"<Relationship Id="rId{rel}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/{name}"/>"#,
                ));
                rel_of_blip.insert(blip_index, rel);
                rel
            }
        };
        let from_x = column_span_px(sheet, col_l, dx_l);
        let from_y = row_span_px(sheet, row_t, dy_t);
        let to_x = column_span_px(sheet, col_r, dx_r);
        let to_y = row_span_px(sheet, row_b, dy_b);
        anchors_xml.push_str(&format!(
            r#"<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>{col_l}</xdr:col><xdr:colOff>{}</xdr:colOff><xdr:row>{row_t}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:from><xdr:to><xdr:col>{col_r}</xdr:col><xdr:colOff>{}</xdr:colOff><xdr:row>{row_b}</xdr:row><xdr:rowOff>{}</xdr:rowOff></xdr:to><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="{}" name="Picture {}"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId{rel}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill><xdr:spPr><a:xfrm><a:off x="{}" y="{}"/><a:ext cx="{}" cy="{}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>"#,
            px_to_emu(col_px(sheet, col_l) * f64::from(dx_l) / 1024.0),
            px_to_emu(row_px(sheet, row_t) * f64::from(dy_t) / 1024.0),
            px_to_emu(col_px(sheet, col_r) * f64::from(dx_r) / 1024.0),
            px_to_emu(row_px(sheet, row_b) * f64::from(dy_b) / 1024.0),
            position + 1,
            position + 1,
            px_to_emu(from_x),
            px_to_emu(from_y),
            px_to_emu((to_x - from_x).max(0.0)),
            px_to_emu((to_y - from_y).max(0.0)),
        ));
    }
    if rel_count == 0 {
        return None;
    }
    Some(SheetArt {
        xml: format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">{anchors_xml}</xdr:wsDr>"#,
        ),
        rels: format!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">{rels_xml}</Relationships>"#,
        ),
        media,
    })
}

/// The left edge of `column` plus `offset` 1024ths of its width, in pixels.
fn column_span_px(sheet: &XlsSheetBinary, column: u16, offset: u16) -> f64 {
    let full: f64 = (0..column).map(|step| col_px(sheet, step)).sum();
    full + col_px(sheet, column) * f64::from(offset) / 1024.0
}

/// The top edge of `row` plus `offset` 1024ths of its height, in pixels.
fn row_span_px(sheet: &XlsSheetBinary, row: u16, offset: u16) -> f64 {
    let full: f64 = (0..row).map(|step| row_px(sheet, step)).sum();
    full + row_px(sheet, row) * f64::from(offset) / 1024.0
}

fn worksheet_xml(
    range: &calamine::Range<Data>,
    formulas: &HashMap<(u32, u32), String>,
    columns: &str,
    tail: &str,
    heights: &HashMap<u16, (u16, bool)>,
    styles: &SheetStyles,
) -> (String, usize) {
    // Rows carrying values plus rows carrying only formulas or a height.
    let mut rows: HashMap<u32, Vec<(u32, String)>> = HashMap::new();
    let mut cells = 0usize;
    let (start_row, start_col) = range.start().unwrap_or((0, 0));
    for (row, column, value) in range.used_cells() {
        let absolute = (start_row + row as u32, start_col + column as u32);
        let formula = formulas.get(&absolute).map(String::as_str);
        let style = styles.cells.get(&absolute).copied();
        if let Some(cell) = cell_xml(absolute, value, formula, style) {
            cells += 1;
            rows.entry(absolute.0).or_default().push((absolute.1, cell));
        }
    }
    for (position, formula) in formulas {
        let covered = range
            .get_value((position.0, position.1))
            .is_some_and(|v| *v != Data::Empty);
        if !covered {
            cells += 1;
            let style = styles
                .cells
                .get(position)
                .map(|s| format!(r#" s="{s}""#))
                .unwrap_or_default();
            rows.entry(position.0).or_default().push((
                position.1,
                format!(
                    r#"<c r="{}"{style}><f>{}</f></c>"#,
                    cell_reference(position.0, position.1),
                    escape_xml(formula),
                ),
            ));
        }
    }
    for (row, (_, custom)) in heights {
        if *custom && !rows.contains_key(&u32::from(*row)) {
            rows.insert(u32::from(*row), Vec::new());
        }
    }
    // A formatted empty cell (borders, a fill) has no value for calamine to
    // report; it exists only through its style.
    for (position, style) in &styles.cells {
        let covered = range
            .get_value((position.0, position.1))
            .is_some_and(|v| *v != Data::Empty)
            || formulas.contains_key(position);
        if !covered {
            rows.entry(position.0).or_default().push((
                position.1,
                format!(
                    r#"<c r="{}" s="{style}"/>"#,
                    cell_reference(position.0, position.1)
                ),
            ));
        }
    }
    for row in styles.rows.keys() {
        rows.entry(*row).or_default();
    }

    let mut row_numbers: Vec<u32> = rows.keys().copied().collect();
    row_numbers.sort_unstable();
    let mut body = String::new();
    for row in row_numbers {
        let mut line = rows.remove(&row).unwrap_or_default();
        line.sort_unstable_by_key(|(column, _)| *column);
        let height = match heights.get(&u16::try_from(row).unwrap_or(u16::MAX)) {
            // a hand-set height goes out with the custom flag; the sheet
            // default the file echoed back stays with the reader
            Some((twips, true)) => {
                format!(r#" ht="{:.2}" customHeight="1""#, f64::from(*twips) / 20.0)
            }
            _ => String::new(),
        };
        let row_style = match styles.rows.get(&row) {
            Some(s) => format!(r#" s="{s}" customFormat="1""#),
            None => String::new(),
        };
        body.push_str(&format!(r#"<row r="{}"{height}{row_style}>"#, row + 1));
        for (_, cell) in line {
            body.push_str(&cell);
        }
        body.push_str("</row>");
    }

    let dimension = match (range.start(), range.end()) {
        (Some(start), Some(end)) => format!(
            "{}:{}",
            cell_reference(start.0, start.1),
            cell_reference(end.0, end.1),
        ),
        _ => "A1:A1".into(),
    };
    (worksheet_document(&dimension, columns, &body, tail), cells)
}

fn cell_xml(
    position: (u32, u32),
    value: &Data,
    formula: Option<&str>,
    style: Option<u16>,
) -> Option<String> {
    let reference = cell_reference(position.0, position.1);
    let head = match style {
        Some(s) => format!(r#"r="{reference}" s="{s}""#),
        None => format!(r#"r="{reference}""#),
    };
    let formula_xml = formula
        .map(|text| format!("<f>{}</f>", escape_xml(text)))
        .unwrap_or_default();
    let cell = match value {
        Data::Empty => {
            if formula.is_none() {
                return None;
            }
            format!(r#"<c {head}>{formula_xml}</c>"#)
        }
        Data::String(text) => format!(
            r#"<c {head} t="inlineStr">{formula_xml}<is><t xml:space="preserve">{}</t></is></c>"#,
            escape_xml(text),
        ),
        Data::Float(number) => format!(r#"<c {head}>{formula_xml}<v>{number}</v></c>"#),
        Data::Int(number) => format!(r#"<c {head}>{formula_xml}<v>{number}</v></c>"#),
        Data::Bool(flag) => format!(
            r#"<c {head} t="b">{formula_xml}<v>{}</v></c>"#,
            if *flag { 1 } else { 0 },
        ),
        Data::DateTime(datetime) => date_cell(&reference, &formula_xml, datetime.as_f64(), style),
        Data::Error(error) => format!(
            r#"<c {head} t="e">{formula_xml}<v>{}</v></c>"#,
            escape_xml(&error.to_string()),
        ),
        // ODF keeps a date as ISO text (`office:date-value="2026-03-05"`) rather
        // than as a serial, so the text form is turned back into one here: left
        // as text, every imported date would sort and calculate as a string.
        Data::DateTimeIso(text) => match iso_serial(text) {
            Some(serial) => date_cell(&reference, &formula_xml, serial, style),
            None => text_cell(&head, &formula_xml, text),
        },
        Data::DurationIso(text) => text_cell(&head, &formula_xml, text),
    };
    Some(cell)
}

/// A date cell keeps the file's own number format when it has one; otherwise
/// whole serials take the short-date format, timed ones the date+time one
/// (xf 1 / xf 2 of STYLES_XML).
fn date_cell(reference: &str, formula_xml: &str, serial: f64, style: Option<u16>) -> String {
    let style = style.unwrap_or(if serial.fract() == 0.0 { 1 } else { 2 });
    format!(r#"<c r="{reference}" s="{style}">{formula_xml}<v>{serial}</v></c>"#)
}

fn text_cell(head: &str, formula_xml: &str, text: &str) -> String {
    format!(
        r#"<c {head} t="inlineStr">{formula_xml}<is><t xml:space="preserve">{}</t></is></c>"#,
        escape_xml(text),
    )
}
