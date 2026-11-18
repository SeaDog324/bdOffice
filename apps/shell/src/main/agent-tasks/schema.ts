/** Initial ledger schema. Maintenance tasks use a subset; the general scheduler is separate. */
export const TASK_SCHEMA = `
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

CREATE TABLE schema_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1');

CREATE TABLE executors (
  id TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  boot_id TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK(authority_revision >= 0),
  capabilities_json TEXT NOT NULL CHECK(json_valid(capabilities_json)),
  availability TEXT NOT NULL CHECK(availability IN ('online','offline','draining')),
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('assistant','diagnostic','repair')),
  session_id TEXT,
  title TEXT NOT NULL,
  goal_json TEXT NOT NULL CHECK(json_valid(goal_json)),
  context_json TEXT NOT NULL CHECK(json_valid(context_json)),
  plan_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(plan_json)),
  budget_json TEXT NOT NULL CHECK(json_valid(budget_json)),
  provider_ref_json TEXT CHECK(provider_ref_json IS NULL OR json_valid(provider_ref_json)),
  executor_id TEXT REFERENCES executors(id),
  state TEXT NOT NULL CHECK(state IN (
    'queued','waiting_device','waiting_resource','preparing','running',
    'waiting_user','verifying','pausing','paused','cancelling',
    'interrupted','completed','failed','cancelled'
  )),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  next_event_sequence INTEGER NOT NULL DEFAULT 1 CHECK(next_event_sequence >= 1),
  reason_code TEXT,
  pending_control TEXT CHECK(pending_control IS NULL OR pending_control IN ('pause','cancel')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(authority_id, principal_id, request_id),
  UNIQUE(id, session_id)
);
CREATE INDEX tasks_dispatch ON tasks(state, updated_at);
CREATE INDEX tasks_session ON tasks(session_id, updated_at);

-- Control request receipts are written atomically with the resulting state/event.
CREATE TABLE task_commands (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(task_id, principal_id, request_id)
);

CREATE TABLE session_owners (
  session_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY(task_id, session_id) REFERENCES tasks(id, session_id) ON DELETE CASCADE
);

CREATE TABLE task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  executor_id TEXT NOT NULL REFERENCES executors(id),
  boot_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('active','quiescing','suspended','completed','failed','lost','cancelled')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  UNIQUE(task_id, epoch),
  UNIQUE(id, task_id),
  UNIQUE(id, task_id, executor_id, boot_id, epoch),
  UNIQUE(id, task_id, epoch)
);
CREATE UNIQUE INDEX one_active_attempt_per_task
  ON task_attempts(task_id) WHERE state IN ('active','quiescing');

CREATE TABLE task_leases (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  executor_id TEXT NOT NULL REFERENCES executors(id),
  boot_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(attempt_id, task_id, executor_id, boot_id, epoch)
    REFERENCES task_attempts(id, task_id, executor_id, boot_id, epoch) ON DELETE CASCADE
);

-- Expiry alone never releases an I/O resource. Reconcile/stop the old owner first.
CREATE TABLE execution_resources (
  resource_key TEXT PRIMARY KEY,
  device_id TEXT NOT NULL,
  owner_task_id TEXT NOT NULL,
  owner_attempt_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL CHECK(owner_epoch > 0),
  state TEXT NOT NULL CHECK(state IN ('held','quarantined')),
  proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(owner_attempt_id, owner_task_id, owner_epoch)
    REFERENCES task_attempts(id, task_id, epoch) ON DELETE RESTRICT
);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  plan_revision INTEGER NOT NULL CHECK(plan_revision > 0),
  display_order INTEGER NOT NULL CHECK(display_order >= 0),
  operation_digest TEXT NOT NULL,
  arguments_ref_json TEXT NOT NULL CHECK(json_valid(arguments_ref_json)),
  targets_json TEXT NOT NULL CHECK(json_valid(targets_json)),
  recovery TEXT NOT NULL CHECK(recovery IN ('repeat_read','verify_effect','user_reconcile')),
  state TEXT NOT NULL CHECK(state IN (
    'planned','prepared','executing','awaiting_reconciliation',
    'verified','failed','cancelled','superseded'
  )),
  effect_state TEXT NOT NULL CHECK(effect_state IN ('not_started','started','applied','not_applied','unknown')),
  receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  UNIQUE(id, task_id)
);
CREATE INDEX steps_task ON task_steps(task_id, plan_revision, display_order);

CREATE TABLE task_artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('checkpoint','diff','repair_backup','user_output')),
  owned_by_store INTEGER NOT NULL CHECK(owned_by_store IN (0,1)),
  storage_ref_json TEXT NOT NULL CHECK(json_valid(storage_ref_json)),
  content_digest TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK(byte_length >= 0),
  evidence_json TEXT CHECK(evidence_json IS NULL OR json_valid(evidence_json)),
  created_at INTEGER NOT NULL,
  CHECK(kind != 'user_output' OR owned_by_store = 0),
  UNIQUE(id, task_id),
  FOREIGN KEY(step_id, task_id) REFERENCES task_steps(id, task_id)
);
CREATE INDEX artifacts_task ON task_artifacts(task_id);

CREATE TABLE task_evidence (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  diff_artifact_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(step_id, task_id) REFERENCES task_steps(id, task_id),
  FOREIGN KEY(diff_artifact_id, task_id) REFERENCES task_artifacts(id, task_id) ON DELETE RESTRICT
);

CREATE TABLE task_checkpoints (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt_id TEXT NOT NULL,
  epoch INTEGER NOT NULL CHECK(epoch > 0),
  through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
  conversation_artifact_id TEXT NOT NULL,
  context_artifact_id TEXT NOT NULL,
  progress_json TEXT NOT NULL CHECK(json_valid(progress_json)),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(attempt_id, task_id, epoch) REFERENCES task_attempts(id, task_id, epoch),
  FOREIGN KEY(conversation_artifact_id, task_id) REFERENCES task_artifacts(id, task_id) ON DELETE RESTRICT,
  FOREIGN KEY(context_artifact_id, task_id) REFERENCES task_artifacts(id, task_id) ON DELETE RESTRICT
);

CREATE TABLE task_confirmations (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  step_id TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('approval','clarification','conflict','budget_extension')),
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','invalidated','expired')),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  subject_digest TEXT NOT NULL,
  authority_revision INTEGER NOT NULL CHECK(authority_revision >= 0),
  context_revisions_json TEXT NOT NULL CHECK(json_valid(context_revisions_json)),
  question_json TEXT NOT NULL CHECK(json_valid(question_json)),
  response_request_id TEXT,
  response_digest TEXT,
  response_json TEXT CHECK(response_json IS NULL OR json_valid(response_json)),
  actor_ref_json TEXT CHECK(actor_ref_json IS NULL OR json_valid(actor_ref_json)),
  expires_at INTEGER,
  resolved_at INTEGER,
  FOREIGN KEY(step_id, task_id) REFERENCES task_steps(id, task_id),
  UNIQUE(task_id, response_request_id)
);

CREATE TABLE task_events (
  feed_cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  revision INTEGER NOT NULL CHECK(revision >= 0),
  type TEXT NOT NULL,
  summary TEXT NOT NULL,
  refs_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(refs_json)),
  created_at INTEGER NOT NULL,
  UNIQUE(task_id, sequence)
);
CREATE INDEX events_task ON task_events(task_id, sequence);

CREATE TABLE task_outbox (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  event_sequence INTEGER NOT NULL,
  destination_id TEXT NOT NULL,
  route TEXT NOT NULL CHECK(route IN ('local','remote_reserved')),
  kind TEXT NOT NULL CHECK(kind IN ('attention_required','result_ready','task_blocked')),
  dedupe_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  state TEXT NOT NULL CHECK(state IN ('pending','inflight','delivered','acked','cancelled','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  retry_at INTEGER,
  delivery_epoch INTEGER NOT NULL DEFAULT 0 CHECK(delivery_epoch >= 0),
  delivery_lease_until INTEGER,
  receipt_id TEXT,
  delivered_at INTEGER,
  acknowledged_at INTEGER,
  read_at INTEGER,
  FOREIGN KEY(task_id, event_sequence) REFERENCES task_events(task_id, sequence)
);
CREATE INDEX outbox_dispatch ON task_outbox(state, retry_at);

-- Cross-store Session purge is a manually authorized saga, never a normal Agent task.
CREATE TABLE lifecycle_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind = 'manual_session_purge'),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  confirmation_ref TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','applying','completed','failed')),
  phase TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- Minimal non-content identities prevent late workers and retries from resurrecting purged tasks.
CREATE TABLE task_tombstones (
  task_id TEXT PRIMARY KEY,
  authority_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  purge_job_id TEXT NOT NULL REFERENCES lifecycle_jobs(id),
  purged_at INTEGER NOT NULL,
  UNIQUE(authority_id, principal_id, request_id)
);

CREATE TABLE session_tombstones (
  session_id TEXT PRIMARY KEY,
  purge_job_id TEXT NOT NULL REFERENCES lifecycle_jobs(id),
  purged_at INTEGER NOT NULL
);

PRAGMA application_id = 0x42444f47;
PRAGMA user_version = 1;
COMMIT;
`
