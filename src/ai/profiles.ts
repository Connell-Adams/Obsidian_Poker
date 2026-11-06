import type { Rng } from '../engine/rng';

export type Archetype =
  | 'aggressive_bluffer'
  | 'calling_station'
  | 'nit'
  | 'maniac'
  | 'tag'
  | 'lag'
  | 'abc'
  | 'tricky_reg'
  | 'recreational'
  | 'short_stack'
  | 'gto_reg'
  | 'exploitative_pro';

export const ARCHETYPES: readonly Archetype[] = [
  'aggressive_bluffer',
  'calling_station',
  'nit',
  'maniac',
  'tag',
  'lag',
  'abc',
  'tricky_reg',
  'recreational',
  'short_stack',
  'gto_reg',
  'exploitative_pro',
];

export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  aggressive_bluffer: 'Aggressive Bluffer',
  calling_station: 'Passive Calling Station',
  nit: 'Tight-Tactical Nit',
  maniac: 'Chaotic Maniac',
  tag: 'Tight-Aggressive',
  lag: 'Loose-Aggressive',
  abc: 'ABC Poker Player',
  tricky_reg: 'Tricky Regular',
  recreational: 'Recreational Player',
  short_stack: 'Short-Stack Specialist',
  gto_reg: 'GTO-Inspired Regular',
  exploitative_pro: 'Exploitative Professional',
};

/** All 1..100, generated per bot from its archetype. */
export interface BotAttributes {
  aggression: number;
  bluff: number;
  risk: number;
  patience: number;
  adaptability: number;
  tiltResistance: number;
  position: number;
  calling: number;
  deception: number;
}

export type TiltStyle = 'reckless' | 'cautious' | 'sticky' | 'bluffy';

interface ArchetypeSpec {
  attrs: BotAttributes;
  skillBias: number;
  tiltStyle: TiltStyle;
  recreational: boolean;
  /** Typical buy-in in big blinds at a cash table. */
  buyInBB: [number, number];
}

const SPECS: Record<Archetype, ArchetypeSpec> = {
  aggressive_bluffer: {
    attrs: { aggression: 80, bluff: 82, risk: 70, patience: 38, adaptability: 40, tiltResistance: 40, position: 55, calling: 38, deception: 60 },
    skillBias: 0,
    tiltStyle: 'bluffy',
    recreational: false,
    buyInBB: [80, 120],
  },
  calling_station: {
    attrs: { aggression: 18, bluff: 8, risk: 55, patience: 22, adaptability: 10, tiltResistance: 55, position: 15, calling: 92, deception: 10 },
    skillBias: -0.25,
    tiltStyle: 'sticky',
    recreational: true,
    buyInBB: [60, 120],
  },
  nit: {
    attrs: { aggression: 32, bluff: 6, risk: 14, patience: 96, adaptability: 25, tiltResistance: 65, position: 45, calling: 14, deception: 14 },
    skillBias: -0.05,
    tiltStyle: 'reckless',
    recreational: false,
    buyInBB: [80, 100],
  },
  maniac: {
    attrs: { aggression: 96, bluff: 72, risk: 96, patience: 6, adaptability: 15, tiltResistance: 20, position: 15, calling: 58, deception: 30 },
    skillBias: -0.3,
    tiltStyle: 'cautious',
    recreational: true,
    buyInBB: [60, 200],
  },
  tag: {
    attrs: { aggression: 66, bluff: 30, risk: 45, patience: 74, adaptability: 55, tiltResistance: 72, position: 82, calling: 32, deception: 40 },
    skillBias: 0.1,
    tiltStyle: 'reckless',
    recreational: false,
    buyInBB: [100, 100],
  },
  lag: {
    attrs: { aggression: 80, bluff: 52, risk: 65, patience: 40, adaptability: 60, tiltResistance: 60, position: 86, calling: 42, deception: 55 },
    skillBias: 0.1,
    tiltStyle: 'cautious',
    recreational: false,
    buyInBB: [100, 150],
  },
  abc: {
    attrs: { aggression: 46, bluff: 14, risk: 35, patience: 68, adaptability: 20, tiltResistance: 62, position: 55, calling: 44, deception: 10 },
    skillBias: 0,
    tiltStyle: 'sticky',
    recreational: false,
    buyInBB: [100, 100],
  },
  tricky_reg: {
    attrs: { aggression: 58, bluff: 46, risk: 50, patience: 58, adaptability: 65, tiltResistance: 70, position: 80, calling: 40, deception: 92 },
    skillBias: 0.15,
    tiltStyle: 'bluffy',
    recreational: false,
    buyInBB: [100, 100],
  },
  recreational: {
    attrs: { aggression: 30, bluff: 20, risk: 55, patience: 22, adaptability: 10, tiltResistance: 35, position: 15, calling: 72, deception: 14 },
    skillBias: -0.3,
    tiltStyle: 'cautious',
    recreational: true,
    buyInBB: [40, 100],
  },
  short_stack: {
    attrs: { aggression: 68, bluff: 20, risk: 60, patience: 72, adaptability: 35, tiltResistance: 60, position: 62, calling: 20, deception: 14 },
    skillBias: 0.05,
    tiltStyle: 'reckless',
    recreational: false,
    buyInBB: [25, 40],
  },
  gto_reg: {
    attrs: { aggression: 60, bluff: 38, risk: 50, patience: 62, adaptability: 45, tiltResistance: 86, position: 92, calling: 40, deception: 56 },
    skillBias: 0.25,
    tiltStyle: 'sticky',
    recreational: false,
    buyInBB: [100, 100],
  },
  exploitative_pro: {
    attrs: { aggression: 62, bluff: 40, risk: 55, patience: 60, adaptability: 96, tiltResistance: 82, position: 88, calling: 42, deception: 66 },
    skillBias: 0.25,
    tiltStyle: 'bluffy',
    recreational: false,
    buyInBB: [100, 120],
  },
};

