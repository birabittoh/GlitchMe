import React, { useEffect, useRef, useState } from 'react';
import { Camera, Settings, Activity, MonitorPlay, Bug, Maximize, Crop } from 'lucide-react';
import { PoseDetectorService, RegionData } from './services/poseDetector';
import { GlitchRenderer } from './services/glitchRenderer';
import { cn } from './lib/utils';

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>(() => {
    return localStorage.getItem('glitch-selected-device-id') || '';
  });
  const [isDynamicMode, setIsDynamicMode] = useState(() => {
    const saved = localStorage.getItem('glitch-dynamic-mode');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [fixedIntensity, setFixedIntensity] = useState(() => {
    const saved = localStorage.getItem('glitch-intensity');
    return saved !== null ? parseFloat(saved) : 1.0;
  });
  const [showDebug, setShowDebug] = useState(() => {
    const saved = localStorage.getItem('glitch-show-debug');
    return saved !== null ? JSON.parse(saved) : false;
  });
  const [isCropMode, setIsCropMode] = useState(() => {
    const saved = localStorage.getItem('glitch-is-crop-mode');
    return saved !== null ? JSON.parse(saved) : false;
  });
  const [isIdle, setIsIdle] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const idleTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const handleInteraction = () => {
    setIsIdle(false);
    if (idleTimeoutRef.current !== null) {
      window.clearTimeout(idleTimeoutRef.current);
    }
    idleTimeoutRef.current = window.setTimeout(() => {
      setIsIdle(true);
    }, 2000);
  };

  const handleMouseLeave = () => {
    setIsIdle(false);
    if (idleTimeoutRef.current !== null) {
      window.clearTimeout(idleTimeoutRef.current);
    }
  };

  const isDynamicModeRef = useRef(isDynamicMode);
  const fixedIntensityRef = useRef(fixedIntensity);
  const showDebugRef = useRef(showDebug);

  useEffect(() => {
    isDynamicModeRef.current = isDynamicMode;
    localStorage.setItem('glitch-dynamic-mode', JSON.stringify(isDynamicMode));
  }, [isDynamicMode]);

  useEffect(() => {
    fixedIntensityRef.current = fixedIntensity;
    localStorage.setItem('glitch-intensity', fixedIntensity.toString());
  }, [fixedIntensity]);

  useEffect(() => {
    showDebugRef.current = showDebug;
    localStorage.setItem('glitch-show-debug', JSON.stringify(showDebug));
  }, [showDebug]);

  useEffect(() => {
    localStorage.setItem('glitch-is-crop-mode', JSON.stringify(isCropMode));
  }, [isCropMode]);

  useEffect(() => {
    if (selectedDeviceId) {
      localStorage.setItem('glitch-selected-device-id', selectedDeviceId);
    }
  }, [selectedDeviceId]);

  const [isModelLoaded, setIsModelLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const detectorRef = useRef<PoseDetectorService | null>(null);
  const rendererRef = useRef<GlitchRenderer | null>(null);
  const requestRef = useRef<number>(0);

  const toggleFullScreen = () => {
    if (!document.fullscreenElement) {
      containerRef.current?.requestFullscreen().catch(console.error);
    } else {
      document.exitFullscreen().catch(console.error);
    }
  };

  // Initialize devices
  useEffect(() => {
    async function getDevices() {
      try {
        await navigator.mediaDevices.getUserMedia({ video: true }); // Request permission first
        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const videoDevices = allDevices.filter(d => d.kind === 'videoinput');
        setDevices(videoDevices);
        if (videoDevices.length > 0) {
          const savedId = localStorage.getItem('glitch-selected-device-id');
          const exists = videoDevices.some(d => d.deviceId === savedId);
          if (!savedId || !exists) {
            setSelectedDeviceId(videoDevices[0].deviceId);
          }
        }
      } catch (err) {
        setError('Failed to access webcam. Please ensure permissions are granted.');
        console.error(err);
      }
    }
    getDevices();
  }, []);

  // Initialize models
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

  // Handle stream
  useEffect(() => {
    if (!selectedDeviceId || !videoRef.current) return;

    let stream: MediaStream | null = null;
    let isMounted = true;

    async function startStream() {
      try {
        const newStream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: selectedDeviceId } }
        });

        if (!isMounted) {
          // If unmounted while waiting for stream, stop it immediately
          newStream.getTracks().forEach(track => track.stop());
          return;
        }

        stream = newStream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(console.error);
        }
      } catch (err) {
        if (isMounted) {
          setError('Failed to start video stream.');
          console.error(err);
        }
      }
    }

    startStream();

    return () => {
      isMounted = false;
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [selectedDeviceId]);

  // Render loop
  useEffect(() => {
    if (!isModelLoaded || !videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (!rendererRef.current) {
      rendererRef.current = new GlitchRenderer(canvas);
    }
    const renderer = rendererRef.current;

    let isProcessing = false;

    const renderLoop = async () => {
      try {
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && detectorRef.current && !isProcessing) {
          isProcessing = true;
          try {
            // Resize canvas to match video
            if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
              renderer.resize(video.videoWidth, video.videoHeight);
            }

            const regions = await detectorRef.current.detectPoses(video);

            // Use refs for current state to avoid dependency loop in useEffect
            renderer.render(
              video,
              regions,
              isDynamicModeRef.current,
              fixedIntensityRef.current,
              showDebugRef.current
            );
          } finally {
            isProcessing = false;
          }
        }
      } catch (err) {
        console.error("Error in render loop:", err);
        try {
          // Fallback: just render the video without glitches
          if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
            renderer.resize(video.videoWidth, video.videoHeight);
          }
          renderer.render(video, [], false, 0, false);
        } catch (fallbackErr) {
          console.error("Fallback render failed:", fallbackErr);
        }
        isProcessing = false;
      }
      requestRef.current = requestAnimationFrame(renderLoop);
    };

    // Start loop immediately
    requestRef.current = requestAnimationFrame(renderLoop);

    return () => {
      cancelAnimationFrame(requestRef.current);
    };
  }, [isModelLoaded]);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/50 backdrop-blur-md sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MonitorPlay className="w-6 h-6 text-emerald-400" />
            <h1 className="text-xl font-semibold tracking-tight">GlitchMe</h1>
          </div>

          <div className="flex items-center gap-4">
            {!isModelLoaded && !error && (
              <div className="flex items-center gap-2 text-sm text-zinc-400">
                <div className="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin" />
                Loading AI Model...
              </div>
            )}
          </div>
        </div>
      </header>

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

            {/* Hidden video element for source */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="absolute opacity-0 pointer-events-none"
            />
            {/* Visible canvas for rendering */}
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
                onClick={() => setShowDebug(!showDebug)}
                className={cn(
                  "p-2 rounded-lg backdrop-blur-sm transition-colors",
                  showDebug ? "bg-emerald-500/80 text-white" : "bg-black/50 hover:bg-black/80 text-white"
                )}
              >
                <Bug className="w-5 h-5" />
              </button>
              <button
                onClick={() => setIsCropMode(!isCropMode)}
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
            <div className="flex items-center gap-2 text-zinc-400 mb-2">
              <Camera className="w-4 h-4" />
              <h2 className="text-sm font-medium uppercase tracking-wider">Input Source</h2>
            </div>

            <select
              value={selectedDeviceId}
              onChange={(e) => setSelectedDeviceId(e.target.value)}
              className="w-full bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/50 transition-all"
            >
              {devices.length === 0 && <option value="">No cameras found</option>}
              {devices.map(device => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${device.deviceId.slice(0, 5)}...`}
                </option>
              ))}
            </select>
          </div>

          {/* Glitch Settings */}
          <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800 space-y-6">
            <div className="flex items-center gap-2 text-zinc-400">
              <Settings className="w-4 h-4" />
              <h2 className="text-sm font-medium uppercase tracking-wider">Glitch Engine</h2>
            </div>

            <div className="space-y-4">
              {/* Mode Toggle */}
              <div className="flex bg-zinc-950 p-1 rounded-lg border border-zinc-800">
                <button
                  onClick={() => setIsDynamicMode(true)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
                    isDynamicMode ? "bg-zinc-800 text-emerald-400 shadow-sm" : "text-zinc-500 hover:text-zinc-300"
                  )}
                >
                  <Activity className="w-4 h-4" />
                  Dynamic
                </button>
                <button
                  onClick={() => setIsDynamicMode(false)}
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

              {/* Intensity Slider */}
              <div className="space-y-3 transition-opacity duration-300">
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Intensity</span>
                  <span className="text-zinc-300 font-mono">{Math.round(fixedIntensity * 100)}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="2"
                  step="0.01"
                  value={fixedIntensity}
                  onChange={(e) => setFixedIntensity(parseFloat(e.target.value))}
                  className="w-full accent-emerald-500"
                />
              </div>
            </div>
          </div>



        </div>
      </main>
    </div>
  );
}
