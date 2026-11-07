import { go, useService } from '../../app/context';
import { levelTitle } from '../../career/achievements';
import { publishStats } from '../../stats/counters';
import { PlayingCard } from '../components/Art';
import { fmt, pct, signed } from '../format';

export function HomeScreen() {
  const service = useService();
  const { career, session, settings, recommendations } = service;
  const p = career.profile;
  const stats = publishStats(p.counters);
  const level = career.level;
  const latest = recommendations[0];
  const broke = career.bankroll < 1000;

  return (
    <div className="screen home">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Welcome back, {settings.playerName}</p>
          <h1>The room is open.</h1>
          <p className="lede">Cash games and tournaments against opponents who think, adapt and tilt, with a coach who reviews every hand you play.</p>
          <div className="hero-actions">
            {session ? (
              <button type="button" className="btn btn-gold btn-lg" onClick={() => go('tables')}>Back to your tables</button>
            ) : (
              <button type="button" className="btn btn-gold btn-lg" onClick={() => go('play')}>Take a seat</button>
            )}
            <button type="button" className="btn btn-lg" onClick={() => go('coach')}>Open the coach</button>
          </div>
        </div>
        <div className="hero-cards" aria-hidden="true">
          <PlayingCard card={48 + 3} face={settings.cardFace} className="hero-fan fan-1" />
          <PlayingCard card={44 + 3} face={settings.cardFace} className="hero-fan fan-2" />
        </div>
      </section>

      {broke && (
        <section className="callout">
          <div>
            <strong>You are nearly out of offline chips.</strong>
            <p>Add as many as you like in Bankroll. Added chips never count as profit.</p>
          </div>
          <button type="button" className="btn btn-gold" onClick={() => go('bankroll')}>Add chips</button>
        </section>
      )}

      <section className="tile-row" aria-label="Career summary">
        <div className="tile">
          <span>Offline bankroll</span>
          <b>{fmt(career.bankroll)}</b>
          <small>{career.netProfit === 0 ? 'even so far' : `${signed(career.netProfit)} lifetime P/L`}</small>
        </div>
        <div className="tile">
          <span>Level {level.level}</span>
          <b className="tile-text">{levelTitle(level.level)}</b>
          <div className="xp-bar"><i style={{ width: `${(level.xpIntoLevel / level.xpForNext) * 100}%` }} /></div>
        </div>
        <div className="tile">
          <span>Hands played</span>
          <b>{fmt(p.handsPlayed)}</b>
          <small>{stats.bb100.value === null ? 'no hands yet' : `${stats.bb100.value.toFixed(1)} BB/100`}</small>
        </div>
        <div className="tile">
          <span>Tournaments</span>
          <b>{fmt(p.tournamentWins)} wins</b>
          <small>{fmt(p.tournamentCashes)} cashes of {fmt(p.tournamentsPlayed)}</small>
        </div>
      </section>

      <section className="grid-2">
        <div className="panel">
          <h2>Play</h2>
          <div className="mode-cards">
            <button type="button" className="mode-card" onClick={() => go('cash')}>
              <strong>Cash Game</strong>
              <span>Choose stakes, up to four tables and any mix of formats. Leave whenever you like.</span>
            </button>
            <button type="button" className="mode-card" onClick={() => go('tournaments')}>
              <strong>Tournament</strong>
              <span>Rising blinds, table balancing, a final table and a real payout ladder.</span>
            </button>
          </div>
        </div>
        <div className="panel">
          <h2>Your game so far</h2>
          {p.handsPlayed < 25 ? (
            <p className="muted">Play a few hands and your statistics and coaching will appear here. Nothing is estimated until there is real data behind it.</p>
          ) : (
            <dl className="mini-stats">
              <div><dt>VPIP</dt><dd>{pct(stats.vpip.value)}</dd></div>
              <div><dt>PFR</dt><dd>{pct(stats.pfr.value)}</dd></div>
              <div><dt>3-Bet</dt><dd>{pct(stats.threeBet.value)}</dd></div>
              <div><dt>WTSD</dt><dd>{pct(stats.wtsd.value)}</dd></div>
              <div><dt>W$SD</dt><dd>{pct(stats.wsd.value)}</dd></div>
              <div><dt>C-Bet</dt><dd>{pct(stats.cbet.value)}</dd></div>
            </dl>
          )}
          {latest && (
            <div className="home-coach">
              <strong>{latest.focus}</strong>
              <p>{latest.message}</p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
