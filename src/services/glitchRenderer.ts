import { RegionData } from './poseDetector';

export class GlitchRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private offscreenCanvas: HTMLCanvasElement;
  private offscreenCtx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    this.offscreenCanvas = document.createElement('canvas');
    this.offscreenCtx = this.offscreenCanvas.getContext('2d', { willReadFrequently: true })!;
  }

  resize(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.offscreenCanvas.width = width;
    this.offscreenCanvas.height = height;
  }

  render(
    video: HTMLVideoElement,
    regions: RegionData[],
    isDynamic: boolean,
    fixedIntensity: number,
    showDebug: boolean
  ) {
    const { width, height } = this.canvas;

    this.ctx.save();
    try {
      // Flip horizontally for mirror effect
      this.ctx.translate(width, 0);
      this.ctx.scale(-1, 1);

      // Draw base video frame
      this.ctx.drawImage(video, 0, 0, width, height);

      // Apply glitches to regions
      for (const region of regions) {
        const intensity = isDynamic ? region.smoothedVelocity * fixedIntensity : fixedIntensity;

        if (intensity > 0.05) {
          this.applyGlitch(video, region, intensity);
        }

        if (showDebug) {
          this.drawDebug(region, intensity);
        }
      }
    } finally {
      this.ctx.restore();
    }
  }

  private applyGlitch(video: HTMLVideoElement, region: RegionData, intensity: number) {
    const { xMin, yMin, width, height } = region.boundingBox;
    
    // Ensure bounds are within canvas
    const x = Math.max(0, Math.floor(xMin));
    const y = Math.max(0, Math.floor(yMin));
    const w = Math.min(this.canvas.width - x, Math.floor(width));
    const h = Math.min(this.canvas.height - y, Math.floor(height));

    if (w <= 0 || h <= 0) return;

    // 1. Color Inversion Block
    if (Math.random() < intensity * 0.5) {
      const invW = Math.random() * w * 0.8;
      const invH = Math.random() * h * 0.8;
      const invX = x + Math.random() * (w - invW);
      const invY = y + Math.random() * (h - invH);

      this.ctx.globalCompositeOperation = 'difference';
      this.ctx.fillStyle = 'white';
      this.ctx.fillRect(invX, invY, invW, invH);
      this.ctx.globalCompositeOperation = 'source-over';
    }

    // 2. Horizontal slice displacement
    const numSlices = Math.floor(intensity * 10) + 1;
    const sliceHeight = Math.floor(h / numSlices);
    
    for (let i = 0; i < numSlices; i++) {
        if (Math.random() > intensity) continue; // Only displace some slices based on intensity
        
        const sliceY = y + i * sliceHeight;
        const sliceH = Math.min(sliceHeight, (y + h) - sliceY);
        
        if (sliceH <= 0) continue;

        const displacement = (Math.random() - 0.5) * intensity * 40; // Max 20px displacement
        
        // Draw the displaced slice from the original video
        this.ctx.drawImage(
            video, 
            x, sliceY, w, sliceH, // Source
            x + displacement, sliceY, w, sliceH // Destination
        );
    }

    // 3. Block displacement
    const numBlocks = Math.floor(intensity * 5);
    for (let i = 0; i < numBlocks; i++) {
        const blockW = Math.random() * w * 0.5;
        const blockH = Math.random() * h * 0.5;
        
        if (blockW <= 0 || blockH <= 0) continue;

        const blockX = x + Math.random() * (w - blockW);
        const blockY = y + Math.random() * (h - blockH);
        const displacementX = (Math.random() - 0.5) * intensity * 60;
        const displacementY = (Math.random() - 0.5) * intensity * 60;

        this.ctx.drawImage(
            video,
            blockX, blockY, blockW, blockH,
            blockX + displacementX, blockY + displacementY, blockW, blockH
        );
    }
  }

  private drawDebug(region: RegionData, intensity: number) {
    const { xMin, yMin, width, height } = region.boundingBox;
    
    // Draw bounding box
    this.ctx.strokeStyle = `rgba(0, 255, 0, ${0.5 + intensity * 0.5})`;
    this.ctx.lineWidth = 2;
    this.ctx.strokeRect(xMin, yMin, width, height);

    // Draw keypoints
    this.ctx.fillStyle = 'red';
    for (const kp of region.keypoints) {
      this.ctx.beginPath();
      this.ctx.arc(kp.x, kp.y, 4, 0, 2 * Math.PI);
      this.ctx.fill();
    }

    // Draw centroid
    this.ctx.fillStyle = 'blue';
    this.ctx.beginPath();
    this.ctx.arc(region.centroid.x, region.centroid.y, 6, 0, 2 * Math.PI);
    this.ctx.fill();

    // Draw label and intensity
    this.ctx.save();
    try {
      // Unflip the canvas for text
      this.ctx.scale(-1, 1);
      this.ctx.fillStyle = 'white';
      this.ctx.font = '12px monospace';
      // The x coordinate needs to be mirrored back: -(xMin) - textWidth
      // But we don't know text width easily. Let's just use -(xMin + width)
      this.ctx.fillText(`${region.id} (P${region.personId}): ${intensity.toFixed(2)}`, -(xMin + width), yMin - 5);
    } finally {
      this.ctx.restore();
    }
  }
}
