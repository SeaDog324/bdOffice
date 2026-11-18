//! The sidecar's request protocol: one JSON request per line in, one JSON
//! response per line out. `main.rs` serves it over stdin/stdout; [`Engine`]
//! serves it one call at a time, for hosts without stdin or threads.

use std::collections::VecDeque;
use std::io::{self, BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use crate::archive::{
    EntryContent, StreamPatchEntry, archive_manifest, read_entries_to_dir, save_archive,
    scan_entries_for_text,
};
use crate::find::FindCellsRequest;
use crate::recalc::{RecalcCache, RecalcEdit, RecalcRead, recalc_cells_reporting};
use crate::{CellRange, SidecarError, THREADS, WorkbookSessions};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u8 = 1;

fn default_locale() -> String {
    "zh".to_owned()
}

#[derive(Debug, Deserialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum Command {
    Open {
        path: PathBuf,
        #[serde(default = "default_locale")]
        locale: String,
        #[serde(default, rename = "shortDateFormat")]
        short_date_format: Option<String>,
    },
    ReadRange {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
        range: CellRange,
    },
    Close {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    ReadMedia {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "visualId")]
        visual_id: String,
    },
    ReadFormulaCells {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
    },
    FindCells(FindCellsRequest),
    ReadRowOutline {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(rename = "sheetId")]
        sheet_id: String,
    },
    Cancel {
        #[serde(rename = "targetRequestId")]
        target_request_id: String,
    },
    #[serde(rename_all = "camelCase")]
    ArchiveManifest {
        path: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    ReadEntries {
        path: PathBuf,
        entries: Vec<String>,
        output_dir: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    ScanEntries {
        path: PathBuf,
        entries: Vec<String>,
        needle: String,
    },
    #[serde(rename_all = "camelCase")]
    ConvertWorkbook {
        path: PathBuf,
        target_path: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    SaveArchive {
        source_path: PathBuf,
        target_path: PathBuf,
        replacements: Vec<EntryContent>,
        removals: Vec<String>,
        additions: Vec<EntryContent>,
        /// Oversized entries rewritten by the streaming cell-upsert pass.
        #[serde(default)]
        stream_patches: Vec<StreamPatchEntry>,
    },
    #[serde(rename_all = "camelCase")]
    RecalcCells {
        path: PathBuf,
        #[serde(default)]
        edits: Vec<RecalcEdit>,
        #[serde(default)]
        reads: Vec<RecalcRead>,
        /// Also report formula cells whose cached `<v>` disagrees with the
        /// engine's computed value (the host refreshes them on save), plus
        /// array spill cells it cannot refresh. Omitted from the answer when
        /// the engine skips the audit (a `date1904` workbook): the result then
        /// carries `auditSkipped` with the reason instead.
        #[serde(default)]
        report_stale: bool,
    },
    #[serde(rename_all = "camelCase")]
    UpdateExternalLinks {
        path: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    ReadExternalLinks {
        path: PathBuf,
    },
    #[serde(rename_all = "camelCase")]
    ListExternalLinks {
        path: PathBuf,
    },
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub version: u8,
    pub request_id: String,
    #[serde(flatten)]
    pub command: Command,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    version: u8,
    request_id: String,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorBody>,
}

#[derive(Serialize)]
pub struct ErrorBody {
    code: &'static str,
    message: String,
}

pub type SharedOutput = Arc<Mutex<BufWriter<io::Stdout>>>;

pub fn write_response(output: &SharedOutput, response: &Response) -> Result<(), ()> {
    let mut output = output
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if serde_json::to_writer(&mut *output, response).is_err()
        || output.write_all(b"\n").is_err()
        || output.flush().is_err()
    {
        return Err(());
    }
    Ok(())
}

/// Owns the formula-engine state so recalc_cells can run off the request
/// loop: a cold IronCalc import of a formula-heavy workbook takes minutes,
/// and running it inline starved every interactive read_range behind it
/// (each timing out client-side while the sheet rendered blank).
pub struct RecalcWorker {
    cache: Arc<Mutex<RecalcCache>>,
    /// Purges arrive from the request loop while a recalc may hold the cache
    /// lock for minutes; they queue here and apply at the next recalc. Safe
    /// to defer: recalc_cells re-imports on mtime+size mismatch anyway.
    pending_purges: Arc<Mutex<Vec<PathBuf>>>,
    busy: Arc<AtomicBool>,
}

/// Clears the busy flag even when recalc_cells panics mid-import.
struct BusyReset(Arc<AtomicBool>);

impl Drop for BusyReset {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

impl Default for RecalcWorker {
    fn default() -> Self {
        Self::new()
    }
}

impl RecalcWorker {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(RecalcCache::new())),
            pending_purges: Arc::new(Mutex::new(Vec::new())),
            busy: Arc::new(AtomicBool::new(false)),
        }
    }

    fn queue_purge(&self, path: &PathBuf) {
        self.pending_purges
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .push(path.clone());
    }

    /// Close must reclaim the resident model right away when it can: a queued
    /// purge only applies at the next recalc, and a closed workbook may never
    /// be recalced again. Falls back to the queue while a recalc holds the
    /// cache lock.
    fn purge_now_or_queue(&self, path: &PathBuf) {
        match self.cache.try_lock() {
            Ok(mut cache) => cache.purge(path),
            Err(std::sync::TryLockError::Poisoned(poisoned)) => poisoned.into_inner().purge(path),
            Err(std::sync::TryLockError::WouldBlock) => self.queue_purge(path),
        }
    }

    fn drain_purges(&self, cache: &mut RecalcCache) {
        let purges: Vec<PathBuf> = self
            .pending_purges
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .drain(..)
            .collect();
        for purge in &purges {
            cache.purge(purge);
        }
    }

    /// The synchronous recalc body (also the unit-test entry point).
    fn run(
        &self,
        request_id: String,
        path: &PathBuf,
        edits: &[RecalcEdit],
        reads: &[RecalcRead],
        report_stale: bool,
    ) -> Response {
        let mut cache = self
            .cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.drain_purges(&mut cache);
        let response = match recalc_cells_reporting(&mut cache, path, edits, reads, report_stale)
            .and_then(to_json_value)
        {
            Ok(value) => Response::success(request_id, value),
            Err(error) => Response::from_error(request_id, error),
        };
        // A Close racing this recalc queued its purge after the drain above;
        // apply it before releasing the lock so the just-inserted model does
        // not outlive its session.
        self.drain_purges(&mut cache);
        response
    }

    /// Runs the recalc on a worker thread, writing the response when done.
    /// Returns an immediate failure response when one is already in flight —
    /// callers fail soft to cached values and retry later. Without threads
    /// the recalc answers inline, before the next request is read.
    fn dispatch(
        &self,
        request_id: String,
        path: PathBuf,
        edits: Vec<RecalcEdit>,
        reads: Vec<RecalcRead>,
        report_stale: bool,
        output: &SharedOutput,
    ) -> Option<Response> {
        if !THREADS {
            return Some(self.run(request_id, &path, &edits, &reads, report_stale));
        }
        if self
            .busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return Some(Response::failure(
                request_id,
                "recalc_busy",
                "Formula engine is busy with another recalculation.".into(),
            ));
        }
        let worker = Self {
            cache: Arc::clone(&self.cache),
            pending_purges: Arc::clone(&self.pending_purges),
            busy: Arc::clone(&self.busy),
        };
        let output = Arc::clone(output);
        let reply_id = request_id.clone();
        let spawned = thread::Builder::new()
            .name("xlsx-recalc".into())
            .spawn(move || {
                let reset = BusyReset(Arc::clone(&worker.busy));
                let response = worker.run(request_id, &path, &edits, &reads, report_stale);
                // Clear busy before replying: a sequential caller issues its
                // next recalc the moment the response lands, and hitting the
                // still-set flag bounced it with recalc_busy.
                drop(reset);
                let _ = write_response(&output, &response);
            });
        match spawned {
            Ok(_) => None,
            Err(error) => {
                self.busy.store(false, Ordering::Release);
                Some(Response::failure(
                    reply_id,
                    "io_error",
                    format!("Unable to start the recalc worker: {error}"),
                ))
            }
        }
    }
}

