import { DEFAULT_TIMING } from '../session/tableController';

export type TableTheme = 'emerald' | 'midnight' | 'crimson' | 'graphite';
export type CardBack = 'obsidian' | 'royal' | 'ember';
export type CardFace = 'classic' | 'four_color';
export type ChipStyle = 'casino' | 'neon' | 'gold';
export type AnimationSpeed = 'off' | 'fast' | 'normal' | 'slow';
export type HudDensity = 'minimal' | 'standard' | 'detailed';
export type HudStat = 'vpip' | 'pfr' | 'threeBet' | 'foldTo3Bet' | 'af' | 'wtsd' | 'wsd' | 'hands';
export type TableLayout = 'auto' | 'grid' | 'focus';

export const ALL_HUD_STATS: readonly HudStat[] = ['vpip', 'pfr', 'threeBet', 'foldTo3Bet', 'af', 'wtsd', 'wsd', 'hands'];

export interface Settings {
  version: number;
  masterMuted: boolean;
  masterVolume: number;
  sfxVolume: number;
  cardsVolume: number;
  chipsVolume: number;
  alertsVolume: number;
  musicVolume: number;
  musicEnabled: boolean;
  turnSound: boolean;
  animationSpeed: AnimationSpeed;
  botSpeed: number;
  tableTheme: TableTheme;
  cardBack: CardBack;
  cardFace: CardFace;
  chipStyle: ChipStyle;
  avatar: number;
  playerName: string;
  hudEnabled: boolean;
  hudStats: HudStat[];
  hudDensity: HudDensity;
  actionTimerSec: number;
  timeBankSec: number;
  timeBankRefillSec: number;
  timeBankRefillHands: number;
  betPresets: number[];
  layout: TableLayout;
  hotkeys: boolean;
  chatEnabled: boolean;
  coachAuto: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  masterMuted: false,
  masterVolume: 0.7,
  sfxVolume: 0.9,
  cardsVolume: 0.9,
  chipsVolume: 0.9,
  alertsVolume: 0.8,
  musicVolume: 0.25,
  musicEnabled: false,
  turnSound: true,
  animationSpeed: 'normal',
  botSpeed: 1,
  tableTheme: 'emerald',
  cardBack: 'obsidian',
  cardFace: 'four_color',
  chipStyle: 'casino',
  avatar: 0,
  playerName: 'You',
  hudEnabled: true,
  hudStats: ['vpip', 'pfr', 'threeBet', 'hands'],
  hudDensity: 'standard',
  actionTimerSec: DEFAULT_TIMING.actionTimerSec,
  timeBankSec: DEFAULT_TIMING.timeBankSec,
  timeBankRefillSec: DEFAULT_TIMING.timeBankRefillSec,
  timeBankRefillHands: DEFAULT_TIMING.timeBankRefillHands,
  betPresets: [0.5, 0.66, 0.75, 1],
  layout: 'auto',
  hotkeys: true,
  chatEnabled: true,
  coachAuto: true,
};

const STORAGE_KEY = 'obsidian-room.settings';

const inRange = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const oneOf = <T extends string>(v: unknown, options: readonly T[]): v is T => typeof v === 'string' && options.includes(v as T);

/**
 * Accepts only well-typed, in-range values and uses defaults for the rest, so a
 * corrupted or older saved blob can never break the app.
 */
export function sanitizeSettings(raw: unknown): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (typeof raw !== 'object' || raw === null) return out;
  const r = raw as Record<string, unknown>;
  const num = (key: keyof Settings, lo: number, hi: number) => {
    if (inRange(r[key], lo, hi)) (out[key] as number) = r[key] as number;
  };
  const bool = (key: keyof Settings) => {
    if (typeof r[key] === 'boolean') (out[key] as boolean) = r[key] as boolean;
  };
  num('masterVolume', 0, 1);
  num('sfxVolume', 0, 1);
  num('cardsVolume', 0, 1);
  num('chipsVolume', 0, 1);
  num('alertsVolume', 0, 1);
  num('musicVolume', 0, 1);
  num('botSpeed', 0.1, 3);
  num('avatar', 0, 15);
  num('actionTimerSec', 5, 120);
  num('timeBankSec', 0, 600);
  num('timeBankRefillSec', 0, 120);
  num('timeBankRefillHands', 0, 500);
  bool('masterMuted');
  bool('musicEnabled');
  bool('turnSound');
  bool('hudEnabled');
  bool('hotkeys');
  bool('chatEnabled');
  bool('coachAuto');
  if (oneOf(r.animationSpeed, ['off', 'fast', 'normal', 'slow'] as const)) out.animationSpeed = r.animationSpeed;
  if (oneOf(r.tableTheme, ['emerald', 'midnight', 'crimson', 'graphite'] as const)) out.tableTheme = r.tableTheme;
  if (oneOf(r.cardBack, ['obsidian', 'royal', 'ember'] as const)) out.cardBack = r.cardBack;
  if (oneOf(r.cardFace, ['classic', 'four_color'] as const)) out.cardFace = r.cardFace;
  if (oneOf(r.chipStyle, ['casino', 'neon', 'gold'] as const)) out.chipStyle = r.chipStyle;
  if (oneOf(r.hudDensity, ['minimal', 'standard', 'detailed'] as const)) out.hudDensity = r.hudDensity;
  if (oneOf(r.layout, ['auto', 'grid', 'focus'] as const)) out.layout = r.layout;
  if (typeof r.playerName === 'string' && r.playerName.trim()) out.playerName = r.playerName.trim().slice(0, 18);
  if (Array.isArray(r.hudStats)) out.hudStats = r.hudStats.filter((s): s is HudStat => oneOf(s, ALL_HUD_STATS));
  if (Array.isArray(r.betPresets)) {
    const presets = r.betPresets.filter((p): p is number => inRange(p, 0.1, 5));
    if (presets.length > 0) out.betPresets = presets.slice(0, 5);
  }
  return out;
}

export function loadSettings(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Settings {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return raw ? sanitizeSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be full or blocked. Settings still apply for this session.
  }
}

export function animationScale(speed: AnimationSpeed): number {
  switch (speed) {
    case 'off':
      return 0;
    case 'fast':
      return 0.5;
    case 'slow':
      return 1.5;
    default:
      return 1;
  }
}
