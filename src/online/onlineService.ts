import { createClient, type RealtimeChannel, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { appUrl, onlineConfigured, SUPABASE_KEY, SUPABASE_URL } from './config';
import { type ClientRequest, SERVER_MESSAGES } from './protocol';

export type OnlineStatus = 'disabled' | 'loading' | 'signed_out' | 'signed_in' | 'unavailable';

export interface Profile {
  id: string;
  username: string;
  display_name: string;
  avatar: number;
}

export interface Wallet {
  balance: number;
  lifetime_pl: number;
  sessions_played: number;
  sessions_won: number;
  sessions_lost: number;
  hands_played: number;
  resets: number;
}

export interface OnlineLedgerRow {
  id: number;
  kind: string;
  amount: number;
  balance_after: number;
  note: string | null;
  created_at: string;
}

export interface OfflineCloud {
  balance: number;
  lifetime_pl: number;
  sessions_completed: number;
  updated_at: string;
}

/** The smallest online buy-in. Below this the player is bankrupt (mirrors the database). */
export const MIN_ONLINE_BUYIN = 400;
export const ONLINE_START = 25000;

export class OnlineError extends Error {
  constructor(readonly code: string) {
    super(SERVER_MESSAGES[code] ?? (code === 'network' ? 'Could not reach the server. Check your connection.' : 'Something went wrong on the server.'));
  }
}

const toNumber = (v: unknown): number => Number(v ?? 0);

/**
 * Everything account- and wallet-related for online play. The browser only reads
 * online balances. Every change to them goes through the server.
 */
export class OnlineService {
  status: OnlineStatus = onlineConfigured() ? 'loading' : 'disabled';
  session: Session | null = null;
  profile: Profile | null = null;
  wallet: Wallet | null = null;
  ledger: OnlineLedgerRow[] = [];
  statsCounters: Record<string, number> = {};
  offlineCloud: OfflineCloud | null = null;
  /** Set after following a password-reset link: the player must choose a new password. */
  recovering = false;
  lastError: string | null = null;

  readonly client: SupabaseClient | null;
  private listeners = new Set<() => void>();
  private version = 0;
  private walletChannel: RealtimeChannel | null = null;

  constructor() {
    this.client = onlineConfigured()
      ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' } })
      : null;
  }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getVersion = (): number => this.version;

  private bump(): void {
    this.version++;
    for (const l of this.listeners) l();
  }

  get signedIn(): boolean {
    return this.status === 'signed_in' && this.session !== null;
  }

  get isBankrupt(): boolean {
    return this.wallet !== null && this.wallet.balance < MIN_ONLINE_BUYIN;
  }

  /** Starts listening for sign-in changes. Offline play never waits on this. */
  async start(): Promise<void> {
    if (!this.client) return;
    this.client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') this.recovering = true;
      void this.applySession(session);
    });
    try {
      const { data, error } = await this.client.auth.getSession();
      if (error) throw error;
      await this.applySession(data.session);
    } catch (error) {
      console.warn('Online services unavailable', error);
      this.status = 'unavailable';
      this.bump();
    }
  }

  private async applySession(session: Session | null): Promise<void> {
    const changedUser = session?.user.id !== this.session?.user.id;
    this.session = session;
    if (!session) {
      this.status = this.status === 'unavailable' ? 'unavailable' : 'signed_out';
      this.profile = null;
      this.wallet = null;
      this.ledger = [];
      this.statsCounters = {};
      this.offlineCloud = null;
      void this.walletChannel?.unsubscribe();
      this.walletChannel = null;
      this.bump();
      return;
    }
    this.status = 'signed_in';
    this.bump();
    if (changedUser) {
      await this.refresh();
      this.watchWallet(session.user.id);
    }
  }

  /** Re-reads everything this player may see. */
  async refresh(): Promise<void> {
    const c = this.client;
    const uid = this.session?.user.id;
    if (!c || !uid) return;
    try {
      const [profile, wallet, ledger, stats, offline] = await Promise.all([
        c.from('profiles').select('id, username, display_name, avatar').eq('id', uid).single(),
        c.from('online_wallets').select('*').eq('user_id', uid).single(),
        c.from('online_ledger').select('id, kind, amount, balance_after, note, created_at').eq('user_id', uid).order('id', { ascending: false }).limit(100),
        c.from('online_stats').select('counters').eq('user_id', uid).maybeSingle(),
        c.from('offline_bankrolls').select('balance, lifetime_pl, sessions_completed, updated_at').eq('user_id', uid).maybeSingle(),
      ]);
      if (profile.error) throw profile.error;
      this.profile = profile.data as Profile;
      if (wallet.data) {
        const w = wallet.data as Record<string, unknown>;
        this.wallet = {
          balance: toNumber(w.balance),
          lifetime_pl: toNumber(w.lifetime_pl),
          sessions_played: toNumber(w.sessions_played),
          sessions_won: toNumber(w.sessions_won),
          sessions_lost: toNumber(w.sessions_lost),
          hands_played: toNumber(w.hands_played),
          resets: toNumber(w.resets),
        };
      }
      this.ledger = ((ledger.data ?? []) as OnlineLedgerRow[]).map((r) => ({ ...r, amount: toNumber(r.amount), balance_after: toNumber(r.balance_after) }));
      this.statsCounters = (stats.data?.counters as Record<string, number> | undefined) ?? {};
      this.offlineCloud = offline.data ? { ...(offline.data as OfflineCloud), balance: toNumber(offline.data.balance), lifetime_pl: toNumber(offline.data.lifetime_pl) } : null;
      this.lastError = null;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
    this.bump();
  }

  private watchWallet(uid: string): void {
    if (!this.client) return;
    void this.walletChannel?.unsubscribe();
    this.walletChannel = this.client
      .channel(`wallet-${uid}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'online_wallets', filter: `user_id=eq.${uid}` }, () => void this.refresh())
      .subscribe();
  }

  // ------------------------------------------------------------ accounts

  async usernameAvailable(username: string): Promise<boolean> {
    if (!this.client) return false;
    const { data, error } = await this.client.rpc('username_available', { p_username: username });
    if (error) throw new OnlineError('network');
    return data === true;
  }

  /** Creates an account. Supabase stores and hashes the password, never this app. */
  async register(email: string, password: string, username: string, avatar: number): Promise<'signed_in' | 'confirm_email'> {
    const c = this.requireClient();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) throw new Error('Usernames are 3-20 letters, numbers or underscores.');
    if (!(await this.usernameAvailable(username))) throw new Error('That username is taken.');
    const { data, error } = await c.auth.signUp({ email, password, options: { emailRedirectTo: appUrl(), data: { username, display_name: username, avatar } } });
    if (error) throw new Error(error.message);
    return data.session ? 'signed_in' : 'confirm_email';
  }

  async signIn(email: string, password: string): Promise<void> {
    const { error } = await this.requireClient().auth.signInWithPassword({ email, password });
    if (error) throw new Error(error.message);
  }

  async signInWithGitHub(): Promise<void> {
    const { error } = await this.requireClient().auth.signInWithOAuth({ provider: 'github', options: { redirectTo: appUrl() } });
    if (error) throw new Error(error.message);
  }

  async signOut(): Promise<void> {
    await this.requireClient().auth.signOut();
  }

  async sendPasswordReset(email: string): Promise<void> {
    const { error } = await this.requireClient().auth.resetPasswordForEmail(email, { redirectTo: appUrl() });
    if (error) throw new Error(error.message);
  }

  async setNewPassword(password: string): Promise<void> {
    const { error } = await this.requireClient().auth.updateUser({ password });
    if (error) throw new Error(error.message);
    this.recovering = false;
    this.bump();
  }

  async updateProfile(patch: Partial<Pick<Profile, 'username' | 'display_name' | 'avatar'>>): Promise<void> {
    const c = this.requireClient();
    const uid = this.session?.user.id;
    if (!uid) throw new OnlineError('not_signed_in');
    const { error } = await c.from('profiles').update(patch).eq('id', uid);
    if (error) throw new Error(/duplicate|unique/i.test(error.message) ? 'That username is taken.' : error.message);
    await this.refresh();
  }

  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    const uid = this.session?.user.id;
    if (!this.client || !uid) return;
    await this.client.from('user_settings').update({ settings, updated_at: new Date().toISOString() }).eq('user_id', uid);
  }

  async loadSettings(): Promise<Record<string, unknown> | null> {
    const uid = this.session?.user.id;
    if (!this.client || !uid) return null;
    const { data } = await this.client.from('user_settings').select('settings').eq('user_id', uid).maybeSingle();
    return (data?.settings as Record<string, unknown> | undefined) ?? null;
  }

  // ------------------------------------------------------------ online chips

  /** Asks the server for the bankruptcy reset. The server alone decides eligibility. */
  async bankruptcyReset(): Promise<void> {
    const { error } = await this.requireClient().rpc('online_bankrupt_reset');
    if (error) {
      const code = error.message.match(/not_bankrupt|not_signed_in/)?.[0];
      throw new OnlineError(code ?? 'server_error');
    }
    await this.refresh();
  }

  /** Sends one request to the trusted game server. */
  async request<T = unknown>(body: ClientRequest): Promise<T> {
    const c = this.requireClient();
    const { data, error } = await c.functions.invoke('poker', { body });
    if (error) {
      let code = 'server_error';
      const context = (error as { context?: Response }).context;
      if (context && typeof context.json === 'function') {
        try {
          const payload = (await context.json()) as { error?: string };
          if (payload.error) code = payload.error;
        } catch {
          // Not JSON: keep the generic code.
        }
      } else if (/fetch|network/i.test(error.message)) {
        code = 'network';
      }
      throw new OnlineError(code);
    }
    return data as T;
  }

  // ------------------------------------------------------------ offline mirror

  /**
   * Copies the offline bankroll summary to the account so other devices can see it.
   * Offline chips are the player's own to change, so this table is writable by them.
   */
  async uploadOffline(summary: { balance: number; lifetimePL: number; sessions: number }): Promise<void> {
    const uid = this.session?.user.id;
    if (!this.client || !uid) return;
    await this.client.from('offline_bankrolls').upsert({
      user_id: uid,
      balance: summary.balance,
      lifetime_pl: summary.lifetimePL,
      sessions_completed: summary.sessions,
      updated_at: new Date().toISOString(),
    });
  }

  private requireClient(): SupabaseClient {
    if (!this.client) throw new OnlineError('not_configured');
    return this.client;
  }
}

/** A unique id for one request, so a retried request can never be processed twice. */
export function requestRef(): string {
  return globalThis.crypto.randomUUID();
}
