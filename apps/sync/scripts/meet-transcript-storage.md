# Native transcript storage

The outbox stores only renderer-designated shared final rows. Call controller
membership checks and backend upload authorization remain required. Every
outbox and projection command compares the supplied account ID to native saved
credentials, without making a network request. Only call and desktop-alt
windows may invoke them.

`meet_transcript_outbox_enqueue({accountId,row,audience:'room'})` persists rows
under the account hash. `meet_transcript_outbox_read({accountId,offset?})` returns
rows, totalCount, hasMore, and recent receipts. `meet_transcript_outbox_ack`
accepts exact revision keys and optional confirmed backend receipt. The UI must
never acknowledge a mere attempted upload. Receipt metadata survives deletion
of uploaded rows so other windows can show the saved source reference.

`meet_transcript_project({accountId,companyUid,projection})` receives authorized
server content; projection contains sourceId, revision, markdown, rawJson.
The company UID resolves through existing local manifest discovery; callers
cannot choose a slug or path. Only canonical `native-<64 lowercase hex>` IDs
are accepted. Destination is companies/<mapped slug>/sources/meetings/.

The projection ledger is account/company/source scoped under application data,
not in the synced vault. Atomic write-ahead hashes protect interrupted updates.
Untracked existing files or edits differing from the last projected contents
cause a conflict; user contents remain untouched. Source pair updates are
individually atomic; after a crash, repeating the same revision finishes the
pair. There is no hard filesystem immutability, so users may edit files, but the
next projection refuses to replace their edits.

Before writing, the projector appends protected native-source patterns to the
active .hqignore (or legacy .hqsyncignore) at HQ and company roots. Existing
bytes are retained. These server-owned files therefore do not re-upload through
the generic CLI sync engine. The shared Rust default filter also excludes them.
Files use private Unix permissions; Windows uses the user application-data and
vault directories' inherited ACLs and atomic MoveFileEx replacement.

`meet_personal_transcript_project({accountId,projection,reveal?})` uses the same
projection shape and ownership safeguards, with a fixed personal/sources/meetings
location. It writes local solo notes only: no upload outbox or backend endpoint
is called. Generated personal native sources are excluded by Rust defaults and
persisted root/personal ignore rules before the first file is written. Manual
personal meeting notes keep their existing sync behavior.
