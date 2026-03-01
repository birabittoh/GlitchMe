import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Bug, Camera, Crop, HelpCircle, Layers, Maximize, MonitorPlay, Settings, X } from 'lucide-react';
import { PoseDetectorService } from './services/poseDetector';
import { GlitchRenderer, GlitchEffects, DEFAULT_GLITCH_EFFECTS } from './services/glitchRenderer';
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

export const OTHER_KEYBINDINGS: Array<{ key: string; description: string }> = [
  { key: '1 – 9', description: 'Select input device by number' },
  { key: 'Space', description: 'Toggle dynamic / fixed mode' },
  { key: 'Z / X', description: 'Decrease / increase current intensity by 5%' },
  { key: 'C / V', description: 'Decrease / increase dynamic intensity by 5%' },
  { key: 'B / N', description: 'Decrease / increase fixed intensity by 5%' },
  { key: 'P',     description: 'Toggle all effects on / off' },
  { key: 'F',     description: 'Toggle fullscreen' },
  { key: 'D',     description: 'Toggle debug mode' },
  { key: 'S',     description: 'Toggle crop mode' },
  { key: '?',     description: 'Open / close this help modal' },
];

// ─── Persisted settings ───────────────────────────────────────────────────────

interface AppSettings {
  selectedDeviceId: string;
  isDynamicMode: boolean;
  dynamicIntensity: number;
  fixedIntensity: number;
  showDebug: boolean;
  isCropMode: boolean;
  effects: GlitchEffects;
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
};

