import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bug, Camera, Crop, HelpCircle, Layers, Maximize, MonitorPlay, Settings, Volume2, X } from 'lucide-react';
import { PoseDetectorService } from './services/poseDetector';
import { GlitchRenderer, GlitchEffects, DEFAULT_GLITCH_EFFECTS } from './services/glitchRenderer';
import { SoundEngine, AudioSettings, AudioGlitchEffects, Waveform, DEFAULT_AUDIO_SETTINGS, DEFAULT_AUDIO_GLITCH_EFFECTS, sliderToHz, hzToSlider, sliderToDuration, durationToSlider } from './services/soundEngine';
import { cn } from './lib/utils';

// ─── Single source of truth for keybindings ───────────────────────────────────

type EffectKey = keyof GlitchEffects;

export const EFFECT_DEFS: Array<{
  effectKey: EffectKey;
  label: string;
  description: string;
  keybind: string;
}> = [
  { effectKey: 'colorInversion',      label: 'Color Inversion',      description: 'Random inverted color blocks', keybind: 'Q' },
  { effectKey: 'sliceDisplacement',   label: 'Slice Displacement',   description: 'Horizontal slice shifts',      keybind: 'W' },
  { effectKey: 'blockDisplacement',   label: 'Block Displacement',   description: 'Randomly displaced blocks',    keybind: 'E' },
  { effectKey: 'chromaticAberration', label: 'Chromatic Aberration', description: 'RGB channel splitting',        keybind: 'R' },
];

type AudioEffectKey = keyof AudioGlitchEffects;

export const AUDIO_EFFECT_DEFS: Array<{
  effectKey: AudioEffectKey;
  label: string;
  description: string;
}> = [
  { effectKey: 'distortion', label: 'Distortion', description: 'Aggressive waveshaping' },
  { effectKey: 'wobble',     label: 'Wobble',      description: 'Frequency modulation glitch' },
  { effectKey: 'bitcrush',   label: 'Bitcrush',    description: 'Lo-fi sample rate reduction' },
];

const WAVEFORM_OPTIONS: { value: Waveform; label: string }[] = [
  { value: 'square',   label: 'Square' },
  { value: 'sawtooth', label: 'Sawtooth' },
  { value: 'triangle', label: 'Triangle' },
  { value: 'sine',     label: 'Sine' },
];

export const OTHER_KEYBINDINGS: Array<{ key: string; description: string }> = [
  { key: '1 – 9', description: 'Select input device by number' },
  { key: 'Space', description: 'Toggle dynamic / fixed mode' },
  { key: 'Z / X', description: 'Decrease / increase current intensity by 5%' },
  { key: 'C / V', description: 'Decrease / increase fixed intensity by 5%' },
  { key: 'B / N', description: 'Decrease / increase dynamic intensity by 5%' },
  { key: 'P',     description: 'Toggle all effects on / off' },
  { key: 'F',     description: 'Toggle fullscreen' },
  { key: 'D',     description: 'Toggle debug mode' },
  { key: 'S',     description: 'Toggle crop mode' },
  { key: 'M',     description: 'Toggle sound on / off' },
  { key: '?',     description: 'Open / close this help modal' },
];

// ─── App State ────────────────────────────────────────────────────────────────

interface AppSettings {
  selectedDeviceId: string;
  isDynamicMode: boolean;
  dynamicIntensity: number;
  fixedIntensity: number;
  showDebug: boolean;
  isCropMode: boolean;
  effects: GlitchEffects;
  audio: AudioSettings;
}

interface AppState {
  settings: AppSettings;
  devices: MediaDeviceInfo[];
  isIdle: boolean;
  isFullscreen: boolean;
  showHelp: boolean;
  isModelLoaded: boolean;
  isVideoLoaded: boolean;
  error: string | null;
}

const STORAGE_KEY = 'glitch-settings';

