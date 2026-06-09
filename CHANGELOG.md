# Changelog

## [0.1.0] — 2026-06-09

### Added
- Phase 1: full Plane plugin tab for CloudCLI
- Issue list with filtering (state group, priority, assignee, label, cycle)
- Quick state transitions from the issue list (inline dropdown, optimistic update)
- Issue detail pane: description, labels, assignees, dates, comments, state/priority controls
- Inline issue creation with title, priority, label, assignee fields
- Cycle view via cycle filter dropdown
- Overdue flagging (target date past today shown in error color)
- Client-side search across issue title and sequence ID
- WebSocket connection for live refresh after mutations
- Dark/light theme support matching CloudCLI host
- Config via `~/.claude-code-ui/plugins/cloudcli-plugin-plane/config.json`

### Security
- All Plane API string data escaped via `escHtml()` before `innerHTML` insertion
- Label color values validated against hex pattern before style attribute injection
- UUID validation on all route ID parameters (project, issue, cycle)
- Request body size limited to 1MB in `parseBody()`
- 5xx error messages return generic "upstream error" (no path/slug leakage)
- Server warns at startup if config file is world-readable
- No external font loads — monospace stack uses local system fonts
