import { useService } from '../../app/context';
import { ACHIEVEMENTS } from '../../career/achievements';
import { buildLeaderboard } from '../../career/leaderboard';
import { Avatar } from '../components/Art';
import { cx, fmt, signed } from '../format';

export function LeaderboardScreen() {
  const service = useService();
  const { career, pros, settings } = service;
  const p = career.profile;
  const rows = buildLeaderboard(pros, {
    name: settings.playerName,
    avatar: settings.avatar,
    bankroll: career.bankroll,
    profit: career.netProfit,
    tournamentWins: p.tournamentWins,
    achievements: Object.keys(p.achievements).length,
  });
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Leaderboard</h1>
        <p className="notice">Local and simulated. The named professionals are fictional AI players, and this table lives only in this browser. It is not a global ranking.</p>
      </header>
      <section className="panel panel-flush">
        <div className="table-scroll">
          <table className="data-table leaderboard">
            <thead>
              <tr><th>Rank</th><th>Player</th><th className="num">Bankroll</th><th className="num">Total profit</th><th className="num">Tournament wins</th><th className="num">Achievements</th></tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.name} className={cx(r.isHuman && 'row-me')}>
                  <td className="rank">{i + 1}</td>
                  <td className="lb-player"><Avatar index={r.avatar} name={r.name} size={28} /> {r.name}{r.isHuman && <span className="you-tag">You</span>}</td>
                  <td className="num">{fmt(r.bankroll)}</td>
                  <td className={cx('num', r.profit > 0 ? 'pos' : r.profit < 0 ? 'neg' : '')}>{signed(r.profit)}</td>
                  <td className="num">{fmt(r.tournamentWins)}</td>
                  <td className="num">{r.isHuman ? `${r.achievements} of ${ACHIEVEMENTS.length}` : r.achievements}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <p className="muted foot-note">The pros' totals change from the tournaments they play on this device, plus a small simulated drift between your sessions.</p>
    </div>
  );
}
