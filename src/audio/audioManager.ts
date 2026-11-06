import type { EffectKind, TableEffect } from '../session/tableController';

export interface AudioLevels {
  masterMuted: boolean;
  masterVolume: number;
  sfxVolume: number;
  cardsVolume: number;
  chipsVolume: number;
  alertsVolume: number;
  musicVolume: number;
  musicEnabled: boolean;
  turnSound: boolean;
}

type Channel = 'cards' | 'chips' | 'alerts';

/**
 * All sound is synthesised, so the app ships no audio files and needs no licences.
 * The AudioContext is only created on the first user gesture, as browsers require.
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private channels = new Map<Channel, GainNode>();
  private musicGain: GainNode | null = null;
  private musicNodes: Array<OscillatorNode | AudioBufferSourceNode> = [];
  private noiseBuffer: AudioBuffer | null = null;
  private levels: AudioLevels;
  private lastPlayed = new Map<string, number>();

  constructor(levels: AudioLevels) {
    this.levels = levels;
  }

  /** Call from a user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (typeof window === 'undefined') return;
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.ctx = new Ctor();
    this.master = this.ctx.createGain();
    const compressor = this.ctx.createDynamicsCompressor();
    this.master.connect(compressor).connect(this.ctx.destination);
    for (const name of ['cards', 'chips', 'alerts'] as const) {
      const gain = this.ctx.createGain();
      gain.connect(this.master);
      this.channels.set(name, gain);
    }
    this.musicGain = this.ctx.createGain();
    this.musicGain.connect(this.master);
    const length = this.ctx.sampleRate;
    this.noiseBuffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.applyLevels();
    this.syncMusic();
  }

  setLevels(levels: AudioLevels): void {
    this.levels = levels;
    this.applyLevels();
    this.syncMusic();
  }

  private applyLevels(): void {
    if (!this.ctx || !this.master) return;
    const l = this.levels;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(l.masterMuted ? 0 : l.masterVolume, t, 0.02);
    this.channels.get('cards')?.gain.setTargetAtTime(l.sfxVolume * l.cardsVolume, t, 0.02);
    this.channels.get('chips')?.gain.setTargetAtTime(l.sfxVolume * l.chipsVolume, t, 0.02);
    this.channels.get('alerts')?.gain.setTargetAtTime(l.sfxVolume * l.alertsVolume, t, 0.02);
    this.musicGain?.gain.setTargetAtTime(l.musicEnabled ? l.musicVolume * 0.3 : 0, t, 0.3);
  }

  private noiseBurst(channel: Channel, when: number, duration: number, freq: number, q: number, peak: number, type: BiquadFilterType = 'bandpass'): void {
    if (!this.ctx || !this.noiseBuffer) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.loopStart = Math.random() * 0.5;
    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + Math.min(0.006, duration / 3));
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    src.connect(filter).connect(gain).connect(this.channels.get(channel)!);
    src.start(when, Math.random() * 0.5, duration + 0.02);
  }

  private tone(channel: Channel, when: number, duration: number, freq: number, peak: number, type: OscillatorType = 'sine', endFreq?: number): void {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, when);
    if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, when + duration);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + duration);
    osc.connect(gain).connect(this.channels.get(channel)!);
    osc.start(when);
    osc.stop(when + duration + 0.02);
  }

  /** One chip hitting another: a short ceramic click with a bright resonance. */
  private chipClick(when: number, peak: number): void {
    const pitch = 2600 + Math.random() * 2200;
    this.noiseBurst('chips', when, 0.035, pitch, 9, peak);
    this.tone('chips', when, 0.03, pitch * 1.35, peak * 0.3, 'triangle');
  }

  /** The number of clicks grows with the size of the bet relative to the blinds. */
  private chips(chips: number, bigBlind: number, spread = 0.035): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const bbs = chips / Math.max(1, bigBlind);
    const count = Math.max(2, Math.min(14, Math.round(2 + Math.log2(1 + bbs) * 1.6)));
    const loud = Math.min(0.55, 0.22 + Math.log2(1 + bbs) * 0.035);
    for (let i = 0; i < count; i++) this.chipClick(t + i * spread * (0.7 + Math.random() * 0.6), loud * (0.75 + Math.random() * 0.25));
  }

  /** Avoid machine-gunning when four tables fire the same sound at once. */
  private throttled(key: string, ms: number): boolean {
    if (!this.ctx) return true;
    const now = this.ctx.currentTime * 1000;
    if (now - (this.lastPlayed.get(key) ?? -Infinity) < ms) return true;
    this.lastPlayed.set(key, now);
    return false;
  }

  play(effect: TableEffect): void {
    if (!this.ctx || this.ctx.state !== 'running' || this.levels.masterMuted) return;
    const t = this.ctx.currentTime;
    const { kind, chips, bigBlind } = effect;
    switch (kind as EffectKind) {
      case 'deal':
        if (this.throttled('deal', 40)) return;
        this.noiseBurst('cards', t, 0.075, 3200, 1.2, 0.3);
        break;
      case 'burn':
        this.noiseBurst('cards', t, 0.09, 2200, 1, 0.16);
        break;
      case 'board':
        this.noiseBurst('cards', t, 0.11, 2800, 1.1, 0.34);
        this.noiseBurst('cards', t + 0.09, 0.05, 1200, 1, 0.14);
        break;
      case 'check':
        // Two knuckle raps on the felt.
        this.tone('cards', t, 0.07, 170, 0.5, 'sine', 90);
        this.noiseBurst('cards', t, 0.03, 900, 1, 0.22, 'lowpass');
        this.tone('cards', t + 0.12, 0.07, 160, 0.42, 'sine', 85);
        this.noiseBurst('cards', t + 0.12, 0.03, 900, 1, 0.18, 'lowpass');
        break;
      case 'fold':
        this.noiseBurst('cards', t, 0.16, 1500, 0.7, 0.2);
        break;
      case 'call':
      case 'bet':
      case 'raise':
        this.chips(chips, bigBlind);
        break;
      case 'allin':
        // A long shove of chips with a low accent.
        this.chips(Math.max(chips, bigBlind * 60), bigBlind, 0.03);
        this.tone('alerts', t, 0.45, 110, 0.32, 'sine', 70);
        break;
      case 'collect':
        if (this.throttled('collect', 90)) return;
        this.chips(chips, bigBlind, 0.022);
        break;
      case 'award':
        if (this.throttled('award', 120)) return;
        this.chips(chips, bigBlind, 0.03);
        break;
      case 'showdown':
        if (this.throttled('showdown', 150)) return;
        this.noiseBurst('cards', t, 0.09, 3000, 1, 0.26);
        break;
      case 'your_turn':
        if (!this.levels.turnSound || this.throttled('turn', 200)) return;
        this.tone('alerts', t, 0.13, 880, 0.2);
        this.tone('alerts', t + 0.1, 0.18, 1175, 0.16);
        break;
      case 'timer_warning':
        this.tone('alerts', t, 0.09, 1400, 0.22, 'square');
        this.tone('alerts', t + 0.2, 0.09, 1400, 0.22, 'square');
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) => this.tone('alerts', t + i * 0.1, 0.3, f, 0.2, 'triangle'));
        break;
      case 'defeat':
        [392, 330, 262].forEach((f, i) => this.tone('alerts', t + i * 0.15, 0.32, f, 0.15, 'sine'));
        break;
      case 'elimination':
        this.tone('alerts', t, 0.7, 220, 0.25, 'sawtooth', 70);
        this.noiseBurst('alerts', t, 0.5, 400, 0.5, 0.12, 'lowpass');
        break;
    }
  }

  /** A quiet generated pad, so the setting has something real to control. */
  private syncMusic(): void {
    if (!this.ctx || !this.musicGain) return;
    const want = this.levels.musicEnabled && !this.levels.masterMuted;
    if (want && this.musicNodes.length === 0) {
      const chord = [110, 164.81, 220, 277.18];
      chord.forEach((freq, i) => {
        const osc = this.ctx!.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const voice = this.ctx!.createGain();
        voice.gain.value = 0.08;
        const lfo = this.ctx!.createOscillator();
        lfo.frequency.value = 0.05 + i * 0.023;
        const lfoGain = this.ctx!.createGain();
        lfoGain.gain.value = 0.05;
        lfo.connect(lfoGain).connect(voice.gain);
        osc.connect(voice).connect(this.musicGain!);
        osc.start();
        lfo.start();
        this.musicNodes.push(osc, lfo);
      });
    } else if (!want && this.musicNodes.length > 0) {
      for (const node of this.musicNodes) node.stop();
      this.musicNodes = [];
    }
  }

  /** Plays a short preview from Settings. */
  preview(kind: EffectKind): void {
    this.unlock();
    this.play({ kind, tableId: 'preview', chips: 500, bigBlind: 20 });
  }
}
