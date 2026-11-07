import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { go, routeParam, useOnline, useService } from '../../app/context';
import { type OnlineService, MIN_ONLINE_BUYIN, requestRef } from '../../online/onlineService';
import { RoomConnection } from '../../online/roomConnection';
import { ActionPanel } from '../components/Controls';
import { TableSurface } from '../components/TableSurface';
import { cx, fmt, fmtShort } from '../format';

const STAKES = [
  { sb: 5, bb: 10 },
  { sb: 10, bb: 20 },
  { sb: 25, bb: 50 },
  { sb: 50, bb: 100 },
  { sb: 100, bb: 200 },
];

const LAST_ROOM_KEY = 'obsidian-room.online-room';

function rememberRoom(id: string | null): void {
  try {
    if (id) localStorage.setItem(LAST_ROOM_KEY, id);
    else localStorage.removeItem(LAST_ROOM_KEY);
  } catch {
    // Storage may be blocked. Rejoining then uses the "Your rooms" list instead.
  }
}

function useMyRooms(online: OnlineService): { rooms: Array<{ id: string; name: string; code: string }>; reload: () => void } {
  const [rooms, setRooms] = useState<Array<{ id: string; name: string; code: string }>>([]);
  const [tick, setTick] = useState(0);
  const uid = online.session?.user.id;
  useEffect(() => {
    if (!online.client || !uid) return;
    void online.client
      .from('room_seats')
      .select('room_id, rooms(id, name, code)')
      .eq('user_id', uid)
      .then(({ data }) => {
        setRooms(((data ?? []) as Array<{ rooms: unknown }>).map((r) => (Array.isArray(r.rooms) ? r.rooms[0] : r.rooms) as { id: string; name: string; code: string }).filter(Boolean));
      });
  }, [online, uid, tick]);
  return { rooms, reload: () => setTick((t) => t + 1) };
}

function Lobby({ onEnter }: { onEnter: (roomId: string) => void }) {
  const online = useOnline();
  const balance = online.wallet?.balance ?? 0;
  const [stakeIndex, setStakeIndex] = useState(1);
  const stake = STAKES[stakeIndex];
  const minBuy = Math.max(MIN_ONLINE_BUYIN, stake.bb * 40);
  const maxBuy = stake.bb * 200;
  const [name, setName] = useState(`${online.profile?.display_name ?? 'My'}'s table`);
  const [seats, setSeats] = useState(6);
  const [timer, setTimer] = useState(30);
  const [buyIn, setBuyIn] = useState(stake.bb * 100);
  const [code, setCode] = useState(routeParam('code') ?? '');
  const [joinBuyIn, setJoinBuyIn] = useState(2000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { rooms } = useMyRooms(online);

  useEffect(() => setBuyIn(Math.min(Math.max(stake.bb * 100, minBuy), maxBuy)), [stake.bb, minBuy, maxBuy]);

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setError(null);
    try {
      onEnter(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {online.isBankrupt && (
        <div className="callout broke-callout">
          <div><strong>YOU'RE BROKE!</strong><p>You cannot cover the minimum online buy-in.</p></div>
          <button type="button" className="btn btn-gold" onClick={() => go('bankroll')}>Go to the reset</button>
        </div>
      )}
      {rooms.length > 0 && (
        <section className="panel">
          <h2>Your rooms</h2>
          <p className="muted">You still have a seat here. Rejoin to carry on, or leave to cash out.</p>
          <div className="bank-actions">
            {rooms.map((r) => <button key={r.id} type="button" className="btn btn-gold" onClick={() => onEnter(r.id)}>{r.name} · {r.code}</button>)}
          </div>
        </section>
      )}
      <div className="grid-2">
        <section className="panel">
          <h2>Join a room</h2>
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => (await online.request<{ roomId: string }>({ action: 'join_room', code: code.trim().toUpperCase(), buyIn: joinBuyIn, ref: requestRef() })).roomId); }}>
            <div className="form-row">
              <label className="field"><span className="field-label">Room code</span><input type="text" required maxLength={6} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABC123" /></label>
              <label className="field"><span className="field-label">Buy-in (online chips)</span><input type="number" required min={MIN_ONLINE_BUYIN} max={balance} value={joinBuyIn} onChange={(e) => setJoinBuyIn(Number(e.target.value))} /></label>
            </div>
            <button type="submit" className="btn btn-gold btn-block" disabled={busy || code.length !== 6}>Join with online chips</button>
          </form>
        </section>
        <section className="panel">
          <h2>Create a private room</h2>
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => (await online.request<{ roomId: string }>({ action: 'create_room', name: name.trim() || 'Private table', smallBlind: stake.sb, bigBlind: stake.bb, minBuyIn: minBuy, maxBuyIn: maxBuy, maxSeats: seats, actionSeconds: timer, buyIn, ref: requestRef() })).roomId); }}>
            <label className="field"><span className="field-label">Name</span><input type="text" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} /></label>
            <div className="choice-row" role="radiogroup" aria-label="Stakes">
              {STAKES.map((s, i) => (
                <button key={s.bb} type="button" role="radio" aria-checked={stakeIndex === i} className={cx('choice', stakeIndex === i && 'is-on')} onClick={() => setStakeIndex(i)}><b>{s.sb}/{s.bb}</b></button>
              ))}
            </div>
            <div className="form-row">
              <label className="field"><span className="field-label">Your buy-in</span><input type="number" min={minBuy} max={maxBuy} value={buyIn} onChange={(e) => setBuyIn(Number(e.target.value))} /><small>{fmt(minBuy)}-{fmt(maxBuy)}</small></label>
              <label className="field"><span className="field-label">Seats</span><input type="number" min={2} max={9} value={seats} onChange={(e) => setSeats(Number(e.target.value))} /></label>
              <label className="field"><span className="field-label">Seconds per turn</span><input type="number" min={10} max={120} value={timer} onChange={(e) => setTimer(Number(e.target.value))} /></label>
            </div>
            <button type="submit" className="btn btn-gold btn-block" disabled={busy || buyIn > balance}>Create room</button>
          </form>
        </section>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </>
  );
}

