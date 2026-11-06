import { useState } from 'react';
import { useService } from '../../app/context';
import type { EffectKind } from '../../session/tableController';
import { ALL_HUD_STATS, type AnimationSpeed, type CardBack, type ChipStyle, type HudDensity, type HudStat, type Settings, type TableLayout, type TableTheme } from '../../persistence/settings';
import { Avatar, ChipStack, PlayingCard } from '../components/Art';
import { cx } from '../format';

function Slider({ label, value, onChange, preview }: { label: string; value: number; onChange: (v: number) => void; preview?: () => void }) {
  return (
    <label className="setting-row">
      <span>{label}</span>
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} onPointerUp={preview} />
      <b>{Math.round(value * 100)}%</b>
    </label>
  );
}

function Toggle({ label, value, onChange, hint }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="setting-row toggle-row">
      <span>{label}{hint && <small>{hint}</small>}</span>
      <input type="checkbox" role="switch" checked={value} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: ReadonlyArray<[T, string]>; onChange: (v: T) => void }) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <div className="seg" role="radiogroup" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={v} type="button" role="radio" aria-checked={value === v} className={cx(value === v && 'is-on')} onClick={() => onChange(v)}>{text}</button>
        ))}
      </div>
    </div>
  );
}

const HUD_LABELS: Record<HudStat, string> = { vpip: 'VPIP', pfr: 'PFR', threeBet: '3-Bet', foldTo3Bet: 'Fold to 3-Bet', af: 'Aggression', wtsd: 'WTSD', wsd: 'W$SD', hands: 'Hands' };
const PRESET_OPTIONS = [0.33, 0.5, 0.66, 0.75, 1, 1.5, 2];

