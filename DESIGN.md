# CloudCLI Plugin Design System

Reference for building CloudCLI plugins that match the host UI.

**Version:** 1.0 — derived from `cloudcli-plugin-helm-dashboard` and `cloudcli-plugin-task-queue`

---

## Isolation Model

Plugin frontend code runs in a container `<div>` injected by CloudCLI. It does **not** inherit
the host app's CSS (Tailwind + shadcn/ui CSS custom properties). Every style must be applied
inline via TypeScript.

The host signals the active theme via `PluginContext.theme`. Subscribe to changes:

```typescript
export function mount(container: HTMLElement, api: PluginAPI): void {
  const unsub = api.onContextChange(ctx => render(ctx));
  render(api.context);
  // store unsub for unmount
}
```

---

## Color Palette

Copy this function verbatim. Do not deviate from these values — they are tuned to match the
host app's dark/light modes.

```typescript
const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

interface ThemeColors {
  bg: string;
  surface: string;
  border: string;
  text: string;
  muted: string;
  accent: string;
  dim: string;
  ok: string;
  warn: string;
  error: string;
}

function themeColors(dark: boolean): ThemeColors {
  return dark
    ? {
        bg:      '#08080f',
        surface: '#0e0e1a',
        border:  '#1a1a2c',
        text:    '#e2e0f0',
        muted:   '#52507a',
        accent:  '#fbbf24',
        dim:     'rgba(251,191,36,0.1)',
        ok:      '#22c55e',
        warn:    '#f59e0b',
        error:   '#ef4444',
      }
    : {
        bg:      '#fafaf9',
        surface: '#ffffff',
        border:  '#e8e6f0',
        text:    '#0f0e1a',
        muted:   '#9490b0',
        accent:  '#d97706',
        dim:     'rgba(217,119,6,0.08)',
        ok:      '#16a34a',
        warn:    '#d97706',
        error:   '#dc2626',
      };
}
```

---

## Typography

All text uses the monospace stack. No other font families.

| Use | Size |
|-----|------|
| Page title / plugin name | `1.3rem`, `font-weight: 700`, `letter-spacing: -0.02em` |
| Section header | `0.82rem`, `font-weight: 600` |
| Body text | `0.72rem` |
| Secondary / metadata | `0.65rem` |
| Labels / badges | `0.5rem–0.55rem`, `text-transform: uppercase`, `letter-spacing: 0.08em` |

---

## Spacing

Base unit: `4px`. Use multiples: `4`, `6`, `8`, `10`, `12`, `14`, `16`, `20`, `24`.

- Root container padding: `24px`
- Between major sections: `16px`
- Card padding: `12px–14px`
- Between list items: `6px–8px`

---

## CSS Class Prefix

Each plugin must use a unique short prefix for its injected CSS classes to avoid collisions.
Convention: two-to-four letters derived from the plugin name.

| Plugin | Prefix |
|--------|--------|
| helm-dashboard | `helm-` |
| task-queue | `tq-` |
| plane | `pp-` |

Inject a `<style>` tag once via `ensureAssets()` gated on `document.getElementById('pp-styles')`.

---

## Animations

Inject these keyframes once. Apply via CSS classes (with your plugin prefix).

```typescript
function ensureAssets(): void {
  if (document.getElementById('pp-styles')) return;

  // Load JetBrains Mono if not already present
  if (!document.getElementById('pp-font')) {
    const link = document.createElement('link');
    link.id = 'pp-font';
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap';
    document.head.appendChild(link);
  }

  const s = document.createElement('style');
  s.id = 'pp-styles';
  s.textContent = `
    @keyframes pp-fadeup { from { opacity:0; transform:translateY(6px) } to { opacity:1; transform:translateY(0) } }
    @keyframes pp-pulse  { 0%,100% { opacity:0.4 } 50% { opacity:0.8 } }
    @keyframes pp-grow   { from { width:0 } }
    .pp-up   { animation: pp-fadeup 0.4s ease both }
    .pp-live { animation: pp-pulse  2s ease infinite }
    .pp-bar  { animation: pp-grow   0.75s cubic-bezier(.16,1,.3,1) both }
  `;
  document.head.appendChild(s);
}
```

Stagger list items with `animation-delay: ${i * 0.04}s` on `.pp-up` elements.

---

## Components

### Root Container

```typescript
Object.assign(root.style, {
  height:     '100%',
  overflowY:  'auto',
  boxSizing:  'border-box',
  padding:    '24px',
  fontFamily: MONO,
  background: c.bg,
  color:      c.text,
});
```

### Card / Panel

```
background:    c.surface
border:        1px solid c.border
border-radius: 3px
padding:       12px–14px
```

### Section Label (uppercase category header)

```
font-size:      0.55rem
color:          c.muted
text-transform: uppercase
letter-spacing: 0.1em
margin-bottom:  6px
```

### Badge / Status Tag

