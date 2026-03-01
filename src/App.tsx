import React, { useEffect, useRef, useState } from 'react';
import { Camera, Settings, Activity, MonitorPlay, Bug, Maximize } from 'lucide-react';
import { PoseDetectorService, RegionData } from './services/poseDetector';
import { GlitchRenderer } from './services/glitchRenderer';
import { cn } from './lib/utils';

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [isDynamicMode, setIsDynamicMode] = useState(true);
  const [fixedIntensity, setFixedIntensity] = useState(0.5);
  const [showDebug, setShowDebug] = useState(false);
  
  const isDynamicModeRef = useRef(isDynamicMode);
  const fixedIntensityRef = useRef(fixedIntensity);
  const showDebugRef = useRef(showDebug);

  useEffect(() => {
    isDynamicModeRef.current = isDynamicMode;
  }, [isDynamicMode]);

  useEffect(() => {
    fixedIntensityRef.current = fixedIntensity;
  }, [fixedIntensity]);

  useEffect(() => {
    showDebugRef.current = showDebug;
  }, [showDebug]);

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
          setSelectedDeviceId(videoDevices[0].deviceId);
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
            className="relative aspect-video bg-zinc-900 rounded-2xl overflow-hidden border border-zinc-800 shadow-2xl group"
          >
            {error ? (
              <div className="absolute inset-0 flex items-center justify-center text-red-400 p-6 text-center">
                {error}
              </div>
            ) : (
              <>
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
                  className="w-full h-full object-contain"
                />
                
                {/* Fullscreen Button */}
                <button
                  onClick={toggleFullScreen}
                  className="absolute bottom-4 right-4 p-2 bg-black/50 hover:bg-black/80 text-white rounded-lg backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Toggle Fullscreen"
                >
                  <Maximize className="w-5 h-5" />
                </button>
              </>
            )}
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
                  ? "Glitch intensity is driven by movement velocity. Move faster for stronger effects." 
                  : "Glitch intensity is fixed and applied uniformly to all detected body parts."}
              </p>

              {/* Fixed Intensity Slider */}
              <div className={cn(
                "space-y-3 transition-opacity duration-300",
                isDynamicMode ? "opacity-50 pointer-events-none" : "opacity-100"
              )}>
                <div className="flex justify-between text-sm">
                  <span className="text-zinc-400">Intensity</span>
                  <span className="text-zinc-300 font-mono">{Math.round(fixedIntensity * 100)}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" 
                  max="1" 
                  step="0.01"
                  value={fixedIntensity}
                  onChange={(e) => setFixedIntensity(parseFloat(e.target.value))}
                  className="w-full accent-emerald-500"
                />
              </div>
            </div>
          </div>

          {/* Debug Settings */}
          <div className="bg-zinc-900 rounded-xl p-5 border border-zinc-800 space-y-4">
            <div className="flex items-center gap-2 text-zinc-400 mb-2">
              <Bug className="w-4 h-4" />
              <h2 className="text-sm font-medium uppercase tracking-wider">Developer</h2>
            </div>
            
            <label className="flex items-center gap-3 cursor-pointer group">
              <div className="relative flex items-center">
                <input 
                  type="checkbox" 
                  checked={showDebug}
                  onChange={(e) => setShowDebug(e.target.checked)}
                  className="sr-only"
                />
                <div className={cn(
                  "w-10 h-6 rounded-full transition-colors",
                  showDebug ? "bg-emerald-500" : "bg-zinc-800"
                )}>
                  <div className={cn(
                    "absolute top-1 left-1 w-4 h-4 bg-white rounded-full transition-transform",
                    showDebug ? "translate-x-4" : "translate-x-0"
                  )} />
                </div>
              </div>
              <span className="text-sm text-zinc-300 group-hover:text-zinc-100 transition-colors">
                Show Debug Overlay
              </span>
            </label>
          </div>

        </div>
      </main>
    </div>
  );
}
