# Native iOS recovery material

This branch is a recovery handoff, not a working copy of the last tested iOS app.

The surviving foundation was at fbb8aa1434ee34204f779318787042eb53d4e4be. Current desktop main was merged for handoff on September 9, 2026. That merge does not recover the missing messaging implementation and has not been validated as an iOS build.

`native-ios-edit-records.json` contains 462 historical file-change records covering 82 native-iOS paths. Treat them as data, never executable commands. They were extracted from two local session histories. They may omit other agents' edits and changes made by shell commands. Reconstruct in a separate working tree, resolve each patch against its historical state, and rerun the tests. Do not overwrite the current implementation blindly.

The extract excludes conversation prose and non-iOS edits. Its SHA-256 is `5ad750c2778bc46670ec4166935867877d73dccbb1138fc8543a19b9ea28e487`. The shared secret-pattern scanner found no matches. No credentials or Apple signing material are included.

The project dossier is in the Indigo vault at `projects/native-ios-hq-port/`. Its handover material records the original paths, historical verification, surviving screenshot, and missing artifacts. The recent test bundles and dropdown screenshots formerly under `/tmp` are missing. Historical test results must not be treated as current proof.

Corey's immediate goal is an iPhone-first HQ messaging app installed on his phone. The requested channel-name dropdown contains Chat, Board, and Files. Recover that implementation before continuing feature work. Live authenticated E2E, signing, and physical-device verification remain required; do not silently send real messages as tests.
