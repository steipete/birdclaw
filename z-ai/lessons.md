# Lessons

- Bird relay selection is mandatory. Do not assume a default bird profile exists; always require or explicitly resolve `bird_profile_name` before invoking `bird`.
- When changing a command wrapper to require `profileName`, update both runtime callers and tests together so the new contract is enforced end to end.
- A configured `bird_profile_name` is not enough for account-scoped sync. Before persisting bird reads, run `bird whoami` for that profile and reject mismatches against the selected Birdclaw account.
- Status/readiness pages must use the same selected account context as sync and actions; otherwise they report the default account and hide profile configuration problems.