function Room({ roomId, onExit }: { roomId: string; onExit: () => void }) {
  const online = useOnline();
  const { settings } = useService();
  const conn = useMemo(() => new RoomConnection(online, roomId), [online, roomId]);
  const view = useSyncExternalStore(conn.subscribe, conn.getView);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [topUp, setTopUp] = useState(0);

  useEffect(() => {
    void conn.open().catch((e: unknown) => setNote(e instanceof Error ? e.message : String(e)));
    return () => conn.close();
  }, [conn]);

  useEffect(() => {
    if (conn.closed && !conn.room) onExit();
  });

  const appearance = useMemo(
    () => ({ theme: settings.tableTheme, cardFace: settings.cardFace, cardBack: settings.cardBack, chipStyle: settings.chipStyle, animation: settings.animationSpeed }),
    [settings.tableTheme, settings.cardFace, settings.cardBack, settings.chipStyle, settings.animationSpeed],
  );

  const room = conn.room;
  const uid = online.session?.user.id;
  const me = conn.seats.find((s) => s.user_id === uid);
  const inHand = Boolean(conn.pub?.handActive && conn.pub.startSeats.some((s) => s.userId === uid));
  const inviteLink = room ? `${window.location.origin}${window.location.pathname}#/online?code=${room.code}` : '';

  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!room || !view) return <section className="panel"><p className="muted">{conn.error ?? 'Connecting to the table…'}</p></section>;

  const myTurn = view.phase === 'hero_turn' && view.legal !== null;
  return (
    <div className="room-layout">
      <section className={cx('table-frame', 'room-frame', myTurn && 'is-hero-turn is-focused')}>
        <header className="frame-head">
          <span className="chip-badge chip-online">ONLINE CHIPS</span>
          <strong>{room.name}</strong>
          <span className="frame-blinds">{fmtShort(room.small_blind)}/{fmtShort(room.big_blind)}</span>
          <span className="frame-hand">#{view.handNumber}</span>
          {myTurn && <span className="frame-turn" role="status">YOUR TURN</span>}
        </header>
        <div className="table-area">
          <TableSurface view={view} appearance={appearance} />
        </div>
        <div className="frame-controls">
          {myTurn ? (
            <ActionPanel controller={conn} view={view} legal={view.legal!} presets={settings.betPresets} isFocused hotkeys={settings.hotkeys} />
          ) : (
            <div className="pre-panel pre-idle" role="status">
              {conn.seats.filter((s) => s.status === 'active' && s.stack > 0).length < 2
                ? 'Waiting for another player. Share the room code or invite link.'
                : view.phase === 'hand_over'
                  ? (view.lastHandSummary ?? 'Hand complete')
                  : inHand
                    ? 'Waiting for the other players…'
                    : me?.status === 'sitting_out'
                      ? 'You are sitting out.'
                      : 'You will be dealt in next hand.'}
            </div>
          )}
        </div>
        {conn.error && <div className="chat-bubble chat-system">{conn.error}</div>}
      </section>

      <aside className="room-side">
        <div className="panel">
          <h2>Room {room.code}</h2>
          <p className="muted">Blinds {fmt(room.small_blind)}/{fmt(room.big_blind)} · buy-in {fmt(room.min_buyin)}-{fmt(room.max_buyin)} · {room.action_seconds}s per turn</p>
          <button type="button" className="btn" onClick={() => void navigator.clipboard.writeText(inviteLink).then(() => setCopied(true))}>{copied ? 'Invite link copied' : 'Copy invite link'}</button>
        </div>
        <div className="panel">
          <h2>Players</h2>
          <ul className="player-list">
            {conn.seats.map((s) => (
              <li key={s.user_id}>
                <i className={cx('presence-dot', conn.connected.includes(s.user_id) && 'is-on')} title={conn.connected.includes(s.user_id) ? 'Connected' : 'Not connected'} />
                <span>{s.name}{s.user_id === uid ? ' (you)' : ''}</span>
                <em>{s.status === 'sitting_out' ? 'sitting out' : s.status === 'leaving' ? 'leaving' : fmt(s.stack)}</em>
              </li>
            ))}
          </ul>
        </div>
        {me && (
          <div className="panel">
            <h2>Your seat</h2>
            <p className="muted">Stack {fmt(me.stack)}. Wallet {fmt(online.wallet?.balance ?? 0)} online chips.</p>
            {!inHand && me.stack < room.max_buyin && (
              <div className="form-row">
                <input type="number" min={1} max={room.max_buyin - me.stack} value={topUp || ''} placeholder="Top-up" aria-label="Top-up amount" onChange={(e) => setTopUp(Number(e.target.value))} />
                <button type="button" className="btn" disabled={busy || !(topUp > 0)} onClick={() => void run(() => conn.topUp(topUp), 'Topped up.')}>Add chips</button>
              </div>
            )}
            <div className="bank-actions">
              {me.status === 'sitting_out' ? (
                <button type="button" className="btn" disabled={busy} onClick={() => void run(() => conn.setSittingOut(false))}>Sit back in</button>
              ) : (
                <button type="button" className="btn" disabled={busy || me.status === 'leaving'} onClick={() => void run(() => conn.setSittingOut(true))}>Sit out</button>
              )}
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy || me.status === 'leaving'}
                onClick={() =>
                  void run(async () => {
                    const status = await conn.leave();
                    if (status === 'left') {
                      rememberRoom(null);
                      onExit();
                    } else setNote('You will be cashed out when this hand ends.');
                  })
                }
              >
                Leave and cash out
              </button>
            </div>
          </div>
        )}
        {note && <p className="form-error" role="status">{note}</p>}
      </aside>
    </div>
  );
}