function loadSettings(): AppSettings {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_SETTINGS, ...parsed, effects: { ...DEFAULT_GLITCH_EFFECTS, ...parsed.effects } };
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
  const requestRef = useRef<number>(0);

  // ── Persisted state (single object) ────────────────────────────────────────

  const [settings, setSettings] = useState<AppSettings>(loadSettings);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  const adjustIntensity = useCallback((key: 'dynamicIntensity' | 'fixedIntensity', delta: number) =>
    setSettings(s => ({ ...s, [key]: Math.max(0, Math.min(2, parseFloat((s[key] + delta).toFixed(2)))) })), []);

  // ── Transient state ───────────────────────────────────────────────────────

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const devicesRef = useRef(devices);
  useEffect(() => { devicesRef.current = devices; }, [devices]);

  const [isIdle, setIsIdle] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Fullscreen ────────────────────────────────────────────────────────────

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
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
    setIsIdle(false);
    if (idleTimeoutRef.current !== null) window.clearTimeout(idleTimeoutRef.current);
    idleTimeoutRef.current = window.setTimeout(() => setIsIdle(true), 2000);
  };

  const handleMouseLeave = () => {
    setIsIdle(false);
    if (idleTimeoutRef.current !== null) window.clearTimeout(idleTimeoutRef.current);
  };

  // ── Keyboard shortcuts ────────────────────────────────────────────────────

  useEffect(() => {
    const STEP = 0.05;

    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      const key = e.key;

      // 1–9: switch camera by index
      if (/^[1-9]$/.test(key)) {
        const device = devicesRef.current[parseInt(key, 10) - 1];
        if (device) setSettings(s => ({ ...s, selectedDeviceId: device.deviceId }));
        return;
      }

      switch (key) {
        case ' ':
          e.preventDefault();
          setSettings(s => ({ ...s, isDynamicMode: !s.isDynamicMode }));
          break;
        case 'z':
        case 'Z':
          adjustIntensity(settingsRef.current.isDynamicMode ? 'dynamicIntensity' : 'fixedIntensity', -STEP);
          break;
        case 'x':
        case 'X':
          adjustIntensity(settingsRef.current.isDynamicMode ? 'dynamicIntensity' : 'fixedIntensity', STEP);
          break;
        case 'c':
        case 'C':
          adjustIntensity('dynamicIntensity', -STEP);
          break;
        case 'v':
        case 'V':
          adjustIntensity('dynamicIntensity', STEP);
          break;
        case 'b':
        case 'B':
          adjustIntensity('fixedIntensity', -STEP);
          break;
        case 'n':
        case 'N':
          adjustIntensity('fixedIntensity', STEP);
          break;
        case 'p':
        case 'P':
          setSettings(s => {
            const next = !Object.values(s.effects).some(Boolean);
            return { ...s, effects: { colorInversion: next, sliceDisplacement: next, blockDisplacement: next, chromaticAberration: next } };
          });
          break;
        case 'f':
        case 'F':
          toggleFullScreen();
          break;
        case 'd':
        case 'D':
          setSettings(s => ({ ...s, showDebug: !s.showDebug }));
          break;
        case 's':
        case 'S':
          setSettings(s => ({ ...s, isCropMode: !s.isCropMode }));
          break;
        case '?':
          setShowHelp(prev => !prev);
          break;
        case 'Escape':
          setShowHelp(false);
          break;
        default: {
          const effectDef = EFFECT_DEFS.find(d => d.keybind === key.toUpperCase());
          if (effectDef) {
            setSettings(s => ({ ...s, effects: { ...s.effects, [effectDef.effectKey]: !s.effects[effectDef.effectKey] } }));
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
        setDevices(videoDevices);
        if (videoDevices.length > 0) {
          const savedId = settingsRef.current.selectedDeviceId;
          const exists = videoDevices.some(d => d.deviceId === savedId);
          if (!savedId || !exists) {
            setSettings(s => ({ ...s, selectedDeviceId: videoDevices[0].deviceId }));
          }
        }
      } catch (err) {
        setError('Failed to access webcam. Please ensure permissions are granted.');
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
        setIsModelLoaded(true);
      } catch (err) {
        setError('Failed to load pose detection model.');
        console.error(err);
      }
    }
    initModels();
  }, []);

  // ── Stream ────────────────────────────────────────────────────────────────

  const { selectedDeviceId } = settings;

  useEffect(() => {
    if (!selectedDeviceId || !videoRef.current) return;

    let stream: MediaStream | null = null;
    let isMounted = true;

    async function startStream() {
      try {
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
        if (isMounted) { setError('Failed to start video stream.'); console.error(err); }
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
    if (!isModelLoaded || !videoRef.current || !canvasRef.current) return;

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
            const s = settingsRef.current;
            const intensity = s.isDynamicMode ? s.dynamicIntensity : s.fixedIntensity;
            renderer.render(video, regions, s.isDynamicMode, intensity, s.showDebug, s.effects);
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
  }, [isModelLoaded]);

  // ─── Render ────────────────────────────────────────────────────────────────

  const { isDynamicMode, dynamicIntensity, fixedIntensity, showDebug, isCropMode, effects } = settings;

  const intensitySliders = [
    { label: 'Dynamic', key: 'dynamicIntensity' as const, value: dynamicIntensity, active: isDynamicMode },
    { label: 'Fixed',   key: 'fixedIntensity' as const,   value: fixedIntensity,   active: !isDynamicMode },
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
            {!isModelLoaded && !error && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <div className="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                Loading AI Model...
              </div>
            )}
            <button
              onClick={() => setShowHelp(true)}
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
          onClick={() => setShowHelp(false)}
        >
          <div
            className="bg-zinc-900 border border-zinc-700 rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-5"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Keyboard Shortcuts</h2>
              <button
                onClick={() => setShowHelp(false)}
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
              <div className="absolute inset-0 flex items-center justify-center text-red-400 p-6 text-center z-0">
                {error}
              </div>
            )}

            <video ref={videoRef} autoPlay playsInline muted className="absolute opacity-0 pointer-events-none" />
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
                onClick={() => setSettings(s => ({ ...s, showDebug: !s.showDebug }))}
                className={cn(
                  "p-2 rounded-lg backdrop-blur-sm transition-colors",
                  showDebug ? "bg-emerald-500/80 text-white" : "bg-black/50 hover:bg-black/80 text-white"
                )}
              >
                <Bug className="w-5 h-5" />
              </button>
              <button
                onClick={() => setSettings(s => ({ ...s, isCropMode: !s.isCropMode }))}
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
              onChange={(e) => setSettings(s => ({ ...s, selectedDeviceId: e.target.value }))}
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
                  onClick={() => setSettings(s => ({ ...s, isDynamicMode: true }))}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                    isDynamicMode ? "bg-zinc-800 text-emerald-400 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  <Activity className="w-4 h-4" />
                  Dynamic
                </button>
                <button
                  onClick={() => setSettings(s => ({ ...s, isDynamicMode: false }))}
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
                    onChange={(e) => setSettings(s => ({ ...s, [key]: parseFloat(e.target.value) }))}
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
                  onClick={() => setSettings(s => ({ ...s, effects: { ...s.effects, [effectKey]: !s.effects[effectKey] } }))}
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

        </div>
      </main>
    </div>
  );
}
