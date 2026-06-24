# Lessons

- Bird relay selection is mandatory. Do not assume a default bird profile exists; always require or explicitly resolve `bird_profile_name` before invoking `bird`.
- When changing a command wrapper to require `profileName`, update both runtime callers and tests together so the new contract is enforced end to end.
