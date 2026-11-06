import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { go, useMediaQuery, useNow, useService, useServiceStatic, useTableView } from '../../app/context';
import { type ActiveSession, type ActiveTable, ordinal } from '../../app/gameService';
import type { TableController } from '../../session/tableController';
import type { SeatView } from '../../session/tableView';
import { publishStats } from '../../stats/counters';
import { HERO_ID, type TournamentDirector } from '../../tournament/director';
import { LineChart } from '../components/Charts';
import { ActionPanel, PreActionPanel } from '../components/Controls';
import { HudBadge } from '../components/Hud';
import { TableSurface } from '../components/TableSurface';
import { cx, duration, fmt, fmtShort, signed } from '../format';

function RebuyBar({ table }: { table: ActiveTable }) {
  const service = useServiceStatic();
  const view = useTableView(table.controller);
  const cash = service.session?.cash;
  const [amount, setAmount] = useState(cash?.buyIn ?? 0);
  const [error, setError] = useState<string | null>(null);
  if (!cash) return null;
  const bankroll = service.career.bankroll;
  const id = table.controller.config.id;
  return (
    <div className="rebuy-bar" role="group" aria-label={`Rebuy at ${view.tableName}`}>
      <span>Out of chips at {view.tableName}.</span>
      <input type="number" min={cash.bigBlind * 2} max={bankroll} value={amount} aria-label="Rebuy amount" onChange={(e) => setAmount(Number(e.target.value))} />
      <button
        type="button"
        className="btn btn-gold"
        disabled={!Number.isInteger(amount) || amount < cash.bigBlind * 2 || amount > bankroll}
        onClick={() => {
          const result = service.rebuy(id, amount);
          setError(result.ok ? null : result.error);
        }}
      >
        Rebuy
      </button>
      <button type="button" className="btn" onClick={() => service.leaveTable(id)}>Leave table</button>
      {error && <span className="form-error" role="alert">{error}</span>}
    </div>
  );
}

