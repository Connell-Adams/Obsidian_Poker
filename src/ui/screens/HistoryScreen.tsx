import { useEffect, useMemo, useState } from 'react';
import { useService } from '../../app/context';
import type { HandReview } from '../../coach/analyzer';
import { cardsToString } from '../../engine/cards';
import type { HandRecord } from '../../history/record';
import { buildReplayFrames, filterHands, type HistoryFilter } from '../../history/replay';
import { TableSurface } from '../components/TableSurface';
import { cx, dateTime, fmt, fmtShort, signed } from '../format';
import { DecisionList } from './CoachScreen';

const FILTERS: ReadonlyArray<{ id: HistoryFilter; label: string }> = [
  { id: 'all', label: 'All hands' },
  { id: 'biggest_pots', label: 'Biggest pots' },
  { id: 'biggest_losses', label: 'Biggest losses' },
  { id: 'all_in', label: 'All-ins' },
  { id: 'showdowns', label: 'Showdowns' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
];

function Replay({ record, onClose }: { record: HandRecord; onClose: () => void }) {
  const service = useService();
  const { settings } = service;
  const frames = useMemo(() => buildReplayFrames(record), [record]);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [review, setReview] = useState<HandReview | null | undefined>(undefined);
  const frame = frames[Math.min(index, frames.length - 1)];

  useEffect(() => {
    setIndex(0);
    setPlaying(false);
    void service.getReview(record.id).then((r) => setReview(r ?? null));
  }, [record, service]);

  useEffect(() => {
    if (!playing) return;
    if (index >= frames.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setTimeout(() => setIndex((i) => i + 1), 1100);
    return () => clearTimeout(id);
  }, [playing, index, frames.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(frames.length - 1, i + 1));
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(0, i - 1));
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [frames.length, onClose]);

  const appearance = useMemo(
    () => ({ theme: settings.tableTheme, cardFace: settings.cardFace, cardBack: settings.cardBack, chipStyle: settings.chipStyle, animation: 'off' as const }),
    [settings.tableTheme, settings.cardFace, settings.cardBack, settings.chipStyle],
  );

  return (
    <section className="replay" aria-label={`Replay of hand ${record.handNumber}`}>
      <header className="replay-head">
        <div>
          <h2>{record.tableName}, hand #{record.handNumber}</h2>
          <p className="muted">{dateTime(record.ts)} · blinds {fmt(record.sb)}/{fmt(record.bb)}{record.ante ? `, ante ${fmt(record.ante)}` : ''} · {record.mode === 'cash' ? 'Cash' : 'Tournament'}</p>
        </div>
        <button type="button" className="btn" onClick={onClose}>Close replay</button>
      </header>

      <div className="replay-table table-area">
        <TableSurface view={frame.view} appearance={appearance} still />
      </div>

      <div className="replay-bar">
        <div className="replay-caption" aria-live="polite"><span className="street-tag">{frame.street}</span>{frame.caption}</div>
        <input type="range" min={0} max={frames.length - 1} value={index} aria-label="Hand progress" onChange={(e) => { setPlaying(false); setIndex(Number(e.target.value)); }} />
        <div className="replay-ticks" aria-hidden="true">
          {frames.map((f, i) => <i key={i} className={cx(`tick-${f.kind}`, i === index && 'is-on')} />)}
        </div>
        <div className="replay-buttons">
          <button type="button" className="btn" onClick={() => setIndex(0)} disabled={index === 0}>Start</button>
          <button type="button" className="btn" onClick={() => setIndex((i) => Math.max(0, i - 1))} disabled={index === 0}>Back</button>
          <button type="button" className="btn btn-gold" onClick={() => { if (index >= frames.length - 1) setIndex(0); setPlaying((v) => !v); }}>{playing ? 'Pause' : 'Play'}</button>
          <button type="button" className="btn" onClick={() => setIndex((i) => Math.min(frames.length - 1, i + 1))} disabled={index === frames.length - 1}>Forward</button>
          <button type="button" className="btn" onClick={() => setIndex(frames.length - 1)} disabled={index === frames.length - 1}>End</button>
        </div>
      </div>

      <div className="replay-info">
        <div>
          <h3>Result</h3>
          <table className="data-table compact">
            <thead><tr><th>Player</th><th>Pos</th><th className="num">Start</th><th className="num">Net</th><th>Cards</th></tr></thead>
            <tbody>
              {record.players.map((p) => (
                <tr key={p.seat} className={cx(p.isHuman && 'row-me')}>
                  <td>{p.name}</td>
                  <td>{p.position}</td>
                  <td className="num">{fmt(p.startStack)}</td>
                  <td className={cx('num', p.net > 0 ? 'pos' : p.net < 0 ? 'neg' : '')}>{signed(p.net)}</td>
                  <td>{p.shown || p.isHuman ? cardsToString(p.hole) : p.folded ? 'folded' : 'mucked'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {record.pots.length > 1 && (
            <p className="muted">
              {record.pots.map((pot, i) => `${i === 0 ? 'Main pot' : `Side pot ${i}`}: ${fmt(pot.amount)}`).join(' · ')}
            </p>
          )}
        </div>
        <div>
          <h3>Coach review</h3>
          {review === undefined ? <p className="muted">Loading…</p> : review === null ? <p className="muted">No review was stored for this hand.</p> : <DecisionList review={review} />}
        </div>
      </div>
    </section>
  );
}

export function HistoryScreen() {
  const service = useService();
  const [hands, setHands] = useState<HandRecord[] | null>(null);
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [opponent, setOpponent] = useState('');
  const [position, setPosition] = useState('');
  const [tableName, setTableName] = useState('');
  const [selected, setSelected] = useState<HandRecord | null>(null);
  const handCount = service.career.profile.handsPlayed;

  useEffect(() => {
    let active = true;
    void service.career.flush().then(() => service.loadHands()).then((rows) => {
      if (active) setHands(rows);
    });
    return () => {
      active = false;
    };
  }, [service, handCount]);

  const { opponents, positions, tableNames } = useMemo(() => {
    const o = new Map<string, number>();
    const p = new Set<string>();
    const t = new Set<string>();
    for (const h of hands ?? []) {
      t.add(h.tableName);
      for (const x of h.players) {
        if (x.isHuman) p.add(x.position);
        else o.set(x.name, (o.get(x.name) ?? 0) + 1);
      }
    }
    return { opponents: [...o.entries()].sort((a, b) => b[1] - a[1]).slice(0, 80).map(([name]) => name), positions: [...p], tableNames: [...t].sort() };
  }, [hands]);

  const rows = useMemo(() => filterHands(hands ?? [], { filter, opponent: opponent || undefined, position: position || undefined, tableName: tableName || undefined }).slice(0, 200), [hands, filter, opponent, position, tableName]);

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Hand History</h1>
        <p>{hands === null ? 'Loading…' : `${fmt(hands.length)} hands stored. Step through any of them and see the coach's notes. Opponent cards appear only if they were shown.`}</p>
      </header>

      {selected && <Replay record={selected} onClose={() => setSelected(null)} />}

      <div className="toolbar toolbar-wrap">
        <div className="seg" role="radiogroup" aria-label="Filter hands">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} className={cx(filter === f.id && 'is-on')} onClick={() => setFilter(f.id)}>{f.label}</button>
          ))}
        </div>
        <label className="inline-field">
          Opponent
          <select value={opponent} onChange={(e) => setOpponent(e.target.value)}>
            <option value="">Anyone</option>
            {opponents.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="inline-field">
          Table
          <select value={tableName} onChange={(e) => setTableName(e.target.value)}>
            <option value="">Any</option>
            {tableNames.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
        <label className="inline-field">
          Your position
          <select value={position} onChange={(e) => setPosition(e.target.value)}>
            <option value="">Any</option>
            {positions.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>

      <div className="panel panel-flush">
        {rows.length === 0 ? (
          <p className="muted pad">No hands match. Play some, or clear the filters.</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table hand-table">
              <thead>
                <tr><th>When</th><th>Table</th><th>#</th><th>Blinds</th><th>Pos</th><th>Your cards</th><th>Board</th><th className="num">Pot</th><th className="num">Net</th></tr>
              </thead>
              <tbody>
                {rows.map((h) => {
                  const hero = h.players.find((p) => p.seat === h.heroSeat);
                  return (
                    <tr key={h.id} className={cx('clickable', selected?.id === h.id && 'row-me')} onClick={() => { setSelected(h); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
                      <td>{dateTime(h.ts)}</td>
                      <td>{h.tableName}</td>
                      <td>{h.handNumber}</td>
                      <td>{fmtShort(h.sb)}/{fmtShort(h.bb)}</td>
                      <td>{hero?.position ?? '–'}</td>
                      <td className="mono">{hero ? cardsToString(hero.hole) : '–'}</td>
                      <td className="mono">{h.board.length ? cardsToString(h.board) : '–'}</td>
                      <td className="num">{fmtShort(h.totalPot)}</td>
                      <td className={cx('num', h.heroNet > 0 ? 'pos' : h.heroNet < 0 ? 'neg' : '')}>
                        <button type="button" className="link-btn" aria-label={`Replay hand ${h.handNumber}`} onClick={(e) => { e.stopPropagation(); setSelected(h); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>{signed(h.heroNet)}</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
