import { useId, useMemo, useState } from 'react';
import { fmt, signed } from '../format';

export interface LineChartProps {
  values: readonly number[];
  height?: number;
  label: string;
  xLabel?: (index: number) => string;
  yFormat?: (value: number) => string;
  /** Draw a zero baseline: used when values can be positive or negative. */
  zeroLine?: boolean;
}

const niceTicks = (min: number, max: number): number[] => {
  const span = max - min || 1;
  const rough = span / 4;
  const mag = Math.pow(10, Math.floor(Math.log10(rough)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? rough;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v * 1000) / 1000);
  return out;
};

/** One-series line chart: no legend needed, the title names it. Hover shows the exact value. */
export function LineChart({ values, height = 180, label, xLabel, yFormat = fmt, zeroLine = true }: LineChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const W = 640;
  const H = height;
  const pad = { l: 54, r: 14, t: 12, b: 22 };

  const { path, areaPath, x, y, ticks } = useMemo(() => {
    const lo = Math.min(0, ...values);
    const hi = Math.max(0, ...values);
    const margin = (hi - lo || 1) * 0.08;
    const min = lo - margin;
    const max = hi + margin;
    const n = values.length;
    const xf = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
    const yf = (v: number) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
    const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${xf(i).toFixed(1)} ${yf(v).toFixed(1)}`).join(' ');
    const zero = yf(Math.max(min, 0));
    const area = n > 1 ? `${d} L${xf(n - 1).toFixed(1)} ${zero.toFixed(1)} L${xf(0).toFixed(1)} ${zero.toFixed(1)} Z` : '';
    return { path: d, areaPath: area, x: xf, y: yf, ticks: niceTicks(min, max) };
  }, [values, H, pad.l, pad.r, pad.t, pad.b]);

  if (values.length < 2) {
    return <div className="chart-empty">Not enough data to chart yet.</div>;
  }

  const onMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = ((event.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (values.length - 1));
    setHover(Math.max(0, Math.min(values.length - 1, i)));
  };

  const last = values[values.length - 1];
  return (
    <figure className="chart">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-labelledby={titleId}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        preserveAspectRatio="none"
        style={{ height }}
      >
        <title id={titleId}>{`${label}. ${values.length} points, latest ${yFormat(last)}.`}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className={t === 0 && zeroLine ? 'chart-zero' : 'chart-grid'} vectorEffect="non-scaling-stroke" />
            <text x={pad.l - 8} y={y(t) + 3.500} className="chart-tick" textAnchor="end">{yFormat(t)}</text>
          </g>
        ))}
        {areaPath && <path d={areaPath} className="chart-area" />}
        <path d={path} className="chart-line" vectorEffect="non-scaling-stroke" />
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} className="chart-cross" vectorEffect="non-scaling-stroke" />
            <circle cx={x(hover)} cy={y(values[hover])} r="4" className="chart-dot" />
          </g>
        )}
      </svg>
      {hover !== null && (
        <figcaption
          className="chart-tip"
          style={{ left: `${(x(hover) / W) * 100}%`, transform: x(hover) > W * 0.7 ? 'translateX(-105%)' : 'translateX(8px)' }}
        >
          <b>{yFormat(values[hover])}</b>
          <span>{xLabel ? xLabel(hover) : `Hand ${hover + 1}`}</span>
        </figcaption>
      )}
    </figure>
  );
}

export interface BarRow {
  label: string;
  value: number | null;
  n: number;
}

/** Diverging bars around a zero baseline. Value text is always shown, so colour is never alone. */
export function DivergingBars({ rows, unit = '' }: { rows: readonly BarRow[]; unit?: string }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value ?? 0)));
  return (
    <div className="dbars">
      {rows.map((r) => {
        const value = r.value ?? 0;
        const width = (Math.abs(value) / max) * 50;
        return (
          <div key={r.label} className="dbar-row" title={`${r.label}: ${r.value === null ? 'no data' : `${value.toFixed(1)}${unit}`} over ${r.n} hands`}>
            <span className="dbar-label">{r.label}</span>
            <div className="dbar-track">
              <span className="dbar-axis" />
              {r.value !== null && (
                <span
                  className={value >= 0 ? 'dbar-fill dbar-pos' : 'dbar-fill dbar-neg'}
                  style={value >= 0 ? { left: '50%', width: `${width}%` } : { right: '50%', width: `${width}%` }}
                />
              )}
            </div>
            <span className="dbar-value">{r.value === null ? '–' : `${value > 0 ? '+' : ''}${value.toFixed(1)}${unit}`}</span>
            <span className="dbar-n">{r.n}</span>
          </div>
        );
      })}
    </div>
  );
}

export function Sparkline({ values, label }: { values: readonly number[]; label: string }) {
  if (values.length < 2) return <span className="spark-empty">not enough data</span>;
  const W = 120;
  const H = 28;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const d = values.map((v, i) => `${i === 0 ? 'M' : 'L'}${((i / (values.length - 1)) * (W - 4) + 2).toFixed(1)} ${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={label}>
      <path d={d} className="chart-line" />
    </svg>
  );
}

export { signed };