/** One table with its own controls. Renders only when this table's own state changes. */
const TableFrame = memo(function TableFrame({ table, index, isFocused, session, compact }: { table: ActiveTable; index: number; isFocused: boolean; session: ActiveSession; compact: boolean }) {
  const service = useServiceStatic();
  const { settings } = useService();
  const controller: TableController = table.controller;
  const view = useTableView(controller);
  const heroTurn = view.phase === 'hero_turn' && view.legal !== null;
  const isPhone = useMediaQuery('(max-width: 820px)');
  const [confirmLeave, setConfirmLeave] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [tablePresets, setTablePresets] = useState<number[] | null>(null);
  const [timerSec, setTimerSec] = useState(controller.config.timing.actionTimerSec);

  const appearance = useMemo(
    () => ({ theme: settings.tableTheme, cardFace: settings.cardFace, cardBack: settings.cardBack, chipStyle: settings.chipStyle, animation: settings.animationSpeed }),
    [settings.tableTheme, settings.cardFace, settings.cardBack, settings.chipStyle, settings.animationSpeed],
  );

  // HUD figures only change between hands, so this is keyed on the hand number.
  const handKey = view.handNumber;
  const hudFor = useCallback(
    (seat: SeatView) => {
      if (!settings.hudEnabled) return undefined;
      return <HudBadge key={handKey} counters={controller.observed.get(seat.id)} stats={settings.hudStats} density={isPhone ? 'minimal' : compact && settings.hudDensity === 'detailed' ? 'standard' : settings.hudDensity} name={seat.name} />;
    },
    [settings.hudEnabled, settings.hudStats, settings.hudDensity, controller, handKey, compact, isPhone],
  );

  const toCallChips = view.legal?.callAmount ?? 0;
  return (
    <section
      className={cx('table-frame', heroTurn && 'is-hero-turn', isFocused && 'is-focused')}
      aria-label={`${view.tableName}${heroTurn ? ', your turn' : ''}`}
      data-testid={`table-${index}`}
    >
      <header className="frame-head">
        <span className="frame-num">{index + 1}</span>
        <strong>{view.tableName}</strong>
        <span className="frame-blinds">{fmtShort(view.smallBlind)}/{fmtShort(view.bigBlind)}{view.ante ? ` · ante ${fmtShort(view.ante)}` : ''}</span>
        <span className="frame-hand">#{view.handNumber}</span>
        {heroTurn && <span className="frame-turn" role="status">YOUR TURN<span className="hide-small">{toCallChips > 0 ? ` · ${fmtShort(toCallChips)} to call` : ''}</span></span>}
        <span className="frame-spacer" />
        <button type="button" className="mini-btn" aria-expanded={optionsOpen} onClick={() => setOptionsOpen((v) => !v)}>Options</button>
        {session.kind === 'cash' && (
          confirmLeave ? (
            <span className="frame-confirm">
              <button type="button" className="mini-btn mini-danger" onClick={() => service.leaveTable(controller.config.id)}>Leave now</button>
              <button type="button" className="mini-btn" onClick={() => setConfirmLeave(false)}>Stay</button>
            </span>
          ) : view.leaveRequested ? (
            <span className="frame-hand">Leaving after this hand</span>
          ) : (
            <button type="button" className="mini-btn" onClick={() => setConfirmLeave(true)}>Leave</button>
          )
        )}
      </header>

      {optionsOpen && (
        <TableOptions
          controller={controller}
          timerSec={timerSec}
          presets={tablePresets ?? settings.betPresets}
          onTimer={(sec) => {
            setTimerSec(sec);
            controller.setTiming({ actionTimerSec: sec });
          }}
          onPresets={setTablePresets}
          onClose={() => setOptionsOpen(false)}
        />
      )}

      <div className="table-area">
        <TableSurface view={view} appearance={appearance} hudFor={hudFor} />
      </div>

      <div className="frame-controls">
        {view.needsRebuy ? (
          <RebuyBar table={table} />
        ) : heroTurn ? (
          <ActionPanel controller={controller} view={view} legal={view.legal!} presets={tablePresets ?? settings.betPresets} isFocused={isFocused} hotkeys={settings.hotkeys} />
        ) : (
          <PreActionPanel controller={controller} view={view} />
        )}
      </div>

      {settings.chatEnabled && view.chat.length > 0 && <TableChat lines={view.chat} />}
    </section>
  );
});

const TIMER_CHOICES = [10, 15, 20, 30, 45, 60];
const SIZE_CHOICES = [0.33, 0.5, 0.66, 0.75, 1, 1.5];

/** Settings that belong to one table only. Figures come from this table's own hands. */
function TableOptions({ controller, timerSec, presets, onTimer, onPresets, onClose }: { controller: TableController; timerSec: number; presets: readonly number[]; onTimer: (sec: number) => void; onPresets: (p: number[]) => void; onClose: () => void }) {
  const own = controller.heroId ? controller.observed.get(controller.heroId) : undefined;
  const stats = own ? publishStats(own) : null;
  return (
    <div className="table-options" role="dialog" aria-label="Options for this table">
      <label className="inline-field">
        Action timer
        <select value={timerSec} onChange={(e) => onTimer(Number(e.target.value))}>
          {[...new Set([...TIMER_CHOICES, timerSec])].sort((a, b) => a - b).map((s) => <option key={s} value={s}>{s} seconds</option>)}
        </select>
      </label>
      <fieldset className="table-option-sizes">
        <legend>Bet buttons</legend>
        {SIZE_CHOICES.map((p) => (
          <label key={p} className="check">
            <input
              type="checkbox"
              checked={presets.includes(p)}
              onChange={(e) => {
                const next = e.target.checked ? [...presets, p].sort((a, b) => a - b) : presets.filter((x) => x !== p);
                if (next.length > 0) onPresets(next);
              }}
            />
            {Math.round(p * 100)}%
          </label>
        ))}
      </fieldset>
      <p className="table-option-stats">
        {own && stats ? `You at this table: ${own.hands} hands, VPIP ${stats.vpip.value === null ? '–' : Math.round(stats.vpip.value * 100) + '%'}, ${signed(own.net)} chips` : 'No hands played here yet.'}
      </p>
      <button type="button" className="mini-btn" onClick={onClose}>Close</button>
    </div>
  );
}