export function SettingsScreen() {
  const service = useService();
  const s = service.settings;
  const set = (patch: Partial<Settings>) => service.updateSettings(patch);
  const [confirmReset, setConfirmReset] = useState(false);
  const preview = (kind: EffectKind) => () => service.audio.preview(kind);

  return (
    <div className="screen settings">
      <header className="screen-head">
        <h1>Settings</h1>
        <p>Changes apply immediately, including at running tables.</p>
      </header>
      <div className="grid-2">
        <section className="panel">
          <h2>Player</h2>
          <label className="field">
            <span className="field-label">Display name</span>
            <input type="text" maxLength={18} value={s.playerName} onChange={(e) => set({ playerName: e.target.value })} onBlur={(e) => { if (!e.target.value.trim()) set({ playerName: 'You' }); }} />
          </label>
          <div className="field">
            <span className="field-label">Avatar</span>
            <div className="avatar-grid" role="radiogroup" aria-label="Avatar">
              {Array.from({ length: 16 }, (_, i) => (
                <button key={i} type="button" role="radio" aria-checked={s.avatar === i} aria-label={`Avatar ${i + 1}`} className={cx('avatar-choice', s.avatar === i && 'is-on')} onClick={() => set({ avatar: i })}>
                  <Avatar index={i} name="" size={40} />
                </button>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <h2>Table appearance</h2>
          <Choice<TableTheme> label="Felt" value={s.tableTheme} options={[['emerald', 'Emerald'], ['midnight', 'Midnight'], ['crimson', 'Crimson'], ['graphite', 'Graphite']]} onChange={(v) => set({ tableTheme: v })} />
          <Choice label="Card faces" value={s.cardFace} options={[['four_color', 'Four-colour'], ['classic', 'Classic']]} onChange={(v) => set({ cardFace: v })} />
          <Choice<CardBack> label="Card backs" value={s.cardBack} options={[['obsidian', 'Obsidian'], ['royal', 'Royal'], ['ember', 'Ember']]} onChange={(v) => set({ cardBack: v })} />
          <Choice<ChipStyle> label="Chips" value={s.chipStyle} options={[['casino', 'Casino'], ['neon', 'Neon'], ['gold', 'Gold']]} onChange={(v) => set({ chipStyle: v })} />
          <div className="appearance-preview" aria-hidden="true">
            <PlayingCard card={51} face={s.cardFace} />
            <PlayingCard card={46} face={s.cardFace} />
            <PlayingCard card={37} face={s.cardFace} />
            <PlayingCard card={24} face={s.cardFace} />
            <PlayingCard card={null} back={s.cardBack} />
            <ChipStack amount={3125} chipStyle={s.chipStyle} />
          </div>
          <Choice<AnimationSpeed> label="Animation" value={s.animationSpeed} options={[['off', 'Off'], ['fast', 'Fast'], ['normal', 'Normal'], ['slow', 'Slow']]} onChange={(v) => set({ animationSpeed: v })} />
          <label className="setting-row">
            <span>Opponent speed</span>
            <input type="range" min={0.2} max={2} step={0.1} value={s.botSpeed} onChange={(e) => set({ botSpeed: Number(e.target.value) })} />
            <b>{s.botSpeed.toFixed(1)}x thinking time</b>
          </label>
          <Choice<TableLayout> label="Table layout" value={s.layout} options={[['auto', 'Automatic'], ['grid', 'All tables'], ['focus', 'One at a time']]} onChange={(v) => set({ layout: v })} />
        </section>

        <section className="panel">
          <h2>Sound</h2>
          <Toggle label="Mute everything" value={s.masterMuted} onChange={(v) => set({ masterMuted: v })} />
          <Slider label="Master" value={s.masterVolume} onChange={(v) => set({ masterVolume: v })} preview={preview('raise')} />
          <Slider label="Sound effects" value={s.sfxVolume} onChange={(v) => set({ sfxVolume: v })} preview={preview('call')} />
          <Slider label="Cards" value={s.cardsVolume} onChange={(v) => set({ cardsVolume: v })} preview={preview('deal')} />
          <Slider label="Chips" value={s.chipsVolume} onChange={(v) => set({ chipsVolume: v })} preview={preview('bet')} />
          <Slider label="Alerts" value={s.alertsVolume} onChange={(v) => set({ alertsVolume: v })} preview={preview('your_turn')} />
          <Toggle label="Background music" value={s.musicEnabled} onChange={(v) => { service.audio.unlock(); set({ musicEnabled: v }); }} hint="A quiet generated ambience" />
          <Slider label="Music" value={s.musicVolume} onChange={(v) => set({ musicVolume: v })} />
          <Toggle label="Your-turn sound" value={s.turnSound} onChange={(v) => set({ turnSound: v })} />
          <div className="sound-test">
            {(['deal', 'check', 'fold', 'allin', 'showdown', 'victory', 'elimination', 'timer_warning'] as EffectKind[]).map((k) => (
              <button key={k} type="button" className="mini-btn" onClick={preview(k)}>{k.replace('_', ' ')}</button>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>HUD</h2>
          <Toggle label="Show HUD" value={s.hudEnabled} onChange={(v) => set({ hudEnabled: v })} hint="Statistics come only from hands you have observed" />
          <Choice<HudDensity> label="Density" value={s.hudDensity} options={[['minimal', 'Minimal'], ['standard', 'Standard'], ['detailed', 'Detailed']]} onChange={(v) => set({ hudDensity: v })} />
          <div className="field">
            <span className="field-label">Displayed statistics</span>
            <div className="check-grid">
              {ALL_HUD_STATS.map((stat) => (
                <label key={stat} className="check">
                  <input
                    type="checkbox"
                    checked={s.hudStats.includes(stat)}
                    onChange={(e) => set({ hudStats: e.target.checked ? [...s.hudStats, stat] : s.hudStats.filter((x) => x !== stat) })}
                  />
                  {HUD_LABELS[stat]}
                </label>
              ))}
            </div>
          </div>
          <h2 className="h2-gap">Timing and controls</h2>
          <label className="setting-row">
            <span>Action timer</span>
            <input type="range" min={5} max={60} step={1} value={s.actionTimerSec} onChange={(e) => set({ actionTimerSec: Number(e.target.value) })} />
            <b>{s.actionTimerSec}s</b>
          </label>
          <label className="setting-row">
            <span>Time bank</span>
            <input type="range" min={0} max={180} step={5} value={s.timeBankSec} onChange={(e) => set({ timeBankSec: Number(e.target.value) })} />
            <b>{s.timeBankSec}s</b>
          </label>
          <label className="setting-row">
            <span>Time bank refill</span>
            <input type="range" min={0} max={20} step={1} value={s.timeBankRefillSec} onChange={(e) => set({ timeBankRefillSec: Number(e.target.value) })} />
            <b>{s.timeBankRefillSec}s every {s.timeBankRefillHands} hands</b>
          </label>
          <Toggle label="Keyboard shortcuts" value={s.hotkeys} onChange={(v) => set({ hotkeys: v })} hint="F fold, C check or call, R bet or raise, Shift+A all-in, T time bank. They only act on the highlighted table." />
          <Toggle label="Table chat" value={s.chatEnabled} onChange={(v) => set({ chatEnabled: v })} />
          <Toggle label="Coach pop-ups" value={s.coachAuto} onChange={(v) => set({ coachAuto: v })} />
          <div className="field">
            <span className="field-label">Bet size buttons (share of the pot)</span>
            <div className="check-grid">
              {PRESET_OPTIONS.map((p) => (
                <label key={p} className="check">
                  <input
                    type="checkbox"
                    checked={s.betPresets.includes(p)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...s.betPresets, p].sort((a, b) => a - b) : s.betPresets.filter((x) => x !== p);
                      if (next.length > 0) set({ betPresets: next });
                    }}
                  />
                  {Math.round(p * 100)}%
                </label>
              ))}
            </div>
          </div>
        </section>

        <section className="panel danger-panel">
          <h2>Start over</h2>
          <p className="muted">This erases your bankroll, hands, statistics, trophies and achievements in this browser. It cannot be undone.</p>
          {service.session ? (
            <p className="muted">Finish your current session first.</p>
          ) : confirmReset ? (
            <div className="hero-actions">
              <button type="button" className="btn btn-danger" onClick={() => void service.resetCareer().then(() => setConfirmReset(false))}>Yes, erase my career</button>
              <button type="button" className="btn" onClick={() => setConfirmReset(false)}>Keep it</button>
            </div>
          ) : (
            <button type="button" className="btn" onClick={() => setConfirmReset(true)}>Reset career</button>
          )}
        </section>
      </div>
    </div>
  );
}