const DEFAULT_SETTINGS: AppSettings = {
  selectedDeviceId: '',
  isDynamicMode: true,
  dynamicIntensity: 1.0,
  fixedIntensity: 1.0,
  showDebug: false,
  isCropMode: false,
  effects: { ...DEFAULT_GLITCH_EFFECTS },
  audio: { ...DEFAULT_AUDIO_SETTINGS },
};

function loadSettings(): AppSettings {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        effects: { ...DEFAULT_GLITCH_EFFECTS, ...parsed.effects },
        audio: {
          ...DEFAULT_AUDIO_SETTINGS,
          ...parsed.audio,
          effects: { ...DEFAULT_AUDIO_GLITCH_EFFECTS, ...(parsed.audio?.effects) },
        },
      };
    } catch { /* fall through to migration */ }
  }
  // Migrate from old individual keys
  return {
    selectedDeviceId: localStorage.getItem('glitch-selected-device-id') || '',
    isDynamicMode: JSON.parse(localStorage.getItem('glitch-dynamic-mode') ?? 'true'),
    dynamicIntensity: parseFloat(localStorage.getItem('glitch-dynamic-intensity') ?? '1'),
    fixedIntensity: parseFloat(localStorage.getItem('glitch-fixed-intensity') ?? localStorage.getItem('glitch-intensity') ?? '1'),
    showDebug: JSON.parse(localStorage.getItem('glitch-show-debug') ?? 'false'),
    isCropMode: JSON.parse(localStorage.getItem('glitch-is-crop-mode') ?? 'false'),
    effects: { ...DEFAULT_GLITCH_EFFECTS, ...JSON.parse(localStorage.getItem('glitch-effects') ?? '{}') },
    audio: { ...DEFAULT_AUDIO_SETTINGS },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const idleTimeoutRef = useRef<number | null>(null);
  const detectorRef = useRef<PoseDetectorService | null>(null);
  const rendererRef = useRef<GlitchRenderer | null>(null);
  const soundEngineRef = useRef<SoundEngine | null>(null);
  const requestRef = useRef<number>(0);

  // ── Unified State ──────────────────────────────────────────────────────────

  const [state, setState] = useState<AppState>(() => ({
    settings: loadSettings(),
    devices: [],
    isIdle: false,
    isFullscreen: false,
    showHelp: false,
    isModelLoaded: false,
    isVideoLoaded: false,
    error: null,
  }));

  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.settings));
    soundEngineRef.current?.updateSettings(state.settings.audio);
  }, [state]);

  const adjustIntensity = useCallback((key: 'dynamicIntensity' | 'fixedIntensity', delta: number) =>
    setState(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        [key]: Math.max(0, Math.min(2, parseFloat((prev.settings[key] + delta).toFixed(2))))
      }
    })), []);

  // ── Fullscreen ────────────────────────────────────────────────────────────

  useEffect(() => {
    const handler = () => setState(prev => ({ ...prev, isFullscreen: !!document.fullscreenElement }));
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const toggleFullScreen = useCallback(() => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen().catch(console.error);
    }
  }, []);

  // ── Idle detection ────────────────────────────────────────────────────────

  const handleInteraction = () => {
    soundEngineRef.current?.resume();
    setState(prev => prev.isIdle ? { ...prev, isIdle: false } : prev);
    if (idleTimeoutRef.current !== null) window.clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = window.setTimeout(() => setState(prev => ({ ...prev, isIdle: true })), 2000);
  };

  const handleMouseLeave = () => {
    setState(prev => prev.isIdle ? { ...prev, isIdle: false } : prev);
    if (idleTimeoutRef.current !== null) window.clearTimeout(idleTimeoutRef.current);
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const STEP = 0.05;

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      soundEngineRef.current?.resume();
      const key = e.key;

      // 1–9: switch camera by index
      if (/^[1-9]$/.test(key)) {
        const device = stateRef.current.devices[parseInt(key, 10) - 1];
        if (device) setState(prev => ({
          ...prev,
          settings: { ...prev.settings, selectedDeviceId: device.deviceId }
        }));
        return;
      }

      switch (key) {
        case ' ':
          e.preventDefault();
          setState(prev => ({
            ...prev,
            settings: { ...prev.settings, isDynamicMode: !prev.settings.isDynamicMode }
          }));
          break;
        case 'z':
        case 'Z':
          adjustIntensity(stateRef.current.settings.isDynamicMode ? 'dynamicIntensity' : 'fixedIntensity', -STEP);
          break;
        case 'x':
        case 'X':
          adjustIntensity(stateRef.current.settings.isDynamicMode ? 'dynamicIntensity' : 'fixedIntensity', STEP);
          break;
        case 'c':
        case 'C':
          adjustIntensity('fixedIntensity', -STEP);
          break;
        case 'v':
        case 'V':
          adjustIntensity('fixedIntensity', STEP);
          break;
        case 'b':
        case 'B':
          adjustIntensity('dynamicIntensity', -STEP);
          break;
        case 'n':
        case 'N':
          adjustIntensity('dynamicIntensity', STEP);
          break;
        case 'p':
        case 'P':
          setState(prev => {
            const next = !Object.values(prev.settings.effects).some(Boolean);
            return {
              ...prev,
              settings: {
                ...prev.settings,
                effects: { colorInversion: next, sliceDisplacement: next, blockDisplacement: next, chromaticAberration: next }
              }
            };
          });
          break;
        case 'f':
        case 'F':
          toggleFullScreen();
          break;
        case 'd':
        case 'D':
          setState(prev => ({
            ...prev,
            settings: { ...prev.settings, showDebug: !prev.settings.showDebug }
          }));
          break;
        case 's':
        case 'S':
          setState(prev => ({
            ...prev,
            settings: { ...prev.settings, isCropMode: !prev.settings.isCropMode }
          }));
          break;
        case 'm':
        case 'M':
          setState(prev => ({
            ...prev,
            settings: {
              ...prev.settings,
              audio: { ...prev.settings.audio, enabled: !prev.settings.audio.enabled }
            }
          }));
          break;
        case '?':
          setState(prev => ({ ...prev, showHelp: !prev.showHelp }));
          break;
        case 'Escape':
          setState(prev => ({ ...prev, showHelp: false }));
          break;
        default: {
          const effectDef = EFFECT_DEFS.find(d => d.keybind === key.toUpperCase());
          if (effectDef) {
            setState(prev => ({
              ...prev,
              settings: {
                ...prev.settings,
                effects: { ...prev.settings.effects, [effectDef.effectKey]: !prev.settings.effects[effectDef.effectKey] }
              }
            }));
          }
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleFullScreen, adjustIntensity]);

  // ── Device initialisation ─────────────────────────────────────────────────

  useEffect(() => {
    async function getDevices() {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true });
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = allDevices.filter(d => d.kind === 'videoinput');
        setState(prev => {
          const savedId = prev.settings.selectedDeviceId;
          const exists = videoDevices.some(d => d.deviceId === savedId);
          return {
            ...prev,
            devices: videoDevices,
            settings: {
              ...prev.settings,
              selectedDeviceId: (!savedId || !exists) && videoDevices.length > 0
                ? videoDevices[0].deviceId
                : prev.settings.selectedDeviceId
            }
          };
        });
      } catch (err) {
        setState(prev => ({ ...prev, error: 'Failed to access webcam. Please ensure permissions are granted.' }));
        console.error(err);
      }
    }
    getDevices();
  }, []);

  // ── Model initialisation ──────────────────────────────────────────────────

  useEffect(() => {
    async function initModels() {
      try {
        const detector = new PoseDetectorService();
        await detector.initialize();
        detectorRef.current = detector;

        // Initialise the sound engine after the AI model is ready
        const engine = new SoundEngine();
        engine.initialize();
        engine.updateSettings(stateRef.current.settings.audio);
        soundEngineRef.current = engine;

        setState(prev => ({ ...prev, isModelLoaded: true }));
      } catch (err) {
        setState(prev => ({ ...prev, error: 'Failed to load pose detection model.' }));
        console.error(err);
      }
    }
    initModels();
  }, []);

  // ── Stream ────────────────────────────────────────────────────────────────

  const { selectedDeviceId } = state.settings;

  useEffect(() => {
    if (!selectedDeviceId || !videoRef.current) return;

    let stream: MediaStream | null = null;
    let isMounted = true;

    async function startStream() {
      try {
        setState(prev => ({ ...prev, isVideoLoaded: false, error: null }));
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: selectedDeviceId } }
        });
        if (!isMounted) { newStream.getTracks().forEach(t => t.stop()); return; }
        stream = newStream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(console.error);
        }
      } catch (err) {
        if (isMounted) {
          setState(prev => ({ ...prev, error: 'Failed to start video stream.' }));
          console.error(err);
        }
      }
    }

    startStream();
    return () => {
      isMounted = false;
      stream?.getTracks().forEach(t => t.stop());
    };
  }, [selectedDeviceId]);

  // ── Render loop ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!state.isModelLoaded || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!rendererRef.current) rendererRef.current = new GlitchRenderer(canvas);
    const renderer = rendererRef.current;

    let isProcessing = false;

    const renderLoop = async () => {
      try {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && detectorRef.current && !isProcessing) {
          isProcessing = true;
          try {
            if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
              renderer.resize(video.videoWidth, video.videoHeight);
            }
            const regions = await detectorRef.current.detectPoses(video);
            const s = stateRef.current.settings;
            const intensity = s.isDynamicMode ? s.dynamicIntensity : s.fixedIntensity;
            renderer.render(video, regions, s.isDynamicMode, intensity, s.showDebug, s.effects);
            soundEngineRef.current?.processRegions(regions);
          } finally {
            isProcessing = false;
          }
        }
      } catch (err) {
        console.error('Error in render loop:', err);
        try {
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            renderer.resize(video.videoWidth, video.videoHeight);
          }
          renderer.render(video, [], false, 0, false);
        } catch (fallbackErr) {
          console.error('Fallback render failed:', fallbackErr);
        }
        isProcessing = false;
      }
      requestRef.current = requestAnimationFrame(renderLoop);
    };

    requestRef.current = requestAnimationFrame(renderLoop);
    return () => cancelAnimationFrame(requestRef.current);
  }, [state.isModelLoaded]);

  // ─── Render ────────────────────────────────────────────────────────────────

  const {
    settings: { isDynamicMode, dynamicIntensity, fixedIntensity, showDebug, isCropMode, effects, audio },
    devices,
    isIdle,
    isFullscreen,
    showHelp,
    isModelLoaded,
    isVideoLoaded,
    error
  } = state;

  const intensitySliders = [
    { label: 'Fixed',   key: 'fixedIntensity' as const,   value: fixedIntensity,   active: !isDynamicMode },
    { label: 'Dynamic', key: 'dynamicIntensity' as const, value: dynamicIntensity, active: isDynamicMode },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">

      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MonitorPlay className="w-6 h-6 text-emerald-400" />
            <h1 className="text-xl font-semibold tracking-tight">GlitchMe</h1>
          </div>
          <div className="flex items-center gap-3">
            {(!isModelLoaded || !state.isVideoLoaded) && !error && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <div className="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                {!isModelLoaded ? 'Loading AI Model...' : 'Starting Camera...'}
              </div>
            )}
            <button
              onClick={() => setState(prev => ({ ...prev, showHelp: true }))}
              className="p-2 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
              aria-label="Keyboard shortcuts"
            >
              <HelpCircle className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Help Modal */}
      {showHelp && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
          onClick={() => setState(prev => ({ ...prev, showHelp: false }))}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
              <button
                onClick={() => setState(prev => ({ ...prev, showHelp: false }))}
                className="text-zinc-400 hover:text-zinc-100 transition-colors"
                aria-label="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <table className="w-full text-sm">
              <tbody className="divide-y divide-zinc-800">
                {OTHER_KEYBINDINGS.map(({ key, description }) => (
                  <tr key={key}>
                    <td className="py-2 pr-4 w-28">
                      <kbd className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 font-mono text-xs">{key}</kbd>
                    </td>
                    <td className="py-2 text-zinc-400">{description}</td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={2} className="pt-4 pb-1 text-xs font-medium uppercase tracking-wider text-zinc-500">
                    Effects
                  </td>
                </tr>
                {EFFECT_DEFS.map(({ keybind, label }) => (
                  <tr key={keybind}>
                    <td className="py-2 pr-4 w-28">
                      <kbd className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-200 font-mono text-xs">{keybind}</kbd>
                    </td>
                    <td className="py-2 text-zinc-400">Toggle {label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-4 py-8 grid lg:grid-cols-[1fr_320px] gap-8">

        {/* Main Viewport */}
        <div className="space-y-4">
          <div
            ref={containerRef}
            onMouseMove={handleInteraction}
            onMouseLeave={handleMouseLeave}
            onTouchStart={handleInteraction}
            className={cn(
              "relative aspect-video bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl group",
              isIdle && "cursor-none"
            )}
          >
            {error && (
              <div className="absolute inset-0 flex items-center justify-center text-red-400 p-6 text-center z-10">
                {error}
              </div>
            )}

            {(!isModelLoaded || !isVideoLoaded) && !error && (
              <div className="absolute inset-0 flex flex-col items-center justify-center bg-zinc-900/50 backdrop-blur-md z-20">
                <div className="w-12 h-12 border-4 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin mb-4" />
                <div className="text-lg font-medium text-emerald-500">
                  {!isModelLoaded ? 'Initializing AI Model' : 'Connecting to Camera'}
                </div>
                <div className="text-sm text-zinc-400 mt-1">
                  {!isModelLoaded ? 'Downloading neural weights...' : 'Waiting for video stream...'}
                </div>
              </div>
            )}

            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute opacity-0 pointer-events-none"
              onLoadedData={() => setState(prev => ({ ...prev, isVideoLoaded: true }))}
            />
            <canvas
              ref={canvasRef}
              className={cn(
                "w-full h-full transition-all duration-300",
                isCropMode ? "object-cover" : "object-contain"
              )}
            />

            {/* Viewport Controls */}
            <div className={cn(
              "absolute bottom-4 right-4 flex items-center gap-2 transition-opacity duration-300 z-10",
              isIdle ? "opacity-0 pointer-events-none" : "opacity-100 lg:opacity-0 lg:group-hover:opacity-100"
            )}>
              <button
                onClick={() => setState(prev => ({ ...prev, settings: { ...prev.settings, showDebug: !prev.settings.showDebug } }))}
                className={cn(
                  "p-2 rounded-lg backdrop-blur-sm transition-colors",
                  showDebug ? "bg-emerald-500/80 text-white" : "bg-black/50 hover:bg-black/80 text-white"
                )}
              >
                <Bug className="w-5 h-5" />
              </button>
              <button
                onClick={() => setState(prev => ({ ...prev, settings: { ...prev.settings, isCropMode: !prev.settings.isCropMode } }))}
                className={cn(
                  "p-2 rounded-lg backdrop-blur-sm transition-colors",
                  isCropMode ? "bg-emerald-500/80 text-white" : "bg-black/50 hover:bg-black/80 text-white"
                )}
              >
                <Crop className="w-5 h-5" />
              </button>
              <button
                onClick={toggleFullScreen}
                className={cn(
                  "p-2 rounded-lg backdrop-blur-sm transition-colors",
                  isFullscreen ? "bg-emerald-500/80 text-white" : "bg-black/50 hover:bg-black/80 text-white"
                )}
              >
                <Maximize className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>

        {/* Controls Sidebar */}
        <div className="space-y-6">

          {/* Camera Selection */}
          <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800 space-y-4">
            <div className="flex items-center gap-2 text-zinc-400">
              <Camera className="w-4 h-4" />
              <h2 className="text-sm font-medium uppercase tracking-wider">Input Source</h2>
            </div>
            <select
              value={selectedDeviceId}
              onChange={(e) => setState(prev => ({ ...prev, settings: { ...prev.settings, selectedDeviceId: e.target.value } }))}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
            >
              {devices.length === 0 && <option value="">No cameras found</option>}
              {devices.map((device, i) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {i < 9 ? `[${i + 1}] ` : ''}{device.label || `Camera ${device.deviceId.slice(0, 5)}...`}
                </option>
              ))}
            </select>
          </div>

          {/* Glitch Engine */}
          <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800 space-y-6">
            <div className="flex items-center gap-2 text-zinc-400">
              <Settings className="w-4 h-4" />
              <h2 className="text-sm font-medium uppercase tracking-wider">Glitch Engine</h2>
            </div>

            <div className="space-y-4">
              {/* Mode Toggle */}
              <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800">
                <button
                  onClick={() => setState(prev => ({ ...prev, settings: { ...prev.settings, isDynamicMode: true } }))}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                    isDynamicMode ? "bg-zinc-800 text-emerald-400 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  <Activity className="w-4 h-4" />
                  Dynamic
                </button>
                <button
                  onClick={() => setState(prev => ({ ...prev, settings: { ...prev.settings, isDynamicMode: false } }))}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                    !isDynamicMode ? "bg-zinc-800 text-emerald-400 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  <Settings className="w-4 h-4" />
                  Fixed
                </button>
              </div>

              <p className="text-xs text-zinc-500 leading-relaxed">
                {isDynamicMode
                  ? "Glitch intensity is driven by movement velocity."
                  : "Glitch intensity is fixed and applied uniformly to all detected body parts."}
              </p>

              {/* Intensity Sliders */}
              <div className="text-sm text-zinc-400">Intensity</div>
              {intensitySliders.map(({ label, key, value, active }) => (
                <div key={key} className={cn("space-y-2 transition-opacity duration-200", !active && "opacity-40")}>
                  <div className="flex justify-between text-sm">
                    <span className={cn("transition-colors", active ? "text-zinc-200" : "text-zinc-500")}>{label}</span>
                    <span className="text-zinc-300 font-mono">{Math.round(value * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max="2"
                    step="0.01"
                    value={value}
                    onChange={(e) => setState(prev => ({
                      ...prev,
                      settings: { ...prev.settings, [key]: parseFloat(e.target.value) }
                    }))}
                    className="w-full accent-emerald-500"
                  />
                </div>
              ))}
            </div>
          </div>

          {/* Glitch Effects */}
          <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800 space-y-4">
            <div className="flex items-center gap-2 text-zinc-400">
              <Layers className="w-4 h-4" />
              <h2 className="text-sm font-medium uppercase tracking-wider">Glitch Effects</h2>
            </div>

            {EFFECT_DEFS.map(({ effectKey, label, description, keybind }) => (
              <div key={effectKey} className="flex items-center justify-between gap-3 group">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">{label}</span>
                    <kbd className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-500 font-mono text-xs">{keybind}</kbd>
                  </div>
                  <div className="text-xs text-zinc-500">{description}</div>
                </div>
                <button
                  role="switch"
                  aria-checked={effects[effectKey]}
                  onClick={() => setState(prev => ({
                    ...prev,
                    settings: {
                      ...prev.settings,
                      effects: { ...prev.settings.effects, [effectKey]: !prev.settings.effects[effectKey] }
                    }
                  }))}
                  className={cn(
                    "relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
                    effects[effectKey] ? "bg-emerald-500" : "bg-zinc-700"
                  )}
                >
                  <span
                    className={cn(
                      "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transition-transform",
                      effects[effectKey] ? "translate-x-5" : "translate-x-0"
                    )}
                  />
                </button>
              </div>
            ))}
          </div>

          {/* Audio Settings */}
          <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800 space-y-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-zinc-400">
                <Volume2 className="w-4 h-4" />
                <h2 className="text-sm font-medium uppercase tracking-wider">Audio</h2>
              </div>
              <button
                role="switch"
                aria-checked={audio.enabled}
                onClick={() => setState(prev => ({
                  ...prev,
                  settings: {
                    ...prev.settings,
                    audio: { ...prev.settings.audio, enabled: !prev.settings.audio.enabled }
                  }
                }))}
                className={cn(
                  "relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
                  audio.enabled ? "bg-emerald-500" : "bg-zinc-700"
                )}
              >
                <span
                  className={cn(
                    "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transition-transform",
                    audio.enabled ? "translate-x-5" : "translate-x-0"
                  )}
                />
              </button>
            </div>

            <div className={cn("space-y-5 transition-opacity duration-200", !audio.enabled && "opacity-40 pointer-events-none")}>

              {/* Waveform */}
              <div className="space-y-2">
                <div className="text-sm text-zinc-400">Waveform</div>
                <select
                  value={audio.waveform}
                  onChange={(e) => setState(prev => ({
                    ...prev,
                    settings: {
                      ...prev.settings,
                      audio: { ...prev.settings.audio, waveform: e.target.value as Waveform }
                    }
                  }))}
                  className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
                >
                  {WAVEFORM_OPTIONS.map(({ value, label }) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>

              {/* Pitch Range (dual-handle slider, logarithmic) */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Pitch Range</span>
                  <span className="text-zinc-300 font-mono text-xs">
                    {Math.round(audio.minPitch)}Hz – {Math.round(audio.maxPitch)}Hz
                  </span>
                </div>
                <div className="relative h-6">
                  {/* Track background */}
                  <div className="absolute top-1/2 -translate-y-1/2 w-full h-1.5 bg-zinc-700 rounded-full" />
                  {/* Active range highlight */}
                  <div
                    className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-emerald-500/60 rounded-full"
                    style={{
                      left: `${hzToSlider(audio.minPitch)}%`,
                      width: `${Math.max(0, hzToSlider(audio.maxPitch) - hzToSlider(audio.minPitch))}%`,
                    }}
                  />
                  {/* Min handle */}
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={0.5}
                    value={hzToSlider(audio.minPitch)}
                    onChange={(e) => {
                      const hz = sliderToHz(parseFloat(e.target.value));
                      setState(prev => ({
                        ...prev,
                        settings: {
                          ...prev.settings,
                          audio: {
                            ...prev.settings.audio,
                            minPitch: Math.min(hz, prev.settings.audio.maxPitch * 0.95)
                          }
                        }
                      }));
                    }}
                    className="dual-range"
                    style={{ zIndex: hzToSlider(audio.minPitch) > 50 ? 5 : 3 }}
                  />
                  {/* Max handle */}
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={0.5}
                    value={hzToSlider(audio.maxPitch)}
                    onChange={(e) => {
                      const hz = sliderToHz(parseFloat(e.target.value));
                      setState(prev => ({
                        ...prev,
                        settings: {
                          ...prev.settings,
                          audio: {
                            ...prev.settings.audio,
                            maxPitch: Math.max(hz, prev.settings.audio.minPitch * 1.05)
                          }
                        }
                      }));
                    }}
                    className="dual-range"
                    style={{ zIndex: hzToSlider(audio.maxPitch) <= 50 ? 5 : 3 }}
                  />
                </div>
              </div>

              {/* Duration Range (dual-handle slider, logarithmic) */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Duration Range</span>
                  <span className="text-zinc-300 font-mono text-xs">
                    {Math.round(audio.minDuration * 1000)}ms – {Math.round(audio.maxDuration * 1000)}ms
                  </span>
                </div>
                <div className="relative h-6">
                  {/* Track background */}
                  <div className="absolute top-1/2 -translate-y-1/2 w-full h-1.5 bg-zinc-700 rounded-full" />
                  {/* Active range highlight */}
                  <div
                    className="absolute top-1/2 -translate-y-1/2 h-1.5 bg-emerald-500/60 rounded-full"
                    style={{
                      left: `${durationToSlider(audio.minDuration)}%`,
                      width: `${Math.max(0, durationToSlider(audio.maxDuration) - durationToSlider(audio.minDuration))}%`,
                    }}
                  />
                  {/* Min handle */}
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={0.5}
                    value={durationToSlider(audio.minDuration)}
                    onChange={(e) => {
                      const sec = sliderToDuration(parseFloat(e.target.value));
                      setState(prev => ({
                        ...prev,
                        settings: {
                          ...prev.settings,
                          audio: {
                            ...prev.settings.audio,
                            minDuration: Math.min(sec, prev.settings.audio.maxDuration * 0.95)
                          }
                        }
                      }));
                    }}
                    className="dual-range"
                    style={{ zIndex: durationToSlider(audio.minDuration) > 50 ? 5 : 3 }}
                  />
                  {/* Max handle */}
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={0.5}
                    value={durationToSlider(audio.maxDuration)}
                    onChange={(e) => {
                      const sec = sliderToDuration(parseFloat(e.target.value));
                      setState(prev => ({
                        ...prev,
                        settings: {
                          ...prev.settings,
                          audio: {
                            ...prev.settings.audio,
                            maxDuration: Math.max(sec, prev.settings.audio.minDuration * 1.05)
                          }
                        }
                      }));
                    }}
                    className="dual-range"
                    style={{ zIndex: durationToSlider(audio.maxDuration) <= 50 ? 5 : 3 }}
                  />
                </div>
              </div>

              {/* Probability */}
              <div className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Probability</span>
                  <span className="text-zinc-300 font-mono">{audio.probability.toFixed(1)}%</span>
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="25"
                  step="0.1"
                  value={audio.probability}
                  onChange={(e) => setState(prev => ({
                    ...prev,
                    settings: {
                      ...prev.settings,
                      audio: { ...prev.settings.audio, probability: parseFloat(e.target.value) }
                    }
                  }))}
                  className="w-full accent-emerald-500"
                />
              </div>

              {/* Audio Glitch Effects */}
              <div className="space-y-3">
                <div className="text-sm text-zinc-400">Effects</div>
                {AUDIO_EFFECT_DEFS.map(({ effectKey, label, description }) => (
                  <div key={effectKey} className="flex items-center justify-between gap-3 group">
                    <div className="min-w-0">
                      <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">{label}</span>
                      <div className="text-xs text-zinc-500">{description}</div>
                    </div>
                    <button
                      role="switch"
                      aria-checked={audio.effects[effectKey]}
                      onClick={() => setState(prev => ({
                        ...prev,
                        settings: {
                          ...prev.settings,
                          audio: {
                            ...prev.settings.audio,
                            effects: {
                              ...prev.settings.audio.effects,
                              [effectKey]: !prev.settings.audio.effects[effectKey]
                            }
                          }
                        }
                      }))}
                      className={cn(
                        "relative inline-flex h-6 w-11 shrink-0 rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50",
                        audio.effects[effectKey] ? "bg-emerald-500" : "bg-zinc-700"
                      )}
                    >
                      <span
                        className={cn(
                          "pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transition-transform",
                          audio.effects[effectKey] ? "translate-x-5" : "translate-x-0"
                        )}
                      />
                    </button>
                  </div>
                ))}
              </div>

            </div>
          </div>

        </div>
      </main>
    </div>
  );
}
