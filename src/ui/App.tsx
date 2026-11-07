import { useEffect, useRef, useState } from 'react';
import { type Route, useMediaQuery, useOnline, useRoute, useService } from '../app/context';
import { ordinal } from '../app/gameService';
import { levelTitle } from '../career/achievements';
import { Logo } from './components/Art';
import { cx, duration, fmt, signed } from './format';
import { CareerScreen } from './screens/CareerScreen';
import { CoachScreen } from './screens/CoachScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { HomeScreen } from './screens/HomeScreen';
import { AccountScreen } from './screens/AccountScreen';
import { BankrollScreen } from './screens/BankrollScreen';
import { OnlineScreen } from './screens/OnlineScreen';
import { CloudSync } from './screens/CloudSync';
import { LeaderboardScreen } from './screens/LeaderboardScreen';
import { CashLobby, PlayScreen, TournamentLobby } from './screens/LobbyScreens';
import { SettingsScreen } from './screens/SettingsScreen';
import { StatsScreen } from './screens/StatsScreen';
import { TablesScreen } from './screens/TablesScreen';

const NAV: ReadonlyArray<{ route: Route; label: string; short: string; icon: string; primary?: boolean }> = [
  { route: 'home', label: 'Home', short: 'Home', icon: 'M3 11.500 12 4l9 7.500V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z', primary: true },
  { route: 'play', label: 'Play', short: 'Play', icon: 'M7 4.500v15l12-7.500z', primary: true },
  { route: 'cash', label: 'Cash Games', short: 'Cash', icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 3.500a5.500 5.500 0 1 1 0 11 5.500 5.500 0 0 1 0-11z' },
  { route: 'tournaments', label: 'Tournaments', short: 'Events', icon: 'M7 3h10v3h4v3a4 4 0 0 1-4 4h-.5A5 5 0 0 1 13 15.900V18h3v3H8v-3h3v-2.100A5 5 0 0 1 7.500 13H7a4 4 0 0 1-4-4V6h4z' },
  { route: 'tables', label: 'Multi-Table', short: 'Tables', icon: 'M3 4h8v7H3zm10 0h8v7h-8zM3 13h8v7H3zm10 0h8v7h-8z', primary: true },
  { route: 'career', label: 'Career', short: 'Career', icon: 'M12 2.500l2.900 6.100 6.600.800-4.900 4.500 1.300 6.600L12 17.200l-5.900 3.300 1.300-6.600L2.500 9.400l6.600-.800z' },
  { route: 'stats', label: 'Statistics', short: 'Stats', icon: 'M4 20V10h3.500v10zm6.200 0V4h3.500v16zm6.300 0v-7H20v7z', primary: true },
  { route: 'coach', label: 'Poker Coach', short: 'Coach', icon: 'M12 3a7 7 0 0 0-4 12.700V18a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.300A7 7 0 0 0 12 3zM9.500 21h5v1.500h-5z', primary: true },
  { route: 'history', label: 'Hand History', short: 'History', icon: 'M12 4a8 8 0 1 1-7.700 10h2.200A6 6 0 1 0 12 6a5.900 5.900 0 0 0-4.200 1.800L10 10H4V4l2.300 2.300A8 8 0 0 1 12 4zm-1 4h2v4.200l3 1.800-1 1.700-4-2.400z' },
  { route: 'leaderboard', label: 'Leaderboard', short: 'Board', icon: 'M9 10h6v11H9zM2.500 14h5v7h-5zm14 3h5v4h-5zM12 2l1.600 3.300 3.600.500-2.600 2.500.6 3.600L12 10.200 8.800 11.900l.6-3.600L6.800 5.800l3.600-.500z' },
  { route: 'online', label: 'Play Online', short: 'Online', icon: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm6.900 6h-2.950a15.700 15.700 0 0 0-1.380-3.560A8.030 8.030 0 0 1 18.900 8zM12 4.040A14 14 0 0 1 13.910 8h-3.820A14 14 0 0 1 12 4.040zM4.260 14a8.200 8.200 0 0 1 0-4h3.380a16.500 16.500 0 0 0 0 4zm.840 2h2.950a15.700 15.700 0 0 0 1.380 3.560A8 8 0 0 1 5.100 16zm2.950-8H5.100a8 8 0 0 1 4.330-3.560A15.700 15.700 0 0 0 8.050 8zM12 19.960A14 14 0 0 1 10.090 16h3.820A14 14 0 0 1 12 19.960zM14.340 14H9.660a14.700 14.700 0 0 1 0-4h4.680a14.700 14.700 0 0 1 0 4zm.250 5.560A15.700 15.700 0 0 0 15.950 16h2.950a8 8 0 0 1-4.310 3.560zM16.360 14a16.500 16.500 0 0 0 0-4h3.380a8.200 8.200 0 0 1 0 4z', primary: true },
  { route: 'bankroll', label: 'Bankroll', short: 'Chips', icon: 'M3 6h18v12H3zm2 2v8h14V8zm7 1.500a2.500 2.500 0 1 1 0 5 2.500 2.500 0 0 1 0-5z' },
  { route: 'account', label: 'Account', short: 'Account', icon: 'M12 3a4.500 4.500 0 1 1 0 9 4.500 4.500 0 0 1 0-9zm0 11c4.700 0 8 2.300 8 5v2H4v-2c0-2.700 3.300-5 8-5z' },
  { route: 'settings', label: 'Settings', short: 'Settings', icon: 'M12 8.500a3.500 3.500 0 1 0 0 7 3.500 3.500 0 0 0 0-7zm8.700 5.200-1.900.900a7 7 0 0 1-.6 1.400l.7 2-1.700 1.700-2-.7a7 7 0 0 1-1.400.6l-.9 1.900h-2.400l-.9-1.900a7 7 0 0 1-1.400-.6l-2 .7-1.700-1.700.7-2a7 7 0 0 1-.6-1.400l-1.900-.9v-2.400l1.900-.9a7 7 0 0 1 .6-1.400l-.7-2 1.700-1.700 2 .7a7 7 0 0 1 1.400-.6l.9-1.900h2.400l.9 1.900a7 7 0 0 1 1.400.6l2-.7 1.700 1.700-.7 2a7 7 0 0 1 .6 1.400l1.900.9z' },
];

function NavIcon({ path }: { path: string }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path d={path} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

function OnlineMini({ onOpen }: { onOpen: () => void }) {
  const online = useOnline();
  if (online.status === 'disabled') return null;
  return (
    <button type="button" className="bankroll-mini bankroll-mini-online" onClick={onOpen}>
      <span>Online chips</span>
      <b>{online.signedIn && online.wallet ? fmt(online.wallet.balance) : online.status === 'unavailable' ? 'offline' : 'sign in'}</b>
    </button>
  );
}

function Modal({ title, children, actions }: { title: string; children: React.ReactNode; actions: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('button')?.focus();
  }, []);
  return (
    <div className="modal-scrim" role="dialog" aria-modal="true" aria-label={title}>
      <div className="modal" ref={ref}>
        <h2>{title}</h2>
        <div className="modal-body">{children}</div>
        <div className="modal-actions">{actions}</div>
      </div>
    </div>
  );
}

export function App() {
  const service = useService();
  const [route, setRoute] = useRoute();
  const isPhone = useMediaQuery('(max-width: 820px)');
  const [navOpen, setNavOpen] = useState(false);
  const { session, career, pendingTurnCount, openSession, reentryPrompt, lastSummary, toasts } = service;
  const level = career.level;
  const [dismissedSummary, setDismissedSummary] = useState<typeof lastSummary>(null);
  const showSummary = lastSummary && lastSummary !== dismissedSummary && !session;

  const screen = (() => {
    switch (route) {
      case 'home':
        return <HomeScreen />;
      case 'play':
        return <PlayScreen />;
      case 'cash':
        return <CashLobby />;
      case 'tournaments':
        return <TournamentLobby />;
      case 'tables':
        return <TablesScreen />;
      case 'career':
        return <CareerScreen />;
      case 'stats':
        return <StatsScreen />;
      case 'coach':
        return <CoachScreen />;
      case 'history':
        return <HistoryScreen />;
      case 'leaderboard':
        return <LeaderboardScreen />;
      case 'settings':
        return <SettingsScreen />;
      case 'bankroll':
        return <BankrollScreen />;
      case 'account':
        return <AccountScreen />;
      case 'online':
        return <OnlineScreen />;
    }
  })();

  const primaryNav = NAV.filter((n) => n.primary && n.route !== 'play');

  return (
    <div className={cx('shell', route === 'tables' && 'shell-tables')}>
      {!isPhone && (
        <aside className="sidebar">
          <button type="button" className="brand" onClick={() => setRoute('home')}>
            <Logo size={26} />
            <span className="brand-text">Obsidian<br />Room</span>
          </button>
          <nav aria-label="Main">
            {NAV.map((n) => (
              <button key={n.route} type="button" className={cx('nav-item', route === n.route && 'is-current')} onClick={() => setRoute(n.route)} aria-current={route === n.route ? 'page' : undefined}>
                <NavIcon path={n.icon} />
                <span className="nav-label">{n.label}</span>
                {n.route === 'tables' && session && <span className={cx('nav-badge', pendingTurnCount > 0 && 'is-urgent')}>{pendingTurnCount > 0 ? pendingTurnCount : session.tables.filter((t) => !t.closed).length}</span>}
              </button>
            ))}
          </nav>
          <div className="sidebar-foot">
            <button type="button" className="bankroll-mini" onClick={() => setRoute('bankroll')}>
              <span>Offline chips</span>
              <b>{fmt(career.bankroll)}</b>
            </button>
            <OnlineMini onOpen={() => setRoute('bankroll')} />
            <div className="level-mini" title={`${level.xpIntoLevel} of ${level.xpForNext} XP to the next level`}>
              <span>Lv {level.level} · {levelTitle(level.level)}</span>
              <div className="xp-bar"><i style={{ width: `${(level.xpIntoLevel / level.xpForNext) * 100}%` }} /></div>
            </div>
            <small className="sim-note">Simulated chips only. No real money.</small>
          </div>
        </aside>
      )}

      <main className="main" id="main">
        {isPhone && route !== 'tables' && (
          <header className="phone-top">
            <button type="button" className="brand" onClick={() => setRoute('home')}><Logo size={22} /><span className="brand-text">Obsidian Room</span></button>
            <b className="phone-bankroll">{fmt(career.bankroll)}</b>
          </header>
        )}
        {screen}
      </main>

      {isPhone && (
        <nav className="phone-nav" aria-label="Main">
          {primaryNav.map((n) => (
            <button key={n.route} type="button" className={cx('phone-nav-item', route === n.route && 'is-current')} onClick={() => setRoute(n.route)}>
              <NavIcon path={n.icon} />
              <span>{n.short}</span>
              {n.route === 'tables' && pendingTurnCount > 0 && <i className="nav-dot">{pendingTurnCount}</i>}
            </button>
          ))}
          <button type="button" className={cx('phone-nav-item', navOpen && 'is-current')} onClick={() => setNavOpen((v) => !v)} aria-expanded={navOpen}>
            <NavIcon path="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" />
            <span>More</span>
          </button>
          {navOpen && (
            <div className="phone-more">
              {NAV.filter((n) => !n.primary).map((n) => (
                <button key={n.route} type="button" className="nav-item" onClick={() => { setRoute(n.route); setNavOpen(false); }}>
                  <NavIcon path={n.icon} />
                  <span className="nav-label">{n.label}</span>
                </button>
              ))}
            </div>
          )}
        </nav>
      )}

      {pendingTurnCount > 0 && route !== 'tables' && (
        <button type="button" className="turn-alert" onClick={() => setRoute('tables')}>
          Your turn on {pendingTurnCount} table{pendingTurnCount > 1 ? 's' : ''}: go to tables
        </button>
      )}

      <div className="toasts" aria-live="polite">
        {(route === 'tables' ? toasts.slice(-1) : toasts).map((t) => (
          <div key={t.id} className={cx('toast', `toast-${t.kind}`)}>
            <div>
              <strong>{t.title}</strong>
              {t.body && <p>{t.body}</p>}
            </div>
            <button type="button" aria-label="Dismiss" onClick={() => service.dismissToast(t.id)}>×</button>
          </div>
        ))}
      </div>

      <CloudSync />

      {openSession && (
        <Modal
          title="Unfinished session found"
          actions={
            <>
              <button type="button" className="btn btn-gold" onClick={() => { service.resumeOpenSession(); setRoute('tables'); }}>Resume playing</button>
              <button type="button" className="btn" onClick={() => service.abandonOpenSession()}>{openSession.kind === 'cash' ? 'Cash out' : 'Forfeit'}</button>
            </>
          }
        >
          <p>
            <strong>{openSession.title}</strong> was still running when this page closed.
            {openSession.kind === 'cash'
              ? ` Your chips are safe at their value after the last completed hand: ${fmt(openSession.tables.reduce((sum, t) => sum + (t.seats.find((s) => s.isHuman)?.stack ?? 0), 0))} chips.`
              : ' You can return to your seat, with stacks as they were after the last completed hand.'}
          </p>
          <p className="muted">A hand that was interrupted partway is void: nobody wins or loses those chips.</p>
        </Modal>
      )}

      {reentryPrompt && (
        <Modal
          title="You are out of chips"
          actions={
            <>
              <button type="button" className="btn btn-gold" onClick={() => reentryPrompt.resolve(true)}>Re-enter for {fmt(reentryPrompt.fee)}</button>
              <button type="button" className="btn" onClick={() => reentryPrompt.resolve(false)}>No thanks</button>
            </>
          }
        >
          <p>Re-entry is still open. Buy back in with a full starting stack? This offer closes in 30 seconds.</p>
        </Modal>
      )}

      {showSummary && lastSummary && (
        <Modal
          title={lastSummary.kind === 'cash' ? 'Session complete' : 'Tournament complete'}
          actions={<button type="button" className="btn btn-gold" onClick={() => setDismissedSummary(lastSummary)}>Close</button>}
        >
          <p className="summary-title">{lastSummary.title}</p>
          <div className={cx('summary-net', lastSummary.net > 0 ? 'pos' : lastSummary.net < 0 ? 'neg' : '')}>{signed(lastSummary.net)}</div>
          <dl className="summary-grid">
            <div><dt>Hands</dt><dd>{fmt(lastSummary.hands)}</dd></div>
            <div><dt>Time</dt><dd>{duration(lastSummary.durationMs)}</dd></div>
            <div><dt>Biggest pot</dt><dd>{fmt(lastSummary.biggestPot)}</dd></div>
          </dl>
          <p className="muted">{lastSummary.detail}</p>
          {service.lastTournamentResult && lastSummary.kind === 'tournament' && (
            <p className="muted">
              Champion: <strong>{service.lastTournamentResult.status.championName ?? 'to be decided'}</strong>
              {service.lastTournamentResult.status.heroPlace ? `. You finished ${ordinal(service.lastTournamentResult.status.heroPlace)}.` : ''}
            </p>
          )}
        </Modal>
      )}
    </div>
  );
}
