# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-06-05

### Added
- Initial identity-reflection utility component.
- `scripts/reflect.js fetch` with cursor-based C4 conversation fetching, threshold gating, and JSON envelope output.
- `scripts/reflect.js commit` with atomic state updates and run logging.
- Scheduler task registration and legacy long-prompt task migration in `post-install`.
- Background-subagent workflow and identity safety constraints in `SKILL.md`.
- User-editable policy file for identity-relevant signal priority.

### Upgrade Notes

Initial release. For fresh installation:

```bash
zylos add identity-reflection
```

No migration required.
