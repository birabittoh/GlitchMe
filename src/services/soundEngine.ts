import { RegionData } from './poseDetector';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AudioGlitchEffects {
  distortion: boolean;
  wobble: boolean;
  bitcrush: boolean;
}

export type Waveform = 'square' | 'sawtooth' | 'triangle' | 'sine';

export interface AudioSettings {
  enabled: boolean;
  waveforms: Waveform[];
  minPitch: number;     // Hz
  maxPitch: number;     // Hz
  minDuration: number;  // seconds
  maxDuration: number;  // seconds
  probability: number;  // 0–100
  effects: AudioGlitchEffects;
}

export const DEFAULT_AUDIO_GLITCH_EFFECTS: AudioGlitchEffects = {
  distortion: false,
  wobble: false,
  bitcrush: false,
};

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: true,
  waveforms: ['square'],
  minPitch: 200,
  maxPitch: 2000,
  minDuration: 0.10,
  maxDuration: 0.30,
  probability: 10,
  effects: { ...DEFAULT_AUDIO_GLITCH_EFFECTS },
};

// ─── Pitch helpers (logarithmic scale) ───────────────────────────────────────

const SLIDER_MIN_FREQ = 50;
const SLIDER_MAX_FREQ = 20000;

/** Convert a 0–100 slider position to Hz on a logarithmic scale. */
export function sliderToHz(position: number): number {
  return SLIDER_MIN_FREQ * Math.pow(SLIDER_MAX_FREQ / SLIDER_MIN_FREQ, position / 100);
}

/** Convert Hz to a 0–100 slider position on a logarithmic scale. */
export function hzToSlider(hz: number): number {
  return 100 * Math.log(hz / SLIDER_MIN_FREQ) / Math.log(SLIDER_MAX_FREQ / SLIDER_MIN_FREQ);
}

// ─── Duration helpers (logarithmic scale) ────────────────────────────────────

const SLIDER_MIN_DUR = 0.10;  // 100 ms
const SLIDER_MAX_DUR = 1.0;   // 1000 ms

/** Convert a 0–100 slider position to seconds on a logarithmic scale. */
export function sliderToDuration(position: number): number {
  return SLIDER_MIN_DUR * Math.pow(SLIDER_MAX_DUR / SLIDER_MIN_DUR, position / 100);
}

/** Convert seconds to a 0–100 slider position on a logarithmic scale. */
export function durationToSlider(sec: number): number {
  return 100 * Math.log(sec / SLIDER_MIN_DUR) / Math.log(SLIDER_MAX_DUR / SLIDER_MIN_DUR);
}

// ─── Sound Engine ────────────────────────────────────────────────────────────

const MIN_NOTE_INTERVAL = 60;     // ms – per-region cooldown
const MAX_POLYPHONY = 12;

export class SoundEngine {
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
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
    this.masterGain.gain.value = 3.0;

    this.masterGain.connect(this.audioCtx.destination);

    // Browsers suspend AudioContext until a user gesture.
    // Attach a one-shot document-level listener so any click/key unlocks it.
    const unlockAudio = () => {
      this.resume();
      document.removeEventListener('click', unlockAudio);
      document.removeEventListener('keydown', unlockAudio);
      document.removeEventListener('pointerdown', unlockAudio);
    };
    document.addEventListener('click', unlockAudio);
    document.addEventListener('keydown', unlockAudio);
    document.addEventListener('pointerdown', unlockAudio);
  }

  /** Resume the AudioContext (call from user-gesture handlers). */
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
  }

  // ── Per-frame entry point ────────────────────────────────────────────────

  processRegions(regions: RegionData[]) {
    if (!this.settings.enabled || !this.audioCtx) return;

    // If still suspended, try to resume (will succeed if called during/after a gesture)
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
      return;
    }

    for (const region of regions) {
      const key = `${region.personId}_${region.id}`;
      this.onMovement(key, region.smoothedVelocity);
    }
  }

  // ── Note triggering logic ────────────────────────────────────────────────

  private onMovement(regionKey: string, velocity: number) {
    if (velocity < 0.02) return;

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
    const { minPitch, maxPitch, minDuration, maxDuration, waveforms, effects } = this.settings;

    // Pick a random waveform from the selected ones
    const waveform = waveforms[Math.floor(Math.random() * waveforms.length)] || 'square';

    // Random duration within the configured range
    const dur = minDuration + Math.random() * (maxDuration - minDuration);

    // Logarithmic frequency mapping: low velocity → minPitch, high → maxPitch
    const freq = minPitch * Math.pow(maxPitch / Math.max(minPitch, 1), velocity);

    // Oscillator – user-selected waveform
    const osc = ctx.createOscillator();
    osc.type = waveform;
    osc.frequency.value = freq;

    // Amplitude envelope (quick attack, exponential release)
    const noteGain = ctx.createGain();
    noteGain.gain.setValueAtTime(0.5, now);
    noteGain.gain.exponentialRampToValueAtTime(0.001, now + dur);

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
      lfo.stop(now + dur);
    }

    // ── Distortion ─────────────────────────────────────────────────────
    if (effects.distortion) {
      const ws = ctx.createWaveShaper();
      ws.curve = this.distortionCurve;
      ws.oversample = '4x';
      currentNode.connect(ws);
      currentNode = ws;
    }

    // ── Bitcrush (sample-rate reduction via staircase gain modulation) ─
    if (effects.bitcrush) {
      // Render a staircase buffer that holds each sample for N frames,
      // simulating reduced sample-rate when used as a gain envelope.
      const crushRate = 4000; // target "sample rate" in Hz
      const holdSamples = Math.max(1, Math.floor(ctx.sampleRate / crushRate));
      const bufLen = Math.ceil(ctx.sampleRate * dur);
      const crushBuf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
      const crushData = crushBuf.getChannelData(0);
      for (let i = 0; i < bufLen; i++) {
        // quantise to 4-bit (16 levels) and hold
        const phase = (i % holdSamples) / holdSamples;
        crushData[i] = phase < 0.5 ? 1 : 0;
      }
      const crushSrc = ctx.createBufferSource();
      crushSrc.buffer = crushBuf;
      const crushGain = ctx.createGain();
      crushGain.gain.value = 0;
      crushSrc.connect(crushGain.gain);
      currentNode.connect(crushGain);
      currentNode = crushGain;
      crushSrc.start(now);
      crushSrc.stop(now + dur);
    }

    currentNode.connect(noteGain);
    noteGain.connect(this.masterGain!);

    // ── Start / cleanup ────────────────────────────────────────────────
    this.activeNotes++;
    osc.start(now);
    osc.stop(now + dur);
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
