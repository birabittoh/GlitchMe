import * as poseDetection from '@tensorflow-models/pose-detection';
import * as tf from '@tensorflow/tfjs-core';
import * as tfc from '@tensorflow/tfjs-converter';
// Register WebGL backend.
import '@tensorflow/tfjs-backend-webgl';

export type BodyRegion = 'head' | 'torso' | 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg';

export interface Point {
  x: number;
  y: number;
}

export interface BoundingBox {
  xMin: number;
  yMin: number;
  width: number;
  height: number;
}

export interface RegionData {
  id: BodyRegion;
  keypoints: poseDetection.Keypoint[];
  centroid: Point;
  boundingBox: BoundingBox;
  velocity: number; // Normalized [0, 1]
  smoothedVelocity: number;
}

const REGION_KEYPOINTS: Record<BodyRegion, string[]> = {
  head: ['nose', 'left_eye', 'right_eye', 'left_ear', 'right_ear'],
  torso: ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'],
  leftArm: ['left_shoulder', 'left_elbow', 'left_wrist'],
  rightArm: ['right_shoulder', 'right_elbow', 'right_wrist'],
  leftLeg: ['left_hip', 'left_knee', 'left_ankle'],
  rightLeg: ['right_hip', 'right_knee', 'right_ankle'],
};

const SMOOTHING_FACTOR = 0.2;