/// Request ids cancelled out of band by the reader thread, awaiting their
/// turn in the request queue. A cancel that lands after its target already
/// replied would pin the id here forever (ids are never reused), so the list
/// is capped — forgetting an id merely lets that request run as before.
#[derive(Clone)]
pub struct CancelledRequests(Arc<Mutex<VecDeque<String>>>);

const MAX_CANCELLED_REQUESTS: usize = 256;

impl Default for CancelledRequests {
    fn default() -> Self {
        Self::new()
    }
}

impl CancelledRequests {
    pub fn new() -> Self {
        Self(Arc::new(Mutex::new(VecDeque::new())))
    }

    pub fn insert(&self, request_id: String) {
        let mut ids = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if ids.len() >= MAX_CANCELLED_REQUESTS {
            ids.pop_front();
        }
        ids.push_back(request_id);
    }

    fn take(&self, request_id: &str) -> bool {
        let mut ids = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match ids.iter().position(|id| id == request_id) {
            Some(index) => {
                ids.remove(index);
                true
            }
            None => false,
        }
    }
}

/// The request the loop is currently executing, plus the flag a cancel sets
/// to reach it. `CancelledRequests` only covers requests still waiting their
/// turn: once the loop dequeues one, its queue entry is never consulted
/// again, so an in-flight open would run to completion — creating a cache
/// directory and registering a session for a host that already discarded the
/// snapshot it was going to open.
#[derive(Clone)]
pub struct InFlightRequest(Arc<InFlightState>);

