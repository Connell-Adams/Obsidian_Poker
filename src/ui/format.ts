export const cx = (...parts: Array<string | false | null | undefined>): string => parts.filter(Boolean).join(' ');

export const fmt = (n: number): string => Math.round(n).toLocaleString('en-US');

export function fmtShort(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e5) return `${(n / 1e3).toFixed(0)}K`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return fmt(n);
}

export const signed = (n: number): string => `${n > 0 ? '+' : ''}${fmt(n)}`;

export const pct = (x: number | null, digits = 0): string => (x === null ? '–' : `${(x * 100).toFixed(digits)}%`);

export function duration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export const dateTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
