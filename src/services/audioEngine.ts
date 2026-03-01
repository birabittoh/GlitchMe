export interface AudioGlitchEffects {
  stutter: boolean;
  reverse: boolean;
  distortion: boolean;
  randomPan: boolean;
  bitcrusher: boolean;
}

export const DEFAULT_AUDIO_GLITCH_EFFECTS: AudioGlitchEffects = {
  stutter: false,
  reverse: false,
  distortion: false,
  randomPan: false,
  bitcrusher: false,
};

export interface AudioSettings {
  enabled: boolean;
  volume: number;       // 0–100, mapped logarithmically to gain
  pitchMin: number;     // minimum playbackRate (e.g. 0.25)
  pitchMax: number;     // maximum playbackRate (e.g. 4.0)
  probability: number;  // 0–100, chance of playing per detected movement
  effects: AudioGlitchEffects;
}

export const DEFAULT_AUDIO_SETTINGS: AudioSettings = {
  enabled: true,
  volume: 70,
  pitchMin: 0.5,
  pitchMax: 2.0,
  probability: 50,
  effects: { ...DEFAULT_AUDIO_GLITCH_EFFECTS },
};

const MAX_CONCURRENT_VOICES = 8;
const REGION_COOLDOWN_MS = 80;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private buffer: AudioBuffer | null = null;
  private reversedBuffer: AudioBuffer | null = null;
  private masterGain: GainNode | null = null;
  private distortionCurve: Float32Array<ArrayBuffer>;
  private activeVoices = 0;
  private regionCooldowns: Map<string, number> = new Map();

  constructor() {
    // Pre-compute distortion waveshaper curve
    const samples = 44100;
    this.distortionCurve = new Float32Array(samples);
    const k = 50; // distortion amount
    for (let i = 0; i < samples; i++) {
      const x = (i * 2) / samples - 1;
      this.distortionCurve[i] = ((3 + k) * x * 20 * (Math.PI / 180)) / (Math.PI + k * Math.abs(x));
    }
  }

  async initialize(): Promise<void> {
    this.ctx = new AudioContext();
    this.masterGain = this.ctx.createGain();
    this.masterGain.connect(this.ctx.destination);

    // Load the stylophone WAV from public directory
    const response = await fetch('/stylophone-la.wav');
    const arrayBuffer = await response.arrayBuffer();
    this.buffer = await this.ctx.decodeAudioData(arrayBuffer);

    // Pre-build reversed buffer
    this.reversedBuffer = this.buildReversedBuffer(this.buffer);
  }

  private buildReversedBuffer(source: AudioBuffer): AudioBuffer {
    const reversed = this.ctx!.createBuffer(
      source.numberOfChannels,
      source.length,
      source.sampleRate
    );
    for (let ch = 0; ch < source.numberOfChannels; ch++) {
      const src = source.getChannelData(ch);
      const dst = reversed.getChannelData(ch);
      for (let i = 0; i < src.length; i++) {
        dst[i] = src[src.length - 1 - i];
      }
    }
    return reversed;
  }

  /** Map a 0–100 slider logarithmically to gain (0.0 – 1.0). */
  setVolume(value: number): void {
    if (!this.masterGain) return;
    // Attempt smooth ramp; fallback to direct assignment for cold start
    const gain = value <= 0 ? 0 : Math.pow(value / 100, 3);
    const now = this.ctx!.currentTime;
    this.masterGain.gain.cancelScheduledValues(now);
    this.masterGain.gain.setTargetAtTime(gain, now, 0.02);
  }

  /**
   * Trigger a note for a moving region.
   * @param velocity – smoothed velocity in [0, 1]
   * @param regionKey – unique key like "0_leftArm" for cooldown tracking
   * @param settings – current AudioSettings from the UI
   */
  triggerNote(velocity: number, regionKey: string, settings: AudioSettings): void {
    if (!this.ctx || !this.buffer || !this.masterGain) return;
    if (!settings.enabled) return;

    // Resume context if suspended (autoplay policy)
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    // Probability gate
    if (Math.random() * 100 >= settings.probability) return;

    // Per-region cooldown to avoid machine-gun effect
    const now = performance.now();
    const lastPlayed = this.regionCooldowns.get(regionKey) ?? 0;
    if (now - lastPlayed < REGION_COOLDOWN_MS) return;
    this.regionCooldowns.set(regionKey, now);

    // Limit concurrent voices
    if (this.activeVoices >= MAX_CONCURRENT_VOICES) return;

    // Map velocity to playback rate (pitch)
    const rate = settings.pitchMin + velocity * (settings.pitchMax - settings.pitchMin);

    // Choose buffer (reverse effect)
    const useReversed = settings.effects.reverse && Math.random() < 0.5;
    let sourceBuffer = useReversed ? this.reversedBuffer! : this.buffer;

    // Bitcrusher: create a crushed copy of the buffer
    if (settings.effects.bitcrusher) {
      sourceBuffer = this.crushBuffer(sourceBuffer);
    }

    const ctx = this.ctx;

    // Build audio graph: source → [distortion] → [panner] → masterGain → destination
    const source = ctx.createBufferSource();
    source.buffer = sourceBuffer;
    source.playbackRate.value = rate;

    let lastNode: AudioNode = source;

    // Distortion effect
    if (settings.effects.distortion) {
      const waveshaper = ctx.createWaveShaper();
      waveshaper.curve = this.distortionCurve;
      waveshaper.oversample = '4x';
      lastNode.connect(waveshaper);
      lastNode = waveshaper;
    }

    // Random pan effect
    if (settings.effects.randomPan) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.random() * 2 - 1;
      lastNode.connect(panner);
      lastNode = panner;
    }

    lastNode.connect(this.masterGain);

    // Track active voices
    this.activeVoices++;
    source.onended = () => { this.activeVoices--; };

    // Stutter: rapid retriggering of a short segment
    if (settings.effects.stutter) {
      const stutterCount = 2 + Math.floor(Math.random() * 4); // 2–5 repeats
      const segmentDuration = 0.03 + Math.random() * 0.05;    // 30–80ms segments
      for (let i = 0; i < stutterCount; i++) {
        const s = ctx.createBufferSource();
        s.buffer = sourceBuffer;
        s.playbackRate.value = rate;

        // Clone the same chain for each stutter voice
        let ln: AudioNode = s;
        if (settings.effects.distortion) {
          const ws = ctx.createWaveShaper();
          ws.curve = this.distortionCurve;
          ws.oversample = '4x';
          ln.connect(ws);
          ln = ws;
        }
        if (settings.effects.randomPan) {
          const p = ctx.createStereoPanner();
          p.pan.value = Math.random() * 2 - 1;
          ln.connect(p);
          ln = p;
        }
        ln.connect(this.masterGain);

        const offset = Math.random() * Math.max(0, sourceBuffer.duration - segmentDuration);
        s.start(ctx.currentTime + i * segmentDuration, offset, segmentDuration);
      }
    }

    source.start(0);
  }

  /** Reduce bit depth of a buffer to create a lo-fi / crushed effect. */
  private crushBuffer(input: AudioBuffer): AudioBuffer {
    const ctx = this.ctx!;
    const crushed = ctx.createBuffer(input.numberOfChannels, input.length, input.sampleRate);
    const bits = 4; // target bit depth
    const levels = Math.pow(2, bits);

    for (let ch = 0; ch < input.numberOfChannels; ch++) {
      const src = input.getChannelData(ch);
      const dst = crushed.getChannelData(ch);
      // Also do sample-rate reduction by holding every Nth sample
      const holdEvery = 4;
      let held = 0;
      for (let i = 0; i < src.length; i++) {
        if (i % holdEvery === 0) {
          held = Math.round(src[i] * levels) / levels;
        }
        dst[i] = held;
      }
    }
    return crushed;
  }

  dispose(): void {
    if (this.ctx) {
      this.ctx.close();
      this.ctx = null;
    }
    this.buffer = null;
    this.reversedBuffer = null;
    this.masterGain = null;
    this.regionCooldowns.clear();
  }
}