struct InFlightState {
    id: Mutex<String>,
    cancelled: Arc<AtomicBool>,
}

impl Default for InFlightRequest {
    fn default() -> Self {
        Self::new()
    }
}

impl InFlightRequest {
    pub fn new() -> Self {
        Self(Arc::new(InFlightState {
            id: Mutex::new(String::new()),
            cancelled: Arc::new(AtomicBool::new(false)),
        }))
    }

    /// Registers the request about to run and clears the flag the previous
    /// request may have left set. Called before the queue check, so the two
    /// cover opposite sides of the dequeue: a cancel naming a still-queued
    /// request is caught by the queue, one naming the request now running is
    /// caught by the flag.
    pub fn begin(&self, request_id: &str) {
        *self
            .0
            .id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = request_id.to_owned();
        self.0.cancelled.store(false, Ordering::Release);
    }

    /// The reader thread's half of a cancel that names the running request. A
    /// target that is not the one running is left entirely to
    /// `CancelledRequests`, whose cap and forget-on-overflow semantics are
    /// unchanged.
    pub fn cancel(&self, target_request_id: &str) {
        let id = self
            .0
            .id
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if *id == target_request_id {
            self.0.cancelled.store(true, Ordering::Release);
        }
    }

    /// The live flag an in-flight request polls.
    fn flag(&self) -> Arc<AtomicBool> {
        Arc::clone(&self.0.cancelled)
    }
}

/// The sidecar as a single value: each call handles one request line and
/// returns its response line. For hosts that cannot hand the binary a stdin,
/// such as a WebAssembly build driven from JavaScript. A cancel only reaches
/// requests not yet handled, since requests are handled one at a time.
pub struct Engine {
    sessions: WorkbookSessions,
    recalc: RecalcWorker,
    cancelled: CancelledRequests,
    in_flight: InFlightRequest,
    output: SharedOutput,
}

impl Engine {
    pub fn new() -> Self {
        Self {
            sessions: WorkbookSessions::new(),
            recalc: RecalcWorker::new(),
            cancelled: CancelledRequests::new(),
            in_flight: InFlightRequest::new(),
            output: Arc::new(Mutex::new(BufWriter::new(io::stdout()))),
        }
    }

