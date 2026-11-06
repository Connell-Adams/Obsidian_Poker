import { useEffect, useState } from 'react';
import { useService } from '../../app/context';
import { ordinal } from '../../app/gameService';
import { ACHIEVEMENTS, levelTitle } from '../../career/achievements';
import { type LedgerEntry, RELOAD_AMOUNT } from '../../career/career';
import { LineChart } from '../components/Charts';
import { cx, dateTime, fmt, fmtShort, signed } from '../format';

interface SessionRow {
  id: string;
  kind: 'cash' | 'tournament';
  title: string;
  net: number;
  hands: number;
  endedAt: number;
  detail: string;
}

export function CareerScreen() {
  const service = useService();
  const { career } = service;
  const p = career.profile;
  const level = career.level;
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);

  useEffect(() => {
    void career.flush().then(() => career.ledger()).then(setLedger);
    void service.store.getAll<SessionRow>('sessions').then((rows) => setSessions(rows.sort((a, b) => b.endedAt - a.endedAt).slice(0, 30)));
  }, [career, service, p.bankroll]);

  const curve = ledger.map((e) => e.balanceAfter);
  const unlocked = ACHIEVEMENTS.filter((a) => p.achievements[a.id] !== undefined);

  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Career</h1>
        <p>Level {level.level}, {levelTitle(level.level)}. {level.xpForNext - level.xpIntoLevel} XP to the next level.</p>
      </header>

      <section className="tile-row">
        <div className="tile"><span>Bankroll</span><b>{fmt(career.bankroll)}</b><small>started with {fmt(p.startingBankroll)}</small></div>
        <div className="tile"><span>Net profit</span><b className={career.netProfit > 0 ? 'pos' : career.netProfit < 0 ? 'neg' : ''}>{signed(career.netProfit)}</b><small>{p.reloads ? `excludes ${fmt(p.reloads)} in reloads` : 'all from play'}</small></div>
        <div className="tile"><span>Hands played</span><b>{fmt(p.handsPlayed)}</b><small>{fmt(p.cashHands)} cash, {fmt(p.tournamentHands)} tournament</small></div>
        <div className="tile"><span>Best cash session</span><b>{signed(p.bestCashSession)}</b><small>{fmt(p.cashSessions)} sessions</small></div>
        <div className="tile"><span>Biggest pot won</span><b>{fmt(p.biggestPotWon)}</b></div>
        <div className="tile"><span>Biggest pot lost</span><b>{fmt(p.biggestPotLost)}</b></div>
        <div className="tile">
          <span>Decision quality</span>
          <b>{service.decisionQuality === null ? '–' : `${Math.round(service.decisionQuality * 100)}%`}</b>
          <small>{service.decisionQuality === null ? 'needs 20 reviewed decisions' : 'reviewed decisions rated good or fine'}</small>
        </div>
      </section>

      {career.bankroll < RELOAD_AMOUNT / 10 && (
        <div className="callout">
          <div>
            <strong>Running low.</strong>
            <p>Take a free {fmt(RELOAD_AMOUNT)}-chip reload. It is tracked separately and does not count as profit.</p>
          </div>
          <button type="button" className="btn btn-gold" onClick={() => service.reloadBankroll()}>Reload</button>
        </div>
      )}

      <section className="grid-2">
        <div className="panel">
          <h2>Bankroll over time</h2>
          <LineChart values={curve} label="Bankroll after each transaction" zeroLine={false} yFormat={fmtShort} xLabel={(i) => ledger[i]?.note ?? ''} />
        </div>
        <div className="panel">
          <h2>Ledger</h2>
          <div className="scroll-box">
            <table className="data-table compact">
              <thead><tr><th>When</th><th>What</th><th className="num">Amount</th><th className="num">Balance</th></tr></thead>
              <tbody>
                {[...ledger].reverse().slice(0, 100).map((e) => (
                  <tr key={e.id}>
                    <td>{dateTime(e.ts)}</td>
                    <td>{e.note}</td>
                    <td className={cx('num', e.amount > 0 ? 'pos' : e.amount < 0 ? 'neg' : '')}>{signed(e.amount)}</td>
                    <td className="num">{fmt(e.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {service.windows.length >= 3 && (
        <section className="panel">
          <h2>Skill progression</h2>
          <p className="muted">Your win rate in BB/100 across each block of 25 hands, from real results. Short blocks swing a lot, so look at the overall shape.</p>
          <LineChart values={service.windows.map((w) => (w.hands ? (w.bbNet / w.hands) * 100 : 0))} label="BB per 100 by 25-hand block" yFormat={(v) => v.toFixed(0)} xLabel={(i) => `Block ${i + 1}, hands ${i * 25 + 1}-${(i + 1) * 25}`} />
        </section>
      )}

      <section className="grid-2">
        <div className="panel">
          <h2>Tournament record</h2>
          <dl className="mini-stats">
            <div><dt>Played</dt><dd>{fmt(p.tournamentsPlayed)}</dd></div>
            <div><dt>Wins</dt><dd>{fmt(p.tournamentWins)}</dd></div>
            <div><dt>Cashes</dt><dd>{fmt(p.tournamentCashes)}</dd></div>
            <div><dt>Best finish</dt><dd>{p.bestTournamentPlace ? ordinal(p.bestTournamentPlace) : '–'}</dd></div>
            <div><dt>Entry fees</dt><dd>{fmt(p.tournamentFees)}</dd></div>
            <div><dt>Payouts</dt><dd>{fmt(p.tournamentPayouts)}</dd></div>
          </dl>
          <h3>Trophies</h3>
          {p.trophies.length === 0 ? (
            <p className="muted">Finish in the money to earn your first trophy.</p>
          ) : (
            <ul className="trophy-list">
              {p.trophies.slice(0, 20).map((t) => (
                <li key={t.id + t.ts}>
                  <span className={cx('trophy', t.place === 1 && 'trophy-gold')}>{t.place === 1 ? '★' : ordinal(t.place)}</span>
                  <div><strong>{t.name}</strong><small>{dateTime(t.ts)}, {t.entrants} entries</small></div>
                  <b>{fmt(t.prize)}</b>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="panel">
          <h2>Session history</h2>
          {sessions.length === 0 ? (
            <p className="muted">Finished sessions will appear here.</p>
          ) : (
            <div className="scroll-box">
              <table className="data-table compact">
                <thead><tr><th>Ended</th><th>Game</th><th className="num">Hands</th><th className="num">Net</th></tr></thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id}>
                      <td>{dateTime(s.endedAt)}</td>
                      <td title={s.detail}>{s.title}</td>
                      <td className="num">{fmt(s.hands)}</td>
                      <td className={cx('num', s.net > 0 ? 'pos' : s.net < 0 ? 'neg' : '')}>{signed(s.net)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <h2>Achievements <span className="count-pill">{unlocked.length} of {ACHIEVEMENTS.length}</span></h2>
        <ul className="achievement-grid">
          {ACHIEVEMENTS.map((a) => {
            const at = p.achievements[a.id];
            return (
              <li key={a.id} className={cx('achievement', at !== undefined && 'is-on')}>
                <span className="badge" aria-hidden="true">{at !== undefined ? '★' : '☆'}</span>
                <div>
                  <strong>{a.name}</strong>
                  <small>{a.description}</small>
                  {at !== undefined && <em>{dateTime(at)}</em>}
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
