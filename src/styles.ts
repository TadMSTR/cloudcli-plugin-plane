import type { ThemeColors } from './types.js';

export const MONO = "'JetBrains Mono', 'Fira Code', ui-monospace, monospace";

export function themeColors(dark: boolean): ThemeColors {
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

export function ensureAssets(): void {
  if (document.getElementById('pp-styles')) return;

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

export function priorityColor(priority: string, c: ThemeColors): string {
  switch (priority) {
    case 'urgent': return c.error;
    case 'high':   return c.warn;
    case 'medium': return c.accent;
    default:       return c.muted;
  }
}

export function stateColor(group: string, c: ThemeColors): string {
  switch (group) {
    case 'completed': return c.ok;
    case 'started':   return c.accent;
    case 'cancelled': return c.error;
    default:          return c.muted;
  }
}

export function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function skeletonRow(c: ThemeColors, width: number, delay: number): string {
  return `<div style="height:10px;width:${width}%;background:${c.muted};border-radius:2px;margin-bottom:8px;opacity:0.3;animation:pp-pulse 1.6s ease infinite;animation-delay:${delay}s"></div>`;
}
