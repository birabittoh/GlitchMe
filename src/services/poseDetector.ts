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
  personId: number;
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
  private previousCentroids: Record<string, Point> = {};
  private previousTime: number = 0;
  private smoothedVelocities: Record<string, number> = {};
  private trackedPeople: { id: number; centroid: Point }[] = [];
  private nextPersonId = 0;
  private offscreenCanvas = document.createElement('canvas');
  private offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true })!;

  async initialize() {
    await tf.setBackend('webgl');
    await tf.ready();

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
    const detectorConfig = {
      modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
      enableSmoothing: true,
      enableTracking: true,
      modelUrl: MODEL_CACHE_URL,
    };

    try {
      this.detector = await poseDetection.createDetector(model, detectorConfig);
    } catch (err) {
      console.warn('Failed to load model from IndexedDB, falling back to URL...', err);
      this.detector = await poseDetection.createDetector(model, {
        modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING,
        enableSmoothing: true,
        enableTracking: true,
      });
    }
  }

  private assignStableIds(poses: poseDetection.Pose[]): number[] {
    const MATCH_THRESHOLD = 150; // pixels

    // Compute overall centroid for each pose
    const centroids = poses.map(pose => {
      const valid = pose.keypoints.filter(kp => kp.score && kp.score > 0.3);
      if (valid.length === 0) return { x: 0, y: 0 };
      const sum = valid.reduce((acc, kp) => ({ x: acc.x + kp.x, y: acc.y + kp.y }), { x: 0, y: 0 });
      return { x: sum.x / valid.length, y: sum.y / valid.length };
    });

    const ids: number[] = new Array(poses.length).fill(-1);
    const usedTracked = new Set<number>();

    // Greedy nearest-neighbor matching
    const pairs: { pi: number; ti: number; dist: number }[] = [];
    for (let pi = 0; pi < centroids.length; pi++) {
      for (let ti = 0; ti < this.trackedPeople.length; ti++) {
        const dx = centroids[pi].x - this.trackedPeople[ti].centroid.x;
        const dy = centroids[pi].y - this.trackedPeople[ti].centroid.y;
        pairs.push({ pi, ti, dist: Math.sqrt(dx * dx + dy * dy) });
      }
    }
    pairs.sort((a, b) => a.dist - b.dist);

    for (const { pi, ti, dist } of pairs) {
      if (ids[pi] !== -1 || usedTracked.has(ti) || dist > MATCH_THRESHOLD) continue;
      ids[pi] = this.trackedPeople[ti].id;
      usedTracked.add(ti);
    }

    // Assign new IDs for unmatched poses
    for (let pi = 0; pi < poses.length; pi++) {
      if (ids[pi] === -1) {
        ids[pi] = this.nextPersonId++;
      }
    }

    // Update tracked people for next frame
    this.trackedPeople = ids.map((id, i) => ({ id, centroid: centroids[i] }));

    return ids;
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

    const personIds = this.assignStableIds(poses);
    const regions: RegionData[] = [];
    const activeKeys = new Set<string>();

    for (let poseIdx = 0; poseIdx < poses.length; poseIdx++) {
      const pose = poses[poseIdx];
      const personId = personIds[poseIdx];

      for (const [regionId, keypointNames] of Object.entries(REGION_KEYPOINTS)) {
        const regionKeypoints = pose.keypoints.filter(
          (kp) => keypointNames.includes(kp.name!) && kp.score && kp.score > 0.3
        );

        if (regionKeypoints.length === 0) continue;

        const trackingKey = `${personId}_${regionId}`;
        activeKeys.add(trackingKey);

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

        // Calculate velocity per limb
        let velocity = 0;
        const prevCentroid = this.previousCentroids[trackingKey];
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
        const prevSmoothed = this.smoothedVelocities[trackingKey] || 0;
        const smoothedVelocity = prevSmoothed * (1 - SMOOTHING_FACTOR) + normalizedVelocity * SMOOTHING_FACTOR;

        this.previousCentroids[trackingKey] = centroid;
        this.smoothedVelocities[trackingKey] = smoothedVelocity;

        regions.push({
          id: regionId as BodyRegion,
          personId,
          keypoints: regionKeypoints,
          centroid,
          boundingBox,
          velocity: normalizedVelocity,
          smoothedVelocity,
        });
      }
    }

    // Clean up stale tracking data for people who left the frame
    for (const key of Object.keys(this.previousCentroids)) {
      if (!activeKeys.has(key)) {
        delete this.previousCentroids[key];
        delete this.smoothedVelocities[key];
      }
    }

    return regions;
  }
}
