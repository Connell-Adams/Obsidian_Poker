import { useEffect, useState } from 'react';
import { go, useOnline, useService } from '../../app/context';
import { DEFAULT_STARTING_BANKROLL, type LedgerEntry } from '../../career/career';
import { MIN_ONLINE_BUYIN, ONLINE_START } from '../../online/onlineService';
import { cx, dateTime, fmt, signed } from '../format';

const PRESETS = [1_000, 10_000, 100_000, 1_000_000];

const ONLINE_KIND_LABEL: Record<string, string> = {
  signup: 'Starting chips',
  buyin: 'Buy-in',
  topup: 'Top-up',
  cashout: 'Cash-out',
  bankruptcy_reset: 'Bankruptcy reset',
};

function OnlineCard() {
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (online.status === 'disabled') {
    return (
      <section className="bank-card bank-online">
        <header><span className="chip-badge chip-online">ONLINE</span><h2>Online chips</h2></header>
        <p className="muted">Online play is not connected on this copy of the game yet. Offline play works as normal.</p>
      </section>
    );
  }
  if (online.status === 'unavailable') {
    return (
      <section className="bank-card bank-online">
        <header><span className="chip-badge chip-online">ONLINE</span><h2>Online chips</h2></header>
        <p className="muted">The online server cannot be reached right now. Your online chips are safe on the server. Offline play still works.</p>
      </section>
    );
  }
  if (!online.signedIn || !online.wallet) {
    return (
      <section className="bank-card bank-online">
        <header><span className="chip-badge chip-online">ONLINE</span><h2>Online chips</h2></header>
        <p className="muted">Online chips belong to your account and are stored on the server. They are won and lost only against real players.</p>
        <button type="button" className="btn btn-gold" onClick={() => go('account')}>{online.status === 'loading' ? 'Connecting…' : 'Sign in or create an account'}</button>
      </section>
    );
  }

  const w = online.wallet;
  const reset = async () => {
    setBusy(true);
    setError(null);
    try {
      await online.bankruptcyReset();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bank-card bank-online">
      <header><span className="chip-badge chip-online">ONLINE</span><h2>Online chips</h2></header>
      <div className="bank-balance">{fmt(w.balance)}</div>
      <p className="muted">Stored on the server for <b>{online.profile?.username}</b>. You can only win or lose them against real players.</p>
      <dl className="bank-stats">
        <div><dt>Lifetime P/L</dt><dd className={w.lifetime_pl > 0 ? 'pos' : w.lifetime_pl < 0 ? 'neg' : ''}>{signed(w.lifetime_pl)}</dd></div>
        <div><dt>Sessions played</dt><dd>{fmt(w.sessions_played)}</dd></div>
        <div><dt>Won / lost</dt><dd>{fmt(w.sessions_won)} / {fmt(w.sessions_lost)}</dd></div>
        <div><dt>Hands played</dt><dd>{fmt(w.hands_played)}</dd></div>
      </dl>
      {online.isBankrupt && (
        <div className="broke" role="alert">
          <strong>YOU'RE BROKE!</strong>
          <p>You cannot cover the {fmt(MIN_ONLINE_BUYIN)}-chip minimum buy-in. A reset restores exactly {fmt(ONLINE_START)} chips. It is free, it is recorded, and it does not count as winnings.</p>
          <button type="button" className="btn btn-gold btn-lg" disabled={busy} onClick={() => void reset()}>RESET TO 25,000 CHIPS</button>
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="bank-actions">
        <button type="button" className="btn btn-gold" onClick={() => go('online')}>Play online</button>
      </div>
      <h3>Online transactions</h3>
      <ul className="ledger-list">
        {online.ledger.slice(0, 30).map((e) => (
          <li key={e.id}>
            <span>{ONLINE_KIND_LABEL[e.kind] ?? e.kind}{e.note && e.kind !== 'signup' ? <small>{e.note}</small> : null}</span>
            <time>{dateTime(Date.parse(e.created_at))}</time>
            <b className={e.amount > 0 ? 'pos' : 'neg'}>{signed(e.amount)}</b>
          </li>
        ))}
      </ul>
      <p className="muted foot-note">Lifetime P/L counts completed sessions only: cash-out minus buy-ins. Resets never count.</p>
    </section>
  );
}

const OFFLINE_KIND_LABEL: Record<string, string> = {
  start: 'Starting chips',
  cash_buyin: 'Buy-in',
  cash_topup: 'Top-up',
  cash_cashout: 'Cash-out',
  tournament_fee: 'Tournament entry',
  tournament_prize: 'Tournament prize',
  tournament_refund: 'Entry refund',
  recovery: 'Recovered session',
  reload: 'Reload (older version)',
  offline_add: 'Chips added',
  offline_remove: 'Chips removed',
  offline_reset: 'Bankroll reset',
};

function OfflineCard() {
  const service = useService();
  const online = useOnline();
  const { career } = service;
  const p = career.profile;
  const [custom, setCustom] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);

  useEffect(() => {
    void career.flush().then(() => career.ledger()).then((rows) => setLedger(rows.reverse().slice(0, 30)));
  }, [career, p.bankroll]);

  const run = (result: { ok: boolean; error?: string }, done: string) => {
    setMessage(result.ok ? { ok: true, text: done } : { ok: false, text: result.error ?? 'That did not work.' });
  };
  const amount = Number(custom.replace(/[,\s]/g, ''));
  const cloud = online.signedIn ? online.offlineCloud : null;

  return (
    <section className="bank-card bank-offline">
      <header><span className="chip-badge chip-offline">OFFLINE</span><h2>Offline chips</h2></header>
      <div className="bank-balance">{fmt(career.bankroll)}</div>
      <p className="muted">For games against bots, stored on this device. Change it however you like: it never touches online chips.</p>
      <dl className="bank-stats">
        <div><dt>Lifetime P/L</dt><dd className={career.netProfit > 0 ? 'pos' : career.netProfit < 0 ? 'neg' : ''}>{signed(career.netProfit)}</dd></div>
        <div><dt>Sessions completed</dt><dd>{fmt(p.sessionsCompleted)}</dd></div>
        <div><dt>Won / lost</dt><dd>{fmt(p.sessionsWon)} / {fmt(p.sessionsLost)}</dd></div>
        <div><dt>Added / removed</dt><dd>{fmt(p.chipsAdded)} / {fmt(p.chipsRemoved)}</dd></div>
      </dl>

      <div className="offline-controls">
        <div className="preset-chips" role="group" aria-label="Add a preset amount">
          {PRESETS.map((n) => (
            <button key={n} type="button" className="btn" onClick={() => run(service.addOfflineChips(n), `Added ${fmt(n)} chips.`)}>+{fmt(n)}</button>
          ))}
        </div>
        <label className="field">
          <span className="field-label">Custom amount</span>
          <input type="text" inputMode="numeric" value={custom} placeholder="e.g. 50000" onChange={(e) => setCustom(e.target.value)} />
        </label>
        <div className="bank-actions">
          <button type="button" className="btn btn-gold" disabled={!(amount > 0)} onClick={() => run(service.addOfflineChips(amount), `Added ${fmt(amount)} chips.`)}>ADD OFFLINE CHIPS</button>
          <button type="button" className="btn" disabled={!(amount > 0)} onClick={() => run(service.removeOfflineChips(amount), `Removed ${fmt(amount)} chips.`)}>REMOVE OFFLINE CHIPS</button>
        </div>
        {confirmReset ? (
          <div className="bank-actions">
            <span className="muted">Set your offline bankroll to {fmt(DEFAULT_STARTING_BANKROLL)}? Your P/L is kept.</span>
            <button type="button" className="btn btn-danger" onClick={() => { run(service.resetOfflineBankroll(), 'Offline bankroll reset.'); setConfirmReset(false); }}>Reset</button>
            <button type="button" className="btn" onClick={() => setConfirmReset(false)}>Cancel</button>
          </div>
        ) : (
          <button type="button" className="btn" onClick={() => setConfirmReset(true)}>RESET OFFLINE BANKROLL</button>
        )}
        {message && <p className={message.ok ? 'form-ok' : 'form-error'} role="status">{message.text}</p>}
      </div>

      {cloud && cloud.balance !== career.bankroll && (
        <div className="callout">
          <div>
            <strong>Offline chips from another device</strong>
            <p>Your account last saved {fmt(cloud.balance)} offline chips ({dateTime(Date.parse(cloud.updated_at))}). Use that balance on this device? It is recorded as an adjustment, never as profit.</p>
          </div>
          <button
            type="button"
            className="btn"
            onClick={() => {
              const diff = cloud.balance - career.bankroll;
              run(diff > 0 ? service.addOfflineChips(diff) : service.removeOfflineChips(-diff), `Offline bankroll set to ${fmt(cloud.balance)}.`);
            }}
          >
            Use {fmt(cloud.balance)}
          </button>
        </div>
      )}

      <h3>Offline transactions</h3>
      <ul className="ledger-list">
        {ledger.map((e) => (
          <li key={e.id}>
            <span>{OFFLINE_KIND_LABEL[e.kind] ?? e.kind}<small>{e.note}</small></span>
            <time>{dateTime(e.ts)}</time>
            <b className={e.amount > 0 ? 'pos' : e.amount < 0 ? 'neg' : ''}>{signed(e.amount)}</b>
          </li>
        ))}
      </ul>
      <p className="muted foot-note">Lifetime P/L counts completed sessions only: cash-out minus buy-ins, or prize minus entries. Adding, removing and resetting chips never count.</p>
    </section>
  );
}

export function BankrollScreen() {
  return (
    <div className="screen">
      <header className="screen-head">
        <h1>Bankroll</h1>
        <p>Two completely separate balances. Online chips play real people. Offline chips play bots.</p>
      </header>
      <div className={cx('bank-grid')}>
        <OnlineCard />
        <OfflineCard />
      </div>
    </div>
  );
}
