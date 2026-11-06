import { useMemo, useState } from 'react';
import { go, useNow, useService } from '../../app/context';
import { CASH_STAKES, type CashConfig, type TableFormat } from '../../app/gameService';
import { blindLevelFor, computePayouts, PAYOUT_LABELS, paidPlaces, type PayoutStructure } from '../../tournament/schedule';
import type { LevelMode, TournamentConfig } from '../../tournament/director';
import { cx, fmt } from '../format';

const DIFFICULTY_LABELS = ['Very recreational', 'Beginner', 'Casual', 'Competent', 'Intermediate', 'Advanced', 'Strong regular', 'Expert', 'Professional-style', 'Extremely challenging'];
const FORMAT_LABELS: Record<TableFormat, string> = { '2max': 'Heads-Up', '6max': '6-Max', '9max': 'Full Ring', random: 'Random' };

export function DifficultyControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <label className="field">
      <span className="field-label">Opponent difficulty <b>{value}</b> <em>{DIFFICULTY_LABELS[value - 1]}</em></span>
      <input type="range" min={1} max={10} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <small>Difficulty changes how well bots think, never the cards. The deck is always fair.</small>
    </label>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}

function NumberField({ label, value, onChange, min, max, step, hint }: { label: string; value: number; onChange: (n: number) => void; min: number; max?: number; step?: number; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={Number.isFinite(value) ? value : ''}
        onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
      />
    </Field>
  );
}

export function PlayScreen() {
  const { session, pendingTournament } = useService();
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Choose your game</h1>
        <p>All chips are simulated. Your bankroll follows you between games.</p>
      </header>
      {(session || pendingTournament) && (
        <div className="callout">
          <div><strong>You have a game in progress.</strong></div>
          <button type="button" className="btn btn-gold" onClick={() => go(session ? 'tables' : 'tournaments')}>Go there</button>
        </div>
      )}
      <div className="mode-cards mode-cards-big">
        <button type="button" className="mode-card" onClick={() => go('cash')}>
          <strong>Normal Cash Game</strong>
          <span>Pick the stakes and buy in for chips that are worth exactly what they say. Leave at any time. Play one table, or up to four at once.</span>
        </button>
        <button type="button" className="mode-card" onClick={() => go('tournaments')}>
          <strong>Multi-Table Tournament</strong>
          <span>Pay one entry and play until you bust or win. Blinds rise on a schedule, tables break and balance, and the top finishers get paid.</span>
        </button>
      </div>
    </div>
  );
}