export class PoseDetectorService {
  private detector: poseDetection.PoseDetector | null = null;
  // Keyed by person ID (or '0' if no ID), then by region ID
  private previousCentroids: Record<number, Partial<Record<BodyRegion, Point>>> = {};
  private previousTime: number = 0;
  private smoothedVelocities: Record<number, Partial<Record<BodyRegion, number>>> = {};
  private offscreenCanvas = document.createElement('canvas');
  private offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true })!;

  async initialize() {
    await tf.setBackend('webgl');
    await tf.ready();

    // Note: Multipose currently only has version 1 available on TFHub
    const MOVENET_URL = 'https://tfhub.dev/google/tfjs-model/movenet/multipose/lightning/1';
    const MODEL_CACHE_KEY = 'movenet-multipose-lightning-v1';
    const MODEL_CACHE_URL = `indexeddb://${MODEL_CACHE_KEY}`;

    try {
      const models = await tf.io.listModels();
      if (!models[MODEL_CACHE_URL]) {
        console.log('Model not found in cache. Downloading and caching to IndexedDB...');
        const graphModel = await tfc.loadGraphModel(MOVENET_URL, { fromTFHub: true });
        await graphModel.save(MODEL_CACHE_URL);
        graphModel.dispose();
        console.log('Model cached successfully.');
      } else {
        console.log('Model found in IndexedDB cache.');
      }
    } catch (err) {
      console.error('Failed to cache model to IndexedDB:', err);
      // Fallback to loading from URL directly if caching fails
    }

    const model = poseDetection.SupportedModels.MoveNet;
    const detectorConfig: poseDetection.MoveNetModelConfig = {
      modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
      enableSmoothing: true,
      enableTracking: true,
      trackerType: poseDetection.TrackerType.BoundingBox,
      modelUrl: MODEL_CACHE_URL
    };

    try {
      this.detector = await poseDetection.createDetector(model, detectorConfig);
    } catch (err) {
      console.warn('Failed to load model from IndexedDB, falling back to URL...', err);
      this.detector = await poseDetection.createDetector(model, {
        modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
        enableSmoothing: true,
        enableTracking: true,
        trackerType: poseDetection.TrackerType.BoundingBox,
      });
    }
  }

  async detectPoses(video: HTMLVideoElement): Promise<RegionData[]> {
    if (!this.detector || video.videoWidth === 0 || video.videoHeight === 0) return [];

    if (this.offscreenCanvas.width !== video.videoWidth || this.offscreenCanvas.height !== video.videoHeight) {
      this.offscreenCanvas.width = video.videoWidth;
      this.offscreenCanvas.height = video.videoHeight;
    }
    this.offscreenCtx.drawImage(video, 0, 0);

    const currentTime = performance.now();
    const deltaTime = (currentTime - this.previousTime) / 1000; // in seconds
    this.previousTime = currentTime;

    const poses = await this.detector.estimatePoses(this.offscreenCanvas, {
      flipHorizontal: false, // We'll handle flipping in rendering if needed
    });

    if (poses.length === 0) return [];

    const allRegions: RegionData[] = [];
    const currentPersonIds = new Set<number>();

    for (const pose of poses) {
      const personId = pose.id ?? 0;
      currentPersonIds.add(personId);

      if (!this.previousCentroids[personId]) {
        this.previousCentroids[personId] = {};
        this.smoothedVelocities[personId] = {};
      }

      const personCentroids = this.previousCentroids[personId];
      const personVelocities = this.smoothedVelocities[personId];

      for (const [regionId, keypointNames] of Object.entries(REGION_KEYPOINTS)) {
        const regionKeypoints = pose.keypoints.filter(
          (kp) => keypointNames.includes(kp.name!) && kp.score && kp.score > 0.3
        );

        if (regionKeypoints.length === 0) continue;

        // Calculate centroid
        const centroid = regionKeypoints.reduce(
          (acc, kp) => ({ x: acc.x + kp.x, y: acc.y + kp.y }),
          { x: 0, y: 0 }
        );
        centroid.x /= regionKeypoints.length;
        centroid.y /= regionKeypoints.length;

        // Calculate bounding box
        const xs = regionKeypoints.map((kp) => kp.x);
        const ys = regionKeypoints.map((kp) => kp.y);
        const xMin = Math.min(...xs);
        const xMax = Math.max(...xs);
        const yMin = Math.min(...ys);
        const yMax = Math.max(...ys);

        // Add some padding to bounding box
        const padding = 20;
        const boundingBox: BoundingBox = {
          xMin: Math.max(0, xMin - padding),
          yMin: Math.max(0, yMin - padding),
          width: xMax - xMin + padding * 2,
          height: yMax - yMin + padding * 2,
        };

        // Calculate velocity
        let velocity = 0;
        const prevCentroid = personCentroids[regionId as BodyRegion];
        if (prevCentroid && deltaTime > 0) {
          const dx = centroid.x - prevCentroid.x;
          const dy = centroid.y - prevCentroid.y;
          const distance = Math.sqrt(dx * dx + dy * dy);

          // Normalize distance by video width to make it resolution independent
          const normalizedDistance = distance / video.videoWidth;
          velocity = normalizedDistance / deltaTime;
        }

        // Normalize velocity (e.g. 2.0 means moving 2x video width per second, which is very fast)
        const MAX_NORMALIZED_VELOCITY = 2.0;
        const normalizedVelocity = Math.min(velocity / MAX_NORMALIZED_VELOCITY, 1.0);

        // Smooth velocity
        const prevSmoothed = personVelocities[regionId as BodyRegion] || 0;
        const smoothedVelocity = prevSmoothed * (1 - SMOOTHING_FACTOR) + normalizedVelocity * SMOOTHING_FACTOR;

        personCentroids[regionId as BodyRegion] = centroid;
        personVelocities[regionId as BodyRegion] = smoothedVelocity;

        allRegions.push({
          id: regionId as BodyRegion,
          keypoints: regionKeypoints,
          centroid,
          boundingBox,
          velocity: normalizedVelocity,
          smoothedVelocity,
        });
      }
    }

    // Cleanup old person data to prevent memory leaks
    for (const personId of Object.keys(this.previousCentroids)) {
      const id = parseInt(personId);
      if (!currentPersonIds.has(id)) {
        delete this.previousCentroids[id];
        delete this.smoothedVelocities[id];
      }
    }

    return allRegions;
  }
}
