import { RegionData } from './poseDetector';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AudioGlitchEffects {
  distortion: boolean;
  wobble: boolean;
  echo: boolean;
  noise: boolean;
}

export interface AudioSettings {
  enabled: boolean;
  volume: number;       // 0–1 (mapped logarithmically to gain)
  minPitch: number;     // Hz
  maxPitch: number;     // Hz
  probability: number;  // 0–100
  effects: AudioGlitchEffects;
}

export const DEFAULT_AUDIO_GLITCH_EFFECTS: AudioGlitchEffects = {
  distortion: false,
  wobble: false,
  echo: false,
  noise: false,
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: true,
  volume: 0.5,
  minPitch: 200,
  maxPitch: 2000,
  probability: 50,
  effects: { ...DEFAULT_AUDIO_GLITCH_EFFECTS },
};

// ─── Pitch helpers (logarithmic scale) ───────────────────────────────────────

const SLIDER_MIN_FREQ = 50;
const SLIDER_MAX_FREQ = 5000;

/** Convert a 0–100 slider position to Hz on a logarithmic scale. */
export function sliderToHz(position: number): number {
  return SLIDER_MIN_FREQ * Math.pow(SLIDER_MAX_FREQ / SLIDER_MIN_FREQ, position / 100);
}

/** Convert Hz to a 0–100 slider position on a logarithmic scale. */
export function hzToSlider(hz: number): number {
  return 100 * Math.log(hz / SLIDER_MIN_FREQ) / Math.log(SLIDER_MAX_FREQ / SLIDER_MIN_FREQ);
}

// ─── Sound Engine ────────────────────────────────────────────────────────────

const NOTE_DURATION = 0.08;       // seconds
const MIN_NOTE_INTERVAL = 80;     // ms – per-region cooldown
const MAX_POLYPHONY = 8;

export class SoundEngine {
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private delayNode: DelayNode | null = null;
  private feedbackGain: GainNode | null = null;
  private lastNoteTimes = new Map<string, number>();
  private settings: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private activeNotes = 0;
  private distortionCurve: Float32Array;

  constructor() {
    this.distortionCurve = this.makeDistortionCurve(400);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  initialize() {
    this.audioCtx = new AudioContext();
    this.masterGain = this.audioCtx.createGain();
    this.masterGain.gain.value = this.volumeToGain(this.settings.volume);

    // Persistent delay/echo chain
    this.delayNode = this.audioCtx.createDelay(1.0);
    this.delayNode.delayTime.value = 0.15;
    this.feedbackGain = this.audioCtx.createGain();
    this.feedbackGain.gain.value = 0.3;
    this.delayNode.connect(this.feedbackGain);
    this.feedbackGain.connect(this.delayNode);
    this.delayNode.connect(this.masterGain);

    this.masterGain.connect(this.audioCtx.destination);
  }

  /** Must be called from a user-gesture handler to unlock the AudioContext. */
  resume() {
    if (this.audioCtx?.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  dispose() {
    this.audioCtx?.close();
    this.audioCtx = null;
    this.masterGain = null;
  }

  // ── Settings ─────────────────────────────────────────────────────────────

  updateSettings(settings: AudioSettings) {
    this.settings = settings;
    if (this.masterGain && this.audioCtx) {
      const now = this.audioCtx.currentTime;
      this.masterGain.gain.setTargetAtTime(this.volumeToGain(settings.volume), now, 0.02);
    }
  }

  /** Cubic mapping gives a perceptually-linear (logarithmic) volume feel. */
  private volumeToGain(volume: number): number {
    return volume * volume * volume;
  }

  // ── Per-frame entry point ────────────────────────────────────────────────

  processRegions(regions: RegionData[]) {
    if (!this.settings.enabled || !this.audioCtx || this.audioCtx.state !== 'running') return;

    for (const region of regions) {
      const key = `${region.personId}_${region.id}`;
      this.onMovement(key, region.smoothedVelocity);
    }
  }

  // ── Note triggering logic ────────────────────────────────────────────────

  private onMovement(regionKey: string, velocity: number) {
    if (velocity < 0.05) return;

    // Probability gate
    if (Math.random() * 100 >= this.settings.probability) return;

    // Per-region cooldown
    const now = performance.now();
    const lastTime = this.lastNoteTimes.get(regionKey) || 0;
    if (now - lastTime < MIN_NOTE_INTERVAL) return;

    // Polyphony cap
    if (this.activeNotes >= MAX_POLYPHONY) return;

    this.lastNoteTimes.set(regionKey, now);
    this.playNote(velocity);
  }

  // ── Synthesis ────────────────────────────────────────────────────────────

  private playNote(velocity: number) {
    const ctx = this.audioCtx!;
    const now = ctx.currentTime;
    const { minPitch, maxPitch, effects } = this.settings;

    // Logarithmic frequency mapping: low velocity → minPitch, high → maxPitch
    const freq = minPitch * Math.pow(maxPitch / Math.max(minPitch, 1), velocity);

    // Oscillator – square wave for stylophone-like timbre
    const osc = ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = freq;

    // Amplitude envelope (quick attack, exponential release)
    const noteGain = ctx.createGain();
    noteGain.gain.setValueAtTime(0.15, now);
    noteGain.gain.exponentialRampToValueAtTime(0.001, now + NOTE_DURATION);

    let currentNode: AudioNode = osc;

    // ── Wobble (FM glitch) ─────────────────────────────────────────────
    if (effects.wobble) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 8 + Math.random() * 20;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = freq * 0.3;
      lfo.connect(lfoGain);
      lfoGain.connect(osc.frequency);
      lfo.start(now);
      lfo.stop(now + NOTE_DURATION);
    }

    // ── Distortion ─────────────────────────────────────────────────────
    if (effects.distortion) {
      const ws = ctx.createWaveShaper();
      ws.curve = this.distortionCurve;
      ws.oversample = '4x';
      currentNode.connect(ws);
      currentNode = ws;
    }

    currentNode.connect(noteGain);

    // ── Noise layer ────────────────────────────────────────────────────
    if (effects.noise) {
      const bufLen = Math.ceil(ctx.sampleRate * NOTE_DURATION);
      const noiseBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      const noiseSrc = ctx.createBufferSource();
      noiseSrc.buffer = noiseBuf;
      const noiseGain = ctx.createGain();
      noiseGain.gain.setValueAtTime(0.08, now);
      noiseGain.gain.exponentialRampToValueAtTime(0.001, now + NOTE_DURATION);
      noiseSrc.connect(noiseGain);
      noiseGain.connect(noteGain);
      noiseSrc.start(now);
      noiseSrc.stop(now + NOTE_DURATION);
    }

    // ── Echo send ──────────────────────────────────────────────────────
    if (effects.echo && this.delayNode) {
      noteGain.connect(this.delayNode);
    }

    noteGain.connect(this.masterGain!);

    // ── Start / cleanup ────────────────────────────────────────────────
    this.activeNotes++;
    osc.start(now);
    osc.stop(now + NOTE_DURATION);
    osc.onended = () => {
      this.activeNotes = Math.max(0, this.activeNotes - 1);
    };
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private makeDistortionCurve(amount: number): Float32Array {
    const samples = 44100;
    const curve = new Float32Array(samples);
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      curve[i] = ((3 + amount) * x * 20 * (Math.PI / 180)) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }
}