export const archetypeSpec = (a: Archetype): ArchetypeSpec => SPECS[a];

export interface BotProfile {
  id: string;
  name: string;
  archetype: Archetype;
  attrs: BotAttributes;
  /** 0..1 decision quality derived from difficulty and archetype. */
  skill: number;
  difficulty: number;
  /** Index into the avatar set. */
  avatar: number;
  tiltStyle: TiltStyle;
  recreational: boolean;
  buyInBB: number;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

/** Skill from the 1..10 difficulty, nudged by archetype. High difficulty narrows the gap. */
export function skillFor(difficulty: number, archetype: Archetype): number {
  const d = (clamp(difficulty, 1, 10) - 1) / 9;
  return clamp(0.05 + 0.9 * d + SPECS[archetype].skillBias * (0.7 - 0.35 * d), 0.02, 1);
}

/**
 * Which archetypes appear at each difficulty. Low difficulties are dominated by
 * recreational players, high ones by thinking regulars. Everything stays possible.
 */
function archetypeWeights(difficulty: number): Record<Archetype, number> {
  const d = (clamp(difficulty, 1, 10) - 1) / 9;
  const rec = 1 - d;
  return {
    recreational: 0.4 + 3 * rec,
    calling_station: 0.3 + 2.5 * rec,
    maniac: 0.35 + 1.2 * rec,
    nit: 0.6 + 0.8 * rec,
    abc: 0.8 + 1.2 * rec * (1 - rec) * 4,
    aggressive_bluffer: 0.6 + 0.6 * d,
    short_stack: 0.5 + 0.5 * d,
    tag: 0.5 + 1.6 * d,
    lag: 0.3 + 1.4 * d,
    tricky_reg: 0.15 + 1.5 * d,
    gto_reg: 0.05 + 1.8 * d,
    exploitative_pro: 0.05 + 1.8 * d,
  };
}

export function pickArchetype(difficulty: number, rng: Rng): Archetype {
  const weights = archetypeWeights(difficulty);
  const total = ARCHETYPES.reduce((sum, a) => sum + weights[a], 0);
  let roll = rng.next() * total;
  for (const a of ARCHETYPES) {
    roll -= weights[a];
    if (roll <= 0) return a;
  }
  return 'abc';
}

const FIRST_NAMES = [
  'Mira', 'Diego', 'Anika', 'Tobias', 'Leila', 'Rowan', 'Soren', 'Yuki', 'Marek', 'Ines', 'Callum', 'Priya',
  'Nikolai', 'Amara', 'Felix', 'Saoirse', 'Mateo', 'Hana', 'Lucien', 'Thandi', 'Bram', 'Zofia', 'Kofi', 'Elin',
  'Rafael', 'Noor', 'Emeric', 'Tessa', 'Ivo', 'Marisol', 'Oskar', 'Wren', 'Dario', 'Ayumi', 'Jonah', 'Sanna',
];
const LAST_NAMES = [
  'Volkova', 'Santoro', 'Lindqvist', 'Okafor', 'Haddad', 'Marchetti', 'Takeda', 'Novak', 'Ferreira', 'Whitlock',
  'Bergstrom', 'Nair', 'Dumont', 'Kowal', 'Adeyemi', 'Rourke', 'Vargas', 'Mori', 'Castellan', 'Dlamini',
  'Vos', 'Zielinski', 'Mensah', 'Ekberg', 'Quintero', 'Rahimi', 'Lacroix', 'Hale', 'Petrov', 'Salazar',
];
const HANDLES = [
  'RiverRat', 'NightOwl', 'SlowRoll', 'IronKnuckle', 'ColdDeck', 'BluffCity', 'TiltProof', 'FeltShark', 'ChipLeader',
  'ThinValue', 'GutShot', 'DeepStack', 'MuckIt', 'SnapCall', 'RedLine', 'LuckyFold', 'SetMiner', 'OddChip',
  'TheGrinder', 'PocketRocket', 'CheckRaise', 'Dealer4', 'NoLimitNed', 'BigBlindBetty', 'AceHigh', 'ShortFuse',
];

export function generateName(rng: Rng, taken: ReadonlySet<string>): string {
  for (let tries = 0; tries < 80; tries++) {
    const name =
      rng.next() < 0.3
        ? HANDLES[rng.int(HANDLES.length)] + (rng.next() < 0.35 ? String(rng.int(99)) : '')
        : `${FIRST_NAMES[rng.int(FIRST_NAMES.length)]} ${LAST_NAMES[rng.int(LAST_NAMES.length)]}`;
    if (!taken.has(name)) return name;
  }
  return `Player ${1000 + rng.int(9000)}`;
}

/** Fictional professionals who appear on the local leaderboard and in tournaments. */
export const NAMED_PROS: ReadonlyArray<{ name: string; archetype: Archetype; avatar: number }> = [
  { name: 'Mira Volkova', archetype: 'exploitative_pro', avatar: 3 },
  { name: 'Diego Santoro', archetype: 'lag', avatar: 7 },
  { name: 'Anika Lindqvist', archetype: 'gto_reg', avatar: 1 },
  { name: 'Tobias Okafor', archetype: 'tag', avatar: 9 },
  { name: 'Leila Haddad', archetype: 'tricky_reg', avatar: 5 },
  { name: 'Rowan Whitlock', archetype: 'gto_reg', avatar: 11 },
  { name: 'Yuki Takeda', archetype: 'exploitative_pro', avatar: 2 },
  { name: 'Marek Novak', archetype: 'aggressive_bluffer', avatar: 8 },
  { name: 'Ines Ferreira', archetype: 'tag', avatar: 4 },
  { name: 'Soren Bergstrom', archetype: 'short_stack', avatar: 10 },
];

export interface BotOptions {
  id: string;
  difficulty: number;
  rng: Rng;
  archetype?: Archetype;
  name?: string;
  avatar?: number;
  takenNames?: ReadonlySet<string>;
}

/** Rolls one bot: attributes scatter around the archetype so no two feel identical. */
export function createBotProfile(options: BotOptions): BotProfile {
  const { rng, difficulty } = options;
  const archetype = options.archetype ?? pickArchetype(difficulty, rng);
  const spec = SPECS[archetype];
  const jitter = (value: number): number => {
    const spread = 14;
    const noise = (rng.next() + rng.next() - 1) * spread;
    return Math.round(clamp(value + noise, 1, 100));
  };
  const a = spec.attrs;
  const [lowBuy, highBuy] = spec.buyInBB;
  return {
    id: options.id,
    name: options.name ?? generateName(rng, options.takenNames ?? new Set()),
    archetype,
    attrs: {
      aggression: jitter(a.aggression),
      bluff: jitter(a.bluff),
      risk: jitter(a.risk),
      patience: jitter(a.patience),
      adaptability: jitter(a.adaptability),
      tiltResistance: jitter(a.tiltResistance),
      position: jitter(a.position),
      calling: jitter(a.calling),
      deception: jitter(a.deception),
    },
    skill: skillFor(difficulty, archetype),
    difficulty,
    avatar: options.avatar ?? rng.int(16),
    tiltStyle: spec.tiltStyle,
    recreational: spec.recreational,
    buyInBB: lowBuy + rng.int(highBuy - lowBuy + 1),
  };
}