    /// `None` only when threads are available and a recalc will write its
    /// response to stdout later.
    pub fn handle_line(&mut self, line: &str) -> Option<String> {
        let response = match serde_json::from_str::<Request>(line) {
            Ok(request) => {
                self.in_flight.begin(&request.request_id);
                handle_request(
                    request,
                    &mut self.sessions,
                    &self.recalc,
                    &self.cancelled,
                    &self.in_flight,
                    &self.output,
                )?
            }
            Err(error) => Response::failure(
                String::new(),
                "invalid_json",
                format!("Invalid sidecar request: {error}"),
            ),
        };
        Some(serde_json::to_string(&response).unwrap_or_default())
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}



pub fn handle_request(
    request: Request,
    sessions: &mut WorkbookSessions,
    recalc: &RecalcWorker,
    cancelled: &CancelledRequests,
    in_flight: &InFlightRequest,
    output: &SharedOutput,
) -> Option<Response> {
    if cancelled.take(&request.request_id) {
        return Some(Response::failure(
            request.request_id,
            "cancelled",
            "Request was cancelled by the client.".into(),
        ));
    }
    if request.version != PROTOCOL_VERSION {
        return Some(Response::failure(
            request.request_id,
            "unsupported_version",
            "Unsupported sidecar protocol version.".into(),
        ));
    }

    let request_id = request.request_id;
    let result = match request.command {
        Command::Open {
            path,
            locale,
            short_date_format,
        } => {
            // The flag the open polls: a cancel that landed after this
            // request was dequeued reaches it here, where the queue no
            // longer can.
            let in_flight_cancelled = in_flight.flag();
            sessions
                .open_with_locale(&path, &locale, short_date_format.as_deref(), &in_flight_cancelled)
                .and_then(to_json_value)
        }
        Command::ReadRange {
            session_id,
            sheet_id,
            range,
        } => sessions
            .read_range(&session_id, &sheet_id, &range)
            .and_then(to_json_value),
        Command::Close { session_id } => {
            // A resident recalc model can dwarf the session itself (an
            // 8.8M-cell workbook's model holds ~1.2GB) — it must not outlive
            // the tab that needed it.
            if let Some(path) = sessions.session_path(&session_id) {
                recalc.purge_now_or_queue(&path);
            }
            sessions
                .close(&session_id)
                .and_then(|()| to_json_value(serde_json::json!({ "closed": true })))
        }
        Command::ReadMedia {
            session_id,
            visual_id,
        } => sessions
            .read_media(&session_id, &visual_id)
            .and_then(to_json_value),
        Command::ReadFormulaCells {
            session_id,
            sheet_id,
        } => sessions
            .read_formula_cells(&session_id, &sheet_id)
            .and_then(to_json_value),
        Command::FindCells(request) => sessions
            .find_cells(&request, &in_flight.flag())
            .and_then(to_json_value),
        Command::ReadRowOutline {
            session_id,
            sheet_id,
        } => sessions
            .read_row_outline(&session_id, &sheet_id)
            .and_then(to_json_value),
        // Normally intercepted out of band by the reader thread; through this
        // path (tests) it still marks the target for the skip check above.
        Command::Cancel { target_request_id } => {
            cancelled.insert(target_request_id);
            to_json_value(serde_json::json!({ "cancelled": true }))
        }
        Command::ConvertWorkbook { path, target_path } => {
            crate::convert::convert_to_xlsx(&path, &target_path).and_then(|result| {
                to_json_value(serde_json::json!({
                    "sheets": result.sheets,
                    "cells": result.cells,
                }))
            })
        }
        Command::ArchiveManifest { path } => archive_manifest(&path)
            .and_then(|entries| to_json_value(serde_json::json!({ "entries": entries }))),
        Command::ReadEntries {
            path,
            entries,
            output_dir,
        } => read_entries_to_dir(&path, &entries, &output_dir)
            .and_then(|extracted| to_json_value(serde_json::json!({ "entries": extracted }))),
        Command::ScanEntries {
            path,
            entries,
            needle,
        } => scan_entries_for_text(&path, &entries, &needle)
            .and_then(|matches| to_json_value(serde_json::json!({ "matches": matches }))),
        Command::SaveArchive {
            source_path,
            target_path,
            replacements,
            removals,
            additions,
            stream_patches,
        } => {
            // The saved bytes supersede any resident formula model for the
            // target. The source is only read, so its warm model stays valid;
            // purging it would make every 30s crash-recovery copy of the open
            // workbook force a cold re-import on the next recalc. If the file
            // behind the source path changes later (e.g. the target is renamed
            // over it), the mtime+size guard in recalc_cells rebuilds anyway.
            recalc.queue_purge(&target_path);
            save_archive(
                &source_path,
                &target_path,
                &replacements,
                &removals,
                &additions,
                &stream_patches,
            )
            .and_then(to_json_value)
        }
        Command::RecalcCells {
            path,
            edits,
            reads,
            report_stale,
        } => {
            return recalc.dispatch(request_id, path, edits, reads, report_stale, output);
        }
        Command::UpdateExternalLinks { path } => {
            crate::external_links::update_external_link_values(&path).and_then(to_json_value)
        }
        Command::ReadExternalLinks { path } => {
            crate::external_links::read_external_link_statuses(&path).and_then(to_json_value)
        }
        Command::ListExternalLinks { path } => {
            crate::external_links::list_external_link_statuses(&path).and_then(to_json_value)
        }
    };
    Some(match result {
        Ok(value) => Response::success(request_id, value),
        Err(error) => Response::from_error(request_id, error),
    })
}

fn to_json_value<T: Serialize>(value: T) -> Result<Value, SidecarError> {
    serde_json::to_value(value).map_err(SidecarError::from)
}

impl Response {
    pub fn success(request_id: String, result: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id,
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn from_error(request_id: String, error: SidecarError) -> Self {
        let code = match error {
            SidecarError::InvalidRequest(_) => "invalid_request",
            SidecarError::Io(_) => "io_error",
            SidecarError::Workbook(_) => "workbook_error",
            SidecarError::Cancelled => "cancelled",
        };
        Self::failure(request_id, code, error.to_string())
    }

    pub fn failure(request_id: String, code: &'static str, message: String) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            request_id,
            ok: false,
            result: None,
            error: Some(ErrorBody { code, message }),
        }
    }
}
