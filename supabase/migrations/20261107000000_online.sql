-- Obsidian Room: accounts, online bankrolls and private rooms.
--
-- Security model
--  * Browsers use the public (anon/publishable) key and can only READ rows that
--    Row Level Security allows. They cannot write any online chip value.
--  * Every online chip movement happens inside the SECURITY DEFINER functions
--    below, which lock the wallet row and write an audit ledger entry with a
--    unique reference. These functions can only be called with the service role,
--    which only the poker Edge Function holds.
--  * The only chip function a player may call directly is the bankruptcy reset,
--    and it checks eligibility under a row lock.
--  * Shuffled decks live in room_secrets, which no client role can read.

-- ------------------------------------------------------------------ tables

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null,
  display_name text not null,
  avatar smallint not null default 0,
  created_at timestamptz not null default now(),
  constraint username_format check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  constraint display_name_length check (char_length(btrim(display_name)) between 1 and 24),
  constraint avatar_range check (avatar between 0 and 15)
);
create unique index profiles_username_unique on public.profiles (lower(username));

create table public.user_settings (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table public.online_wallets (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  balance bigint not null check (balance >= 0),
  lifetime_pl bigint not null default 0,
  sessions_played integer not null default 0,
  sessions_won integer not null default 0,
  sessions_lost integer not null default 0,
  hands_played integer not null default 0,
  resets integer not null default 0,
  updated_at timestamptz not null default now()
);

create table public.online_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  kind text not null check (kind in ('signup', 'buyin', 'topup', 'cashout', 'bankruptcy_reset')),
  amount bigint not null,
  balance_after bigint not null check (balance_after >= 0),
  ref text not null,
  room_id uuid,
  note text,
  created_at timestamptz not null default now(),
  -- A reference can only ever be processed once per player: retries and races cannot pay twice.
  unique (user_id, ref)
);

