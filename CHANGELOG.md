# Changelog

## [0.2.0] — 2026-06-09

### Added
- "My Issues" default landing view — shows assigned issues grouped by state (started > unstarted > backlog)
- `/me` server endpoint resolves API key to user identity (cached)
- My issues / all issues toggle in header
- Default assignee pre-selected on issue creation
- Responsive layout for narrow widths (<480px) via ResizeObserver
- Keyboard navigation: j/k to move, Enter to open, c to create, / to search, Esc to clear/back, s/p to focus state/priority in detail
- Shortcut help overlay (? button)
- Add comment from detail view with Enter-to-submit
- Sort controls: newest, priority, updated, due date
- Issue count badges by state group (clickable to filter)
- Quick-filter presets: My open, High priority, Overdue
- "Open in Plane" link in detail view
- Sub-issue awareness: parent link, child count indicator, navigable sub-issue list in detail

### Fixed
- Description textarea value now sent on issue creation
- Stale error state cleared on every action
- Priority change in detail view now invalidates list cache
- "New issue" button hidden when no project selected
- Double-quote typo in issue row HTML attribute

### Security
- `comment_html` type validated server-side (typeof guard rejects non-string values)
- WebSocket origin validation on upgrade (allowlist check)
- Comment and description text escaped before HTML wrapping

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