export function OnlineScreen() {
  const online = useOnline();
  const [roomId, setRoomId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_ROOM_KEY);
    } catch {
      return null;
    }
  });

  const enter = (id: string) => {
    rememberRoom(id);
    setRoomId(id);
    void online.refresh();
  };
  const exit = () => {
    rememberRoom(null);
    setRoomId(null);
    void online.refresh();
  };

  let body: React.ReactNode;
  if (online.status === 'disabled') body = <section className="panel"><p className="muted">Online play is not connected on this copy of the game yet. Offline play works as normal.</p></section>;
  else if (online.status === 'unavailable') body = <section className="panel"><p className="muted">The online server cannot be reached. Offline play still works.</p></section>;
  else if (online.status === 'loading') body = <section className="panel"><p className="muted">Connecting…</p></section>;
  else if (!online.signedIn) {
    body = (
      <section className="panel">
        <p>Sign in to play real people with your online chips. {routeParam('code') ? `You were invited to room ${routeParam('code')}.` : ''}</p>
        <button type="button" className="btn btn-gold" onClick={() => go('account')}>Sign in or create an account</button>
      </section>
    );
  } else body = roomId ? <Room key={roomId} roomId={roomId} onExit={exit} /> : <Lobby onEnter={enter} />;

  return (
    <div className="screen screen-wide">
      <header className="screen-head">
        <h1>Play Online <span className="chip-badge chip-online">ONLINE CHIPS</span></h1>
        <p>Private rooms against real players. These games use only your online chips{online.wallet ? `: ${fmt(online.wallet.balance)} available` : ''}. Offline chips are never used here.</p>
      </header>
      {body}
    </div>
  );
}