create table public.online_stats (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  counters jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Offline data is the player's own and fully under their control, so the browser may write it.
create table public.offline_bankrolls (
  user_id uuid primary key references public.profiles (id) on delete cascade,
  balance bigint not null check (balance >= 0),
  lifetime_pl bigint not null default 0,
  sessions_completed integer not null default 0,
  updated_at timestamptz not null default now()
);

create table public.offline_ledger (
  user_id uuid not null references public.profiles (id) on delete cascade,
  entry_id text not null,
  kind text not null,
  amount bigint not null,
  balance_after bigint not null,
  note text,
  created_at timestamptz not null default now(),
  primary key (user_id, entry_id)
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{6}$'),
  host_id uuid not null references public.profiles (id),
  name text not null check (char_length(name) between 1 and 40),
  small_blind bigint not null check (small_blind > 0),
  big_blind bigint not null,
  min_buyin bigint not null,
  max_buyin bigint not null,
  max_seats smallint not null check (max_seats between 2 and 9),
  action_seconds smallint not null default 30 check (action_seconds between 10 and 120),
  status text not null default 'open' check (status in ('open', 'closed')),
  created_at timestamptz not null default now(),
  check (big_blind >= small_blind),
  check (min_buyin >= big_blind * 10 and max_buyin >= min_buyin)
);

create table public.room_seats (
  room_id uuid not null references public.rooms (id) on delete cascade,
  seat smallint not null check (seat between 0 and 8),
  user_id uuid not null references public.profiles (id),
  stack bigint not null check (stack >= 0),
  -- Chips brought to the table during this stay: the session P/L is cash-out minus this.
  invested bigint not null check (invested >= 0),
  status text not null default 'active' check (status in ('active', 'sitting_out', 'leaving')),
  missed_turns smallint not null default 0,
  hands_played integer not null default 0,
  joined_at timestamptz not null default now(),
  primary key (room_id, seat),
  unique (room_id, user_id)
);

create table public.room_state (
  room_id uuid primary key references public.rooms (id) on delete cascade,
  -- Every change bumps the version. Writes must name the version they read, so two
  -- simultaneous actions can never both apply.
  version bigint not null default 0,
  hand_no integer not null default 0,
  button_seat smallint,
  hand_active boolean not null default false,
  public jsonb not null default '{}'::jsonb,
  next_hand_at timestamptz,
  updated_at timestamptz not null default now()
);

-- The deck and full action list. No policies: only the service role can read it.
create table public.room_secrets (
  room_id uuid primary key references public.rooms (id) on delete cascade,
  hand_no integer not null default 0,
  deck smallint[],
  start_seats jsonb,
  actions jsonb not null default '[]'::jsonb
);

create table public.hand_private (
  room_id uuid not null references public.rooms (id) on delete cascade,
  hand_no integer not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  cards smallint[] not null check (array_length(cards, 1) = 2),
  primary key (room_id, hand_no, user_id)
);

create table public.online_hands (
  id bigint generated always as identity primary key,
  room_id uuid references public.rooms (id) on delete set null,
  hand_no integer not null,
  participants uuid[] not null,
  -- Unshown hole cards are removed before this is written.
  record jsonb not null,
  created_at timestamptz not null default now()
);
create index online_hands_participants on public.online_hands using gin (participants);

create table public.online_sessions (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  room_id uuid references public.rooms (id) on delete set null,
  kind text not null default 'cash' check (kind in ('cash', 'tournament')),
  buyin_total bigint not null check (buyin_total >= 0),
  cashout bigint not null check (cashout >= 0),
  pl bigint generated always as (cashout - buyin_total) stored,
  hands integer not null default 0,
  ended_at timestamptz not null default now()
);

-- Reserved for online tournaments. Online P/L counts prize minus entry.
create table public.online_tournament_results (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete cascade,
  name text not null,
  entry_total bigint not null check (entry_total >= 0),
  prize bigint not null check (prize >= 0),
  pl bigint generated always as (prize - entry_total) stored,
  place integer,
  entrants integer,
  ended_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ constants and helpers

create function public.min_online_buyin() returns bigint language sql immutable as $$ select 400::bigint $$;
create function public.starting_online_chips() returns bigint language sql immutable as $$ select 25000::bigint $$;

create function public.is_room_member(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.room_seats where room_id = p_room and user_id = auth.uid())
      or exists (select 1 from public.rooms where id = p_room and host_id = auth.uid());
$$;

create function public.username_available(p_username text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_username ~ '^[A-Za-z0-9_]{3,20}$'
     and not exists (select 1 from public.profiles where lower(username) = lower(p_username));
$$;

-- ------------------------------------------------------------------ account creation

create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  wanted text := coalesce(new.raw_user_meta_data ->> 'username', '');
  chosen text;
  display text;
  av smallint := 0;
begin
  if wanted ~ '^[A-Za-z0-9_]{3,20}$' and not exists (select 1 from profiles where lower(username) = lower(wanted)) then
    chosen := wanted;
  else
    chosen := 'player_' || substr(replace(new.id::text, '-', ''), 1, 8);
  end if;
  display := left(btrim(coalesce(nullif(new.raw_user_meta_data ->> 'display_name', ''), chosen)), 24);
  if (new.raw_user_meta_data ->> 'avatar') ~ '^[0-9]{1,2}$' then
    av := least(15, (new.raw_user_meta_data ->> 'avatar')::smallint);
  end if;

  insert into profiles (id, username, display_name, avatar) values (new.id, chosen, display, av);
  insert into user_settings (user_id) values (new.id);
  insert into online_stats (user_id) values (new.id);
  insert into online_wallets (user_id, balance) values (new.id, starting_online_chips());
  insert into online_ledger (user_id, kind, amount, balance_after, ref, note)
    values (new.id, 'signup', starting_online_chips(), starting_online_chips(), 'signup', 'Starting online chips');
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------ wallet primitive (service role only)

-- Moves online chips for one player. Locks the wallet, refuses overdrafts and
-- refuses a reference that was already used, all in the caller's transaction.
create function public.wallet_move(p_user uuid, p_kind text, p_amount bigint, p_ref text, p_room uuid, p_note text)
returns bigint
language plpgsql security definer set search_path = public as $$
declare
  current_balance bigint;
  new_balance bigint;
begin
  select balance into current_balance from online_wallets where user_id = p_user for update;
  if not found then raise exception 'no_wallet' using errcode = 'P0001'; end if;
  if exists (select 1 from online_ledger where user_id = p_user and ref = p_ref) then
    raise exception 'duplicate_request' using errcode = 'P0001';
  end if;
  new_balance := current_balance + p_amount;
  if new_balance < 0 then raise exception 'insufficient_chips' using errcode = 'P0001'; end if;
  update online_wallets set balance = new_balance, updated_at = now() where user_id = p_user;
  insert into online_ledger (user_id, kind, amount, balance_after, ref, room_id, note)
    values (p_user, p_kind, p_amount, new_balance, p_ref, p_room, p_note);
  return new_balance;
end;
$$;

-- ------------------------------------------------------------------ bankruptcy reset (player callable)

create function public.online_bankrupt_reset() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  w online_wallets%rowtype;
  seated bigint;
  delta bigint;
begin
  if uid is null then raise exception 'not_signed_in' using errcode = 'P0001'; end if;
  -- The row lock serialises simultaneous resets: the second one sees the restored balance.
  select * into w from online_wallets where user_id = uid for update;
  if not found then raise exception 'no_wallet' using errcode = 'P0001'; end if;
  select coalesce(sum(stack), 0) into seated from room_seats where user_id = uid;
  if w.balance >= min_online_buyin() or seated > 0 then
    raise exception 'not_bankrupt' using errcode = 'P0001';
  end if;
  delta := starting_online_chips() - w.balance;
  -- Recorded as a reset, not winnings: lifetime_pl is deliberately untouched.
  update online_wallets set balance = starting_online_chips(), resets = resets + 1, updated_at = now() where user_id = uid;
  insert into online_ledger (user_id, kind, amount, balance_after, ref, note)
    values (uid, 'bankruptcy_reset', delta, starting_online_chips(), 'reset:' || (w.resets + 1), 'Bankruptcy reset to 25,000');
  return jsonb_build_object('balance', starting_online_chips());
end;
$$;

-- ------------------------------------------------------------------ rooms (service role only)

create function public.room_create(p_host uuid, p_code text, p_name text, p_sb bigint, p_bb bigint, p_min bigint, p_max bigint, p_seats smallint, p_action_seconds smallint)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  new_id uuid;
begin
  if p_min < min_online_buyin() then raise exception 'buyin_too_small' using errcode = 'P0001'; end if;
  insert into rooms (code, host_id, name, small_blind, big_blind, min_buyin, max_buyin, max_seats, action_seconds)
    values (p_code, p_host, p_name, p_sb, p_bb, p_min, p_max, p_seats, p_action_seconds)
    returning id into new_id;
  insert into room_state (room_id) values (new_id);
  insert into room_secrets (room_id) values (new_id);
  return new_id;
end;
$$;

create function public.room_load(p_room uuid) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'room', (select to_jsonb(r) from rooms r where r.id = p_room),
    'state', (select to_jsonb(s) from room_state s where s.room_id = p_room),
    'secret', (select to_jsonb(x) from room_secrets x where x.room_id = p_room),
    'seats', coalesce((
      select jsonb_agg(jsonb_build_object(
        'seat', rs.seat, 'user_id', rs.user_id, 'stack', rs.stack, 'invested', rs.invested,
        'status', rs.status, 'missed_turns', rs.missed_turns, 'hands_played', rs.hands_played,
        'username', p.username, 'display_name', p.display_name, 'avatar', p.avatar) order by rs.seat)
      from room_seats rs join profiles p on p.id = rs.user_id where rs.room_id = p_room), '[]'::jsonb)
  );
$$;

create function public.room_find(p_code text) returns uuid
language sql stable security definer set search_path = public as $$
  select id from rooms where code = upper(p_code) and status = 'open';
$$;

-- True when the player holds cards in the hand currently being played.
create function public.in_active_hand(p_room uuid, p_user uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select st.hand_active from room_state st where st.room_id = p_room), false)
     and exists (
       select 1 from room_secrets x, jsonb_array_elements(coalesce(x.start_seats, '[]'::jsonb)) e
       where x.room_id = p_room and (e ->> 'id')::uuid = p_user);
$$;

create function public.room_bump(p_room uuid) returns void
language sql security definer set search_path = public as $$
  update room_state set version = version + 1, updated_at = now() where room_id = p_room;
$$;

create function public.room_join(p_room uuid, p_user uuid, p_amount bigint, p_ref text) returns smallint
language plpgsql security definer set search_path = public as $$
declare
  r rooms%rowtype;
  free_seat smallint;
begin
  -- Locking the room serialises joins, so two players can never take the same seat.
  select * into r from rooms where id = p_room for update;
  if not found or r.status <> 'open' then raise exception 'room_not_found' using errcode = 'P0001'; end if;
  if exists (select 1 from room_seats where room_id = p_room and user_id = p_user) then
    raise exception 'already_seated' using errcode = 'P0001';
  end if;
  if p_amount < r.min_buyin or p_amount > r.max_buyin then raise exception 'buyin_out_of_range' using errcode = 'P0001'; end if;
  select s into free_seat from generate_series(0, r.max_seats - 1) s
    where s not in (select seat from room_seats where room_id = p_room) order by s limit 1;
  if free_seat is null then raise exception 'room_full' using errcode = 'P0001'; end if;
  perform wallet_move(p_user, 'buyin', -p_amount, p_ref, p_room, 'Buy-in: ' || r.name);
  insert into room_seats (room_id, seat, user_id, stack, invested) values (p_room, free_seat, p_user, p_amount, p_amount);
  perform room_bump(p_room);
  return free_seat;
end;
$$;

create function public.room_topup(p_room uuid, p_user uuid, p_amount bigint, p_ref text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  r rooms%rowtype;
  s room_seats%rowtype;
begin
  select * into r from rooms where id = p_room for update;
  select * into s from room_seats where room_id = p_room and user_id = p_user for update;
  if not found then raise exception 'not_seated' using errcode = 'P0001'; end if;
  if in_active_hand(p_room, p_user) then raise exception 'in_hand' using errcode = 'P0001'; end if;
  if p_amount <= 0 or s.stack + p_amount > r.max_buyin then raise exception 'buyin_out_of_range' using errcode = 'P0001'; end if;
  perform wallet_move(p_user, 'topup', -p_amount, p_ref, p_room, 'Top-up: ' || r.name);
  update room_seats set stack = stack + p_amount, invested = invested + p_amount, status = 'active', missed_turns = 0
    where room_id = p_room and user_id = p_user;
  perform room_bump(p_room);
  return s.stack + p_amount;
end;
$$;

-- Cashes a seat out: credits the wallet, records the session and its P/L, frees the seat.
create function public.cash_out_seat(p_room uuid, p_user uuid, p_ref text) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  s room_seats%rowtype;
  r rooms%rowtype;
  pl bigint;
begin
  select * into s from room_seats where room_id = p_room and user_id = p_user for update;
  if not found then raise exception 'not_seated' using errcode = 'P0001'; end if;
  select * into r from rooms where id = p_room;
  if s.stack > 0 then perform wallet_move(p_user, 'cashout', s.stack, p_ref, p_room, 'Cash-out: ' || r.name); end if;
  pl := s.stack - s.invested;
  insert into online_sessions (user_id, room_id, buyin_total, cashout, hands) values (p_user, p_room, s.invested, s.stack, s.hands_played);
  update online_wallets set
    lifetime_pl = lifetime_pl + pl,
    sessions_played = sessions_played + 1,
    sessions_won = sessions_won + (case when pl > 0 then 1 else 0 end),
    sessions_lost = sessions_lost + (case when pl < 0 then 1 else 0 end),
    updated_at = now()
  where user_id = p_user;
  delete from room_seats where room_id = p_room and user_id = p_user;
  perform room_bump(p_room);
  return s.stack;
end;
$$;

create function public.room_leave(p_room uuid, p_user uuid, p_ref text) returns text
language plpgsql security definer set search_path = public as $$
begin
  perform 1 from rooms where id = p_room for update;
  if not exists (select 1 from room_seats where room_id = p_room and user_id = p_user) then
    raise exception 'not_seated' using errcode = 'P0001';
  end if;
  if in_active_hand(p_room, p_user) then
    -- Chips in the hand stay in play. The seat folds when its turn comes and cashes out at the end.
    update room_seats set status = 'leaving' where room_id = p_room and user_id = p_user;
    perform room_bump(p_room);
    return 'leaving';
  end if;
  perform cash_out_seat(p_room, p_user, p_ref);
  return 'left';
end;
$$;

create function public.room_set_status(p_room uuid, p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_status not in ('active', 'sitting_out') then raise exception 'bad_status' using errcode = 'P0001'; end if;
  update room_seats set status = p_status, missed_turns = 0
    where room_id = p_room and user_id = p_user and status <> 'leaving';
  if not found then raise exception 'not_seated' using errcode = 'P0001'; end if;
  perform room_bump(p_room);
end;
$$;

-- Adds one hand's statistics to a player's online totals. Biggest-pot fields keep the maximum.
create function public.stats_add(p_user uuid, p_delta jsonb) returns void
language plpgsql security definer set search_path = public as $$
declare
  current jsonb;
  k text;
  v numeric;
  existing numeric;
begin
  select counters into current from online_stats where user_id = p_user for update;
  if not found then
    insert into online_stats (user_id) values (p_user);
    current := '{}'::jsonb;
  end if;
  for k, v in select key, value::numeric from jsonb_each_text(p_delta) loop
    existing := coalesce((current ->> k)::numeric, 0);
    if k like 'biggestPot%' then
      current := jsonb_set(current, array[k], to_jsonb(greatest(existing, v)));
    else
      current := jsonb_set(current, array[k], to_jsonb(existing + v));
    end if;
  end loop;
  update online_stats set counters = current, updated_at = now() where user_id = p_user;
end;
$$;

-- The one place game progress is written. It applies only if nobody else changed the
-- room since `p_version` was read, so concurrent actions cannot both succeed. When a
-- hand ends it settles stacks, but only if the total chips are exactly conserved.
create function public.room_commit(
  p_room uuid,
  p_version bigint,
  p_public jsonb,
  p_hand_active boolean,
  p_hand_no integer,
  p_button smallint,
  p_next_hand_at timestamptz,
  p_secret jsonb,
  p_private jsonb,
  p_seat_updates jsonb,
  p_settle jsonb
) returns bigint
language plpgsql security definer set search_path = public as $$
declare
  new_version bigint;
  u jsonb;
  before_total bigint;
  after_total bigint;
  leaver record;
begin
  update room_state set
    version = version + 1,
    public = p_public,
    hand_active = p_hand_active,
    hand_no = p_hand_no,
    button_seat = p_button,
    next_hand_at = p_next_hand_at,
    updated_at = now()
  where room_id = p_room and version = p_version
  returning version into new_version;
  if new_version is null then raise exception 'version_conflict' using errcode = 'P0001'; end if;

  if p_secret is not null then
    update room_secrets set
      hand_no = coalesce((p_secret ->> 'hand_no')::integer, hand_no),
      deck = case when p_secret ? 'deck' then array(select jsonb_array_elements_text(p_secret -> 'deck')::smallint) else deck end,
      start_seats = case when p_secret ? 'start_seats' then p_secret -> 'start_seats' else start_seats end,
      actions = coalesce(p_secret -> 'actions', actions)
    where room_id = p_room;
  end if;

  if p_private is not null then
    for u in select * from jsonb_array_elements(p_private) loop
      insert into hand_private (room_id, hand_no, user_id, cards)
        values (p_room, p_hand_no, (u ->> 'user_id')::uuid, array(select jsonb_array_elements_text(u -> 'cards')::smallint));
    end loop;
  end if;

  if p_seat_updates is not null then
    for u in select * from jsonb_array_elements(p_seat_updates) loop
      update room_seats set
        missed_turns = coalesce((u ->> 'missed_turns')::smallint, missed_turns),
        status = case when status = 'leaving' then status else coalesce(u ->> 'status', status) end
      where room_id = p_room and seat = (u ->> 'seat')::smallint;
    end loop;
  end if;

  if p_settle is not null then
    -- Chips are conserved or nothing is written.
    select coalesce(sum(rs.stack), 0) into before_total from room_seats rs
      where rs.room_id = p_room and rs.seat in (select (e ->> 'seat')::smallint from jsonb_array_elements(p_settle -> 'stacks') e);
    select coalesce(sum((e ->> 'stack')::bigint), 0) into after_total from jsonb_array_elements(p_settle -> 'stacks') e;
    if before_total <> after_total then
      raise exception 'chip_conservation_failed % %', before_total, after_total using errcode = 'P0001';
    end if;
    for u in select * from jsonb_array_elements(p_settle -> 'stacks') loop
      update room_seats set stack = (u ->> 'stack')::bigint, hands_played = hands_played + 1
        where room_id = p_room and seat = (u ->> 'seat')::smallint and user_id = (u ->> 'user_id')::uuid;
      if not found then raise exception 'seat_changed_during_hand' using errcode = 'P0001'; end if;
      update online_wallets set hands_played = hands_played + 1 where user_id = (u ->> 'user_id')::uuid;
    end loop;
    insert into online_hands (room_id, hand_no, participants, record)
      values (p_room, p_hand_no, array(select (e ->> 'user_id')::uuid from jsonb_array_elements(p_settle -> 'stacks') e), p_settle -> 'record');
    for u in select * from jsonb_array_elements(coalesce(p_settle -> 'stats', '[]'::jsonb)) loop
      perform stats_add((u ->> 'user_id')::uuid, u -> 'delta');
    end loop;
    -- Players who asked to leave during the hand are cashed out now.
    for leaver in select user_id from room_seats where room_id = p_room and status = 'leaving' loop
      perform cash_out_seat(p_room, leaver.user_id, 'leave:' || p_room || ':' || p_hand_no);
    end loop;
    select version into new_version from room_state where room_id = p_room;
  end if;
  return new_version;
end;
$$;

-- ------------------------------------------------------------------ permissions

alter table public.profiles enable row level security;
alter table public.user_settings enable row level security;
alter table public.online_wallets enable row level security;
alter table public.online_ledger enable row level security;
alter table public.online_stats enable row level security;
alter table public.offline_bankrolls enable row level security;
alter table public.offline_ledger enable row level security;
alter table public.rooms enable row level security;
alter table public.room_seats enable row level security;
alter table public.room_state enable row level security;
alter table public.room_secrets enable row level security;
alter table public.hand_private enable row level security;
alter table public.online_hands enable row level security;
alter table public.online_sessions enable row level security;
alter table public.online_tournament_results enable row level security;

-- Start from nothing, then grant only what each role needs.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- Profiles are public within the game (usernames and avatars appear at tables).
grant select on public.profiles to authenticated;
grant update (username, display_name, avatar) on public.profiles to authenticated;
create policy "profiles are visible to players" on public.profiles for select to authenticated using (true);
create policy "players edit their own profile" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

grant select, update (settings, updated_at) on public.user_settings to authenticated;
create policy "own settings: read" on public.user_settings for select to authenticated using (user_id = auth.uid());
create policy "own settings: write" on public.user_settings for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Online money: read your own, never write.
grant select on public.online_wallets, public.online_ledger, public.online_stats, public.online_sessions, public.online_tournament_results to authenticated;
create policy "own wallet" on public.online_wallets for select to authenticated using (user_id = auth.uid());
create policy "own ledger" on public.online_ledger for select to authenticated using (user_id = auth.uid());
create policy "own stats" on public.online_stats for select to authenticated using (user_id = auth.uid());
create policy "own sessions" on public.online_sessions for select to authenticated using (user_id = auth.uid());
create policy "own tournament results" on public.online_tournament_results for select to authenticated using (user_id = auth.uid());

-- Offline data: fully the player's own.
grant select, insert, update, delete on public.offline_bankrolls, public.offline_ledger to authenticated;
create policy "own offline bankroll" on public.offline_bankrolls for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own offline ledger" on public.offline_ledger for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Rooms: visible to the people in them.
grant select on public.rooms, public.room_seats, public.room_state, public.hand_private, public.online_hands to authenticated;
create policy "room members see the room" on public.rooms for select to authenticated using (public.is_room_member(id));
create policy "room members see seats" on public.room_seats for select to authenticated using (public.is_room_member(room_id));
create policy "room members see the table" on public.room_state for select to authenticated using (public.is_room_member(room_id));
create policy "only your own hole cards" on public.hand_private for select to authenticated using (user_id = auth.uid());
create policy "hands you played" on public.online_hands for select to authenticated using (auth.uid() = any (participants));
-- room_secrets has no policy at all: no client can read a deck.

grant execute on function public.online_bankrupt_reset() to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
grant execute on function public.is_room_member(uuid) to authenticated;
grant execute on function public.min_online_buyin() to anon, authenticated;
grant execute on function public.starting_online_chips() to anon, authenticated;

-- Live updates for the tables and the wallet.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.room_state, public.room_seats, public.online_wallets;
  end if;
end $$;
