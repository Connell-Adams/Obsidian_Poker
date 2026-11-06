import { memo, useState } from 'react';
import type { HudDensity, HudStat } from '../../persistence/settings';
import { publishStats, type Rate, type StatCounters } from '../../stats/counters';
import { cx, pct } from '../format';

const LABELS: Record<HudStat, string> = {
  vpip: 'VPIP',
  pfr: 'PFR',
  threeBet: '3B',
  foldTo3Bet: 'F3B',
  af: 'AF',
  wtsd: 'WTSD',
  wsd: 'W$SD',
  hands: 'H',
};

/** Below this many observations, a figure is greyed rather than presented as reliable. */
const RELIABLE = 30;
const MIN_TO_SHOW = 6;

function statText(stat: HudStat, c: StatCounters): { text: string; n: number } {
  const s = publishStats(c);
  if (stat === 'hands') return { text: String(c.hands), n: c.hands };
  if (stat === 'af') {
    return { text: s.af.value === null ? '–' : s.af.value.toFixed(1), n: s.af.n };
  }
  const rate: Rate = s[stat];
  return { text: rate.n < MIN_TO_SHOW ? '–' : pct(rate.value), n: rate.n };
}

export interface HudProps {
  counters: StatCounters | undefined;
  stats: readonly HudStat[];
  density: HudDensity;
  name: string;
}

/** Opponent statistics from observed hands only. Thin samples are visibly marked. */
export const HudBadge = memo(function HudBadge({ counters, stats, density, name }: HudProps) {
  const [open, setOpen] = useState(false);
  const hands = counters?.hands ?? 0;
  if (!counters || hands === 0) {
    return <div className="hud hud-empty" title="No hands observed yet">no reads</div>;
  }
  const shown = density === 'minimal' ? stats.filter((s) => s === 'vpip' || s === 'pfr' || s === 'hands') : density === 'detailed' ? (['vpip', 'pfr', 'threeBet', 'foldTo3Bet', 'af', 'wtsd', 'wsd', 'hands'] as HudStat[]) : stats;
  const lowSample = hands < RELIABLE;
  const s = publishStats(counters);
  const rows: Array<[string, Rate | { value: number | null; n: number }]> = [
    ['VPIP', s.vpip],
    ['PFR', s.pfr],
    ['3-Bet', s.threeBet],
    ['Fold to 3-Bet', s.foldTo3Bet],
    ['4-Bet', s.fourBet],
    ['C-Bet', s.cbet],
    ['Fold to C-Bet', s.foldToCbet],
    ['Aggression freq.', s.afq],
    ['WTSD', s.wtsd],
    ['W$SD', s.wsd],
  ];
  return (
    <div className={cx('hud', lowSample && 'hud-low', `hud-${density}`)}>
      <button type="button" className="hud-line" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={`Statistics for ${name}, ${hands} hands observed`}>
        {shown.map((stat) => {
          const { text, n } = statText(stat, counters);
          return (
            <span key={stat} className={cx('hud-stat', n < RELIABLE && stat !== 'hands' && 'hud-thin')} title={`${LABELS[stat]}: ${text} from ${n} opportunities`}>
              {density !== 'minimal' && <i>{LABELS[stat]}</i>}
              {text}
            </span>
          );
        })}
      </button>
      {open && (
        <div className="hud-popover" role="dialog" aria-label={`${name} statistics`}>
          <header>
            <strong>{name}</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close">×</button>
          </header>
          <p className="hud-sample">{hands} hands observed{lowSample ? '. Small sample: treat as a rough guide.' : ''}</p>
          <table>
            <tbody>
              {rows.map(([label, rate]) => (
                <tr key={label} className={rate.n < RELIABLE ? 'hud-thin' : undefined}>
                  <th scope="row">{label}</th>
                  <td>{rate.n > 0 ? pct(rate.value) : '–'}</td>
                  <td className="hud-n">n={rate.n}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
});