function TableChat({ lines }: { lines: ReturnType<TableController['getView']>['chat'] }) {
  const last = lines[lines.length - 1];
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    const id = setTimeout(() => setVisible(false), 6000);
    return () => clearTimeout(id);
  }, [last.key]);
  if (!visible) return null;
  return (
    <div className={cx('chat-bubble', last.kind === 'system' && 'chat-system')} role="log" aria-live="polite">
      {last.kind === 'chat' && <b>{last.name}: </b>}
      {last.text}
    </div>
  );
}

function SessionStrip({ session, onToggle, open }: { session: ActiveSession; onToggle: () => void; open: boolean }) {
  const now = useNow(true, 1000);
  const s = session.stats;
  const elapsed = now - s.startedAt;
  const bb100 = s.hands > 0 ? (s.bbNet / s.hands) * 100 : null;
  return (
    <button type="button" className="session-strip" onClick={onToggle} aria-expanded={open} aria-controls="session-dash">
      <span className="strip-item"><i>{session.title}</i></span>
      <span className="strip-item"><i>Session</i><b className={s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : ''}>{signed(s.net)}</b></span>
      <span className="strip-item"><i>Hands</i><b>{s.hands}</b></span>
      <span className="strip-item hide-small"><i>BB/100</i><b>{bb100 === null ? '–' : bb100.toFixed(1)}</b></span>
      <span className="strip-item hide-small"><i>Time</i><b>{duration(elapsed)}</b></span>
      <span className="strip-more">{open ? 'Hide dashboard' : 'Dashboard'}</span>
    </button>
  );
}

function SessionDashboard({ session }: { session: ActiveSession }) {
  const service = useService();
  const now = useNow(true, 1000);
  const s = session.stats;
  const elapsedHours = (now - s.startedAt) / 3600000;
  const stats = publishStats(s.counters);
  return (
    <div className="dash" id="session-dash">
      <div className="tile-row tile-row-tight">
        <div className="tile"><span>Bankroll</span><b>{fmt(service.career.bankroll)}</b><small>off the table</small></div>
        <div className="tile"><span>Session P/L</span><b className={s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : ''}>{signed(s.net)}</b><small>{s.hands} hands</small></div>
        <div className="tile"><span>Hourly</span><b>{elapsedHours > 0.02 ? signed(s.net / elapsedHours) : '–'}</b><small>chips per hour</small></div>
        <div className="tile"><span>BB/100</span><b>{stats.bb100.value === null ? '–' : stats.bb100.value.toFixed(1)}</b><small>{s.hands < 100 ? 'very small sample' : `${s.hands} hands`}</small></div>
        <div className="tile"><span>Biggest pot</span><b>{fmt(s.biggestPot)}</b></div>
        <div className="tile"><span>Best streak</span><b>{s.bestWinStreak}</b><small>{s.worstLoseStreak} worst losing</small></div>
        <div className="tile"><span>Duration</span><b>{duration(now - s.startedAt)}</b></div>
      </div>
      <h3 className="chart-title">Session profit, by hand</h3>
      <LineChart values={[0, ...s.curve]} label="Session profit by hand" yFormat={fmtShort} height={150} />
    </div>
  );
}

