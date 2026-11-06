import { useMemo, useState } from 'react';
import { useService } from '../../app/context';
import { findLeaks, type Leak } from '../../coach/leaks';
import { publishStats, type Rate, type StatCounters, wilsonInterval } from '../../stats/counters';
import { DivergingBars, Sparkline } from '../components/Charts';
import { cx, fmt, pct, signed } from '../format';

const POSITION_ORDER = ['UTG', 'UTG+1', 'UTG+2', 'MP', 'HJ', 'CO', 'BTN', 'SB', 'BB'];

/** Below this, a figure is shown but marked as unreliable. */
const LOW_SAMPLE = 30;

interface StatRow {
  name: string;
  rate: Rate;
  healthy: string;
  definition: string;
  format?: (r: Rate) => string;
}

function StatTable({ rows }: { rows: StatRow[] }) {
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr><th>Statistic</th><th className="num">Value</th><th className="num">Sample</th><th>Typical winner</th><th>What it measures</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const thin = r.rate.n < LOW_SAMPLE;
            return (
              <tr key={r.name} className={cx(thin && 'row-thin')}>
                <th scope="row">{r.name}</th>
                <td className="num"><b>{r.format ? r.format(r.rate) : pct(r.rate.value, 1)}</b></td>
                <td className="num">{r.rate.n}{thin && r.rate.n > 0 && <span className="thin-tag">low</span>}</td>
                <td className="muted">{r.healthy}</td>
                <td className="muted def">{r.definition}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function statRows(c: StatCounters): StatRow[] {
  const s = publishStats(c);
  const number1 = (r: Rate) => (r.value === null ? '–' : r.value.toFixed(1));
  return [
    { name: 'VPIP', rate: s.vpip, healthy: '20-30%', definition: 'Voluntarily put chips in preflop, per hand with a preflop decision' },
    { name: 'PFR', rate: s.pfr, healthy: '15-25%', definition: 'Raised preflop, per hand with a preflop decision' },
    { name: '3-Bet', rate: s.threeBet, healthy: '6-11%', definition: 'Re-raised the first raise, per chance to do so' },
    { name: 'Fold to 3-Bet', rate: s.foldTo3Bet, healthy: '45-70%', definition: 'Folded after raising and being re-raised' },
    { name: '4-Bet', rate: s.fourBet, healthy: '10-25%', definition: 'Re-raised a 3-bet, per 3-bet faced' },
    { name: 'C-Bet', rate: s.cbet, healthy: '50-75%', definition: 'Bet the flop as the preflop aggressor, per chance to do so' },
    { name: 'Fold to C-Bet', rate: s.foldToCbet, healthy: '35-60%', definition: 'Folded to a flop bet from the preflop aggressor' },
    { name: 'WTSD', rate: s.wtsd, healthy: '24-32%', definition: 'Reached showdown, per hand seeing the flop' },
    { name: 'W$SD', rate: s.wsd, healthy: '50-58%', definition: 'Won chips at showdown, per showdown reached' },
    { name: 'Aggression frequency', rate: s.afq, healthy: '35-50%', definition: 'Postflop bets and raises, as a share of bets, raises, calls and folds' },
    { name: 'Aggression factor', rate: s.af, healthy: '2-4', definition: 'Postflop bets and raises per call', format: number1 },
    { name: 'BB/100', rate: s.bb100, healthy: 'above 0', definition: 'Big blinds won per 100 hands dealt', format: number1 },
    { name: 'River call', rate: s.riverCall, healthy: '30-50%', definition: 'Called, per river bet faced' },
    { name: 'Showdown frequency', rate: s.showdownFreq, healthy: '–', definition: 'Reached showdown, per hand dealt' },
    { name: 'All-in equity', rate: s.allInEquity, healthy: '50% or more', definition: 'Average equity when all-in, computed from revealed cards' },
    { name: 'Steal', rate: s.steal, healthy: '30-50%', definition: 'Raised first-in from the cutoff, button or small blind' },
    { name: 'BB defend', rate: s.bbDefend, healthy: '35-60%', definition: 'Continued from the big blind against a late-position raise' },
  ];
}

function PositionSection({ counters }: { counters: StatCounters }) {
  const rows = POSITION_ORDER.flatMap((pos) => {
    const c = counters.byPosition[pos];
    if (!c) return [];
    return [{ pos, c, bb100: c.hands > 0 ? (c.bbNet / c.hands) * 100 : null }];
  });
  if (rows.length === 0) return <p className="muted">Play some hands to see results by position.</p>;
  return (
    <>
      <DivergingBars rows={rows.map((r) => ({ label: r.pos, value: r.bb100, n: r.c.hands }))} />
      <div className="table-scroll">
        <table className="data-table compact">
          <thead><tr><th>Position</th><th className="num">Hands</th><th className="num">VPIP</th><th className="num">PFR</th><th className="num">Net chips</th><th className="num">BB/100</th></tr></thead>
          <tbody>
            {rows.map(({ pos, c, bb100 }) => (
              <tr key={pos} className={cx(c.hands < LOW_SAMPLE && 'row-thin')}>
                <th scope="row">{pos}</th>
                <td className="num">{fmt(c.hands)}</td>
                <td className="num">{c.decisions ? pct(c.vpip / c.decisions) : '–'}</td>
                <td className="num">{c.decisions ? pct(c.pfr / c.decisions) : '–'}</td>
                <td className={cx('num', c.net > 0 ? 'pos' : c.net < 0 ? 'neg' : '')}>{signed(c.net)}</td>
                <td className="num">{bb100 === null ? '–' : bb100.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

const DIRECTION_TEXT = { improving: 'Improving', worsening: 'Getting worse', flat: 'Unchanged', unknown: 'Not enough history' };

function LeakCard({ leak }: { leak: Leak }) {
  const isFrequency = !leak.id.startsWith('position_');
  const pr = leak.progress;
  return (
    <article className={cx('leak', `leak-${leak.severity}`)}>
      <header>
        <span className={cx('severity', `sev-${leak.severity}`)}>{leak.severity}</span>
        <h3>{leak.title}</h3>
        <span className={cx('confidence', leak.confidence === 'supported' && 'is-strong')} title={leak.confidence === 'supported' ? 'The uncertainty range sits clear of the healthy range' : 'Outside the usual range, but the sample cannot rule out normal variation'}>
          {leak.confidence === 'supported' ? 'Supported by the data' : 'Possible tendency'}
        </span>
      </header>
      <p>{leak.evidence}</p>
      <dl className="leak-facts">
        <div><dt>Sample</dt><dd>{fmt(leak.sampleSize)} {leak.sampleLabel}</dd></div>
        {isFrequency && <div><dt>Likely true rate</dt><dd>{pct(leak.low)}-{pct(leak.high)}</dd></div>}
        <div><dt>Usual range</dt><dd>{leak.healthy}</dd></div>
        <div><dt>Rough cost</dt><dd>about {leak.estimatedImpactBB100} BB/100 (estimate)</dd></div>
        <div>
          <dt>Trend</dt>
          <dd className="leak-trend">
            {DIRECTION_TEXT[pr.direction]}
            {pr.earlier !== null && pr.recent !== null && ` (${pct(pr.earlier)} to ${pct(pr.recent)})`}
            {pr.series.length >= 2 && <Sparkline values={pr.series} label={`Trend for ${leak.title}`} />}
          </dd>
        </div>
      </dl>
      <p className="leak-fix"><b>What to do:</b> {leak.correction}</p>
    </article>
  );
}

export function StatsScreen() {
  const service = useService();
  const { career, session, windows } = service;
  const [scope, setScope] = useState<'career' | 'session'>('career');
  const [tab, setTab] = useState<'overview' | 'positions' | 'leaks'>('overview');
  const counters = scope === 'session' && session ? session.stats.counters : career.profile.counters;
  const leaks = useMemo(() => findLeaks(career.profile.counters, { windows }), [career.profile.counters, career.profile.handsPlayed, windows]);
  const winCi = counters.hands > 0 ? wilsonInterval(counters.handsWon, counters.hands) : null;

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Statistics</h1>
        <p>Every figure comes from hands you actually played, and each lists its sample size.</p>
      </header>
      <div className="toolbar">
        <div className="seg" role="tablist" aria-label="Statistics view">
          <button type="button" role="tab" aria-selected={tab === 'overview'} className={cx(tab === 'overview' && 'is-on')} onClick={() => setTab('overview')}>Overview</button>
          <button type="button" role="tab" aria-selected={tab === 'positions'} className={cx(tab === 'positions' && 'is-on')} onClick={() => setTab('positions')}>By position</button>
          <button type="button" role="tab" aria-selected={tab === 'leaks'} className={cx(tab === 'leaks' && 'is-on')} onClick={() => setTab('leaks')}>Leak Finder{leaks.length ? ` (${leaks.length})` : ''}</button>
        </div>
        {tab !== 'leaks' && (
          <div className="seg" aria-label="Scope">
            <button type="button" className={cx(scope === 'career' && 'is-on')} onClick={() => setScope('career')}>Career</button>
            <button type="button" className={cx(scope === 'session' && 'is-on')} disabled={!session} onClick={() => setScope('session')}>This session</button>
          </div>
        )}
      </div>

      {tab === 'overview' && (
        <section className="panel">
          <h2>{fmt(counters.hands)} hands{winCi ? `, ${pct(counters.handsWon / counters.hands)} won` : ''}</h2>
          {counters.hands === 0 ? <p className="muted">No hands recorded yet.</p> : <StatTable rows={statRows(counters)} />}
          <p className="muted foot-note">Figures with fewer than {LOW_SAMPLE} opportunities are marked low: at that size they can easily swing by 15 percentage points or more. "Typical winner" ranges are broad guidelines for 6-max and full ring.</p>
        </section>
      )}
      {tab === 'positions' && (
        <section className="panel">
          <h2>Win rate by position, BB/100</h2>
          <PositionSection counters={counters} />
        </section>
      )}
      {tab === 'leaks' && (
        <section className="leak-list">
          <p className="muted">
            Based on {fmt(career.profile.handsPlayed)} career hands. A leak appears only with enough data behind it. "Possible tendency" means your numbers are unusual, not that your play is proven wrong.
            Costs are rough estimates to help you prioritise.
          </p>
          {leaks.length === 0 ? (
            <div className="panel"><h2>No leaks detected</h2><p className="muted">{career.profile.handsPlayed < 150 ? 'There are not enough hands yet. Most checks need a few hundred hands to say anything useful.' : 'Nothing stands out across the checks with enough data so far.'}</p></div>
          ) : (
            leaks.map((leak) => <LeakCard key={leak.id} leak={leak} />)
          )}
        </section>
      )}
    </div>
  );
}
