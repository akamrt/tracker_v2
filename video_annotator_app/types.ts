


export type MaskType = 'box' | 'circle';





export interface VideoDimensions {
  width: number;
  height: number;
}

export interface AiAnalysisResult {
  subject: string;
  recommendation: string;
  confidence: string;
}

export enum AppState {
  IDLE = 'IDLE',
  LOADING = 'LOADING',
  READY = 'READY',
  ANALYZING = 'ANALYZING',         // Active tracking (Manual set)
  AUTO_ANALYZING = 'AUTO_ANALYZING', // Automated background tracking
  ANALYZING_PAUSED = 'ANALYZING_PAUSED', // Tracking lost/paused
  PLAYING = 'PLAYING',             // Just playback (review)
  EXPORTING = 'EXPORTING'          // Recording the result
}

export interface KeyTangent {
  x: number; // Frame offset (relative)
  y: number; // Value offset (relative)
}

export interface KeyframeConfig {
  inTangent?: KeyTangent;
  outTangent?: KeyTangent;
  broken?: boolean; // If true, tangents move independently
}

export type PropertyKeyframeConfig = Record<string, KeyframeConfig>; // e.g. { 'x': { ... }, 'opacity': { ... } }

// Augment existing interfaces
export interface TrackingPoint {
  id: string;
  color: string;
  x: number;
  y: number;
  offsetX: number;
  offsetY: number;
  rotation?: number;
  isRotation?: boolean;
  isManual?: boolean;
  matchScore?: number;
  isInactive?: boolean;
  patchSize: number;
  searchWindow: number;
  isStabilizer?: boolean;
  keyframeConfig?: PropertyKeyframeConfig;
  keyedProperties?: string[]; // Only these properties are keyed at this frame
}

export interface MaskObject {
  id: string;
  type: MaskType;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  isManual?: boolean;
  keyframeConfig?: PropertyKeyframeConfig;
  keyedProperties?: string[];
}

export interface ImageAttachment {
  id: string;
  parentId: string;
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  opacity: number;
  aspectRatio: number;
  isManual?: boolean;
  keyframeConfig?: PropertyKeyframeConfig;
  keyedProperties?: string[];
}