function TournamentPanel({ director, heroController }: { director: TournamentDirector; heroController?: TableController }) {
  useService();
  const now = useNow(director.config.levelMode === 'minutes', 1000);
  void now;
  const status = director.status();
  const standings = director.standings();
  const heroRank = standings.findIndex((r) => r.id === HERO_ID) + 1;
  const heroStack = heroController ? director.stackOf(HERO_ID) : 0;
  const [tab, setTab] = useState<'standings' | 'payouts'>('standings');
  return (
    <aside className={cx('tourney-panel', status.isFinalTable && 'is-final')} aria-label="Tournament information">
      {status.isFinalTable && <div className="final-flag">FINAL TABLE</div>}
      <h2>{status.name}</h2>
      <dl className="tourney-grid">
        <div><dt>Level {status.level.level}</dt><dd>{fmtShort(status.level.smallBlind)}/{fmtShort(status.level.bigBlind)}{status.level.ante ? ` (${fmtShort(status.level.ante)})` : ''}</dd></div>
        <div><dt>Next</dt><dd>{fmtShort(status.nextLevel.smallBlind)}/{fmtShort(status.nextLevel.bigBlind)}</dd></div>
        <div>
          <dt>{status.levelMode === 'hands' ? 'Hands to next' : 'Time to next'}</dt>
          <dd>{status.levelMode === 'hands' ? status.handsLeftInLevel : duration(status.msLeftInLevel ?? 0)}</dd>
        </div>
        <div><dt>Players</dt><dd>{status.playersLeft} / {status.totalEntries}</dd></div>
        <div><dt>Avg stack</dt><dd>{fmtShort(status.averageStack)}</dd></div>
        <div><dt>Tables</dt><dd>{status.tableCount}</dd></div>
        <div><dt>Prize pool</dt><dd>{fmtShort(status.prizePool)}</dd></div>
        <div><dt>Paid</dt><dd>{status.paidPlaces} places</dd></div>
        {heroRank > 0 && heroStack > 0 && <div><dt>Your rank</dt><dd>{ordinal(heroRank)} · {fmtShort(heroStack)}</dd></div>}
      </dl>
      {status.isBubble && <p className="bubble-flag">On the bubble: the next elimination puts everyone in the money.</p>}
      {heroController && <ForfeitButton />}
      <div className="seg seg-wide">
        <button type="button" className={cx(tab === 'standings' && 'is-on')} onClick={() => setTab('standings')}>Standings</button>
        <button type="button" className={cx(tab === 'payouts' && 'is-on')} onClick={() => setTab('payouts')}>Payouts</button>
      </div>
      {tab === 'standings' ? (
        <ol className="standings">
          {standings.slice(0, 40).map((r, i) => (
            <li key={r.id} className={cx(r.isHuman && 'is-me', r.status === 'out' && 'is-out')}>
              <span>{r.status === 'active' ? i + 1 : (r.place ?? '–')}</span>
              <b>{r.name}</b>
              <em>{r.status === 'active' ? fmtShort(r.chips) : r.prize > 0 ? `won ${fmtShort(r.prize)}` : 'out'}</em>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="standings">
          {status.payouts.map((prize, i) => (
            <li key={i} className={cx(status.playersLeft === i + 1 && 'is-me')}>
              <span>{i + 1}</span>
              <b>{fmt(prize)}</b>
            </li>
          ))}
        </ol>
      )}
    </aside>
  );
}

function ForfeitButton() {
  const service = useServiceStatic();
  const [confirm, setConfirm] = useState(false);
  if (!confirm) return <button type="button" className="mini-btn" onClick={() => setConfirm(true)}>Leave tournament</button>;
  return (
    <div className="forfeit">
      <span>Your seat will fold every hand until you are out. You keep any prize that earns.</span>
      <button type="button" className="mini-btn mini-danger" onClick={() => service.forfeitTournament()}>Leave</button>
      <button type="button" className="mini-btn" onClick={() => setConfirm(false)}>Stay</button>
    </div>
  );
}

export function TablesScreen() {
  const service = useService();
  const { session, settings, focusedTableId, pendingTournament } = service;
  const isPhone = useMediaQuery('(max-width: 820px)');
  const [dashOpen, setDashOpen] = useState(false);
  const [selected, setSelected] = useState(0);

  const openTables = useMemo(() => session?.tables.filter((t) => !t.closed) ?? [], [session, session?.tables.length, session?.tables.filter((t) => t.closed).length]);
  const layout = settings.layout === 'auto' ? (isPhone ? 'focus' : 'grid') : isPhone ? 'focus' : settings.layout;

  // In single-table view, jump to a table that needs the player unless they are mid-decision elsewhere.
  const selectedTable = openTables[Math.min(selected, Math.max(0, openTables.length - 1))];
  const selectedNeedsYou = selectedTable && selectedTable.controller.config.id === focusedTableId;
  useEffect(() => {
    if (layout !== 'focus' || !focusedTableId || selectedNeedsYou) return;
    if (selectedTable && selectedTable.controller.getView().phase === 'hero_turn') return;
    const index = openTables.findIndex((t) => t.controller.config.id === focusedTableId);
    if (index >= 0) setSelected(index);
  }, [layout, focusedTableId, openTables, selectedNeedsYou, selectedTable]);

  if (!session) {
    return (
      <div className="screen">
        <header className="screen-head">
          <h1>Multi-Table</h1>
          <p>Play up to four tables at once, each with its own stakes format, timers, pre-actions and opponents.</p>
        </header>
        {pendingTournament ? (
          <div className="callout">
            <div><strong>{pendingTournament.config.name}</strong> starts soon.</div>
            <button type="button" className="btn btn-gold" onClick={() => go('tournaments')}>View</button>
          </div>
        ) : (
          <div className="mode-cards mode-cards-big">
            <button type="button" className="mode-card" onClick={() => go('cash')}>
              <strong>Set up cash tables</strong>
              <span>Choose one to four tables and mix heads-up, 6-max, full ring and random formats.</span>
            </button>
            <button type="button" className="mode-card" onClick={() => go('tournaments')}>
              <strong>Join a tournament</strong>
              <span>Play your table while the rest of the field plays on through the same engine.</span>
            </button>
          </div>
        )}
      </div>
    );
  }

  if (session.simulatingRest && session.director) {
    return (
      <div className="screen">
        <header className="screen-head">
          <h1>Your tournament is over</h1>
          <p>The rest of the field is playing out to find the champion.</p>
        </header>
        <TournamentPanel director={session.director} />
      </div>
    );
  }

  const count = openTables.length;
  const gridClass = layout === 'focus' ? 'tg-focus' : `tg-${Math.min(count, 4)}`;
  const shown = layout === 'focus' && selectedTable ? [selectedTable] : openTables;

  return (
    <div className={cx('tables-screen', session.kind === 'tournament' && 'with-side')}>
      <SessionStrip session={session} onToggle={() => setDashOpen((v) => !v)} open={dashOpen} />
      {dashOpen && <SessionDashboard session={session} />}

      {layout === 'focus' && count > 1 && (
        <div className="table-tabs" role="tablist" aria-label="Tables">
          {openTables.map((t, i) => (
            <TableTab key={t.controller.config.id} table={t} index={i} selected={selectedTable === t} onSelect={() => setSelected(i)} />
          ))}
        </div>
      )}

      <div className="tables-body">
        <div className={cx('tables-grid', gridClass)}>
          {shown.map((t) => (
            <TableFrame
              key={t.controller.config.id}
              table={t}
              index={openTables.indexOf(t)}
              isFocused={focusedTableId === t.controller.config.id}
              session={session}
              compact={count >= 3 || isPhone}
            />
          ))}
        </div>
        {session.kind === 'tournament' && session.director && !isPhone && <TournamentPanel director={session.director} heroController={session.tables[0]?.controller} />}
      </div>
      {session.kind === 'tournament' && session.director && isPhone && <TournamentPanel director={session.director} heroController={session.tables[0]?.controller} />}
    </div>
  );
}

function TableTab({ table, index, selected, onSelect }: { table: ActiveTable; index: number; selected: boolean; onSelect: () => void }) {
  const view = useTableView(table.controller);
  const heroTurn = view.phase === 'hero_turn';
  const hero = view.heroSeat !== null ? view.seats[view.heroSeat] : null;
  return (
    <button type="button" role="tab" aria-selected={selected} className={cx('table-tab', selected && 'is-on', heroTurn && 'needs-you')} onClick={onSelect}>
      <b>{index + 1}</b>
      <span>{hero ? fmtShort(hero.stack) : '–'}</span>
      {heroTurn && <i>ACT</i>}
    </button>
  );
}
