import { useState } from 'react';
import { useOnline } from '../../app/context';
import { GITHUB_SIGN_IN } from '../../online/config';
import { Avatar } from '../components/Art';
import { cx } from '../format';

type Mode = 'sign_in' | 'register' | 'forgot';

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const result = await fn();
      if (result) setNote(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, note, run };
}

function AvatarPicker({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="avatar-grid" role="radiogroup" aria-label="Avatar">
      {Array.from({ length: 16 }, (_, i) => (
        <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`Avatar ${i + 1}`} className={cx('avatar-choice', value === i && 'is-on')} onClick={() => onChange(i)}>
          <Avatar index={i} name="" size={40} />
        </button>
      ))}
    </div>
  );
}

function SignedOut() {
  const online = useOnline();
  const [mode, setMode] = useState<Mode>('sign_in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [username, setUsername] = useState('');
  const [avatar, setAvatar] = useState(0);
  const { busy, error, note, run } = useAction();

  return (
    <section className="panel account-panel">
      <div className="seg seg-wide" role="tablist">
        <button type="button" role="tab" aria-selected={mode === 'sign_in'} className={cx(mode === 'sign_in' && 'is-on')} onClick={() => setMode('sign_in')}>Sign in</button>
        <button type="button" role="tab" aria-selected={mode === 'register'} className={cx(mode === 'register' && 'is-on')} onClick={() => setMode('register')}>Create account</button>
        <button type="button" role="tab" aria-selected={mode === 'forgot'} className={cx(mode === 'forgot' && 'is-on')} onClick={() => setMode('forgot')}>Forgot password</button>
      </div>
      <form
        className="account-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (mode === 'sign_in') void run(() => online.signIn(email.trim(), password));
          else if (mode === 'register')
            void run(async () => {
              const result = await online.register(email.trim(), password, username.trim(), avatar);
              return result === 'confirm_email' ? 'Almost there: open the confirmation email we just sent, then come back and sign in.' : undefined;
            });
          else void run(async () => {
            await online.sendPasswordReset(email.trim());
            return 'If that email has an account, a reset link is on its way. It brings you back here to choose a new password.';
          });
        }}
      >
        <label className="field">
          <span className="field-label">Email</span>
          <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {mode !== 'forgot' && (
          <label className="field">
            <span className="field-label">Password</span>
            <input type="password" autoComplete={mode === 'register' ? 'new-password' : 'current-password'} required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
            {mode === 'register' && <small>At least 8 characters. Your password is handled by Supabase Auth and never stored by this game.</small>}
          </label>
        )}
        {mode === 'register' && (
          <>
            <label className="field">
              <span className="field-label">Username</span>
              <input type="text" required pattern="[A-Za-z0-9_]{3,20}" value={username} onChange={(e) => setUsername(e.target.value)} />
              <small>3-20 letters, numbers or underscores. Other players see this.</small>
            </label>
            <div className="field">
              <span className="field-label">Avatar</span>
              <AvatarPicker value={avatar} onChange={setAvatar} />
            </div>
          </>
        )}
        <button type="submit" className="btn btn-gold btn-lg" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'sign_in' ? 'Sign in' : mode === 'register' ? 'Create account' : 'Send reset link'}
        </button>
        {GITHUB_SIGN_IN && mode !== 'forgot' && (
          <button type="button" className="btn btn-lg" disabled={busy} onClick={() => void run(() => online.signInWithGitHub())}>Continue with GitHub</button>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        {note && <p className="form-ok" role="status">{note}</p>}
      </form>
    </section>
  );
}

function NewPassword() {
  const online = useOnline();
  const [password, setPassword] = useState('');
  const { busy, error, note, run } = useAction();
  return (
    <section className="panel account-panel">
      <h2>Choose a new password</h2>
      <form className="account-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await online.setNewPassword(password); return 'Password updated.'; }); }}>
        <label className="field">
          <span className="field-label">New password</span>
          <input type="password" autoComplete="new-password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <button type="submit" className="btn btn-gold" disabled={busy}>Save password</button>
        {error && <p className="form-error" role="alert">{error}</p>}
        {note && <p className="form-ok" role="status">{note}</p>}
      </form>
    </section>
  );
}

function Profile() {
  const online = useOnline();
  const p = online.profile;
  const [displayName, setDisplayName] = useState(p?.display_name ?? '');
  const [username, setUsername] = useState(p?.username ?? '');
  const [avatar, setAvatar] = useState(p?.avatar ?? 0);
  const { busy, error, note, run } = useAction();
  if (!p) return <section className="panel"><p className="muted">Loading your profile…</p></section>;
  return (
    <section className="panel account-panel">
      <div className="profile-head">
        <Avatar index={p.avatar} name={p.display_name} size={64} />
        <div>
          <h2>{p.display_name}</h2>
          <p className="muted">@{p.username} · {online.session?.user.email}</p>
        </div>
      </div>
      <form className="account-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await online.updateProfile({ display_name: displayName.trim(), username: username.trim(), avatar }); return 'Profile saved.'; }); }}>
        <label className="field">
          <span className="field-label">Display name</span>
          <input type="text" maxLength={24} required value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label className="field">
          <span className="field-label">Username</span>
          <input type="text" required pattern="[A-Za-z0-9_]{3,20}" value={username} onChange={(e) => setUsername(e.target.value)} />
        </label>
        <div className="field">
          <span className="field-label">Avatar</span>
          <AvatarPicker value={avatar} onChange={setAvatar} />
        </div>
        <div className="bank-actions">
          <button type="submit" className="btn btn-gold" disabled={busy}>Save profile</button>
          <button type="button" className="btn" onClick={() => void run(() => online.signOut())}>Sign out</button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        {note && <p className="form-ok" role="status">{note}</p>}
      </form>
      <p className="muted foot-note">Your online chips, transactions, statistics, profile and settings follow this account to any device you sign in on.</p>
    </section>
  );
}

export function AccountScreen() {
  const online = useOnline();
  return (
    <div className="screen screen-narrow">
      <header className="screen-head">
        <h1>Account</h1>
        <p>An account is only needed for online play. Offline play against bots works without one.</p>
      </header>
      {online.status === 'disabled' && <section className="panel"><p className="muted">Online accounts are not connected on this copy of the game yet.</p></section>}
      {online.status === 'unavailable' && <section className="panel"><p className="muted">The account server cannot be reached right now. Offline play still works.</p></section>}
      {online.status === 'loading' && <section className="panel"><p className="muted">Connecting…</p></section>}
      {online.status === 'signed_out' && <SignedOut />}
      {online.status === 'signed_in' && (online.recovering ? <NewPassword /> : <Profile />)}
    </div>
  );
}