export function CashLobby() {
  const service = useService();
  const { session, career } = service;
  const [stakeIndex, setStakeIndex] = useState(1);
  const [custom, setCustom] = useState(false);
  const [sb, setSb] = useState(10);
  const [bb, setBb] = useState(20);
  const [buyIn, setBuyIn] = useState(2000);
  const [opponentStack, setOpponentStack] = useState(2000);
  const [difficulty, setDifficulty] = useState(4);
  const [tables, setTables] = useState<TableFormat[]>(['6max']);
  const [error, setError] = useState<string | null>(null);

  const smallBlind = custom ? sb : CASH_STAKES[stakeIndex].sb;
  const bigBlind = custom ? bb : CASH_STAKES[stakeIndex].bb;

  const pickStake = (i: number) => {
    setStakeIndex(i);
    setCustom(false);
    setBuyIn(CASH_STAKES[i].bb * 100);
    setOpponentStack(CASH_STAKES[i].bb * 100);
  };

  const total = buyIn * tables.length;
  const blindsOk = Number.isInteger(smallBlind) && Number.isInteger(bigBlind) && smallBlind > 0 && bigBlind >= smallBlind;
  const canAfford = total <= career.bankroll;
  const valid = blindsOk && Number.isInteger(buyIn) && buyIn >= bigBlind * 2 && Number.isInteger(opponentStack) && opponentStack >= bigBlind * 2 && canAfford;

  const start = () => {
    const config: CashConfig = { smallBlind, bigBlind, buyIn, opponentStack, difficulty, tables };
    const result = service.startCash(config);
    if (!result.ok) setError(result.error);
    else go('tables');
  };

  const setTableCount = (n: number) => {
    setTables((current) => {
      const next = current.slice(0, n);
      while (next.length < n) next.push(next[next.length - 1] ?? '6max');
      return next;
    });
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Cash Games</h1>
        <p>Bankroll: <b>{fmt(career.bankroll)}</b> chips</p>
      </header>
      {session ? (
        <div className="callout">
          <div><strong>{session.title}</strong> is running. Finish it before starting another game.</div>
          <button type="button" className="btn btn-gold" onClick={() => go('tables')}>Go to tables</button>
        </div>
      ) : (
        <div className="grid-2 lobby-grid">
          <section className="panel">
            <h2>Stakes</h2>
            <div className="choice-row" role="radiogroup" aria-label="Stakes">
              {CASH_STAKES.map((s, i) => (
                <button key={s.label} type="button" role="radio" aria-checked={!custom && stakeIndex === i} className={cx('choice', !custom && stakeIndex === i && 'is-on')} onClick={() => pickStake(i)}>
                  <b>{s.sb}/{s.bb}</b>
                  <span>{s.label}</span>
                </button>
              ))}
              <button type="button" role="radio" aria-checked={custom} className={cx('choice', custom && 'is-on')} onClick={() => setCustom(true)}>
                <b>Custom</b>
                <span>Your blinds</span>
              </button>
            </div>
            {custom && (
              <div className="form-row">
                <NumberField label="Small blind" value={sb} min={1} onChange={setSb} />
                <NumberField label="Big blind" value={bb} min={1} onChange={setBb} />
              </div>
            )}
            <div className="form-row">
              <NumberField label="Your buy-in, per table" value={buyIn} min={bigBlind * 2} step={bigBlind} onChange={setBuyIn} hint={`${Number.isFinite(buyIn) ? (buyIn / bigBlind).toFixed(0) : '–'} big blinds`} />
              <NumberField label="Opponents' starting stack" value={opponentStack} min={bigBlind * 2} step={bigBlind} onChange={setOpponentStack} hint={`${Number.isFinite(opponentStack) ? (opponentStack / bigBlind).toFixed(0) : '–'} big blinds`} />
            </div>
            <DifficultyControl value={difficulty} onChange={setDifficulty} />
          </section>

          <section className="panel">
            <h2>Tables</h2>
            <div className="choice-row" role="radiogroup" aria-label="Number of tables">
              {[1, 2, 3, 4].map((n) => (
                <button key={n} type="button" role="radio" aria-checked={tables.length === n} className={cx('choice choice-num', tables.length === n && 'is-on')} onClick={() => setTableCount(n)}>
                  <b>{n}</b>
                </button>
              ))}
            </div>
            <div className="table-setups">
              {tables.map((format, i) => (
                <div key={i} className="table-setup">
                  <span>Table {i + 1}</span>
                  <div className="seg" role="radiogroup" aria-label={`Format of table ${i + 1}`}>
                    {(Object.keys(FORMAT_LABELS) as TableFormat[]).map((f) => (
                      <button key={f} type="button" role="radio" aria-checked={format === f} className={cx(format === f && 'is-on')} onClick={() => setTables((t) => t.map((x, j) => (j === i ? f : x)))}>
                        {FORMAT_LABELS[f]}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="lobby-total">
              <div>
                <span>Total buy-in</span>
                <b className={canAfford ? '' : 'neg'}>{fmt(total || 0)}</b>
              </div>
              <button type="button" className="btn btn-gold btn-lg" disabled={!valid} onClick={start}>Sit down</button>
            </div>
            {!blindsOk && <p className="form-error">Blinds must be whole chips, and the big blind cannot be smaller than the small blind.</p>}
            {blindsOk && !canAfford && <p className="form-error">That is more than your bankroll. Lower the buy-in or play fewer tables.</p>}
            {error && <p className="form-error" role="alert">{error}</p>}
          </section>
        </div>
      )}
    </div>
  );
}

const PRESETS: ReadonlyArray<{ name: string; buyIn: number; entrants: number; seats: number; stack: number; sb: number; bb: number; length: number; pct: number; ante: number; payout: PayoutStructure; desc: string }> = [
  { name: 'Sit & Go Turbo', buyIn: 200, entrants: 9, seats: 9, stack: 1500, sb: 15, bb: 30, length: 6, pct: 50, ante: 0, payout: 'standard', desc: 'One table, quick blinds' },
  { name: 'Daily Deepstack', buyIn: 500, entrants: 27, seats: 9, stack: 5000, sb: 25, bb: 50, length: 10, pct: 40, ante: 4, payout: 'standard', desc: 'Three tables, deep play' },
  { name: 'The Obsidian Open', buyIn: 1000, entrants: 90, seats: 9, stack: 5000, sb: 25, bb: 50, length: 10, pct: 45, ante: 4, payout: 'standard', desc: 'Ten tables, a real run' },
  { name: 'High Noon 6-Max', buyIn: 2500, entrants: 36, seats: 6, stack: 3000, sb: 25, bb: 50, length: 8, pct: 50, ante: 3, payout: 'top_heavy', desc: 'Six tables, big first prize' },
];

export function TournamentLobby() {
  const service = useService();
  const { session, career, pendingTournament } = service;
  const [name, setName] = useState(PRESETS[1].name);
  const [buyIn, setBuyIn] = useState(PRESETS[1].buyIn);
  const [entrants, setEntrants] = useState(PRESETS[1].entrants);
  const [seats, setSeats] = useState(PRESETS[1].seats);
  const [stack, setStack] = useState(PRESETS[1].stack);
  const [sb, setSb] = useState(PRESETS[1].sb);
  const [bb, setBb] = useState(PRESETS[1].bb);
  const [mode, setMode] = useState<LevelMode>('hands');
  const [length, setLength] = useState(PRESETS[1].length);
  const [increase, setIncrease] = useState(PRESETS[1].pct);
  const [ante, setAnte] = useState(PRESETS[1].ante);
  const [payout, setPayout] = useState<PayoutStructure>(PRESETS[1].payout);
  const [reentries, setReentries] = useState(0);
  const [reentryUntil, setReentryUntil] = useState(4);
  const [difficulty, setDifficulty] = useState(5);
  const [startDelay, setStartDelay] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const applyPreset = (p: (typeof PRESETS)[number]) => {
    setName(p.name);
    setBuyIn(p.buyIn);
    setEntrants(p.entrants);
    setSeats(p.seats);
    setStack(p.stack);
    setSb(p.sb);
    setBb(p.bb);
    setMode('hands');
    setLength(p.length);
    setIncrease(p.pct);
    setAnte(p.ante);
    setPayout(p.payout);
  };

  const tableCount = Math.max(1, Math.ceil(entrants / Math.max(2, seats)));
  const valid =
    name.trim().length > 0 &&
    [buyIn, entrants, seats, stack, sb, bb, length, increase].every((n) => Number.isFinite(n) && n > 0) &&
    entrants >= 2 && entrants <= 540 && seats >= 2 && seats <= 9 && bb >= sb && stack >= bb * 2 && buyIn <= career.bankroll;

  const payouts = useMemo(() => (valid ? computePayouts(buyIn * entrants, entrants, payout) : []), [valid, buyIn, entrants, payout]);
  const schedule = useMemo(() => {
    if (!valid) return [];
    const config = { startingSmallBlind: sb, startingBigBlind: bb, blindIncreasePct: increase, anteFromLevel: ante };
    return [1, 2, 3, 4, 5, 6].map((l) => blindLevelFor(config, l));
  }, [valid, sb, bb, increase, ante]);

  const register = () => {
    const config: TournamentConfig = {
      name: name.trim(),
      buyIn,
      entrants,
      seatsPerTable: seats,
      startingStack: stack,
      startingSmallBlind: sb,
      startingBigBlind: bb,
      levelMode: mode,
      levelLength: length,
      blindIncreasePct: increase,
      anteFromLevel: ante,
      payout,
      reentries,
      reentryUntilLevel: reentryUntil,
      difficulty,
    };
    const result = service.registerTournament(config, startDelay);
    if (!result.ok) setError(result.error);
    else if (startDelay <= 0) go('tables');
  };

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Tournaments</h1>
        <p>Bankroll: <b>{fmt(career.bankroll)}</b> chips</p>
      </header>
      {session && (
        <div className="callout">
          <div><strong>{session.title}</strong> is running.</div>
          <button type="button" className="btn btn-gold" onClick={() => go('tables')}>Go to tables</button>
        </div>
      )}
      {pendingTournament && <PendingCard />}
      {!session && !pendingTournament && (
        <>
          <div className="preset-row">
            {PRESETS.map((p) => (
              <button key={p.name} type="button" className={cx('preset-card', name === p.name && 'is-on')} onClick={() => applyPreset(p)}>
                <strong>{p.name}</strong>
                <span>{fmt(p.buyIn)} · {p.entrants} players</span>
                <small>{p.desc}</small>
              </button>
            ))}
          </div>
          <div className="grid-2 lobby-grid">
            <section className="panel">
              <h2>Structure</h2>
              <Field label="Name"><input type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <div className="form-row">
                <NumberField label="Entry fee" value={buyIn} min={1} onChange={setBuyIn} hint="Paid from your bankroll" />
                <NumberField label="Players" value={entrants} min={2} max={540} onChange={setEntrants} />
                <NumberField
                  label="Tables"
                  value={tableCount}
                  min={1}
                  max={270}
                  onChange={(tables) => {
                    if (!Number.isFinite(tables) || tables < 1) return;
                    // The number of seats follows from players and tables, within the 2-9 limit.
                    setSeats(Math.max(2, Math.min(9, Math.ceil(entrants / tables))));
                  }}
                  hint={`${seats} seats per table`}
                />
                <NumberField label="Seats per table" value={seats} min={2} max={9} onChange={setSeats} />
              </div>
              <div className="form-row">
                <NumberField label="Starting stack" value={stack} min={2} onChange={setStack} hint={`${Number.isFinite(stack / bb) ? (stack / bb).toFixed(0) : '–'} big blinds`} />
                <NumberField label="Starting small blind" value={sb} min={1} onChange={setSb} />
                <NumberField label="Starting big blind" value={bb} min={1} onChange={setBb} />
              </div>
              <div className="form-row">
                <Field label="Blinds rise by">
                  <div className="seg">
                    <button type="button" className={cx(mode === 'hands' && 'is-on')} onClick={() => setMode('hands')}>Hands</button>
                    <button type="button" className={cx(mode === 'minutes' && 'is-on')} onClick={() => setMode('minutes')}>Minutes</button>
                  </div>
                </Field>
                <NumberField label={mode === 'hands' ? 'Hands per level' : 'Minutes per level'} value={length} min={1} onChange={setLength} />
                <NumberField label="Increase per level (%)" value={increase} min={1} onChange={setIncrease} />
              </div>
              <div className="form-row">
                <NumberField label="Antes from level" value={ante} min={0} onChange={setAnte} hint="0 means no antes" />
                <NumberField label="Re-entries allowed" value={reentries} min={0} max={5} onChange={setReentries} />
                <NumberField label="Re-entry until level" value={reentryUntil} min={1} onChange={setReentryUntil} />
              </div>
              <Field label="Starts">
                <div className="seg">
                  {[[0, 'Now'], [30, 'In 30 sec'], [120, 'In 2 min'], [300, 'In 5 min']].map(([value, label]) => (
                    <button key={value} type="button" className={cx(startDelay === value && 'is-on')} onClick={() => setStartDelay(value as number)}>{label}</button>
                  ))}
                </div>
              </Field>
              <DifficultyControl value={difficulty} onChange={setDifficulty} />
            </section>

            <section className="panel">
              <h2>Payouts</h2>
              <div className="seg seg-wide">
                {(Object.keys(PAYOUT_LABELS) as PayoutStructure[]).map((p) => (
                  <button key={p} type="button" className={cx(payout === p && 'is-on')} onClick={() => setPayout(p)}>{PAYOUT_LABELS[p]}</button>
                ))}
              </div>
              {valid && (
                <>
                  <p className="muted">Prize pool <b>{fmt(buyIn * entrants)}</b>. {paidPlaces(entrants, payout)} place{paidPlaces(entrants, payout) > 1 ? 's' : ''} paid.</p>
                  <ol className="payout-list">
                    {payouts.slice(0, 8).map((prize, i) => (
                      <li key={i}><span>{i + 1}</span><b>{fmt(prize)}</b><em>{((prize / (buyIn * entrants)) * 100).toFixed(1)}%</em></li>
                    ))}
                    {payouts.length > 8 && <li className="muted"><span>…</span><b>{payouts.length - 8} more</b></li>}
                  </ol>
                  <h3>Blind schedule</h3>
                  <table className="data-table compact">
                    <thead><tr><th>Level</th><th>Blinds</th><th>Ante</th></tr></thead>
                    <tbody>
                      {schedule.map((l) => (
                        <tr key={l.level}><td>{l.level}</td><td>{fmt(l.smallBlind)}/{fmt(l.bigBlind)}</td><td>{l.ante ? fmt(l.ante) : '–'}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <button type="button" className="btn btn-gold btn-lg btn-block" disabled={!valid} onClick={register}>
                Register for {Number.isFinite(buyIn) ? fmt(buyIn) : '–'}
              </button>
              {!valid && buyIn > career.bankroll && <p className="form-error">That entry is more than your bankroll.</p>}
              {!valid && buyIn <= career.bankroll && <p className="form-error">Check the values: the stack must be at least two big blinds, and 2-540 players, 2-9 seats.</p>}
              {error && <p className="form-error" role="alert">{error}</p>}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function PendingCard() {
  const service = useService();
  const pending = service.pendingTournament!;
  const now = useNow(true, 1000);
  const left = Math.max(0, Math.ceil((pending.startsAt - now) / 1000));
  return (
    <div className="callout">
      <div>
        <strong>{pending.config.name}</strong>
        <p>Registered. Starts in {left} seconds. You will be seated automatically.</p>
      </div>
      <button type="button" className="btn" onClick={() => service.cancelPendingTournament()}>Unregister and refund</button>
    </div>
  );
}