```
font-size:      0.5rem
padding:        1px 5px
border-radius:  2px
text-transform: uppercase
letter-spacing: 0.08em
background:     [semantic color] + '20'  (8-digit hex opacity)
color:          [semantic color]
```

Example: `background: c.error + '20', color: c.error`

### Button (outline style)

```
background:    transparent
border:        1px solid c.border
color:         c.muted
border-radius: 3px
padding:       4px 10px
font-family:   MONO
font-size:     0.7rem
cursor:        pointer
```

Hover: `borderColor: c.accent, color: c.accent` via `onmouseover`/`onmouseout` inline handlers.

### Status Dot

```
width:         6px
height:        6px
border-radius: 50%
background:    [semantic color]
flex-shrink:   0
```

Add `.pp-live` class for pulsing animation on live connection indicators.

### Input / Select

```
background:    c.surface
color:         c.text
border:        1px solid c.border
border-radius: 4px
padding:       4px 8px
font-family:   MONO
font-size:     0.72rem
outline:       none
```

Focus: `borderColor: c.accent`

### Empty State

```typescript
`<div style="display:flex;flex-direction:column;align-items:center;
             justify-content:center;height:50%;gap:14px">
  <pre style="font-size:0.75rem;color:${c.muted};opacity:0.5;
              line-height:1.6;text-align:center">
    (descriptive ASCII art or path example)
  </pre>
  <div style="font-size:0.72rem;color:${c.muted};
              letter-spacing:0.1em;text-transform:uppercase">
    instruction text
  </div>
</div>`
```

### Skeleton / Loading State

```typescript
function skeletonRow(c: ThemeColors, width: number, delay: number): string {
  return `<div style="height:10px;width:${width}%;background:${c.muted};
    border-radius:2px;margin-bottom:8px;opacity:0.3;
    animation:pp-pulse 1.6s ease infinite;animation-delay:${delay}s"></div>`;
}
```

---

## List / Row Pattern

```
<div class="pp-up" style="animation-delay:${i * 0.04}s">
  <div style="display:flex;align-items:center;gap:8px;
              padding:8px 10px;border-bottom:1px solid ${c.border}">
    <div style="width:6px;height:6px;border-radius:50%;
                background:${statusColor};flex-shrink:0"></div>
    <span style="flex:1;font-size:0.72rem;color:${c.text};
                 overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
      {title}
    </span>
    <span style="font-size:0.55rem;color:${c.muted}">{metadata}</span>
    <button ...>{action}</button>
  </div>
</div>
```

---

## Semantic Color Mapping

Map domain states to the three semantic colors (`ok`, `warn`, `error`). Add `muted` for neutral.

Example for Plane issue states:

| State group | Color |
|-------------|-------|
| `completed` | `c.ok` |
| `started` | `c.accent` |
| `unstarted` | `c.muted` |
| `backlog` | `c.muted` (dimmer) |
| `cancelled` | `c.error` |

Example for priority:

| Priority | Color |
|----------|-------|
| `urgent` | `c.error` |
| `high` | `c.warn` |
| `medium` | `c.accent` |
| `none` / `low` | `c.muted` |

---

## Utility Helpers

Include these in `styles.ts` or equivalent:

```typescript
export function ago(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function priorityIcon(priority: string): string {
  switch (priority) {
    case 'urgent': return '!!!';
    case 'high':   return '!!';
    case 'medium': return '!';
    default:       return '·';
  }
}
```

---

## Project Title Header Pattern

Use at the top of the plugin when a project/context is selected:

```typescript
`<div class="pp-up" style="margin-bottom:24px">
  <div style="font-size:1.3rem;font-weight:700;letter-spacing:-0.02em">
    ${name}<span style="color:${c.accent}">▌</span>
  </div>
  <div style="font-size:0.7rem;color:${c.muted};margin-top:4px">${subtitle}</div>
</div>`
```

The `▌` cursor glyph after the title is the standard "active" indicator across all plugins.

---

## No-Project / No-Config State

When required config (API key, URL) is missing, show a setup prompt rather than an error:

```typescript
`<div style="display:flex;flex-direction:column;align-items:center;
             justify-content:center;height:60%;gap:16px">
  <div style="font-size:0.72rem;color:${c.muted}">
    configure plane connection
  </div>
  <div style="font-size:0.62rem;color:${c.muted};opacity:0.6;
              text-align:center;max-width:320px;line-height:1.7">
    create ~/.claude-code-ui/plugins/cloudcli-plugin-plane/config.json<br>
    with planeUrl, apiKey, and workspaceSlug
  </div>
</div>`
```

---

## Do Not

- Use React, Vue, or any UI framework
- Import external CSS
- Use CSS custom properties from the host app (`--background`, `--primary`, etc.) — plugins don't have access to these
- Use `font-family: sans-serif` or system UI fonts — monospace only
- Use border-radius > `4px` on cards or buttons
- Use `box-shadow` for elevation (use border instead)
- Add loading spinners — use skeleton rows with pulse animation
