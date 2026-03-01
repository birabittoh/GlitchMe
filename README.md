# GlitchMe - AI-Powered Webcam Glitch Art

GlitchMe is a real-time webcam experiment that transforms your movements into dynamic glitch art. Using AI-powered pose detection, it identifies body parts and applies unique visual effects based on your movement velocity.

## Features

- **Real-time AI Pose Detection**: Utilizes TensorFlow.js and the MoveNet model to track body movements with high precision and low latency.
- **Dynamic Glitch Effects**: Visual distortions are applied to detected body parts. In Dynamic Mode, the intensity of the effect is directly driven by how fast you move.
- **Model Caching**: The AI model is cached locally in IndexedDB after the first load, ensuring near-instant startup on subsequent visits.
- **Settings Persistence**: Your preferred glitch intensity and mode are automatically saved and restored.
- **Responsive Design**: Built with Tailwind CSS for a seamless experience across different screen sizes.
- **Privacy Focused**: All AI processing happens locally in your browser. No video data is ever sent to a server.

## Tech Stack

- **Framework**: React 19
- **Build Tool**: Vite
- **AI/ML**: TensorFlow.js, @tensorflow-models/pose-detection (MoveNet)
- **Styling**: Tailwind CSS, Lucide React (Icons), Motion (Animations)
- **Language**: TypeScript

## Getting Started

### Prerequisites

- Node.js (v18 or later recommended)

### Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd glitchme
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```

4. Open your browser and navigate to `http://localhost:3000`.

## How it Works

1. **Camera Input**: The app requests access to your webcam.
2. **Pose Detection**: The MoveNet model analyzes each frame to identify 17 keypoints (nose, shoulders, elbows, etc.).
3. **Region Processing**: Keypoints are grouped into regions (Head, Torso, Arms, Legs).
4. **Velocity Calculation**: The app calculates the movement speed of each region.
5. **Canvas Rendering**: A custom GlitchRenderer applies visual effects (pixel manipulation, RGB shifts) to the identified regions on a 2D canvas.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
