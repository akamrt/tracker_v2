import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Play, Pause, Upload, Target, Video, Activity, Eye, EyeOff, Magnet, SkipBack, SkipForward, ChevronLeft, ChevronRight, Wand2, Trash2, ScanEye, Square, ZoomIn, ZoomOut, Circle, BoxSelect, Settings2, Maximize, Grip, Layers, Lock, Unlock, MousePointer2, Move, LayoutTemplate, List, AlertTriangle, Image as ImageIcon, Copy, Plus, GitCommit, Zap, XCircle, Download, Link, Loader2, Cookie } from 'lucide-react';
import { AppState, TrackingPoint, MaskObject, MaskType, ImageAttachment } from '../types';
import GraphEditor from './GraphEditor';
import { getInterpolatedImages, getInterpolatedTrackers, getInterpolatedMasks } from '../utils/interpolation';

const DEFAULT_PATCH_SIZE = 32;
const DEFAULT_SEARCH_WINDOW = 60;
const DEFAULT_SENSITIVITY = 50;
const DEFAULT_ADAPTIVE = false;

const TRACKER_COLORS = ['#00ff00', '#00ffff', '#ff00ff', '#ffff00', '#ff9900', '#adff2f', '#00bfff'];
const MASK_COLORS = ['#f43f5e', '#3b82f6', '#8b5cf6', '#ec4899'];

// Helper to draw timeline tracks
const drawTimelineTracks = (
    canvas: HTMLCanvasElement,
    duration: number,
    currentTime: number,
    cache: Map<number, TrackingPoint[]>,
    frameCache: Map<number, ImageBitmap>,
    playbackRange: { start: number, end: number },
    isZoomed: boolean
) => {
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { width, height } = canvas;

    ctx.clearRect(0, 0, width, height);

    // Background
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, width, height);

    if (!duration) return;

    // View Window logic
    let viewStart = 0;
    let viewEnd = duration;

    if (isZoomed && playbackRange.end > playbackRange.start) {
        viewStart = playbackRange.start;
        viewEnd = playbackRange.end;
    }
    const viewDuration = viewEnd - viewStart;
    if (viewDuration <= 0) return;

    const timeToX = (t: number) => ((t - viewStart) / viewDuration) * width;

    // Draw Range (Dim outside area)
    const rangeStartX = timeToX(playbackRange.start);
    const rangeEndX = timeToX(playbackRange.end);

    // Draw playable region (lighter)
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(rangeStartX, 0, rangeEndX - rangeStartX, height);

    // Dim areas outside range
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    if (rangeStartX > 0) ctx.fillRect(0, 0, rangeStartX, height);
    if (rangeEndX < width) ctx.fillRect(rangeEndX, 0, width - rangeEndX, height);

    // Draw Frame Cache Indicators
    ctx.fillStyle = "#22c55e"; // Green for cached frames
    const widthPerFrame = Math.max(1, width / (viewDuration * 30));

    // Iterate frames in view for cache check to avoid iterating 1000s of keys
    const startFrame = Math.floor(viewStart * 30);
    const endFrame = Math.ceil(viewEnd * 30);

    for (let f = startFrame; f <= endFrame; f++) {
        if (frameCache.has(f)) {
            const x = timeToX(f / 30);
            ctx.fillRect(x, height - 4, widthPerFrame, 4); // Small bar at bottom
        }
    }

    // Draw Tracking Cache Indicators (Dots/Bars)
    ctx.fillStyle = "rgba(147, 197, 253, 0.4)"; // Blue-ish
    for (const [key, points] of cache.entries()) {
        const time = key / 30;
        if (time >= viewStart && time <= viewEnd) {
            const x = timeToX(time);
            if (points && points.length > 0) {
                ctx.fillRect(x, 0, widthPerFrame, height / 2);
            }
        }
    }

    // Time markers
    const pxPerSec = width / viewDuration;
    let step = 1;
    if (viewDuration < 5) step = 0.1;
    else if (viewDuration < 10) step = 0.5;
    else if (viewDuration < 30) step = 1;
    else if (viewDuration < 60) step = 5;
    else step = 10;

    ctx.fillStyle = "#475569";
    ctx.beginPath();
    for (let i = Math.floor(viewStart / step) * step; i <= viewEnd; i += step) {
        if (i < viewStart) continue;
        const x = timeToX(i);
        const isMajor = Math.abs(i % Math.max(1, Math.floor(step * 5))) < 0.001;
        const h = isMajor ? height : height / 3;
        const y = height - h;
        ctx.fillRect(Math.floor(x), y, 1, h);
    }

    // Playhead
    if (currentTime >= viewStart && currentTime <= viewEnd) {
        const phX = timeToX(currentTime);
        ctx.fillStyle = "#f43f5e";
        ctx.fillRect(phX - 1, 0, 2, height);
    }
};

const VideoWorkspace: React.FC = () => {
    // State
    const [appState, setAppState] = useState<AppState>(AppState.IDLE);
    const [videoSrc, setVideoSrc] = useState<string | null>(null);
    const [videoInfo, setVideoInfo] = useState<{ width: number, height: number, fps: number } | null>(null);

    // YouTube Download
    const [youtubeUrl, setYoutubeUrl] = useState('');
    const [isDownloading, setIsDownloading] = useState(false);
    const [downloadProgress, setDownloadProgress] = useState('');

    // Trackers
    const [trackers, setTrackers] = useState<TrackingPoint[]>([]);
    const [trackerVisibility, setTrackerVisibility] = useState<Record<string, boolean>>({});
    const [trackerInfluence, setTrackerInfluence] = useState<Record<string, boolean>>({});
    const [selectedTrackerId, setSelectedTrackerId] = useState<string | null>(null);

    // Masks
    const [masks, setMasks] = useState<MaskObject[]>([]);
    const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);

    // Images
    const [images, setImages] = useState<ImageAttachment[]>([]);
    const [selectedImageId, setSelectedImageId] = useState<string | null>(null);
    const [graphDataVersion, setGraphDataVersion] = useState(0); // Forcing GraphEditor updates

    const [isStabilized, setIsStabilized] = useState(false);
    const [placementMode, setPlacementMode] = useState<'stabilizer' | 'parent' | null>(null);

    // Transforms
    // viewTransform: The camera view (Pan/Zoom of workspace)
    const [viewTransform, setViewTransform] = useState({ x: 0, y: 0, scale: 0.8 });
    // videoTransform: The manual transform of the video layer relative to the canvas origin
    const [videoTransform, setVideoTransform] = useState({ x: 0, y: 0, scale: 1, rotation: 0 });

    const [cursorStyle, setCursorStyle] = useState('default');

    // Interaction State
    const [isDragging, setIsDragging] = useState(false);
    const [dragTarget, setDragTarget] = useState<'TRACKER' | 'VIEW' | 'VIDEO' | 'MASK' | 'MASK_HANDLE' | 'IMAGE' | null>(null);
    const [dragHandleType, setDragHandleType] = useState<'resize' | null>(null);

    // Layer State
    const [selectedLayer, setSelectedLayer] = useState<'VIDEO' | 'CANVAS' | null>('CANVAS');
    const [isVideoLocked, setIsVideoLocked] = useState(false);
    const [isVideoHidden, setIsVideoHidden] = useState(false);
    const [isCanvasLocked, setIsCanvasLocked] = useState(false);

    // Caching State
    const frameCacheRef = useRef<Map<number, ImageBitmap>>(new Map());
    const [isCaching, setIsCaching] = useState(false);
    const [cacheProgress, setCacheProgress] = useState(0);

    // Drag Refs
    const dragStartPosRef = useRef<{ x: number, y: number } | null>(null); // In relevant local space (Video Space)
    const dragStartElementPosRef = useRef<{ x: number, y: number } | null>(null); // Original pos of element being dragged
    const dragStartClientPosRef = useRef<{ x: number, y: number } | null>(null); // In Screen Space (for view/pan)
    const dragStartViewTransformRef = useRef<{ x: number, y: number, scale: number } | null>(null);
    const dragStartVideoTransformRef = useRef<{ x: number, y: number, scale: number, rotation: number } | null>(null);
    const dragStartDimsRef = useRef<{ w: number, h: number } | null>(null);

    const [isEditingGraph, setIsEditingGraph] = useState(false);
    const [isScrubbingTimeline, setIsScrubbingTimeline] = useState(false);
    const [isSidebarOpen, setIsSidebarOpen] = useState(true);

    const [errorTrackerId, setErrorTrackerId] = useState<string | null>(null);

    // Timeline State
    const [duration, setDuration] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const currentTimeRef = useRef(0); // Rendering Source of Truth
    const lastSeekTimeRef = useRef(0); // For throttling video seeks
    const lastReactUpdateRef = useRef(0); // For throttling heavy React state updates
    const isScrubbingRef = useRef(false); // Independent Scrub Flag
    const [playbackRange, setPlaybackRange] = useState({ start: 0, end: 0 });
    const [isTimelineZoomed, setIsTimelineZoomed] = useState(false);

    // Graph Editor State
    const [isGraphOpen, setIsGraphOpen] = useState(false);
    const [dataVersion, setDataVersion] = useState(0);

    // Refs
    const videoRef = useRef<HTMLVideoElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null); // Display Canvas
    const timelineCanvasRef = useRef<HTMLCanvasElement>(null);
    const requestRef = useRef<number | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const cookieInputRef = useRef<HTMLInputElement>(null);
    const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null); // Compute Canvas
    const containerRef = useRef<HTMLDivElement>(null);

    const templatesRef = useRef<Map<string, ImageData>>(new Map());
    const lastPointsRef = useRef<Map<string, TrackingPoint>>(new Map());
    const trackingCacheRef = useRef<Map<number, TrackingPoint[]>>(new Map());
    const trackerSettingsRef = useRef<Map<string, { patchSize: number, searchWindow: number, sensitivity: number, adaptive: boolean }>>(new Map());

    // START OPTIMIZATION: Cache for interpolation to avoid re-calculating identical frames
    const interpolationCacheRef = useRef<{
        key: number;
        trackers: TrackingPoint[];
        masks: MaskObject[];
        images: ImageAttachment[];
    } | null>(null);

    // BAKED PLAYBACK: Pre-computed positions for every frame in playback range
    const bakedPlaybackRef = useRef<Map<number, {
        trackers: TrackingPoint[];
        masks: MaskObject[];
        images: ImageAttachment[];
    }>>(new Map());
    const isPlaybackBakedRef = useRef(false);

    // Add refs to track exactly what is currently rendered on screen for reliable hit testing
    const renderedPointsRef = useRef<TrackingPoint[]>([]);
    const renderedMasksRef = useRef<MaskObject[]>([]);
    const renderedImagesRef = useRef<ImageAttachment[]>([]);

    const lastMasksRef = useRef<Map<string, MaskObject>>(new Map());
    const maskCacheRef = useRef<Map<number, MaskObject[]>>(new Map());
    const nextMaskIdRef = useRef<number>(1);

    const lastImagesRef = useRef<Map<string, ImageAttachment>>(new Map());
    const imageCacheRef = useRef<Map<number, ImageAttachment[]>>(new Map());
    const loadedImagesRef = useRef<Map<string, HTMLImageElement>>(new Map());
    const nextImageIdRef = useRef<number>(1);

    const historyRef = useRef<Array<{
        trackers: Map<number, TrackingPoint[]>,
        masks: Map<number, MaskObject[]>,
        images: Map<number, ImageAttachment[]>
    }>>([]);

    const currentShiftRef = useRef<{ x: number, y: number }>({ x: 0, y: 0 });
    const currentShiftRotationRef = useRef<number>(0);
    const lastStabilizationKeyRef = useRef<number | null>(null);
    const lastAnalysisKeyRef = useRef<number | null>(null);

    const autoTrackBadFramesRef = useRef<Map<string, number>>(new Map());
    const trackerAgeRef = useRef<Map<string, number>>(new Map());
    const nextTrackerIdRef = useRef<number>(1);

    const mediaRecorderRef = useRef<MediaRecorder | null>(null);
    const recordedChunksRef = useRef<Blob[]>([]);
    const abortControllerRef = useRef<AbortController | null>(null);

    const tickRef = useRef<() => void>(() => { });

    // Clipboard State
    const clipboardWorldPosRef = useRef<{ x: number, y: number } | null>(null);

    // OPTIMIZATION: Refs for Tick Loop to avoid dependency usage
    const trackersRef = useRef(trackers); trackersRef.current = trackers;
    const masksRef = useRef(masks); masksRef.current = masks;
    const imagesRef = useRef(images); imagesRef.current = images;
    const trackerVisibilityRef = useRef(trackerVisibility); trackerVisibilityRef.current = trackerVisibility;
    const trackerInfluenceRef = useRef(trackerInfluence); trackerInfluenceRef.current = trackerInfluence;
    const selectedTrackerIdRef = useRef(selectedTrackerId); selectedTrackerIdRef.current = selectedTrackerId;
    const selectedMaskIdRef = useRef(selectedMaskId); selectedMaskIdRef.current = selectedMaskId;
    const selectedImageIdRef = useRef(selectedImageId); selectedImageIdRef.current = selectedImageId;
    const appStateRef = useRef(appState); appStateRef.current = appState;
    const viewTransformRef = useRef(viewTransform); viewTransformRef.current = viewTransform;
    const videoTransformRef = useRef(videoTransform); videoTransformRef.current = videoTransform;
    const playbackRangeRef = useRef(playbackRange); playbackRangeRef.current = playbackRange;
    const isDraggingRef = useRef(isDragging); isDraggingRef.current = isDragging;
    const dragTargetRef = useRef(dragTarget); dragTargetRef.current = dragTarget;

    // --- Helpers ---

    // Sync Refs with State (So tick loop can read latest without dependencies)
    useEffect(() => {
        trackersRef.current = trackers;
        masksRef.current = masks;
        imagesRef.current = images;
        trackerVisibilityRef.current = trackerVisibility;
        trackerInfluenceRef.current = trackerInfluence;
        selectedTrackerIdRef.current = selectedTrackerId;
        selectedMaskIdRef.current = selectedMaskId;
        selectedImageIdRef.current = selectedImageId;
        appStateRef.current = appState;
        viewTransformRef.current = viewTransform;
        videoTransformRef.current = videoTransform;
        playbackRangeRef.current = playbackRange;
        isDraggingRef.current = isDragging;
        dragTargetRef.current = dragTarget;
    }, [trackers, masks, images, trackerVisibility, trackerInfluence, selectedTrackerId, selectedMaskId, selectedImageId, appState, viewTransform, videoTransform, playbackRange, isDragging, dragTarget]);

    const getKeyFromTime = (time: number) => Math.floor(time * 30);

    const generateId = () => (nextTrackerIdRef.current++).toString();
    const generateMaskId = () => `m${nextMaskIdRef.current++}`;
    const generateImageId = () => `img${nextImageIdRef.current++}`;

    const getNextColor = (currentList: TrackingPoint[] = trackers) => {
        const usedColors = currentList.map(t => t.color);
        return TRACKER_COLORS.find(c => !usedColors.includes(c)) || TRACKER_COLORS[Math.floor(Math.random() * TRACKER_COLORS.length)];
    };

    const clearFutureCacheForIds = (fromKey: number, ids: string[]) => {
        if (ids.length === 0) return;
        const idsSet = new Set(ids);
        const keysToDelete: number[] = [];
        for (const [key, points] of trackingCacheRef.current.entries()) {
            if (key > fromKey) {
                const remainingPoints = points.filter(p => !idsSet.has(p.id));
                if (remainingPoints.length === 0) keysToDelete.push(key);
                else trackingCacheRef.current.set(key, remainingPoints);
            }
        }
        keysToDelete.forEach(k => trackingCacheRef.current.delete(k));
    };

    const saveToHistory = useCallback(() => {
        const trackerSnapshot = new Map<number, TrackingPoint[]>();
        for (const [key, points] of trackingCacheRef.current.entries()) trackerSnapshot.set(key, points.map(p => ({ ...p })));
        const maskSnapshot = new Map<number, MaskObject[]>();
        for (const [key, points] of maskCacheRef.current.entries()) maskSnapshot.set(key, points.map(p => ({ ...p })));
        const imageSnapshot = new Map<number, ImageAttachment[]>();
        for (const [key, imgs] of imageCacheRef.current.entries()) imageSnapshot.set(key, imgs.map(i => ({ ...i })));

        if (historyRef.current.length >= 20) historyRef.current.shift();
        historyRef.current.push({ trackers: trackerSnapshot, masks: maskSnapshot, images: imageSnapshot });
    }, []);

    const handleUndo = useCallback(() => {
        if (historyRef.current.length === 0) return;
        const previousState = historyRef.current.pop();
        if (previousState) {
            trackingCacheRef.current = previousState.trackers;
            maskCacheRef.current = previousState.masks;
            if (videoRef.current) {
                const key = getKeyFromTime(videoRef.current.currentTime);
                const points = trackingCacheRef.current.get(key) || [];
                setTrackers(points);
                points.forEach(p => lastPointsRef.current.set(p.id, p));
                const mks = maskCacheRef.current.get(key) || [];
                setMasks(mks);
                mks.forEach(m => lastMasksRef.current.set(m.id, m));

                imageCacheRef.current = previousState.images || new Map();
                const imgs = imageCacheRef.current.get(key) || [];
                setImages(imgs);
                imgs.forEach(i => lastImagesRef.current.set(i.id, i));
            }
        }
    }, []);

    const resetWorkspace = (newVideoUrl: string) => {
        setVideoSrc(newVideoUrl);
        setAppState(AppState.READY);
        setTrackers([]);
        setMasks([]);
        setImages([]);
        setTrackerVisibility({});
        setTrackerInfluence({});
        setSelectedTrackerId(null);
        setSelectedMaskId(null);
        setErrorTrackerId(null);
        setIsStabilized(false);
        setViewTransform({ x: 0, y: 0, scale: 0.8 });
        setVideoTransform({ x: 0, y: 0, scale: 1, rotation: 0 });
        setIsCanvasLocked(false);
        setVideoInfo(null);

        lastPointsRef.current.clear();
        lastMasksRef.current.clear();
        templatesRef.current.clear();
        trackingCacheRef.current.clear();
        trackerSettingsRef.current.clear();
        maskCacheRef.current.clear();
        renderedPointsRef.current = [];
        renderedMasksRef.current = [];
        historyRef.current = [];
        autoTrackBadFramesRef.current.clear();
        trackerAgeRef.current.clear();
        nextTrackerIdRef.current = 1;
        nextMaskIdRef.current = 1;

        setPlacementMode(null);
        currentShiftRef.current = { x: 0, y: 0 };
        currentShiftRotationRef.current = 0;
        lastAnalysisKeyRef.current = null;
        lastStabilizationKeyRef.current = null;
    };

    const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (file) {
            const url = URL.createObjectURL(file);
            resetWorkspace(url);
        }
    };

    const handleYouTubeDownload = async () => {
        if (!youtubeUrl.trim() || isDownloading) return;

        setIsDownloading(true);
        setDownloadProgress('Downloading video...');

        try {
            // Server downloads to public/downloads/ and returns the static URL
            const res = await fetch(`/api/download?url=${encodeURIComponent(youtubeUrl)}`);
            const data = await res.json();

            if (!res.ok || data.error) {
                throw new Error(data.error || 'Download failed');
            }

            console.log('Download complete:', data);
            setDownloadProgress('Loading video...');

            // Use the static URL served by Vite from public/downloads/
            const videoUrl = data.url;
            console.log('Setting video src to:', videoUrl);

            resetWorkspace(videoUrl);
            setYoutubeUrl('');
            setDownloadProgress('');
        } catch (error: any) {
            console.error('YouTube download error:', error);
            const msg = error.name === 'AbortError' ? 'Download timed out' : error.message;
            setDownloadProgress(`Error: ${msg}`);
            setTimeout(() => setDownloadProgress(''), 5000);
        } finally {
            setIsDownloading(false);
        }
    };


    const togglePlay = () => {
        if (!videoRef.current) return;
        if (appState === AppState.PLAYING || appState === AppState.ANALYZING || appState === AppState.AUTO_ANALYZING) {
            videoRef.current.pause();
            setAppState(AppState.READY);
        } else {
            if (videoRef.current.currentTime < playbackRange.start || videoRef.current.currentTime >= playbackRange.end) {
                videoRef.current.currentTime = playbackRange.start;
            }

            // BAKE PLAYBACK: Pre-compute all frames before playing
            bakePlayback();

            setAppState(prev => {
                if (prev === AppState.ANALYZING || prev === AppState.AUTO_ANALYZING) return prev;
                return AppState.PLAYING;
            });
            videoRef.current.play();
            setPlacementMode(null);
        }
    };

    // Bake all tracker/mask/image positions for the playback range
    const bakePlayback = useCallback(() => {
        const fps = videoInfo?.fps || 30;
        const startFrame = Math.floor(playbackRange.start * fps);
        const endFrame = Math.ceil(playbackRange.end * fps);

        bakedPlaybackRef.current.clear();

        for (let frame = startFrame; frame <= endFrame; frame++) {
            const time = frame / fps;

            // Pre-calculate all interpolated values
            let bakedTrackers = getInterpolatedTrackers(time, trackingCacheRef.current, fps, trackers);
            bakedTrackers = bakedTrackers.map(p => {
                const settings = trackerSettingsRef.current.get(p.id);
                if (settings) { return { ...p, patchSize: settings.patchSize, searchWindow: settings.searchWindow }; }
                return p;
            });

            const bakedMasks = getInterpolatedMasks(time, maskCacheRef.current, fps, masks);
            const bakedImages = getInterpolatedImages(time, imageCacheRef.current, fps, images);

            bakedPlaybackRef.current.set(frame, {
                trackers: bakedTrackers,
                masks: bakedMasks,
                images: bakedImages
            });
        }

        isPlaybackBakedRef.current = true;
        console.log(`Baked ${endFrame - startFrame + 1} frames for playback`);
    }, [videoInfo, playbackRange, trackers, masks, images]);

    // Invalidate baked cache when data changes (user edits)
    useEffect(() => {
        isPlaybackBakedRef.current = false;
    }, [trackers, masks, images, playbackRange]);


    const toggleAnalyze = () => {
        if (!videoRef.current || trackers.length === 0) return;
        if (appState === AppState.ANALYZING) {
            videoRef.current.pause();
            setAppState(AppState.READY);
            lastAnalysisKeyRef.current = null;
            // Auto-bake after analysis for smooth scrubbing
            setTimeout(() => bakePlayback(), 100);
        } else {
            saveToHistory();
            const currentKey = getKeyFromTime(videoRef.current.currentTime);
            const idsToTrack = selectedTrackerId ? [selectedTrackerId] : trackers.map(t => t.id);
            // clearFutureCacheForIds(currentKey, idsToTrack); // Removed per user request to allow overwriting only as we go
            idsToTrack.forEach(id => {
                const t = trackers.find(trk => trk.id === id);
                if (t) {
                    lastPointsRef.current.set(t.id, t);
                    captureTemplate(t);
                }
            });
            lastAnalysisKeyRef.current = currentKey;
            videoRef.current.play();
            setAppState(AppState.ANALYZING);
            setPlacementMode(null);
            setIsStabilized(true);
            setErrorTrackerId(null);
        }
    };



    const handleTimelineChange = (time: number) => {
        if (!videoRef.current) return;

        // Ensure we don't spam tiny updates
        const diff = Math.abs(videoRef.current.currentTime - time);
        const now = performance.now();
        const timeSinceLastSeek = now - lastSeekTimeRef.current;

        // --- OPTIMIZATION START ---

        // 1. Update Ref immediately for UI/Render loop (Source of Truth for Canvas)
        currentTimeRef.current = time;

        // Throttle React State Update (which causes re-render)
        // Only update React state every ~50ms during scrubbing to keep the main thread free for Canvas drawing
        if (!isScrubbingTimeline || now - lastReactUpdateRef.current > 50) {
            setCurrentTime(time);
            // We don't update lastReactUpdateRef here to avoid conflict with the other throttles?
            // Actually we probably should share the throttle timer or be careful.
            // But let's just use the same logic, it's fine if they sync up.
        }

        // 2. Throttle the expensive video element seek
        // If it's a small step (scrubbing), we throttle. 
        // If it's a large jump (click), we do it immediately.
        // CHECK CACHE: If we have the frame in memory, DO NOT SEEK VIDEO. 
        // This is the key to 60fps scrubbing.
        const targetKey = getKeyFromTime(time);
        const hasCache = frameCacheRef.current.has(targetKey);

        // Only touch the video element if we CANNOT serve the frame from cache
        if (!hasCache && diff > 0.001) {
            const isScrubbing = isScrubbingTimeline;
            if (!isScrubbing || timeSinceLastSeek > 16) { // 16ms throttle (~60fps) for scrubbing
                videoRef.current.currentTime = time;
                lastSeekTimeRef.current = now;
            }
        }

        // --- OPTIMIZATION END ---

        const key = getKeyFromTime(time);

        // TRACKERS Logic
        const finalTrackers = getInterpolatedTrackers(time, trackingCacheRef.current, 30, trackers).map(t => {
            const settings = trackerSettingsRef.current.get(t.id);
            if (settings) return { ...t, patchSize: settings.patchSize, searchWindow: settings.searchWindow };
            return t;
        });

        // Use the same scrubbing logic for state throttling
        const isScrubbing = isScrubbingTimeline;

        if (!isScrubbing || now - lastReactUpdateRef.current > 50) {
            setTrackers(finalTrackers);
        }

        // CRITICAL: Update Refs IMMEDIATELY for the tick loop and click handlers
        renderedPointsRef.current = finalTrackers;
        // Update lastPointsRef with current interpolated values to support 'add to nothing' scenarios if needed, 
        // though getInterpolated handles history.
        finalTrackers.forEach(p => lastPointsRef.current.set(p.id, p));
        setErrorTrackerId(null);

        // MASKS Logic
        const finalMasks = getInterpolatedMasks(time, maskCacheRef.current, 30, masks);
        if (!isScrubbing || now - lastReactUpdateRef.current > 50) {
            setMasks(finalMasks);
        }
        renderedMasksRef.current = finalMasks;

        // IMAGES Logic
        const finalImages = getInterpolatedImages(time, imageCacheRef.current, 30, images);
        if (!isScrubbing || now - lastReactUpdateRef.current > 50) {
            setImages(finalImages);
            lastReactUpdateRef.current = now;
        }
        renderedImagesRef.current = finalImages;
    };

    const toggleTimelineZoom = () => setIsTimelineZoomed(prev => !prev);
    const stepFrame = (frames: number) => { if (videoRef.current) handleTimelineChange(Math.max(0, Math.min(duration, videoRef.current.currentTime + (frames / 30)))); };

    const jumpToKeyframe = (direction: 'next' | 'prev') => {
        if (!videoRef.current) return;
        const currentKey = getKeyFromTime(videoRef.current.currentTime);
        const keys = Array.from<number>(trackingCacheRef.current.keys()).sort((a, b) => a - b);
        let targetKey: number | null = null;
        if (direction === 'next') targetKey = keys.find((k) => k > currentKey && trackingCacheRef.current.get(k)?.some(p => p.isManual)) || null;
        else targetKey = keys.reverse().find((k) => k < currentKey && trackingCacheRef.current.get(k)?.some(p => p.isManual)) || null;
        if (targetKey !== null) handleTimelineChange(targetKey / 30);
    };

    const activatePlacement = (type: 'stabilizer' | 'parent') => {
        if (videoRef.current && !videoRef.current.paused) { videoRef.current.pause(); setAppState(AppState.READY); }
        setSelectedTrackerId(null); setSelectedMaskId(null); setPlacementMode(type);
        // Ensure we are tracking on video layer if we place tracker
        if (selectedLayer !== 'VIDEO') setSelectedLayer('VIDEO');
    };

    const spawnMask = (type: MaskType) => {
        if (!videoRef.current) return;
        // Spawn in center of VIDEO coordinates
        const vidW = videoRef.current.videoWidth;
        const vidH = videoRef.current.videoHeight;
        const cx = vidW / 2;
        const cy = vidH / 2;

        const newId = generateMaskId();
        const newMask: MaskObject = {
            id: newId, type: type, color: MASK_COLORS[Math.floor(Math.random() * MASK_COLORS.length)],
            x: cx, y: cy, width: 200, height: type === 'circle' ? 200 : 150, isManual: true
        };
        saveToHistory();
        setMasks(prev => [...prev, newMask]);
        setSelectedMaskId(newId); setSelectedTrackerId(null);
        lastMasksRef.current.set(newId, newMask);
        const key = getKeyFromTime(videoRef.current.currentTime);
        maskCacheRef.current.set(key, [...(maskCacheRef.current.get(key) || []), newMask]);

        if (selectedLayer !== 'VIDEO') setSelectedLayer('VIDEO');
        if (selectedLayer !== 'VIDEO') setSelectedLayer('VIDEO');
    };

    const spawnImage = (img: HTMLImageElement, parentId: string): ImageAttachment => {
        const newId = generateImageId();
        let w = img.naturalWidth;
        let h = img.naturalHeight;

        // Scale down if huge (relative to video width)
        if (videoRef.current) {
            const maxW = videoRef.current.videoWidth * 0.3; // Max 30% of video width
            if (w > maxW) {
                const ratio = maxW / w;
                w *= ratio;
                h *= ratio;
            }
        }

        return {
            id: newId,
            parentId,
            src: img.src,
            x: 0,
            y: 0,
            width: w,
            height: h,
            aspectRatio: w / h,
            rotation: 0,
            opacity: 1,
            isManual: true
        };
    };

    const triggerImageUpload = () => {
        if (!selectedTrackerId) return;
        imageInputRef.current?.click();
    };

    const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file || !selectedTrackerId || !videoRef.current) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            const result = e.target?.result as string;
            if (result) {
                const img = new Image();
                img.onload = () => {
                    loadedImagesRef.current.set(result, img); // Use src as key? No, safer to just cache object or by ID? 
                    // Actually we need to link ID to Img object.
                    // But here we generate ID later.
                    // Let's create object first.
                    saveToHistory();
                    const newImage = spawnImage(img, selectedTrackerId);
                    loadedImagesRef.current.set(newImage.id, img);
                    setImages(prev => [...prev, newImage]);
                    lastImagesRef.current.set(newImage.id, newImage);
                    const key = getKeyFromTime(videoRef.current?.currentTime || 0);
                    imageCacheRef.current.set(key, [...(imageCacheRef.current.get(key) || []), newImage]);
                    setSelectedImageId(newImage.id);
                    // Clear file input
                    if (imageInputRef.current) imageInputRef.current.value = "";
                };
                img.src = result;
            }
        };
        reader.readAsDataURL(file);
    };

    const deleteImage = (id: string) => {
        saveToHistory();
        setImages(prev => prev.filter(i => i.id !== id));
        if (selectedImageId === id) setSelectedImageId(null);
        lastImagesRef.current.delete(id);
        loadedImagesRef.current.delete(id); // Optional, maybe keep cache
        for (const [key, imgs] of imageCacheRef.current.entries()) {
            const filtered = imgs.filter(i => i.id !== id);
            if (filtered.length === 0) imageCacheRef.current.delete(key); else imageCacheRef.current.set(key, filtered);
        }
    };

    // Helper to ensure loadedImages are populated
    const ensureImageLoaded = (imgObj: ImageAttachment) => {
        if (!loadedImagesRef.current.has(imgObj.id)) {
            const img = new Image();
            img.src = imgObj.src;
            loadedImagesRef.current.set(imgObj.id, img);
        }
        return loadedImagesRef.current.get(imgObj.id);
    };

    const deleteTracker = (id: string) => {
        saveToHistory();
        const newTrackers = trackers.filter(t => t.id !== id);
        setTrackers(newTrackers);
        setTrackerVisibility(prev => { const n = { ...prev }; delete n[id]; return n; });
        setTrackerInfluence(prev => { const n = { ...prev }; delete n[id]; return n; });
        templatesRef.current.delete(id); lastPointsRef.current.delete(id); trackerSettingsRef.current.delete(id); autoTrackBadFramesRef.current.delete(id); trackerAgeRef.current.delete(id);
        if (selectedTrackerId === id) setSelectedTrackerId(null);
        if (errorTrackerId === id) setErrorTrackerId(null);
        for (const [key, points] of trackingCacheRef.current.entries()) {
            const filtered = points.filter(p => p.id !== id);
            if (filtered.length === 0) trackingCacheRef.current.delete(key); else trackingCacheRef.current.set(key, filtered);
        }
        if (newTrackers.length === 0 && appState !== AppState.AUTO_ANALYZING) { setAppState(AppState.READY); setIsStabilized(false); }
    };

    const deleteMask = (id: string) => {
        saveToHistory();
        setMasks(prev => prev.filter(m => m.id !== id));
        if (selectedMaskId === id) setSelectedMaskId(null);
        lastMasksRef.current.delete(id);
        for (const [key, masks] of maskCacheRef.current.entries()) {
            const filtered = masks.filter(m => m.id !== id);
            if (filtered.length === 0) maskCacheRef.current.delete(key); else maskCacheRef.current.set(key, filtered);
        }
    };

    const handleImageSelect = (id: string) => {
        setSelectedImageId(id);
        setSelectedMaskId(null);
        setSelectedTrackerId(null);
        if (selectedLayer !== 'VIDEO') setSelectedLayer('VIDEO');
    };

    const addKeyframe = (id: string, property: 'opacity' | 'width' | 'height' | 'rotation', value: number) => {
        if (!videoRef.current) return;
        saveToHistory();
        const key = getKeyFromTime(videoRef.current.currentTime);

        // Update State
        setImages(prev => prev.map(img => img.id === id ? { ...img, [property]: value, isManual: true } : img));

        // Update Cache
        const currentImages = imageCacheRef.current.get(key) || images;
        const index = currentImages.findIndex(i => i.id === id);
        let updatedImages = [...currentImages];

        if (index >= 0) {
            updatedImages[index] = { ...updatedImages[index], [property]: value, isManual: true };
        } else {
            // Should verify we have the image object
            const current = images.find(i => i.id === id);
            if (current) updatedImages.push({ ...current, [property]: value, isManual: true });
        }
        imageCacheRef.current.set(key, updatedImages);

        // Update Last Known
        const last = lastImagesRef.current.get(id);
        if (last) {
            lastImagesRef.current.set(id, { ...last, [property]: value, isManual: true });
        }
        setGraphDataVersion(v => v + 1);
    };

    const toggleAllVisibility = () => {
        const allHidden = Object.values(trackerVisibility).every(v => v === false);
        const newVis = {}; trackers.forEach(t => newVis[t.id] = !allHidden);
        setTrackerVisibility(newVis);
    };
    const toggleAllInfluence = () => {
        const allMuted = Object.values(trackerInfluence).every(v => v === false);
        const newInf = {}; trackers.forEach(t => newInf[t.id] = !allMuted);
        setTrackerInfluence(newInf);
    };

    const cacheFrames = async () => {
        if (!videoRef.current) return;
        setIsCaching(true);
        setAppState(AppState.IDLE); // Stop playback/analysis

        const vid = videoRef.current;
        const fps = videoInfo?.fps || 30;
        const totalFrames = Math.floor(vid.duration * fps);
        const start = Math.floor(playbackRange.start * fps);
        const end = Math.floor(playbackRange.end * fps);
        const count = end - start;

        // Cache chunk
        const CHUNK_SIZE = 240; // Limit to avoid crashing browser memory
        const limit = Math.min(count, CHUNK_SIZE);

        for (let i = 0; i < limit; i++) {
            const frameIdx = start + i;
            vid.currentTime = frameIdx / fps + 0.01; // Tiny offset to ensure we land in the frame
            await new Promise<void>(r => {
                const onSeeked = () => { vid.removeEventListener('seeked', onSeeked); r(); };
                vid.addEventListener('seeked', onSeeked);
            });

            try {
                const bitmap = await createImageBitmap(vid);
                frameCacheRef.current.set(frameIdx, bitmap);
            } catch (e) { console.error("Cache failed for frame", frameIdx, e); }

            setCacheProgress(Math.round(((i + 1) / limit) * 100));
        }

        setIsCaching(false);
        // Return to start
        vid.currentTime = playbackRange.start;
    };
    const toggleTrackerVisibility = (id: string) => setTrackerVisibility(prev => ({ ...prev, [id]: prev[id] === undefined ? false : !prev[id] }));
    const toggleTrackerInfluence = (id: string) => setTrackerInfluence(prev => ({ ...prev, [id]: prev[id] === undefined ? false : !prev[id] }));

    const handleTrackerSelect = (id: string) => {
        setSelectedTrackerId(id); setSelectedMaskId(null); setSelectedImageId(null);
        if (selectedLayer !== 'VIDEO') setSelectedLayer('VIDEO');
        const tracker = trackers.find(t => t.id === id);
        if (tracker && tracker.isInactive && videoRef.current) {
            saveToHistory();
            const activeTracker: TrackingPoint = { ...tracker, isInactive: false, isManual: true };
            setTrackers(prev => prev.map(t => t.id === id ? activeTracker : t));
            lastPointsRef.current.set(id, activeTracker);
            const currentKey = getKeyFromTime(videoRef.current.currentTime);
            const currentPoints = trackingCacheRef.current.get(currentKey) || [];
            const idx = currentPoints.findIndex(p => p.id === id);
            if (idx >= 0) currentPoints[idx] = activeTracker; else currentPoints.push(activeTracker);
            trackingCacheRef.current.set(currentKey, currentPoints);
            captureTemplate(activeTracker);
        }
    };

    const updateTrackerSetting = (id: string, setting: 'patchSize' | 'searchWindow' | 'sensitivity' | 'adaptive' | 'isRotation', value: number | boolean) => {
        saveToHistory();
        setTrackers(prev => prev.map(t => t.id === id ? { ...t, [setting]: value } : t));
        if (setting !== 'isRotation') {
            const cur = trackerSettingsRef.current.get(id) || { patchSize: DEFAULT_PATCH_SIZE, searchWindow: DEFAULT_SEARCH_WINDOW, sensitivity: DEFAULT_SENSITIVITY, adaptive: DEFAULT_ADAPTIVE };
            trackerSettingsRef.current.set(id, { ...cur, [setting]: value } as any);
        }
        const lastPt = lastPointsRef.current.get(id);
        if (lastPt) { lastPointsRef.current.set(id, { ...lastPt, [setting]: value }); }
        if (setting === 'patchSize') {
            const pt = lastPointsRef.current.get(id);
            if (pt) setTimeout(() => captureTemplate(pt), 10);
        }
    };

    const handleMaskSelect = (id: string) => { setSelectedMaskId(id); setSelectedTrackerId(null); setSelectedImageId(null); if (selectedLayer !== 'VIDEO') setSelectedLayer('VIDEO'); };

    // --- Absolute Copy/Paste Logic ---
    const getObjectWorldPos = (id: string, type: 'TRACKER' | 'MASK' | 'IMAGE'): { x: number, y: number } | null => {
        if (type === 'TRACKER') {
            // Trackers are always world space in this app mostly, but can be stabilizers. 
            // In this app, trackers are top-level.
            const t = trackers.find(t => t.id === id);
            return t ? { x: t.x, y: t.y } : null;
        } else if (type === 'MASK') {
            const m = masks.find(m => m.id === id);
            return m ? { x: m.x, y: m.y } : null; // Masks in this app are currently World Space (no parenting implemented for masks yet in this file?)
        } else if (type === 'IMAGE') {
            const img = images.find(i => i.id === id);
            if (!img) return null;
            if (!img.parentId) return { x: img.x, y: img.y };

            // Parented
            const parent = trackers.find(t => t.id === img.parentId);
            if (!parent) return { x: img.x, y: img.y }; // Fallback

            // Calculate World Pos: ParentPos + Rotate(ChildPos)
            // The formula used in rendering is: 
            // ctx.translate(parent.x, parent.y);
            // ctx.rotate(parent.rotation);
            // ctx.translate(child.x, child.y); 

            // So P_world = P_parent + R_parent * P_child
            const r = (parent.rotation || 0) * Math.PI / 180;
            const cos = Math.cos(r);
            const sin = Math.sin(r);

            // child.x/y is relative to parent
            const rx = img.x * cos - img.y * sin;
            const ry = img.x * sin + img.y * cos;

            return {
                x: parent.x + rx,
                y: parent.y + ry
            };
        }
        return null;
    };

    const handleCopyAbsolute = () => {
        let pos: { x: number, y: number } | null = null;
        if (selectedTrackerId) pos = getObjectWorldPos(selectedTrackerId, 'TRACKER');
        else if (selectedMaskId) pos = getObjectWorldPos(selectedMaskId, 'MASK');
        else if (selectedImageId) pos = getObjectWorldPos(selectedImageId, 'IMAGE');

        if (pos) {
            clipboardWorldPosRef.current = pos;
            console.log("Copied Absolute Pos:", pos);
        }
    };

    const handlePasteAbsolute = () => {
        const targetPos = clipboardWorldPosRef.current;
        if (!targetPos) return;
        saveToHistory();

        // We need to set the object's LOCAL x/y such that it lands at targetPos
        if (selectedTrackerId) {
            // Trackers are world space
            setTrackers(prev => prev.map(t => t.id === selectedTrackerId ? { ...t, x: targetPos.x, y: targetPos.y, isManual: true } : t));
            // Update cache/last for current frame
            const t = lastPointsRef.current.get(selectedTrackerId);
            if (t) {
                const updated = { ...t, x: targetPos.x, y: targetPos.y, isManual: true };
                lastPointsRef.current.set(selectedTrackerId, updated);
                const key = getKeyFromTime(videoRef.current?.currentTime || currentTime);
                const cached = trackingCacheRef.current.get(key) || trackers;
                const idx = cached.findIndex(p => p.id === selectedTrackerId);
                const newCached = [...cached];
                if (idx >= 0) newCached[idx] = updated; else newCached.push(updated);
                trackingCacheRef.current.set(key, newCached);
            }
        } else if (selectedMaskId) {
            setMasks(prev => prev.map(m => m.id === selectedMaskId ? { ...m, x: targetPos.x, y: targetPos.y } : m));
            // Update cache/last
            const m = lastMasksRef.current.get(selectedMaskId);
            if (m) {
                const updated = { ...m, x: targetPos.x, y: targetPos.y };
                lastMasksRef.current.set(selectedMaskId, updated);
                const key = getKeyFromTime(videoRef.current?.currentTime || currentTime);
                const cached = maskCacheRef.current.get(key) || masks;
                const idx = cached.findIndex(msk => msk.id === selectedMaskId);
                const newCached = [...cached];
                if (idx >= 0) newCached[idx] = updated; else newCached.push(updated);
                maskCacheRef.current.set(key, newCached);
            }
        } else if (selectedImageId) {
            const img = images.find(i => i.id === selectedImageId);
            if (!img) return;

            let newLocalX = targetPos.x;
            let newLocalY = targetPos.y;

            if (img.parentId) {
                const parent = trackers.find(t => t.id === img.parentId);
                if (parent) {
                    // Start: P_world = P_parent + R_parent * P_child
                    // Target: P_world
                    // P_child = R_parent_inv * (P_world - P_parent)

                    const dx = targetPos.x - parent.x;
                    const dy = targetPos.y - parent.y;

                    const r = -(parent.rotation || 0) * Math.PI / 180; // Inverse rotation
                    const cos = Math.cos(r);
                    const sin = Math.sin(r);

                    newLocalX = dx * cos - dy * sin;
                    newLocalY = dx * sin + dy * cos;
                }
            }

            // Apply updates
            addKeyframe(img.id, 'x' as any, newLocalX); // hack cast because addKeyframe expects specific strings but x/y are valid properties just maybe not in signature? 
            // Wait, addKeyframe signature is: (id: string, property: 'opacity' | 'width' | 'height' | 'rotation', value: number)
            // It doesn't support 'x' or 'y'. I should update addKeyframe or manually update.
            // Let's manually update to be safe essentially replicating addKeyframe logic for x/y.

            const properties = { x: newLocalX, y: newLocalY, isManual: true };

            // Update State
            setImages(prev => prev.map(i => i.id === img.id ? { ...i, ...properties } : i));

            // Update Cache
            const key = getKeyFromTime(videoRef.current?.currentTime || currentTime);
            const currentImages = imageCacheRef.current.get(key) || images;
            const index = currentImages.findIndex(i => i.id === img.id);
            let updatedImages = [...currentImages];
            if (index >= 0) {
                updatedImages[index] = { ...updatedImages[index], ...properties };
            } else {
                // Push current state logic...
                const last = lastImagesRef.current.get(img.id) || img;
                updatedImages.push({ ...last, ...properties });
            }
            imageCacheRef.current.set(key, updatedImages);

            // Update Last Known
            const last = lastImagesRef.current.get(img.id);
            if (last) {
                lastImagesRef.current.set(img.id, { ...last, ...properties });
            }
            setGraphDataVersion(v => v + 1);
        }
    };

    // --- CV ---
    const findGoodFeatures = (ctx: CanvasRenderingContext2D, width: number, height: number): { x: number, y: number }[] => {
        const GRID_SIZE = 80; const MARGIN = 40; const candidates: { x: number, y: number }[] = [];
        const cols = Math.floor((width - 2 * MARGIN) / GRID_SIZE); const rows = Math.floor((height - 2 * MARGIN) / GRID_SIZE);
        let gridCells: { c: number, r: number }[] = [];
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) gridCells.push({ c, r });
        for (let i = gridCells.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[gridCells[i], gridCells[j]] = [gridCells[j], gridCells[i]]; }
        for (const cell of gridCells) {
            const cellX = MARGIN + cell.c * GRID_SIZE; const cellY = MARGIN + cell.r * GRID_SIZE;
            if (trackers.some(t => Math.abs(t.x - (cellX + GRID_SIZE / 2)) < GRID_SIZE * 0.8 && Math.abs(t.y - (cellY + GRID_SIZE / 2)) < GRID_SIZE * 0.8)) continue;
            try {
                const imgData = ctx.getImageData(cellX, cellY, GRID_SIZE, GRID_SIZE);
                const data = imgData.data; let maxContrast = 0; let bestX = 0; let bestY = 0;
                for (let y = 0; y < GRID_SIZE - 4; y += 4) for (let x = 0; x < GRID_SIZE - 4; x += 4) {
                    const i = (y * GRID_SIZE + x) * 4;
                    const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    const rightLum = (data[i + 4] + data[i + 5] + data[i + 6]) / 3;
                    const downLum = (data[i + GRID_SIZE * 4] + data[i + GRID_SIZE * 4 + 1] + data[i + GRID_SIZE * 4 + 2]) / 3;
                    const contrast = Math.abs(lum - rightLum) + Math.abs(lum - downLum);
                    if (contrast > maxContrast) { maxContrast = contrast; bestX = x; bestY = y; }
                }
                if (maxContrast > 30) candidates.push({ x: cellX + bestX, y: cellY + bestY });
            } catch (e) { }
        }
        return candidates;
    };

    // Convert Screen Event -> Video Space Coordinates
    const getVideoCoords = (e: React.PointerEvent) => {
        if (!canvasRef.current || !videoRef.current) return { x: 0, y: 0 };

        const rect = canvasRef.current.getBoundingClientRect();

        // Calculate scaling factor between Display Size (CSS) and Canvas Resolution
        // This handles High DPI screens and browser zoom levels where rect.width != canvas.width
        const scaleX = canvasRef.current.width / rect.width;
        const scaleY = canvasRef.current.height / rect.height;

        const canvasX = (e.clientX - rect.left) * scaleX;
        const canvasY = (e.clientY - rect.top) * scaleY;

        // 1. Inverse View Transform (Canvas -> Workspace)
        const workspaceX = (canvasX - viewTransform.x) / viewTransform.scale;
        const workspaceY = (canvasY - viewTransform.y) / viewTransform.scale;

        // 2. Inverse Video Manual Transform (Workspace -> Video Local Plane)
        const vidLocalX = (workspaceX - videoTransform.x) / videoTransform.scale;
        const vidLocalY = (workspaceY - videoTransform.y) / videoTransform.scale;

        // 3. Inverse Stabilization Transform (Applied during render)
        // Note: Video dimensions for Pivot should match the internal resolution logic
        const pivotX = videoRef.current.videoWidth / 2;
        const pivotY = videoRef.current.videoHeight / 2;
        const shiftX = currentShiftRef.current.x;
        const shiftY = currentShiftRef.current.y;
        const shiftRot = currentShiftRotationRef.current;

        // P_final = P_local - (Pivot + Shift)
        // Visual Render Logic: T(pivot+shift) * R(rot) * T(-pivot) * P
        // Inverse Logic: T(pivot) * R(-rot) * T(-(pivot+shift)) * P_Visual

        const pFinalX = vidLocalX - (pivotX + shiftX);
        const pFinalY = vidLocalY - (pivotY + shiftY);

        // Inverse Rotation
        const rad = -shiftRot * Math.PI / 180;
        const rotX = pFinalX * Math.cos(rad) - pFinalY * Math.sin(rad);
        const rotY = pFinalX * Math.sin(rad) + pFinalY * Math.cos(rad);

        // Add Pivot back
        const videoX = rotX + pivotX;
        const videoY = rotY + pivotY;

        return { x: videoX, y: videoY };
    };

    const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        e.preventDefault();
        if (!canvasRef.current || !videoRef.current) return;
        const allowedStates = [AppState.READY, AppState.IDLE, AppState.ANALYZING_PAUSED, AppState.PLAYING];
        if (!allowedStates.includes(appState)) return;
        if (appState === AppState.PLAYING) { videoRef.current.pause(); setAppState(AppState.READY); }

        // IMPORTANT: Prioritize hit testing to ensure Trackers/Masks are selected over Background.
        const { x: videoX, y: videoY } = getVideoCoords(e);
        const zoomLevel = viewTransform.scale * videoTransform.scale;

        // Improved Hit Testing Logic
        // We strictly use visual boundaries for selection.
        // Screen Hit Radius is only a fallback for very small points, but we prioritize "Inside Visual Shape" first.
        const SCREEN_SLOP = 10; // 10px slop in screen space for small points

        const getScreenDist = (x1: number, y1: number, x2: number, y2: number) => {
            return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2)) * zoomLevel;
        };

        if (placementMode) {
            addTrackerAt(videoX, videoY, placementMode === 'stabilizer');
            return;
        }

        let hitFound = false;

        if (!isVideoHidden) {
            // Use RENDERED masks for hit testing to match what is visible on screen
            const renderedMasks = renderedMasksRef.current.length > 0 ? renderedMasksRef.current : masks;

            // Priority 1: Mask Handles (Resizing)
            for (const m of renderedMasks) {
                const currentM = lastMasksRef.current.get(m.id) || m;
                if (selectedMaskId === m.id) {
                    let hx = 0, hy = 0;
                    // Handle is at bottom-right of box, or right-edge of circle
                    if (currentM.type === 'circle') { hx = currentM.width / 2 + currentM.x; hy = currentM.y; }
                    else { hx = currentM.width / 2 + currentM.x; hy = currentM.height / 2 + currentM.y; }

                    // Visual Handle Size is 10px screen space
                    const handleDist = getScreenDist(hx, hy, videoX, videoY);

                    if (handleDist < 15) { // 15px screen radius for handle
                        handleMaskSelect(m.id);
                        setDragTarget('MASK_HANDLE');
                        setDragHandleType('resize');
                        setIsDragging(true);
                        dragStartPosRef.current = { x: videoX, y: videoY };
                        dragStartDimsRef.current = { w: currentM.width, h: currentM.height };
                        dragStartElementPosRef.current = { x: currentM.x, y: currentM.y };
                        canvasRef.current.setPointerCapture(e.pointerId);

                        if (renderedMasksRef.current.length > 0) setMasks(renderedMasksRef.current);
                        saveToHistory();
                        e.stopPropagation(); return;
                    }
                }
            }

            // Priority 2: Trackers (Selection & Movement)
            const visibleTrackers = renderedPointsRef.current.length > 0 ? renderedPointsRef.current : trackers;

            let clickedTrackerId: string | null = null;

            // Check exact bounds first
            for (const t of visibleTrackers) {
                if (trackerVisibility[t.id] === false) continue;
                const currentT = lastPointsRef.current.get(t.id) || t;
                const pSize = currentT.patchSize || DEFAULT_PATCH_SIZE;

                // Box Check
                const halfSize = pSize / 2;
                if (videoX >= currentT.x - halfSize && videoX <= currentT.x + halfSize &&
                    videoY >= currentT.y - halfSize && videoY <= currentT.y + halfSize) {
                    clickedTrackerId = t.id;
                    break;
                }
            }

            // If not clicked strictly inside, check proximity (Slop)
            if (!clickedTrackerId) {
                let closestDist = Number.MAX_VALUE;
                for (const t of visibleTrackers) {
                    if (trackerVisibility[t.id] === false) continue;
                    const currentT = lastPointsRef.current.get(t.id) || t;
                    const dist = getScreenDist(currentT.x, currentT.y, videoX, videoY);
                    if (dist < SCREEN_SLOP && dist < closestDist) {
                        closestDist = dist;
                        clickedTrackerId = t.id;
                    }
                }
            }

            if (clickedTrackerId) {
                hitFound = true;
                if (renderedPointsRef.current.length > 0) {
                    setTrackers(renderedPointsRef.current);
                    renderedPointsRef.current.forEach(p => lastPointsRef.current.set(p.id, p));
                }

                handleTrackerSelect(clickedTrackerId);
                setDragTarget('TRACKER');
                setIsDragging(true);
                dragStartPosRef.current = { x: videoX, y: videoY };

                const t = lastPointsRef.current.get(clickedTrackerId) || visibleTrackers.find(tr => tr.id === clickedTrackerId);
                if (t) {
                    dragStartElementPosRef.current = { x: t.x, y: t.y };
                }
                canvasRef.current.setPointerCapture(e.pointerId);
                saveToHistory();
                if (clickedTrackerId === errorTrackerId) { setErrorTrackerId(null); if (appState === AppState.ANALYZING_PAUSED) setAppState(AppState.READY); }
                e.stopPropagation(); return;
            }

            // Priority 3: Mask Bodies
            let clickedMaskId: string | null = null;

            const checkMaskHit = (m: MaskObject, vx: number, vy: number) => {
                const currentM = lastMasksRef.current.get(m.id) || m;
                if (currentM.type === 'circle') {
                    return Math.sqrt(Math.pow(currentM.x - vx, 2) + Math.pow(currentM.y - vy, 2)) <= currentM.width / 2;
                } else {
                    return vx >= currentM.x - currentM.width / 2 && vx <= currentM.x + currentM.width / 2 &&
                        vy >= currentM.y - currentM.height / 2 && vy <= currentM.y + currentM.height / 2;
                }
            };

            // Check selected mask first
            if (selectedMaskId) {
                const m = renderedMasks.find(mk => mk.id === selectedMaskId);
                if (m && checkMaskHit(m, videoX, videoY)) {
                    clickedMaskId = m.id;
                }
            }

            if (!clickedMaskId) {
                for (let i = renderedMasks.length - 1; i >= 0; i--) {
                    const m = renderedMasks[i];
                    if (m.id === selectedMaskId) continue;
                    if (checkMaskHit(m, videoX, videoY)) { clickedMaskId = m.id; break; }
                }
            }

            if (clickedMaskId) {
                hitFound = true;
                if (renderedMasksRef.current.length > 0) {
                    setMasks(renderedMasksRef.current);
                    renderedMasksRef.current.forEach(m => lastMasksRef.current.set(m.id, m));
                }
                handleMaskSelect(clickedMaskId);
                setDragTarget('MASK');
                setIsDragging(true);
                dragStartPosRef.current = { x: videoX, y: videoY };
                const m = lastMasksRef.current.get(clickedMaskId) || renderedMasks.find(k => k.id === clickedMaskId);
                if (m) dragStartElementPosRef.current = { x: m.x, y: m.y };
                canvasRef.current.setPointerCapture(e.pointerId);
                saveToHistory();
                e.stopPropagation(); return;
            }
        }

        // Check Images
        if (!hitFound) {
            for (const img of renderedImagesRef.current) {
                const parent = trackers.find(t => t.id === img.parentId);
                if (!parent || trackerVisibility[parent.id] === false) continue;

                let lx = videoX - parent.x;
                let ly = videoY - parent.y;
                if (parent.rotation) {
                    const r = -parent.rotation * Math.PI / 180;
                    const rx = lx * Math.cos(r) - ly * Math.sin(r);
                    const ry = lx * Math.sin(r) + ly * Math.cos(r);
                    lx = rx; ly = ry;
                }
                lx -= img.x;
                ly -= img.y;
                if (img.rotation) {
                    const r = -img.rotation * Math.PI / 180;
                    const rx = lx * Math.cos(r) - ly * Math.sin(r);
                    const ry = lx * Math.sin(r) + ly * Math.cos(r);
                    lx = rx; ly = ry;
                }

                const hw = img.width / 2;
                const hh = img.height / 2;

                // Handle Gizmo Logic (if selected)
                if (selectedImageId === img.id) {
                    const zoomLevel = viewTransform.scale * videoTransform.scale;
                    const handleSize = 10 / zoomLevel;
                    const rotStickLen = 20 / zoomLevel;

                    // Check Rotation Handle
                    // Tip of stick is at (0, -hh - rotStickLen) in local space
                    const dxRot = lx - 0;
                    const dyRot = ly - (-hh - rotStickLen);
                    if (Math.sqrt(dxRot * dxRot + dyRot * dyRot) < handleSize) {
                        hitFound = true;
                        setIsDragging(true);
                        setDragTarget('IMAGE_ROTATE');  // Custom target
                        canvasRef.current.setPointerCapture(e.pointerId);
                        dragStartPosRef.current = { x: videoX, y: videoY };
                        // Store current rotation as "x" for convenience, or add dedicated cache
                        dragStartElementPosRef.current = { x: img.rotation, y: 0 };
                        e.stopPropagation(); return;
                    }

                    // Check Scale Handles
                    // TL, TR, BR, BL
                    const corners = [
                        { id: 'TL', x: -hw, y: -hh }, { id: 'TR', x: hw, y: -hh },
                        { id: 'BR', x: hw, y: hh }, { id: 'BL', x: -hw, y: hh }
                    ];
                    for (const c of corners) {
                        if (Math.abs(lx - c.x) < handleSize && Math.abs(ly - c.y) < handleSize) {
                            hitFound = true;
                            setIsDragging(true);
                            setDragTarget('IMAGE_SCALE');
                            canvasRef.current.setPointerCapture(e.pointerId);
                            dragStartPosRef.current = { x: videoX, y: videoY };
                            dragStartElementPosRef.current = { x: img.width, y: img.height }; // Store Start Dims
                            dragStartDimsRef.current = { w: img.width, h: img.height }; // Abuse Dims Ref for consistency
                            // We need to know WHICH corner. Hack: Store in a randomly available Ref or add one?
                            // Let's use `activeTrackerIdRef` (misused) or just closure? Can't use closure in React Handler easily without re-binding.
                            // Actually, we can use `dragStartDimsRef` to store metadata if we type cast? No.
                            // Let's add `dragCornerRef` to state or just assume uniform scaling from center for now?
                            // Better: Store corner ID in `dragStartElementPosRef` ?? No, type number.
                            // Let's rely on calculating based on quadrant later or just store in a new transient ref which I can't add easily.
                            // Alternative: `dragStartElementPosRef.current` = { x: img.width, y: img.height, ... } - JS allows extra props? Yes.
                            (dragStartElementPosRef.current as any).corner = c.id;
                            e.stopPropagation(); return;
                        }
                    }
                }

                if (lx >= -hw && lx <= hw && ly >= -hh && ly <= hh) {
                    hitFound = true;
                    handleImageSelect(img.id);
                    setIsDragging(true);
                    setDragTarget('IMAGE');
                    canvasRef.current.setPointerCapture(e.pointerId);
                    dragStartPosRef.current = { x: videoX, y: videoY };
                    dragStartElementPosRef.current = { x: img.x, y: img.y };
                    saveToHistory();
                    e.stopPropagation();
                    return;
                }
            }
        }

        // Priority 4: Background Dragging

        // If we didn't hit any object, check if we need to DESELECT first.
        // If something was selected, clicking background should DESELECT it.
        // To prevent accidental "deselect and drag" in one motion which can be jarring,
        // we simply deselect and return, requiring a second click to drag. 
        // OR we can deselect and immediately allow dragging.
        // User requested "If selected, don't move video". 
        // This implies clicking background while selected should JUST deselect.
        if (!hitFound && (selectedTrackerId || selectedMaskId)) {
            setSelectedTrackerId(null);
            setSelectedMaskId(null);
            return;
        }

        setSelectedTrackerId(null); setSelectedMaskId(null);
        dragStartClientPosRef.current = { x: e.clientX, y: e.clientY };

        if (selectedLayer === 'VIDEO' && !isVideoLocked) {
            setDragTarget('VIDEO');
            dragStartVideoTransformRef.current = { ...videoTransform };
            setIsDragging(true);
            canvasRef.current.setPointerCapture(e.pointerId);
        } else if (!isCanvasLocked) {
            setDragTarget('VIEW');
            dragStartViewTransformRef.current = { ...viewTransform };
            setIsDragging(true);
            canvasRef.current.setPointerCapture(e.pointerId);
        }
    };

    const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const { x: videoX, y: videoY } = getVideoCoords(e);
        const zoomLevel = viewTransform.scale * videoTransform.scale;

        if (!isDragging) {
            // Hover Cursor Logic
            const getScreenDist = (x1: number, y1: number, x2: number, y2: number) => {
                return Math.sqrt(Math.pow(x1 - x2, 2) + Math.pow(y1 - y2, 2)) * zoomLevel;
            };

            let hoverCursor = 'default';

            if (placementMode) {
                hoverCursor = 'crosshair';
            } else if (!isVideoHidden) {
                // Use Rendered list for hover detection too
                const renderedMasks = renderedMasksRef.current.length > 0 ? renderedMasksRef.current : masks;
                const renderedPoints = renderedPointsRef.current.length > 0 ? renderedPointsRef.current : trackers;

                // 1. Check Mask Handles
                for (const m of renderedMasks) {
                    const currentM = lastMasksRef.current.get(m.id) || m;
                    if (selectedMaskId === m.id) {
                        let hx = 0, hy = 0;
                        if (currentM.type === 'circle') { hx = currentM.width / 2 + currentM.x; hy = currentM.y; } else { hx = currentM.width / 2 + currentM.x; hy = currentM.height / 2 + currentM.y; }
                        if (getScreenDist(hx, hy, videoX, videoY) < 15) {
                            hoverCursor = 'nwse-resize';
                            break;
                        }
                    }
                }

                // 2. Check Trackers
                if (hoverCursor === 'default') {
                    for (const t of renderedPoints) {
                        if (trackerVisibility[t.id] === false) continue;
                        const currentT = lastPointsRef.current.get(t.id) || t;
                        const pSize = currentT.patchSize || DEFAULT_PATCH_SIZE;
                        const halfSize = pSize / 2;

                        // Strict box check
                        if (videoX >= currentT.x - halfSize && videoX <= currentT.x + halfSize &&
                            videoY >= currentT.y - halfSize && videoY <= currentT.y + halfSize) {
                            hoverCursor = 'pointer';
                            break;
                        }

                        // Proximity check
                        if (getScreenDist(currentT.x, currentT.y, videoX, videoY) < 10) {
                            hoverCursor = 'pointer';
                            break;
                        }
                    }
                }

                // 3. Check Mask Bodies
                if (hoverCursor === 'default') {
                    for (const m of renderedMasks) {
                        const currentM = lastMasksRef.current.get(m.id) || m;
                        let isBody = false;
                        if (currentM.type === 'circle') { if (Math.sqrt(Math.pow(currentM.x - videoX, 2) + Math.pow(currentM.y - videoY, 2)) <= currentM.width / 2) isBody = true; }
                        else { if (videoX >= currentM.x - currentM.width / 2 && videoX <= currentM.x + currentM.width / 2 && videoY >= currentM.y - currentM.height / 2 && videoY <= currentM.y + currentM.height / 2) isBody = true; }
                        if (isBody) { hoverCursor = 'move'; break; }
                    }
                }

                // 4. Check Images
                if (hoverCursor === 'default') {
                    for (const img of renderedImagesRef.current) {
                        const parent = trackers.find(t => t.id === img.parentId);
                        if (!parent || trackerVisibility[parent.id] === false) continue;

                        // Check hit in local space
                        let lx = videoX - parent.x;
                        let ly = videoY - parent.y;
                        if (parent.rotation) {
                            const r = -parent.rotation * Math.PI / 180;
                            const rx = lx * Math.cos(r) - ly * Math.sin(r);
                            const ry = lx * Math.sin(r) + ly * Math.cos(r);
                            lx = rx; ly = ry;
                        }
                        lx -= img.x;
                        ly -= img.y;
                        if (img.rotation) {
                            const r = -img.rotation * Math.PI / 180;
                            const rx = lx * Math.cos(r) - ly * Math.sin(r);
                            const ry = lx * Math.sin(r) + ly * Math.cos(r);
                            lx = rx; ly = ry;
                        }

                        const hw = img.width / 2;
                        const hh = img.height / 2;

                        if (selectedImageId === img.id) {
                            const zoomLevel = viewTransform.scale * videoTransform.scale;
                            // Check Handles (Local Space Logic)
                            const handleSize = 10 / zoomLevel;
                            const rotStickLen = 20 / zoomLevel;
                            // Rotate
                            const dxRot = lx - 0;
                            const dyRot = ly - (-hh - rotStickLen);
                            if (Math.sqrt(dxRot * dxRot + dyRot * dyRot) < handleSize) {
                                hoverCursor = 'grab'; break;
                            }
                            // Scale
                            const corners = [
                                { x: -hw, y: -hh }, { x: hw, y: -hh },
                                { x: hw, y: hh }, { x: -hw, y: hh }
                            ];
                            let cornerHit = false;
                            for (const c of corners) {
                                if (Math.abs(lx - c.x) < handleSize && Math.abs(ly - c.y) < handleSize) {
                                    hoverCursor = 'nwse-resize'; cornerHit = true; break;
                                }
                            }
                            if (cornerHit) break;
                        }

                        if (lx >= -hw && lx <= hw && ly >= -hh && ly <= hh) {
                            hoverCursor = 'move';
                            break;
                        }
                    }
                }
            }

            if (hoverCursor === 'default') {
                // Only show move/grab cursor if we aren't locking selection
                if (!selectedTrackerId && !selectedMaskId) {
                    if (selectedLayer === 'VIDEO' && !isVideoLocked) hoverCursor = 'move';
                    else if (!isCanvasLocked) hoverCursor = 'grab';
                }
            }

            if (cursorStyle !== hoverCursor) setCursorStyle(hoverCursor);
        }

        if (!isDragging || !canvasRef.current || !videoRef.current) return;

        if (dragTarget === 'VIEW') {
            if (!dragStartClientPosRef.current || !dragStartViewTransformRef.current) return;
            const dx = e.clientX - dragStartClientPosRef.current.x;
            const dy = e.clientY - dragStartClientPosRef.current.y;
            const start = dragStartViewTransformRef.current;
            setViewTransform({ ...start, x: start.x + dx, y: start.y + dy });
        }
        else if (dragTarget === 'VIDEO') {
            if (!dragStartClientPosRef.current || !dragStartVideoTransformRef.current) return;
            // Movement in screen pixels needs to be converted to Workspace pixels to apply to video offset
            const dxScreen = e.clientX - dragStartClientPosRef.current.x;
            const dyScreen = e.clientY - dragStartClientPosRef.current.y;

            const dxWorkspace = dxScreen / viewTransform.scale;
            const dyWorkspace = dyScreen / viewTransform.scale;

            const start = dragStartVideoTransformRef.current;
            setVideoTransform({ ...start, x: start.x + dxWorkspace, y: start.y + dyWorkspace });
        }
        else if (dragTarget === 'TRACKER' && selectedTrackerId) {
            // Delta-based drag to prevent snapping
            const dx = videoX - (dragStartPosRef.current?.x || 0);
            const dy = videoY - (dragStartPosRef.current?.y || 0);

            // 1. Calculate new state locally
            const newTrackers = trackers.map(t => {
                if (t.id === selectedTrackerId) {
                    const newX = (dragStartElementPosRef.current?.x || t.x) + dx;
                    const newY = (dragStartElementPosRef.current?.y || t.y) + dy;
                    return {
                        ...t,
                        x: newX,
                        y: newY,
                        offsetX: (newX + t.offsetX) - videoX,
                        offsetY: (newY + t.offsetY) - videoY,
                        isManual: true,
                        matchScore: 100,
                        isInactive: false
                    };
                }
                return t;
            });

            // 2. update REFS immediately for Render Loop
            renderedPointsRef.current = newTrackers;
            newTrackers.forEach(t => lastPointsRef.current.set(t.id, t));

            // 3. Update CACHE immediately so getInterpolated picks it up next frame
            const currentKey = getKeyFromTime(currentTimeRef.current);
            trackingCacheRef.current.set(currentKey, newTrackers);

            // 4. Throttle State Update
            const now = performance.now();
            if (now - lastReactUpdateRef.current > 32) { // ~30fps state update for UI
                setTrackers(newTrackers);
                lastReactUpdateRef.current = now;
            }
        }
        else if ((dragTarget === 'MASK' || dragTarget === 'MASK_HANDLE') && selectedMaskId) {
            const dx = videoX - (dragStartPosRef.current?.x || 0);
            const dy = videoY - (dragStartPosRef.current?.y || 0);

            // 1. Calculate new state locally
            const newMasks = masks.map(m => {
                if (m.id === selectedMaskId) {
                    if (dragTarget === 'MASK') {
                        // Apply delta to original position
                        return {
                            ...m,
                            x: (dragStartElementPosRef.current?.x || m.x) + dx,
                            y: (dragStartElementPosRef.current?.y || m.y) + dy,
                            isManual: true
                        };
                    }
                    else {
                        if (!dragStartDimsRef.current) return m;
                        const newW = Math.max(10, dragStartDimsRef.current.w + dx * 2);
                        const newH = m.type === 'circle' ? newW : Math.max(10, dragStartDimsRef.current.h + dy * 2);
                        return { ...m, width: newW, height: newH, isManual: true };
                    }
                }
                return m;
            });

            // 2. update REFS immediately
            renderedMasksRef.current = newMasks;
            newMasks.forEach(m => lastMasksRef.current.set(m.id, m));

            // 3. Update CACHE
            const currentKey = getKeyFromTime(currentTimeRef.current);
            maskCacheRef.current.set(currentKey, newMasks);

            // 4. Throttle State Update
            const now = performance.now();
            if (now - lastReactUpdateRef.current > 32) {
                setMasks(newMasks);
                lastReactUpdateRef.current = now;
            }
        }
        else if (dragTarget === 'IMAGE_ROTATE' && selectedImageId) {
            const img = images.find(i => i.id === selectedImageId);
            if (img) {
                const parent = trackers.find(t => t.id === img.parentId);
                let px = img.x; let py = img.y;
                // Calculate Screen Pos of Image Center to get Angle
                // This is slightly expensive but needed.
                // Actually, we can just use vector from DragStart? No, rotation is absolute angle to center.
                // We need screen coordinates of the Image Center.
                // P_screen = T_view * T_video * (P_parent + R_parent * P_image)

                // Let's do it simpler.
                // Vector from Image Center (in Video Space) to Mouse (Video Space).
                // We know Mouse In Video Space (videoX, videoY).
                // We need Image Center in Video Space.
                let cx = img.x; let cy = img.y;
                if (parent) {
                    // Apply parent transform to image local pos (img.x, img.y)
                    // But wait, img.x/y IS local to parent.
                    // So Image Center in Parent Space is (img.x, img.y)
                    // Image Center in Video Space:
                    const pr = (parent.rotation || 0) * Math.PI / 180;
                    const rcn = Math.cos(pr); const rsn = Math.sin(pr);
                    cx = parent.x + (img.x * rcn - img.y * rsn);
                    cy = parent.y + (img.x * rsn + img.y * rcn);
                }

                const dx = videoX - cx;
                const dy = videoY - cy;
                const angle = Math.atan2(dy, dx) * 180 / Math.PI; // -180 to 180
                // The handle is at -90 degrees (Top). So if mouse is at Top (-90), rotation should be 0 (if unrotated).
                // Current Rotation = (MouseAngle - (-90)).
                // However, we also have parent rotation to account for? 
                // Image Rotation is LOCAL.
                // Total Angle = ParentRot + LocalRot.
                // LocalRot = TotalAngle - ParentRot.

                const parentRot = parent ? (parent.rotation || 0) : 0;
                let newRot = (angle + 90) - parentRot;

                const newImages = images.map(i => i.id === selectedImageId ? { ...i, rotation: newRot, isManual: true } : i);
                renderedImagesRef.current = newImages;
                // Update cache/state throttled
                const currentKey = getKeyFromTime(currentTimeRef.current);
                imageCacheRef.current.set(currentKey, newImages);
                const now = performance.now();
                if (now - lastReactUpdateRef.current > 32) { setImages(newImages); lastReactUpdateRef.current = now; }
            }
        }
        else if (dragTarget === 'IMAGE_SCALE' && selectedImageId) {
            const img = images.find(i => i.id === selectedImageId);
            if (img) {
                // Calculate distance from center (in local space if possible, or approximate).
                // Center in Video Space we calculated above?
                // Let's assume uniform scale based on distance from center for simplicity & robustness.
                // Corner drag = change radius.
                const parent = trackers.find(t => t.id === img.parentId);
                let cx = img.x; let cy = img.y;
                if (parent) {
                    const pr = (parent.rotation || 0) * Math.PI / 180;
                    const rcn = Math.cos(pr); const rsn = Math.sin(pr);
                    cx = parent.x + (img.x * rcn - img.y * rsn);
                    cy = parent.y + (img.x * rsn + img.y * rcn);
                }
                const dist = Math.sqrt(Math.pow(videoX - cx, 2) + Math.pow(videoY - cy, 2));

                // Initial Dist?
                const startW = dragStartElementPosRef.current?.x || 100;
                const startH = dragStartElementPosRef.current?.y || 100;
                const startRadius = Math.sqrt((startW / 2) ** 2 + (startH / 2) ** 2);

                // Detect initial distance? We didn't store it.
                // Let's use the Ratio.
                // This is a bit jumpy if we don't start smoothly. 
                // Better: Store start distance in Down.
                // Workaround: We define scale factor based on (CurrentDist / StartDist).
                // We need StartDist.
                // Let's assume start mouse pos.
                const startMX = dragStartPosRef.current?.x || 0;
                const startMY = dragStartPosRef.current?.y || 0;
                const startDistToMouse = Math.sqrt(Math.pow(startMX - cx, 2) + Math.pow(startMY - cy, 2));

                const scaleFactor = dist / (startDistToMouse || 1);

                const newW = startW * scaleFactor;
                const newH = startH * scaleFactor; // Uniform

                const newImages = images.map(i => i.id === selectedImageId ? { ...i, width: newW, height: newH, isManual: true } : i);
                renderedImagesRef.current = newImages;
                const currentKey = getKeyFromTime(currentTimeRef.current);
                imageCacheRef.current.set(currentKey, newImages);
                const now = performance.now();
                if (now - lastReactUpdateRef.current > 32) { setImages(newImages); lastReactUpdateRef.current = now; }
            }
        }
        else if (dragTarget === 'IMAGE' && selectedImageId) {
            const dx = videoX - (dragStartPosRef.current?.x || 0);
            const dy = videoY - (dragStartPosRef.current?.y || 0);

            setImages(prev => prev.map(img => {
                if (img.id === selectedImageId) {
                    const parent = trackers.find(t => t.id === img.parentId);
                    let pdx = dx; // pdx/pdy are changes in PARENT space (rotated)
                    let pdy = dy; // dx/dy are changes in VIDEO space (upright)

                    // Interaction Logic:
                    // We need to map Video Space movement (dx, dy) into the User's Intended Manipulation.
                    // If simply moving (IMAGE target), we want the image to follow the mouse in Video Space.
                    // The image's position is stored relative to Parent. P_final = T_parent * T_image * P_local
                    // To move image by (dx, dy) in Video Space, we need to apply inverse of Parent Rotation to the delta.

                    if (parent && parent.rotation) {
                        const rad = -parent.rotation * Math.PI / 180;
                        const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
                        const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
                        pdx = rx; pdy = ry;
                    }

                    // SAFETY CHECK: If start pos ref is missing, prevent exponential transform explosion
                    const startX = dragStartElementPosRef.current?.x;
                    const startY = dragStartElementPosRef.current?.y;

                    if (typeof startX !== 'number' || typeof startY !== 'number') return img;

                    // Apply Rotation/Scale
                    // For now, simple move.
                    const updatedImg = {
                        ...img,
                        x: startX + pdx, // Apply Total Delta to Fixed Start Position
                        y: startY + pdy,
                        isManual: true
                    };

                    // PERFORMANCE OPTIMIZATION: Update ref directly for instant visual feedback
                    const idx = renderedImagesRef.current.findIndex(i => i.id === selectedImageId);
                    if (idx >= 0) renderedImagesRef.current[idx] = updatedImg;

                    return updatedImg;
                }
                return img;
            }));
            // Throttle state update? React handles it reasonably well, but direct ref update ensures Tick loop is smooth.
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        const vid = videoRef.current;
        const key = vid ? getKeyFromTime(vid.currentTime) : 0;
        if (isDragging && dragTarget === 'TRACKER' && selectedTrackerId && vid) {
            const tracker = trackers.find(t => t.id === selectedTrackerId);
            if (tracker) {
                captureTemplate(tracker);
                const currentFramePoints = trackingCacheRef.current.get(key) || trackers;
                const updatedPoints = currentFramePoints.map(p => p.id === selectedTrackerId ? { ...tracker, isManual: true, matchScore: 100 } : p);
                trackingCacheRef.current.set(key, updatedPoints);
                // Propagate to neighbours
                for (let i = -3; i <= 3; i++) {
                    if (i === 0) continue;
                    const neighborKey = key + i;
                    if (trackingCacheRef.current.has(neighborKey)) {
                        const framePoints = trackingCacheRef.current.get(neighborKey)!;
                        const updatedFramePoints = framePoints.map(p => {
                            if (p.id === selectedTrackerId) return i > 0 ? { ...p, x: tracker.x, y: tracker.y, isManual: true, matchScore: 100 } : { ...p, isManual: true, matchScore: 100 };
                            return p;
                        });
                        trackingCacheRef.current.set(neighborKey, updatedFramePoints);
                    }
                }
                setTrackers(updatedPoints);
            }
        }
        else if (isDragging && (dragTarget === 'MASK' || dragTarget === 'MASK_HANDLE') && selectedMaskId && vid) {
            const m = masks.find(mk => mk.id === selectedMaskId);
            if (m) {
                lastMasksRef.current.set(m.id, m);
                const currentMasks = maskCacheRef.current.get(key) || masks;
                const idx = currentMasks.findIndex(mk => mk.id === m.id);
                let updatedMasks = [...currentMasks];
                if (idx >= 0) updatedMasks[idx] = m; else updatedMasks.push(m);
                maskCacheRef.current.set(key, updatedMasks);
                setMasks(updatedMasks);
            }
        }
        else if (isDragging && dragTarget === 'IMAGE' && selectedImageId && vid) {
            const img = images.find(i => i.id === selectedImageId);
            if (img) {
                lastImagesRef.current.set(img.id, img);
                const currentImages = imageCacheRef.current.get(key) || images;
                const idx = currentImages.findIndex(i => i.id === img.id);
                let updatedImages = [...currentImages];
                if (idx >= 0) updatedImages[idx] = img; else updatedImages.push(img);
                imageCacheRef.current.set(key, updatedImages);
                setImages(updatedImages);
            }
        }
        setIsDragging(false); setDragTarget(null);
        dragStartPosRef.current = null; dragStartDimsRef.current = null;
        dragStartElementPosRef.current = null; // Clear new ref
        dragStartClientPosRef.current = null; dragStartViewTransformRef.current = null; dragStartVideoTransformRef.current = null;
        if (canvasRef.current) canvasRef.current.releasePointerCapture(e.pointerId);
    };

    const spawnTracker = (x: number, y: number, currentList: TrackingPoint[], isStabilizer: boolean = true): TrackingPoint => {
        const newId = generateId();
        trackerSettingsRef.current.set(newId, { patchSize: DEFAULT_PATCH_SIZE, searchWindow: DEFAULT_SEARCH_WINDOW, sensitivity: DEFAULT_SENSITIVITY, adaptive: DEFAULT_ADAPTIVE });
        return {
            id: newId, color: getNextColor(currentList), x, y, offsetX: 0, offsetY: 0,
            rotation: 0, isRotation: false, isManual: true, matchScore: 100, isInactive: false,
            patchSize: DEFAULT_PATCH_SIZE, searchWindow: DEFAULT_SEARCH_WINDOW, isStabilizer
        };
    };

    const addTrackerAt = (x: number, y: number, isStabilizer: boolean) => {
        if (!videoRef.current) return;
        if (!appState.includes('AUTO')) saveToHistory();
        const newTracker = spawnTracker(x, y, trackers, isStabilizer);
        const newTrackers = [...trackers, newTracker];
        setTrackers(newTrackers);
        setTrackerVisibility(prev => ({ ...prev, [newTracker.id]: true }));
        setTrackerInfluence(prev => ({ ...prev, [newTracker.id]: true }));
        if (placementMode) setSelectedTrackerId(newTracker.id);
        lastPointsRef.current.set(newTracker.id, newTracker);
        trackerAgeRef.current.set(newTracker.id, 10);
        const key = getKeyFromTime(videoRef.current.currentTime);
        trackingCacheRef.current.set(key, newTrackers);
        captureTemplate(newTracker);
        setPlacementMode(null);
    };

    const captureTemplate = (point: TrackingPoint, sourceCtx?: CanvasRenderingContext2D) => {
        let ctx = sourceCtx;
        if (!ctx) {
            if (!videoRef.current) return;
            if (!scratchCanvasRef.current) scratchCanvasRef.current = document.createElement('canvas');
            const scratch = scratchCanvasRef.current;
            if (scratch.width !== videoRef.current.videoWidth || scratch.height !== videoRef.current.videoHeight) { scratch.width = videoRef.current.videoWidth; scratch.height = videoRef.current.videoHeight; }
            const sCtx = scratch.getContext('2d', { willReadFrequently: true });
            if (!sCtx) return;
            // Use the current video frame
            try { sCtx.drawImage(videoRef.current, 0, 0); } catch (e) { return; }
            ctx = sCtx;
        }
        if (!ctx) return;
        const pSize = point.patchSize || DEFAULT_PATCH_SIZE;
        const startX = Math.max(0, Math.floor(point.x - pSize / 2));
        const startY = Math.max(0, Math.floor(point.y - pSize / 2));
        try { const imageData = ctx.getImageData(startX, startY, pSize, pSize); templatesRef.current.set(point.id, imageData); } catch (e) { }
    };

    const handleExport = () => {
        if (!canvasRef.current || !videoRef.current) return;
        setIsStabilized(true);
        setAppState(AppState.EXPORTING);
        recordedChunksRef.current = [];
        abortControllerRef.current = new AbortController();

        // We must export from Display Canvas but isolate the "Hole" area.
        // Actually, captureStream grabs the whole canvas.
        // For proper export of just the box, we might need a separate export canvas or crop.
        // For MVP, we will export the whole view, but ideally we should only export the center box.
        // Let's assume the user wants what they see in the box.
        // Browser media recorder captures the whole canvas element.
        const stream = canvasRef.current.captureStream(30);

        try {
            const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9' });
            recorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunksRef.current.push(e.data); };
            recorder.onstop = () => {
                if (abortControllerRef.current?.signal.aborted) { setAppState(AppState.READY); return; }
                const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
                if (blob.size > 0) {
                    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = `stabilized-${Date.now()}.webm`; document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
                }
                setAppState(AppState.READY);
            };
            mediaRecorderRef.current = recorder; recorder.start(); videoRef.current.currentTime = playbackRange.start; videoRef.current.play();
        } catch (err) { setAppState(AppState.READY); }
    };

    const handleCanvasWheel = (e: React.WheelEvent) => {
        e.stopPropagation();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // Zoom about the mouse pointer
        // Screen = (World - T) * S + Center (simplified) -> World = (Screen - T)/S

        // Calculate point in Workspace Space before zoom
        const workspaceX = (mouseX - viewTransform.x) / viewTransform.scale;
        const workspaceY = (mouseY - viewTransform.y) / viewTransform.scale;

        const delta = -Math.sign(e.deltaY) * 0.1;
        const newScale = Math.max(0.05, Math.min(10, viewTransform.scale + delta));

        // New Offset to keep workspace point under mouse
        const newX = mouseX - workspaceX * newScale;
        const newY = mouseY - workspaceY * newScale;

        setViewTransform({ x: newX, y: newY, scale: newScale });
    };

    const findBestMatch = (ctx: CanvasRenderingContext2D, center: TrackingPoint, predictedX: number, predictedY: number) => {
        // IMPORTANT: ctx here MUST be the Scratch (Video Size) Context
        const template = templatesRef.current.get(center.id); if (!template) return null;
        const width = ctx.canvas.width; const height = ctx.canvas.height;
        const tData = template.data;
        const settings = trackerSettingsRef.current.get(center.id) || { patchSize: DEFAULT_PATCH_SIZE, searchWindow: DEFAULT_SEARCH_WINDOW, sensitivity: DEFAULT_SENSITIVITY };
        const tSize = settings.patchSize; const searchWin = settings.searchWindow;
        const searchCenterX = predictedX; const searchCenterY = predictedY;
        const searchStartX = Math.max(0, Math.floor(searchCenterX - searchWin));
        const searchStartY = Math.max(0, Math.floor(searchCenterY - searchWin));
        const searchEndX = Math.min(width - tSize, Math.floor(searchCenterX + searchWin));
        const searchEndY = Math.min(height - tSize, Math.floor(searchCenterY + searchWin));
        if (searchEndX <= searchStartX || searchEndY <= searchStartY) return { point: center, error: 0 };
        const searchWidth = searchEndX - searchStartX + tSize;
        const searchHeight = searchEndY - searchStartY + tSize;
        const searchImgData = ctx.getImageData(searchStartX, searchStartY, searchWidth, searchHeight);
        const sData = searchImgData.data;
        let minDiff = Number.MAX_VALUE; let bestX = center.x; let bestY = center.y;
        // Coarse
        for (let y = 0; y < searchEndY - searchStartY; y += 2) {
            for (let x = 0; x < searchEndX - searchStartX; x += 2) {
                let diff = 0;
                for (let ty = 0; ty < tSize; ty += 2) {
                    for (let tx = 0; tx < tSize; tx += 2) {
                        const tIndex = (ty * tSize + tx) * 4;
                        const sIndex = ((y + ty) * searchWidth + (x + tx)) * 4;
                        diff += Math.abs(tData[tIndex] - sData[sIndex]) + Math.abs(tData[tIndex + 1] - sData[sIndex + 1]) + Math.abs(tData[tIndex + 2] - sData[sIndex + 2]);
                    }
                    if (diff > minDiff) break;
                }
                if (diff < minDiff) { minDiff = diff; bestX = searchStartX + x; bestY = searchStartY + y; }
            }
        }
        // Fine 
        const fineRadius = 6; let minFineDiff = Number.MAX_VALUE; let fineBestX = bestX; let fineBestY = bestY;
        const coarseRelX = bestX - searchStartX; const coarseRelY = bestY - searchStartY;
        for (let fy = -fineRadius; fy <= fineRadius; fy++) {
            for (let fx = -fineRadius; fx <= fineRadius; fx++) {
                const y = coarseRelY + fy; const x = coarseRelX + fx;
                if (x < 0 || y < 0 || x >= searchWidth - tSize || y >= searchHeight - tSize) continue;
                let diff = 0;
                for (let ty = 0; ty < tSize; ty += 2) {
                    for (let tx = 0; tx < tSize; tx += 2) {
                        const tIndex = (ty * tSize + tx) * 4; const sIndex = ((y + ty) * searchWidth + (x + tx)) * 4;
                        diff += Math.abs(tData[tIndex] - sData[sIndex]) + Math.abs(tData[tIndex + 1] - sData[sIndex + 1]) + Math.abs(tData[tIndex + 2] - sData[sIndex + 2]);
                    }
                }
                if (diff < minFineDiff) { minFineDiff = diff; fineBestX = searchStartX + coarseRelX + fx; fineBestY = searchStartY + coarseRelY + fy; }
            }
        }
        const finalX = fineBestX + tSize / 2; const finalY = fineBestY + tSize / 2;
        const pixelsSampled = (tSize / 2) * (tSize / 2); const avgDiffPerPixel = minFineDiff / pixelsSampled;
        const matchScore = Math.max(0, Math.min(100, 100 - (avgDiffPerPixel * 1.5)));
        return { point: { ...center, x: finalX, y: finalY, isManual: false, matchScore, patchSize: tSize, searchWindow: searchWin }, error: avgDiffPerPixel };
    };

    // --- Render Loop ---
    const tick = useCallback(() => {
        if (!videoRef.current || !canvasRef.current) return;

        const vid = videoRef.current;
        if (vid.readyState < 2) return; // Need minimal data

        // 1. Prepare Scratch Canvas (Video Resolution)
        // This is used for Tracking logic which needs raw video pixels
        if (!scratchCanvasRef.current) scratchCanvasRef.current = document.createElement('canvas');
        const scratch = scratchCanvasRef.current;
        if (scratch.width !== vid.videoWidth || scratch.height !== vid.videoHeight) {
            scratch.width = vid.videoWidth; scratch.height = vid.videoHeight;
        }
        const scratchCtx = scratch.getContext('2d', { willReadFrequently: true });
        if (!scratchCtx) return;
        scratchCtx.drawImage(vid, 0, 0);

        // 2. Prepare Display Canvas (Screen Resolution)
        // This is what the user sees
        const mainCanvas = canvasRef.current;
        // NOTE: Canvas resizing is now handled by ResizeObserver in useEffect to avoid lag
        const ctx = mainCanvas.getContext('2d');
        if (!ctx) return;

        // Timeline Updates
        let t = vid.currentTime;

        // Scrubbing Logic:
        // Always prefer the requested time (currentTimeRef) if we are scrubbing.
        // We will try to fetch from cache.
        // Scrubbing Logic:
        // Always prefer the requested time (currentTimeRef) if we are scrubbing.
        // We will try to fetch from cache.
        const isScrubbing = isScrubbingTimeline || isScrubbingRef.current;

        if (isScrubbing) {
            t = currentTimeRef.current;
        } else {
            t = vid.currentTime;
        }

        const targetKey = getKeyFromTime(t);
        const hasCache = frameCacheRef.current.has(targetKey);

        // If we are scrubbing but don't have cache, we unfortunately have to fall back
        // to the video element's time to ensure we don't draw overlays on top of the wrong frame.
        if (isScrubbing && !hasCache) {
            t = vid.currentTime;
        }

        // Sync state if needed (for Playhead UI)
        if (Math.abs(currentTime - t) > 0.05 && !isScrubbingTimeline) setCurrentTime(t);
        currentTimeRef.current = t;

        if (!vid.paused) {
            if (appStateRef.current === AppState.PLAYING) { if (t >= playbackRangeRef.current.end || t < playbackRangeRef.current.start) vid.currentTime = playbackRangeRef.current.start; }
            if (appStateRef.current === AppState.EXPORTING || appStateRef.current === AppState.AUTO_ANALYZING) {
                if (t >= playbackRangeRef.current.end) {
                    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') mediaRecorderRef.current.stop(); else vid.pause();
                    setAppState(AppState.READY);
                }
            }
        }

        const isAnalyzing = appStateRef.current === AppState.ANALYZING;
        const isAutoAnalyzing = appStateRef.current === AppState.AUTO_ANALYZING;
        const isExporting = appStateRef.current === AppState.EXPORTING;
        const isPlaying = appStateRef.current === AppState.PLAYING;

        // --- Tracking Logic (Runs on scratchCtx) ---
        // (Omitted detailed tracking logic for brevity - it remains similar but ensures it uses scratchCtx)
        // Ideally this block should be preserved from previous version, just ensuring it runs on 'scratchCtx'
        let activePoints: TrackingPoint[] = [];
        let anyTrackerLost = false;

        if ((isAnalyzing || isAutoAnalyzing)) {
            let currentPoints = trackersRef.current;
            let passivePoints: TrackingPoint[] = [];
            if (isAnalyzing) {
                const targetIds = selectedTrackerIdRef.current ? [selectedTrackerIdRef.current] : trackersRef.current.map(t => t.id);
                currentPoints = trackersRef.current.filter(t => targetIds.includes(t.id));
                const currentKey = getKeyFromTime(vid.currentTime);
                const cachedCurrent = trackingCacheRef.current.get(currentKey) || [];
                passivePoints = cachedCurrent.filter(p => !targetIds.includes(p.id));
            }
            if (isAutoAnalyzing && trackersRef.current.length < 12) {
                const newCandidates = findGoodFeatures(scratchCtx, scratch.width, scratch.height);
                const needed = 12 - trackersRef.current.length;
                const toAdd = Math.min(needed, newCandidates.length);
                if (toAdd > 0) {
                    const nextTrackers = [...trackersRef.current];
                    const newVisibility = {}; const newInfluence = {};
                    for (let i = 0; i < toAdd; i++) {
                        const newT = spawnTracker(newCandidates[i].x, newCandidates[i].y, nextTrackers);
                        nextTrackers.push(newT); lastPointsRef.current.set(newT.id, newT); trackerAgeRef.current.set(newT.id, 0); captureTemplate(newT, scratchCtx); newVisibility[newT.id] = true; newInfluence[newT.id] = true;
                    }
                    setTrackers(nextTrackers); setTrackerVisibility(prev => ({ ...prev, ...newVisibility })); setTrackerInfluence(prev => ({ ...prev, ...newInfluence })); currentPoints = nextTrackers; passivePoints = [];
                }
            }

            const newPointsForFrame: TrackingPoint[] = [];
            const currentKey = getKeyFromTime(vid.currentTime);
            const prevKey = currentKey - 1;
            const prevPrevKey = currentKey - 2;
            const prevFramePoints = trackingCacheRef.current.get(prevKey);
            const prevPrevFramePoints = trackingCacheRef.current.get(prevPrevKey);

            if (currentPoints.length > 0) {
                for (const tracker of currentPoints) {
                    let prevPoint = lastPointsRef.current.get(tracker.id) || tracker;
                    let velocityX = 0; let velocityY = 0;
                    if (prevFramePoints) {
                        const p1 = prevFramePoints.find(p => p.id === tracker.id);
                        if (p1) {
                            if (p1.isManual) { velocityX = 0; velocityY = 0; }
                            else if (prevPrevFramePoints) {
                                const p2 = prevPrevFramePoints.find(p => p.id === tracker.id);
                                if (p2) { velocityX = p1.x - p2.x; velocityY = p1.y - p2.y; }
                            } else { velocityX = prevPoint.x - p1.x; velocityY = prevPoint.y - p1.y; }
                        }
                    }
                    const predictedX = prevPoint.x + velocityX;
                    const predictedY = prevPoint.y + velocityY;
                    const result = findBestMatch(scratchCtx, prevPoint, predictedX, predictedY);

                    if (result) {
                        const settings = trackerSettingsRef.current.get(tracker.id) || { sensitivity: DEFAULT_SENSITIVITY, adaptive: DEFAULT_ADAPTIVE };
                        const baseThreshold = 20 + (100 - settings.sensitivity) * 0.6;
                        const errorThreshold = isAutoAnalyzing ? 60 : baseThreshold;

                        if (isAutoAnalyzing && result.point.matchScore && result.point.matchScore < 60) { deleteTracker(tracker.id); }
                        else if (result.error > errorThreshold) {
                            if (!isAutoAnalyzing && trackerVisibilityRef.current[tracker.id] !== false) { anyTrackerLost = true; setErrorTrackerId(tracker.id); } else if (isAutoAnalyzing) { deleteTracker(tracker.id); }
                            if (!isAutoAnalyzing) { const lostPoint = result.point; lastPointsRef.current.set(tracker.id, lostPoint); newPointsForFrame.push(lostPoint); }
                        } else {
                            result.point.rotation = prevPoint.rotation || 0;
                            lastPointsRef.current.set(tracker.id, result.point);
                            newPointsForFrame.push(result.point);
                            if (settings.adaptive || isAutoAnalyzing) { if (result.point.matchScore && result.point.matchScore < 95) { captureTemplate(result.point, scratchCtx); } }
                        }
                    } else { newPointsForFrame.push(prevPoint); }
                }

                if (newPointsForFrame.length > 0 && prevFramePoints) {
                    const commonPoints = newPointsForFrame.filter(p => prevFramePoints.some(prev => prev.id === p.id));
                    if (commonPoints.length > 1) {
                        let cxPrev = 0, cyPrev = 0; let cxCurr = 0, cyCurr = 0;
                        commonPoints.forEach(p => {
                            const prev = prevFramePoints.find(pp => pp.id === p.id);
                            if (prev) {
                                cxPrev += prev.x; cyPrev += prev.y; cxCurr += p.x; cyCurr += p.y;
                            }
                        });
                        cxPrev /= commonPoints.length; cyPrev /= commonPoints.length; cxCurr /= commonPoints.length; cyCurr /= commonPoints.length;

                        newPointsForFrame.forEach(p => {
                            if (p.isRotation) {
                                const prev = prevFramePoints.find(pp => pp.id === p.id);
                                if (prev) {
                                    const angPrev = Math.atan2(prev.y - cyPrev, prev.x - cxPrev); const angCurr = Math.atan2(p.y - cyCurr, p.x - cxCurr);
                                    let d = angCurr - angPrev; while (d <= -Math.PI) d += 2 * Math.PI; while (d > Math.PI) d -= 2 * Math.PI;
                                    p.rotation = (prev.rotation || 0) + d * (180 / Math.PI);
                                }
                            }
                        });
                    }
                }

                if (isAutoAnalyzing && newPointsForFrame.length > 2) {
                    const motions = newPointsForFrame.map(p => { const oldP = prevFramePoints?.find(op => op.id === p.id); if (oldP) return { dx: p.x - oldP.x, dy: p.y - oldP.y, id: p.id }; return null; }).filter(Boolean);
                    if (motions.length > 2) {
                        motions.sort((a, b) => (a!.dx) - (b!.dx)); const medianDx = motions[Math.floor(motions.length / 2)]!.dx;
                        motions.sort((a, b) => (a!.dy) - (b!.dy)); const medianDy = motions[Math.floor(motions.length / 2)]!.dy;
                        const OUTLIER_THRESHOLD = 1.5; const idsToDelete: string[] = [];
                        motions.forEach(m => { if (!m) return; const dev = Math.abs(m.dx - medianDx) + Math.abs(m.dy - medianDy); if (dev > OUTLIER_THRESHOLD) { const badCount = (autoTrackBadFramesRef.current.get(m.id) || 0) + 1; autoTrackBadFramesRef.current.set(m.id, badCount); if (badCount > 3) idsToDelete.push(m.id); } else { autoTrackBadFramesRef.current.set(m.id, 0); } });
                        idsToDelete.forEach(id => deleteTracker(id)); activePoints = newPointsForFrame.filter(p => !idsToDelete.includes(p.id));
                    } else activePoints = newPointsForFrame;
                } else activePoints = newPointsForFrame;
            }
            const mergedPoints = [...passivePoints, ...activePoints];
            setTrackers(mergedPoints);
            trackingCacheRef.current.set(currentKey, mergedPoints);
            lastAnalysisKeyRef.current = currentKey;
            if (anyTrackerLost && !isAutoAnalyzing) { vid.pause(); setAppState(AppState.ANALYZING_PAUSED); lastAnalysisKeyRef.current = null; }
        } else {
            // PLAYBACK or SCRUBBING or EDITING
            const fps = videoInfo?.fps || 30;
            const currentFrame = Math.floor(t * fps);

            // OPTIMIZATION: During playback or scrubbing, use pre-baked data (fast lookup)
            if ((isPlaying || isScrubbing) && isPlaybackBakedRef.current && bakedPlaybackRef.current.has(currentFrame)) {
                const baked = bakedPlaybackRef.current.get(currentFrame)!;
                activePoints = baked.trackers;
                // Masks and images will be grabbed from baked data in their respective sections below
            } else {
                // Fallback: Calculate interpolated values (for scrubbing or when not baked)
                const currentKey = getKeyFromTime(t);
                const cache = interpolationCacheRef.current;

                // If we have a valid cache for this exact frame, use it!
                if (cache && cache.key === currentKey && (isPlaying || isScrubbing)) {
                    activePoints = cache.trackers;
                } else {
                    activePoints = getInterpolatedTrackers(t, trackingCacheRef.current, fps, trackersRef.current);

                    // Apply setting overrides
                    activePoints = activePoints.map(p => {
                        const settings = trackerSettingsRef.current.get(p.id);
                        if (settings) { return { ...p, patchSize: settings.patchSize, searchWindow: settings.searchWindow }; }
                        return p;
                    });
                }
            }

            // Update last points
            activePoints.forEach(p => lastPointsRef.current.set(p.id, p));
        }

        const key = getKeyFromTime(t);

        // OPTIMIZATION: Throttle React Updates during playback
        if (isPlaying || isExporting) {
            const now = performance.now();
            if (now - lastReactUpdateRef.current > 50) {
                setTrackers(activePoints);
                // We don't update time here, handled together at end 
            }
        }

        // MASKS
        // Use Interpolation for smooth playback/scrubbing
        let mergedMasks: MaskObject[] = [];
        const fps = videoInfo?.fps || 30;
        const currentFrame = Math.floor(t * fps);

        // OPTIMIZATION: During playback or scrubbing, use pre-baked data
        if ((isPlaying || isScrubbing) && isPlaybackBakedRef.current && bakedPlaybackRef.current.has(currentFrame)) {
            const baked = bakedPlaybackRef.current.get(currentFrame)!;
            mergedMasks = baked.masks;
        } else {
            // Cache Check fallback
            const cache = interpolationCacheRef.current;
            if (cache && cache.key === key && (isPlaying || isScrubbing)) {
                mergedMasks = cache.masks;
            } else {
                mergedMasks = getInterpolatedMasks(t, maskCacheRef.current, fps, masksRef.current);
            }
        }

        if (isPlaying || isExporting) {
            const now = performance.now();
            if (now - lastReactUpdateRef.current > 50) {
                setMasks(mergedMasks);
            }
        }

        // Populate Rendered Refs for Hit Testing
        // If we are dragging, we ALREADY updated the refs in handlePointerMove.
        // We generally shouldn't overwrite them here with 'activePoints' which might be stale (from React state)
        // unless we are playing/scrubbing.

        if (!isDraggingRef.current) {
            renderedPointsRef.current = activePoints;
            renderedMasksRef.current = mergedMasks;
        } else {
            // If dragging, we might still want to update 'passive' points that aren't being dragged?
            // Actually handlePointerMove updates the ENTIRE array in the ref.
            // But we need to make sure we don't lose updates from interpolation if we are dragging one item but playing?
            // (Dragging while playing is rare/weird).

            // Safest: If dragging, trust the Refs. The refs are the source of truth for the Drag.
        }

        // IMAGES
        let mergedImages: ImageAttachment[] = [];

        if (isAnalyzing || isAutoAnalyzing) {
            const cachedImages = imageCacheRef.current.get(key) || [];
            mergedImages = [...cachedImages];
            const cachedImageIds = new Set(cachedImages.map(i => i.id));
            lastImagesRef.current.forEach(i => { if (!cachedImageIds.has(i.id)) mergedImages.push({ ...i }); });
        } else {
            // OPTIMIZATION: During playback or scrubbing, use pre-baked data
            if ((isPlaying || isScrubbing) && isPlaybackBakedRef.current && bakedPlaybackRef.current.has(currentFrame)) {
                const baked = bakedPlaybackRef.current.get(currentFrame)!;
                mergedImages = baked.images;
            } else {
                // For Playback/Export, use Interpolation
                const cache = interpolationCacheRef.current;
                if (cache && cache.key === key && (isPlaying || isScrubbing)) {
                    mergedImages = cache.images;
                } else {
                    mergedImages = getInterpolatedImages(t, imageCacheRef.current, fps, imagesRef.current);
                }
            }
        }

        // Update Cache if we calculated new values
        if (isPlaying || isScrubbing) {
            interpolationCacheRef.current = {
                key: key,
                trackers: activePoints,
                masks: mergedMasks,
                images: mergedImages
            };
        }

        if (isPlaying || isExporting) {
            const now = performance.now();
            if (now - lastReactUpdateRef.current > 50) {
                setImages(mergedImages);
                lastReactUpdateRef.current = now; // Sync update time
            }
            mergedImages.forEach(i => lastImagesRef.current.set(i.id, i));
        }

        renderedImagesRef.current = (isDraggingRef.current && imagesRef.current.length > 0) ? imagesRef.current : mergedImages;

        // Apply visual updates needed for drawing
        activePoints.forEach(p => { const age = trackerAgeRef.current.get(p.id) || 0; trackerAgeRef.current.set(p.id, age + 1); });

        // --- Render Display Canvas (Apply Transforms Here) ---

        // 1. Clear Screen
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);

        // Ensure video element is hidden (we render to canvas)
        if (vid.style.opacity !== '0') vid.style.opacity = '0';

        // 2. Calculate Stabilization Transform (Shifts)
        let shiftX = 0; let shiftY = 0; let shiftRotation = 0;
        let pivotX = vid.videoWidth / 2; let pivotY = vid.videoHeight / 2;

        const influentialPoints = activePoints.filter(p =>
            trackerInfluenceRef.current[p.id] !== false && ((trackerAgeRef.current.get(p.id) || 0) >= 5 || p.isManual) && !p.isInactive &&
            !(isDraggingRef.current && p.id === selectedTrackerIdRef.current) && !(isEditingGraph && p.id === selectedTrackerIdRef.current) && p.isStabilizer !== false
        );

        if (isDraggingRef.current || placementMode !== null || isEditingGraph) {
            shiftX = currentShiftRef.current.x; shiftY = currentShiftRef.current.y; shiftRotation = currentShiftRotationRef.current;
            lastStabilizationKeyRef.current = getKeyFromTime(t);
        }
        else if (isStabilized) {
            if (influentialPoints.length > 0) {
                const currentKey = getKeyFromTime(t);
                const prevKey = currentKey - 1;
                const isSequential = lastStabilizationKeyRef.current !== null && (currentKey === lastStabilizationKeyRef.current + 1 || currentKey === lastStabilizationKeyRef.current);
                const prevPoints = trackingCacheRef.current.get(prevKey);

                // If seeking/scrubbing (non-sequential), or if we are just starting, we use absolute centering
                // to avoid "messing up" the position with stale deltas.
                const isSeeking = lastStabilizationKeyRef.current !== null && Math.abs(currentKey - lastStabilizationKeyRef.current) > 1;

                if (isSequential && prevPoints && currentKey !== lastStabilizationKeyRef.current && !isScrubbingTimeline && !isSeeking) {
                    const deltas: { dx: number, dy: number }[] = [];
                    influentialPoints.forEach(p => {
                        const prev = prevPoints.find(pp => pp.id === p.id);
                        if (prev) {
                            const dx = p.x - prev.x; const dy = p.y - prev.y;
                            if (Math.abs(dx) > 30 || Math.abs(dy) > 30) return;
                            deltas.push({ dx, dy });
                        }
                    });

                    if (deltas.length > 0) {
                        deltas.sort((a, b) => a.dx - b.dx); const medianDx = deltas[Math.floor(deltas.length / 2)].dx;
                        deltas.sort((a, b) => a.dy - b.dy); const medianDy = deltas[Math.floor(deltas.length / 2)].dy;
                        shiftX = currentShiftRef.current.x - medianDx; shiftY = currentShiftRef.current.y - medianDy;
                    } else { shiftX = currentShiftRef.current.x; shiftY = currentShiftRef.current.y; }
                }
                else if (currentKey === lastStabilizationKeyRef.current && !isSeeking) {
                    shiftX = currentShiftRef.current.x; shiftY = currentShiftRef.current.y; shiftRotation = currentShiftRotationRef.current;
                }
                else {
                    // Absolute Stabilization (Centering) for Seeks/Scrubbing
                    // Or if no previous points to compare
                    const centerX = vid.videoWidth / 2; const centerY = vid.videoHeight / 2;
                    let sumX = 0, sumY = 0; influentialPoints.forEach(p => { sumX += p.x; sumY += p.y; });
                    shiftX = centerX - (sumX / influentialPoints.length); shiftY = centerY - (sumY / influentialPoints.length);
                    shiftRotation = 0;
                }
                lastStabilizationKeyRef.current = currentKey;
            } else { shiftX = currentShiftRef.current.x; shiftY = currentShiftRef.current.y; shiftRotation = currentShiftRotationRef.current; lastStabilizationKeyRef.current = getKeyFromTime(t); }
        } else { lastStabilizationKeyRef.current = null; shiftX = 0; shiftY = 0; shiftRotation = 0; }

        currentShiftRef.current = { x: shiftX, y: shiftY };
        currentShiftRotationRef.current = shiftRotation;

        // --- 3. Render Composition ---

        // Apply View Transform (Camera Pan/Zoom)
        ctx.save();
        ctx.translate(viewTransform.x, viewTransform.y);
        ctx.scale(viewTransform.scale, viewTransform.scale);

        // A. Draw "Background" Video
        // This is the infinite video plane layer
        if (!isVideoHidden) {
            ctx.save();

            // Apply Manual Video Transform (User moves video)
            ctx.translate(videoTransform.x, videoTransform.y);
            ctx.scale(videoTransform.scale, videoTransform.scale);

            // Apply Stabilization Shifts (Calculated)
            ctx.translate(pivotX + shiftX, pivotY + shiftY);
            ctx.rotate(shiftRotation * Math.PI / 180);
            ctx.translate(-pivotX, -pivotY);

            // Draw Video Image (Live or Cached)
            let bgSource: CanvasImageSource = scratch;
            const cfIdx = getKeyFromTime(t);
            // If we detected cache earlier (or now), use it.
            if (frameCacheRef.current.has(cfIdx)) {
                bgSource = frameCacheRef.current.get(cfIdx)!;
            } else if (isScrubbing && !hasCache) {
                // FALLBACK for scrubbing without cache:
                // We've set 't' to vid.currentTime above, so 'scratch' (video element) is correct source.
                // However, we must ensure 'scratch' is updated.
                // scratchCtx.drawImage(vid, 0, 0) happened at top of tick.
            }

            try { ctx.drawImage(bgSource, 0, 0); } catch (e) { }

            // Draw Overlays attached to video (Masks, Trackers)

            // Use renderedMasksRef for drawing if available and not updating from state loop
            const masksToDraw = (isDraggingRef.current && masksRef.current.length > 0) ? masksRef.current : renderedMasksRef.current;

            masksToDraw.forEach(m => {
                const isSelected = m.id === selectedMaskIdRef.current;
                ctx.strokeStyle = m.color; ctx.lineWidth = 2 / (viewTransformRef.current.scale * videoTransformRef.current.scale);
                if (m.type === 'box') {
                    const hw = m.width / 2; const hh = m.height / 2;
                    ctx.strokeRect(m.x - hw, m.y - hh, m.width, m.height);
                    if (isSelected) {
                        ctx.fillStyle = m.color; ctx.globalAlpha = 0.2; ctx.fillRect(m.x - hw, m.y - hh, m.width, m.height); ctx.globalAlpha = 1.0;
                        const handleSize = 10 / (viewTransformRef.current.scale * videoTransformRef.current.scale); const handleOffset = handleSize / 2; ctx.fillRect(m.x + hw - handleOffset, m.y + hh - handleOffset, handleSize, handleSize);
                    }
                } else if (m.type === 'circle') {
                    const r = m.width / 2; ctx.beginPath(); ctx.arc(m.x, m.y, r, 0, Math.PI * 2); ctx.stroke();
                    if (isSelected) {
                        ctx.fillStyle = m.color; ctx.globalAlpha = 0.2; ctx.fill(); ctx.globalAlpha = 1.0;
                        const handleSize = 10 / (viewTransformRef.current.scale * videoTransformRef.current.scale); const handleOffset = handleSize / 2; ctx.fillRect(m.x + r - handleOffset, m.y - handleOffset, handleSize, handleSize);
                    }
                }
            });

            // Images
            const imagesToDraw = renderedImagesRef.current;
            imagesToDraw.forEach(img => {
                const parent = activePoints.find(p => p.id === img.parentId);
                // If parentId is set but not found (and not undefined/null), skip (e.g. deleted parent). 
                // If parentId is undefined/null, it means World Parent.
                if (img.parentId && !parent) return;
                // If parent exists but invisible, we hide image? 
                // Usually child follows parent visibility or not? 
                // Let's assume child visibility is independent UNLESS parent is "disabled" conceptually?
                // For now, if parent tracking is off, we still draw if we have the data? 
                // Using existing logic: if parent invisible, hide child.
                if (parent && trackerVisibilityRef.current[parent.id] === false) return;

                const loadedImg = ensureImageLoaded(img);
                if (!loadedImg) return;

                ctx.save();
                // 1. Parent Transform (Only if parent exists)
                if (parent) {
                    ctx.translate(parent.x, parent.y);
                    if (parent.rotation) ctx.rotate(parent.rotation * Math.PI / 180);
                } else {
                    // World Space (No parent transform)
                    // img.x/y are world coordinates
                }

                // 2. Local Transform
                ctx.translate(img.x, img.y);
                ctx.rotate(img.rotation * Math.PI / 180);

                // 3. Draw
                const w = img.width;
                const h = img.height;
                ctx.globalAlpha = img.opacity;
                if (loadedImg && loadedImg.complete && loadedImg.naturalWidth > 0) {
                    try {
                        ctx.drawImage(loadedImg, -w / 2, -h / 2, w, h);
                    } catch (e) { }
                } else {
                    ctx.fillStyle = "rgba(100, 100, 100, 0.5)";
                    ctx.fillRect(-w / 2, -h / 2, w, h);
                    ctx.fillStyle = "#ffffff";
                    ctx.font = "10px sans-serif";
                    ctx.fillText("Loading...", -20, 5);
                }

                // Selection Box
                if (selectedImageId === img.id) {
                    ctx.strokeStyle = "#ffffff";
                    ctx.lineWidth = 2 / (viewTransform.scale * videoTransform.scale);
                    ctx.setLineDash([4, 4]);
                    ctx.strokeRect(-w / 2, -h / 2, w, h);
                    ctx.setLineDash([]);

                    // Corner handles for visualization
                    const handleSize = 8 / (viewTransform.scale * videoTransform.scale);
                    ctx.fillStyle = "#ffffff";
                    ctx.fillRect(-w / 2 - handleSize / 2, -h / 2 - handleSize / 2, handleSize, handleSize);
                    ctx.fillRect(w / 2 - handleSize / 2, -h / 2 - handleSize / 2, handleSize, handleSize);
                    ctx.fillRect(w / 2 - handleSize / 2, h / 2 - handleSize / 2, handleSize, handleSize);
                    ctx.fillRect(-w / 2 - handleSize / 2, h / 2 - handleSize / 2, handleSize, handleSize);

                    // Rotation Handle (Stick + Circle)
                    const rotStickLen = 20 / (viewTransform.scale * videoTransform.scale);
                    ctx.beginPath();
                    ctx.moveTo(0, -h / 2);
                    ctx.lineTo(0, -h / 2 - rotStickLen);
                    ctx.stroke();

                    ctx.beginPath();
                    ctx.arc(0, -h / 2 - rotStickLen, handleSize / 1.5, 0, Math.PI * 2);
                    ctx.fillStyle = "#ffffff";
                    ctx.fill();
                    ctx.stroke();
                }
                ctx.restore();
            });

            // Trackers
            if (!isExporting) {
                activePoints.forEach(pt => {
                    if (trackerVisibilityRef.current[pt.id] === false) return;
                    const isSelected = pt.id === selectedTrackerIdRef.current; const isError = pt.id === errorTrackerId; const color = isError ? '#ef4444' : pt.color;
                    const pSize = pt.patchSize || DEFAULT_PATCH_SIZE; const sWin = pt.searchWindow || DEFAULT_SEARCH_WINDOW;
                    const scaleFactor = viewTransformRef.current.scale * videoTransformRef.current.scale;

                    if (pt.isInactive) ctx.globalAlpha = 0.5; else ctx.globalAlpha = 1.0;

                    ctx.strokeStyle = color; ctx.lineWidth = 1.5 / scaleFactor;
                    const crossSize = Math.max(10, pSize * 0.6);

                    ctx.beginPath(); ctx.moveTo(pt.x - crossSize, pt.y); ctx.lineTo(pt.x + crossSize, pt.y); ctx.moveTo(pt.x, pt.y - crossSize); ctx.lineTo(pt.x, pt.y + crossSize); ctx.setLineDash([]); ctx.stroke();

                    // Draw Hitbox Visualizer (User Request: "Draw a box around the perimeter")
                    // The Patch Size IS the hitbox area. We'll fill it faintly to show the area.
                    ctx.fillStyle = isSelected ? "rgba(255, 255, 255, 0.15)" : "rgba(255, 255, 255, 0.05)";
                    ctx.fillRect(pt.x - pSize / 2, pt.y - pSize / 2, pSize, pSize);
                    ctx.strokeRect(pt.x - pSize / 2, pt.y - pSize / 2, pSize, pSize);

                    // Search Window
                    ctx.setLineDash([3 / scaleFactor, 3 / scaleFactor]); ctx.strokeRect(pt.x - sWin, pt.y - sWin, sWin * 2, sWin * 2); ctx.setLineDash([]);

                    if (isSelected) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2 / scaleFactor; ctx.setLineDash([4 / scaleFactor, 4 / scaleFactor]); const margin = 4; ctx.strokeRect(pt.x - pSize / 2 - margin, pt.y - pSize / 2 - margin, pSize + margin * 2, pSize + margin * 2); ctx.setLineDash([]); }

                    ctx.fillStyle = color; ctx.font = `bold ${12 / scaleFactor}px Arial`; ctx.fillText(`${pt.id}`, pt.x + pSize / 2 + 4, pt.y - pSize / 2);
                    ctx.globalAlpha = 1.0;
                });
            }

            ctx.restore();
        }

        // B. Draw "Boolean" Canvas Overlay (The Output Frame)
        // Draw 4 rectangles around the center "hole" to create the boolean effect
        // The "Hole" is defined by (0, 0, videoWidth, videoHeight) in Workspace space (since we want output to be resolution size)

        ctx.fillStyle = "rgba(0, 0, 0, 0.5)"; // Dimmed area

        // Everything to the left
        ctx.fillRect(-100000, -100000, 100000, 200000); // Massive rect
        // Everything to the right
        ctx.fillRect(vid.videoWidth, -100000, 100000, 200000);
        // Top strip (between left/right)
        ctx.fillRect(0, -100000, vid.videoWidth, 100000);
        // Bottom strip (between left/right)
        ctx.fillRect(0, vid.videoHeight, vid.videoWidth, 100000);

        // Draw Output Border
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 / viewTransform.scale;
        ctx.setLineDash([10 / viewTransform.scale, 5 / viewTransform.scale]);
        ctx.strokeRect(0, 0, vid.videoWidth, vid.videoHeight);
        ctx.setLineDash([]);

        // Label for Canvas
        ctx.fillStyle = "#ffffff";
        ctx.font = `${14 / viewTransform.scale}px sans-serif`;
        ctx.fillText(`Output Canvas (${vid.videoWidth}x${vid.videoHeight})`, 10 / viewTransform.scale, -10 / viewTransform.scale);

        ctx.restore(); // End View Transform

        if (timelineCanvasRef.current) drawTimelineTracks(
            timelineCanvasRef.current,
            duration,
            currentTimeRef.current,
            trackingCacheRef.current,
            frameCacheRef.current,
            playbackRange,
            isTimelineZoomed
        ); requestRef.current = requestAnimationFrame(() => tickRef.current());
    }, [
        // Keep full dependencies to ensure tick sees current values
        appState, videoSrc, videoInfo,
        trackers, trackerVisibility, trackerInfluence, selectedTrackerId,
        masks, selectedMaskId,
        images, selectedImageId,
        isStabilized, placementMode,
        viewTransform, videoTransform,
        isDragging, dragTarget,
        isVideoHidden, isCaching,
        isEditingGraph, isScrubbingTimeline,
        duration, currentTime, playbackRange,
        errorTrackerId, isTimelineZoomed
    ]);


    useEffect(() => {
        tickRef.current = tick;
    }, [tick]);

    // Resize Observer to keep Canvas Resolution synced with DOM size
    useEffect(() => {
        if (!containerRef.current || !canvasRef.current) return;
        const resizeObserver = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (canvasRef.current) {
                    const { width, height } = entry.contentRect;
                    canvasRef.current.width = width;
                    canvasRef.current.height = height;
                    // Force a tick to prevent flicker
                    tickRef.current();
                }
            }
        });
        resizeObserver.observe(containerRef.current);
        return () => resizeObserver.disconnect();
    }, []);

    useEffect(() => {
        requestRef.current = requestAnimationFrame(() => tickRef.current());
        return () => {
            if (requestRef.current) cancelAnimationFrame(requestRef.current);
        };
    }, [tick]);

    const fitToScreen = useCallback((vidW: number, vidH: number) => {
        if (!containerRef.current) return;
        const cw = containerRef.current.clientWidth;
        const ch = containerRef.current.clientHeight;
        const scaleW = cw / vidW;
        const scaleH = ch / vidH;
        const scale = Math.min(scaleW, scaleH) * 0.9;
        // Center the Output Frame (which is 0,0 to W,H) in the view
        // View translate moves the origin.
        const x = (cw - vidW * scale) / 2;
        const y = (ch - vidH * scale) / 2;
        setViewTransform({ x, y, scale });
        setVideoTransform({ x: 0, y: 0, scale: 1, rotation: 0 }); // Reset video to align with canvas
    }, []);

    return (
        <div className="flex flex-col h-full bg-slate-950 text-white select-none" ref={containerRef}>
            {/* Header / Toolbar */}
            <div className="h-14 border-b border-slate-800 flex items-center px-4 justify-between bg-slate-900 z-10 shrink-0">
                <div className="flex items-center space-x-4">
                    <div className="flex items-center text-blue-400 font-bold text-lg">
                        <Target className="w-6 h-6 mr-2" />
                        <span>Gemini Tracker</span>
                    </div>
                    <div className="relative group">
                        <button className="p-2 hover:bg-slate-800 rounded text-slate-400 hover:text-white" title="Upload local video">
                            <Upload className="w-5 h-5" />
                        </button>
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="video/*"
                            onChange={handleFileUpload}
                            className="absolute inset-0 opacity-0 cursor-pointer"
                        />
                        <input
                            ref={imageInputRef}
                            type="file"
                            accept="image/*"
                            onChange={handleImageUpload}
                            className="hidden"
                        />
                    </div>

                    {/* YouTube URL Input */}
                    <div className="flex items-center space-x-2">
                        <div className="flex items-center bg-slate-800 rounded-lg border border-slate-700 overflow-hidden">
                            <div className="px-2 text-slate-500">
                                <Link className="w-4 h-4" />
                            </div>
                            <input
                                id="youtube-url-input"
                                type="text"
                                value={youtubeUrl}
                                onChange={(e) => setYoutubeUrl(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') handleYouTubeDownload(); }}
                                placeholder="Paste YouTube URL..."
                                className="bg-transparent text-sm text-white placeholder-slate-500 outline-none py-1.5 w-56"
                                disabled={isDownloading}
                            />
                            <button
                                onClick={handleYouTubeDownload}
                                disabled={isDownloading || !youtubeUrl.trim()}
                                className={`px-3 py-1.5 text-sm font-medium flex items-center transition-colors ${isDownloading
                                    ? 'bg-blue-600/50 text-blue-300 cursor-wait'
                                    : youtubeUrl.trim()
                                        ? 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                                        : 'bg-slate-700 text-slate-500 cursor-not-allowed'
                                    }`}
                            >
                                {isDownloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                            </button>
                        </div>
                        {/* Cookie Upload */}
                        <div className="relative">
                            <button
                                onClick={() => cookieInputRef.current?.click()}
                                className="p-1.5 rounded hover:bg-slate-700 text-slate-500 hover:text-orange-400 transition-colors"
                                title="Upload YouTube cookies.txt"
                            >
                                <Cookie className="w-4 h-4" />
                            </button>
                            <input
                                ref={cookieInputRef}
                                type="file"
                                accept=".txt"
                                className="hidden"
                                onChange={async (e) => {
                                    const file = e.target.files?.[0];
                                    if (!file) return;
                                    try {
                                        const content = await file.text();
                                        const res = await fetch('/api/update-cookies', {
                                            method: 'POST',
                                            headers: { 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ content })
                                        });
                                        const data = await res.json();
                                        if (data.success) {
                                            setDownloadProgress('Cookies updated!');
                                            setTimeout(() => setDownloadProgress(''), 3000);
                                        } else {
                                            setDownloadProgress(`Error: ${data.error}`);
                                            setTimeout(() => setDownloadProgress(''), 5000);
                                        }
                                    } catch (err: any) {
                                        setDownloadProgress(`Error: ${err.message}`);
                                        setTimeout(() => setDownloadProgress(''), 5000);
                                    }
                                    if (cookieInputRef.current) cookieInputRef.current.value = '';
                                }}
                            />
                        </div>
                        {downloadProgress && (
                            <span className={`text-xs max-w-48 truncate ${downloadProgress.startsWith('Error') ? 'text-red-400' : downloadProgress === 'Cookies updated!' ? 'text-green-400' : 'text-blue-400'}`}>
                                {downloadProgress}
                            </span>
                        )}
                    </div>
                </div>

                {videoSrc && (
                    <div className="flex items-center space-x-2">
                        <button onClick={togglePlay} className="p-2 bg-slate-800 hover:bg-slate-700 rounded-full transition-colors text-white">
                            {appState === AppState.PLAYING ? <Pause className="w-5 h-5 fill-current" /> : <Play className="w-5 h-5 fill-current" />}
                        </button>
                        <div className="w-px h-6 bg-slate-800 mx-2"></div>
                        <button
                            onClick={toggleAnalyze}
                            className={`flex items-center px-3 py-1.5 rounded-md font-medium text-sm transition-colors ${appState === AppState.ANALYZING ? 'bg-red-500/20 text-red-400 border border-red-500/50' : 'bg-indigo-600 hover:bg-indigo-500 text-white'}`}
                        >
                            {appState === AppState.ANALYZING ? <Square className="w-4 h-4 mr-2 fill-current" /> : <ScanEye className="w-4 h-4 mr-2" />}
                            {appState === AppState.ANALYZING ? 'Stop Tracking' : 'Track Selected'}
                        </button>

                        <button
                            onClick={handleExport}
                            className={`flex items-center px-3 py-1.5 rounded-md font-medium text-sm transition-colors ${appState === AppState.EXPORTING ? 'bg-orange-500/20 text-orange-400 animate-pulse' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'}`}
                        >
                            {appState === AppState.EXPORTING ? 'Exporting...' : 'Export'}
                        </button>
                    </div>
                )}

                <div className="flex items-center space-x-3">
                    <button onClick={() => setIsSidebarOpen(!isSidebarOpen)} className={`p-2 rounded hover:bg-slate-800 ${isSidebarOpen ? 'text-blue-400 bg-slate-800' : 'text-slate-400'}`}>
                        <List className="w-5 h-5" />
                    </button>
                    <button onClick={() => setIsGraphOpen(!isGraphOpen)} className={`p-2 rounded hover:bg-slate-800 ${isGraphOpen ? 'text-blue-400 bg-slate-800' : 'text-slate-400'}`}>
                        <Activity className="w-5 h-5" />
                    </button>
                </div>
            </div>

            <div className="flex-1 flex overflow-hidden">
                <div className="flex-1 relative overflow-hidden bg-[#0a0a0a] flex flex-col">
                    {videoSrc && (
                        <div className="absolute left-4 top-4 flex flex-col bg-slate-900/95 backdrop-blur border border-slate-800 rounded-lg p-2 space-y-2 z-20 shadow-xl w-48">

                            {/* Layer Controls */}
                            <div className="mb-2">
                                <span className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-1 block px-1">Layers</span>

                                {/* Video Layer */}
                                <div
                                    className={`flex items-center justify-between p-2 rounded cursor-pointer transition-colors ${selectedLayer === 'VIDEO' ? 'bg-blue-600/20 border border-blue-500/30' : 'hover:bg-slate-800 border border-transparent'}`}
                                    onClick={() => setSelectedLayer('VIDEO')}
                                >
                                    <div className="flex items-center space-x-2 overflow-hidden">
                                        <Video className={`w-4 h-4 ${selectedLayer === 'VIDEO' ? 'text-blue-400' : 'text-slate-400'}`} />
                                        <span className={`text-sm truncate ${selectedLayer === 'VIDEO' ? 'text-blue-100' : 'text-slate-300'}`}>Video</span>
                                    </div>
                                    <div className="flex items-center space-x-1">
                                        <button onClick={(e) => { e.stopPropagation(); setIsVideoLocked(!isVideoLocked); }} className={`p-1 rounded hover:bg-slate-700 ${isVideoLocked ? 'text-orange-400' : 'text-slate-500'}`}>
                                            {isVideoLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); setIsVideoHidden(!isVideoHidden); }} className={`p-1 rounded hover:bg-slate-700 ${isVideoHidden ? 'text-slate-600' : 'text-slate-400'}`}>
                                            {isVideoHidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                                        </button>
                                    </div>
                                </div>

                                {/* Canvas Layer */}
                                <div
                                    className={`flex items-center justify-between p-2 rounded cursor-pointer mt-1 transition-colors ${selectedLayer === 'CANVAS' ? 'bg-blue-600/20 border border-blue-500/30' : 'hover:bg-slate-800 border border-transparent'}`}
                                    onClick={() => setSelectedLayer('CANVAS')}
                                >
                                    <div className="flex items-center space-x-2">
                                        <LayoutTemplate className={`w-4 h-4 ${selectedLayer === 'CANVAS' ? 'text-blue-400' : 'text-slate-400'}`} />
                                        <span className={`text-sm ${selectedLayer === 'CANVAS' ? 'text-blue-100' : 'text-slate-300'}`}>Canvas</span>
                                    </div>
                                    <button onClick={(e) => { e.stopPropagation(); setIsCanvasLocked(!isCanvasLocked); }} className={`p-1 rounded hover:bg-slate-700 ${isCanvasLocked ? 'text-orange-400' : 'text-slate-500'}`}>
                                        {isCanvasLocked ? <Lock className="w-3 h-3" /> : <Unlock className="w-3 h-3" />}
                                    </button>
                                </div>
                            </div>

                            <div className="h-px bg-slate-700 w-full my-2"></div>

                            {/* Tools */}
                            <div className="grid grid-cols-3 gap-1">
                                <button
                                    onClick={() => activatePlacement('stabilizer')}
                                    className={`p-2 rounded hover:bg-slate-700 transition-colors flex justify-center ${placementMode === 'stabilizer' ? 'bg-blue-600 text-white' : 'text-slate-400'}`}
                                    title="Add Stabilizer Point"
                                >
                                    <Target className="w-5 h-5" />
                                </button>
                                <button
                                    onClick={() => activatePlacement('parent')}
                                    className={`p-2 rounded hover:bg-slate-700 transition-colors flex justify-center ${placementMode === 'parent' ? 'bg-indigo-600 text-white' : 'text-indigo-400'}`}
                                    title="Add Parent Point"
                                >
                                    <MousePointer2 className="w-5 h-5" />
                                </button>
                                <button onClick={() => spawnMask('box')} className="p-2 rounded hover:bg-slate-700 text-slate-400 transition-colors flex justify-center" title="Add Box Mask"><BoxSelect className="w-5 h-5" /></button>
                                <button onClick={() => spawnMask('circle')} className="p-2 rounded hover:bg-slate-700 text-slate-400 transition-colors flex justify-center" title="Add Circle Mask"><Circle className="w-5 h-5" /></button>
                            </div>

                            <button
                                onClick={() => { fitToScreen(videoInfo?.width || 1920, videoInfo?.height || 1080); }}
                                className="w-full mt-2 p-2 rounded hover:bg-slate-700 text-slate-400 transition-colors text-xs flex items-center justify-center"
                            >
                                <Maximize className="w-3 h-3 mr-2" /> Reset View
                            </button>
                        </div>
                    )}

                    <div className="flex-1 relative overflow-hidden">
                        {!videoSrc && (
                            <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-600">
                                <Video className="w-16 h-16 mb-4 opacity-20" />
                                <p className="text-lg font-medium">Upload a video to begin</p>
                                <p className="text-sm opacity-50">Drag & drop or use the upload button</p>
                            </div>
                        )}

                        <video
                            ref={videoRef}
                            src={videoSrc || undefined}
                            className="absolute inset-0 w-full h-full object-contain pointer-events-auto opacity-100 z-10"
                            playsInline
                            muted
                            controls
                            onError={(e) => console.error('Video error event:', e.nativeEvent)}
                            onLoadedMetadata={(e) => {
                                const v = e.currentTarget;
                                console.log('Video loaded metadata:', v.duration, v.videoWidth, v.videoHeight);
                                setDuration(v.duration);
                                setPlaybackRange({ start: 0, end: v.duration });
                                setVideoInfo({ width: v.videoWidth, height: v.videoHeight, fps: 30 });
                                fitToScreen(v.videoWidth, v.videoHeight);
                                // Fix black first frame by seeking slightly
                                if (v.duration > 0.1) v.currentTime = 0.01;
                            }}
                        />

                        <canvas
                            ref={canvasRef}
                            className="absolute inset-0 block w-full h-full touch-none"
                            style={{ cursor: cursorStyle }}
                            onPointerDown={handlePointerDown}
                            onPointerMove={handlePointerMove}
                            onPointerUp={handlePointerUp}
                            onPointerLeave={handlePointerUp}
                            onWheel={handleCanvasWheel}
                        />
                    </div>

                    {videoSrc && (
                        <div className="shrink-0 flex flex-col border-t border-slate-800 bg-slate-900 z-20">
                            <GraphEditor
                                visible={isGraphOpen}
                                onClose={() => setIsGraphOpen(false)}
                                trackers={trackers}
                                masks={masks}
                                images={images}
                                selectedId={selectedTrackerId || selectedMaskId || selectedImageId}
                                selectedColor={
                                    selectedTrackerId ? trackers.find(t => t.id === selectedTrackerId)?.color || '#fff' :
                                        selectedMaskId ? masks.find(m => m.id === selectedMaskId)?.color || '#fff' :
                                            selectedImageId ? '#f472b6' : '#fff'
                                }
                                videoDuration={duration}
                                currentTime={currentTime}
                                onSeek={handleTimelineChange}
                                trackingCache={trackingCacheRef.current}
                                maskCache={maskCacheRef.current}
                                imageCache={imageCacheRef.current}
                                onCopyAbsolute={handleCopyAbsolute}
                                onPasteAbsolute={handlePasteAbsolute}
                                onUpdateData={(frameKey, point, id, save) => {
                                    if (save) saveToHistory();
                                    const targetId = id || selectedTrackerId || selectedMaskId || selectedImageId;
                                    if (!targetId) return;
                                    const isMask = masks.some(m => m.id === targetId);
                                    const isImage = images.some(i => i.id === targetId);

                                    if (isMask) {
                                        let current = maskCacheRef.current.get(frameKey) || [];
                                        if (point === null) {
                                            current = current.filter(m => m.id !== targetId);
                                            if (current.length === 0) maskCacheRef.current.delete(frameKey); else maskCacheRef.current.set(frameKey, current);
                                        } else {
                                            const idx = current.findIndex(m => m.id === targetId);
                                            if (idx >= 0) current[idx] = point; else current.push(point);
                                            maskCacheRef.current.set(frameKey, current);
                                        }
                                    } else if (isImage) {
                                        let current = imageCacheRef.current.get(frameKey) || [];
                                        if (point === null) {
                                            current = current.filter(i => i.id !== targetId);
                                            if (current.length === 0) imageCacheRef.current.delete(frameKey); else imageCacheRef.current.set(frameKey, current);
                                        } else {
                                            const idx = current.findIndex(i => i.id === targetId);
                                            if (idx >= 0) current[idx] = point; else current.push(point);
                                            imageCacheRef.current.set(frameKey, current);
                                        }
                                    } else {
                                        let current = trackingCacheRef.current.get(frameKey) || [];
                                        if (point === null) {
                                            current = current.filter(t => t.id !== targetId);
                                            if (current.length === 0) trackingCacheRef.current.delete(frameKey); else trackingCacheRef.current.set(frameKey, current);
                                        } else {
                                            const idx = current.findIndex(t => t.id === targetId);
                                            if (idx >= 0) current[idx] = point; else current.push(point);
                                            trackingCacheRef.current.set(frameKey, current);
                                        }
                                    }

                                    // If deleting the specific key at the current time, remove it from the 'last' refs 
                                    // so it doesn't get resurrected as a ghost/stale value in handleTimelineChange.
                                    if (point === null && getKeyFromTime(currentTime) === frameKey) {
                                        if (isMask) lastMasksRef.current.delete(targetId);
                                        else if (isImage) lastImagesRef.current.delete(targetId);
                                        else lastPointsRef.current.delete(targetId);
                                    }
                                    if (getKeyFromTime(currentTime) === frameKey) handleTimelineChange(currentTime);
                                    else setDataVersion(v => v + 1); // Force update if not on current frame
                                }}
                                onInteractionStart={saveToHistory}
                                onUndo={handleUndo}

                                onEditingChange={setIsEditingGraph}
                                dataVersion={dataVersion}
                            />

                            <div className="h-10 flex items-center px-4 justify-between bg-slate-950 border-b border-slate-900">
                                <div className="flex items-center space-x-2">
                                    {/* Bottom Play Controls */}
                                    <button onClick={togglePlay} className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded mr-1">
                                        {appState === AppState.PLAYING ? <Pause className="w-4 h-4 fill-current" /> : <Play className="w-4 h-4 fill-current" />}
                                    </button>
                                    <div className="w-px h-4 bg-slate-800 mx-1"></div>
                                    <button onClick={() => jumpToKeyframe('prev')} className="p-1 text-slate-500 hover:text-white"><SkipBack className="w-4 h-4" /></button>
                                    <button onClick={() => stepFrame(-1)} className="p-1 text-slate-500 hover:text-white"><ChevronLeft className="w-4 h-4" /></button>
                                    <span className="text-xs font-mono text-slate-400 w-16 text-center">
                                        {currentTime.toFixed(2)}s
                                    </span>
                                    <button onClick={() => stepFrame(1)} className="p-1 text-slate-500 hover:text-white"><ChevronRight className="w-4 h-4" /></button>
                                    <button onClick={() => jumpToKeyframe('next')} className="p-1 text-slate-500 hover:text-white"><SkipForward className="w-4 h-4" /></button>

                                    <div className="w-px h-4 bg-slate-800 mx-2"></div>
                                    <button onClick={() => { setPlaybackRange(prev => ({ ...prev, start: currentTime })); setIsTimelineZoomed(true); setDataVersion(v => v + 1); }} className="p-1 text-[10px] font-bold text-slate-500 hover:text-white bg-slate-900 border border-slate-700 rounded px-1.5" title="Set In Point (I)">IN</button>
                                    <button onClick={() => { setPlaybackRange(prev => ({ ...prev, end: currentTime })); setIsTimelineZoomed(true); setDataVersion(v => v + 1); }} className="p-1 text-[10px] font-bold text-slate-500 hover:text-white bg-slate-900 border border-slate-700 rounded px-1.5" title="Set Out Point (O)">OUT</button>
                                    <button onClick={() => { setPlaybackRange({ start: 0, end: videoRef.current?.duration || 100 }); setIsTimelineZoomed(false); setDataVersion(v => v + 1); }} className="p-1 text-slate-500 hover:text-red-400" title="Clear Range (X)"><XCircle className="w-3 h-3" /></button>
                                </div>
                                <div className="flex items-center space-x-3">
                                    <button onClick={toggleTimelineZoom} className={`p-1 rounded ${isTimelineZoomed ? 'text-blue-400' : 'text-slate-500 hover:text-white'}`}><ZoomIn className="w-4 h-4" /></button>
                                    <div className="h-4 w-px bg-slate-700 mx-2"></div>
                                    <button
                                        onClick={cacheFrames}
                                        disabled={isCaching}
                                        className={`p-1 rounded flex items-center gap-1 text-xs ${isCaching ? 'text-orange-400' : 'text-slate-500 hover:text-white'}`}
                                        title="Cache Frames for Smooth Playback"
                                    >
                                        {isCaching ? <Activity className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                                        {isCaching ? `${cacheProgress}%` : 'Cache'}
                                    </button>
                                </div>
                            </div>

                            <div
                                className="h-16 relative cursor-pointer group"
                                onPointerDown={(e) => {
                                    const r = e.currentTarget.getBoundingClientRect();
                                    const x = e.clientX - r.left;
                                    const w = r.width;
                                    let viewStart = 0;
                                    let viewEnd = duration;
                                    if (isTimelineZoomed && playbackRange.end > playbackRange.start) {
                                        viewStart = playbackRange.start;
                                        viewEnd = playbackRange.end;
                                    }
                                    const t = viewStart + (x / w) * (viewEnd - viewStart);
                                    // Pause for smoother scrubbing
                                    if (videoRef.current && !videoRef.current.paused) videoRef.current.pause();
                                    setAppState(AppState.READY);

                                    handleTimelineChange(Math.max(0, Math.min(duration, t)));
                                    setIsScrubbingTimeline(true);
                                    e.currentTarget.setPointerCapture(e.pointerId);

                                    // Smooth Scrubbing Loop
                                    const scrubLoop = () => {
                                        if (isScrubbingRef.current) {
                                            // Force Update Canvas
                                            if (timelineCanvasRef.current) {
                                                drawTimelineTracks(
                                                    timelineCanvasRef.current,
                                                    duration,
                                                    currentTimeRef.current, // Read from REF
                                                    trackingCacheRef.current,
                                                    frameCacheRef.current,
                                                    playbackRange,
                                                    isTimelineZoomed
                                                );
                                            }
                                            // Force Update Main Canvas (Tick)
                                            // This ensures visual feedback even if video seek is throttled,
                                            // provided we have cached frames or interpolation data.
                                            if (tickRef.current) tickRef.current();

                                            requestAnimationFrame(scrubLoop);
                                        }
                                    };
                                    isScrubbingRef.current = true;
                                    requestAnimationFrame(scrubLoop);
                                }}
                                onPointerMove={(e) => {
                                    if (isScrubbingTimeline) {
                                        const r = e.currentTarget.getBoundingClientRect();
                                        const x = e.clientX - r.left;
                                        const w = r.width;
                                        let viewStart = 0;
                                        let viewEnd = duration;
                                        if (isTimelineZoomed && playbackRange.end > playbackRange.start) {
                                            viewStart = playbackRange.start;
                                            viewEnd = playbackRange.end;
                                        }
                                        const t = viewStart + (x / w) * (viewEnd - viewStart);

                                        // Update Value Immediately
                                        const clampedT = Math.max(0, Math.min(duration, t));
                                        currentTimeRef.current = clampedT; // Instant Ref Update
                                        handleTimelineChange(clampedT);
                                    }
                                }}
                                onPointerUp={(e) => {
                                    setIsScrubbingTimeline(false);
                                    isScrubbingRef.current = false; // Stop Loop
                                    // Final sync to ensure we land exactly on the frame we stopped at
                                    if (videoRef.current) {
                                        videoRef.current.currentTime = currentTimeRef.current;
                                    }
                                    e.currentTarget.releasePointerCapture(e.pointerId);
                                }}
                            >
                                <canvas ref={timelineCanvasRef} className="w-full h-full block" width={1000} height={64} />
                            </div>
                        </div>
                    )}
                </div>

                {/* Right Sidebar - Trackers List */}
                {videoSrc && isSidebarOpen && (
                    <div className="w-64 bg-slate-900 border-l border-slate-800 flex flex-col shrink-0 overflow-hidden">
                        <div className="h-10 border-b border-slate-800 flex items-center px-3 bg-slate-900/50">
                            <span className="text-xs font-bold text-slate-400 uppercase tracking-wider">Objects</span>
                        </div>

                        {/* Selected Tracker Settings */}
                        {selectedTrackerId && (
                            <div className="p-3 bg-slate-800/50 border-b border-slate-800 flex flex-col space-y-3">
                                <span className="text-xs font-bold text-blue-400 uppercase">Settings (ID: {selectedTrackerId})</span>
                                {(() => {
                                    const t = trackers.find(tr => tr.id === selectedTrackerId);
                                    if (!t) return null;
                                    const settings = trackerSettingsRef.current.get(t.id) || { patchSize: DEFAULT_PATCH_SIZE, searchWindow: DEFAULT_SEARCH_WINDOW, sensitivity: DEFAULT_SENSITIVITY, adaptive: DEFAULT_ADAPTIVE };

                                    return (
                                        <>
                                            <div className="flex flex-col space-y-1">
                                                <div className="flex justify-between text-xs text-slate-300">
                                                    <span>Patch Size</span>
                                                    <span>{settings.patchSize}px</span>
                                                </div>
                                                <input
                                                    type="range" min="16" max="128" step="8"
                                                    value={settings.patchSize}
                                                    onChange={(e) => updateTrackerSetting(t.id, 'patchSize', parseInt(e.target.value))}
                                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                                                />
                                            </div>
                                            <div className="flex flex-col space-y-1">
                                                <div className="flex justify-between text-xs text-slate-300">
                                                    <span>Search Window</span>
                                                    <span>{settings.searchWindow}px</span>
                                                </div>
                                                <input
                                                    type="range" min="20" max="200" step="10"
                                                    value={settings.searchWindow}
                                                    onChange={(e) => updateTrackerSetting(t.id, 'searchWindow', parseInt(e.target.value))}
                                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                                                />
                                            </div>
                                            <div className="flex flex-col space-y-1">
                                                <div className="flex justify-between text-xs text-slate-300">
                                                    <span>Sensitivity</span>
                                                    <span>{settings.sensitivity}%</span>
                                                </div>
                                                <input
                                                    type="range" min="0" max="100" step="5"
                                                    value={settings.sensitivity}
                                                    onChange={(e) => updateTrackerSetting(t.id, 'sensitivity', parseInt(e.target.value))}
                                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                                                />
                                            </div>

                                        </>
                                    );
                                })()}
                                <div className="pt-2 border-t border-slate-700">
                                    <button
                                        onClick={triggerImageUpload}
                                        className="w-full py-1.5 px-3 bg-pink-600 hover:bg-pink-500 text-white rounded text-xs font-medium flex items-center justify-center transition-colors"
                                    >
                                        <ImageIcon className="w-3 h-3 mr-2" />
                                        Attach Image
                                    </button>
                                </div>
                            </div >
                        )}

                        {/* Selected Image Settings */}
                        {selectedImageId && (
                            <div className="p-3 bg-slate-800/50 border-b border-slate-800 flex flex-col space-y-3">
                                <span className="text-xs font-bold text-pink-400 uppercase">Image Settings (ID: {selectedImageId})</span>
                                {(() => {
                                    const img = images.find(i => i.id === selectedImageId);
                                    if (!img) return null;
                                    return (
                                        <div className="flex flex-col space-y-3">
                                            {/* Parent Dropdown */}
                                            <div className="flex flex-col space-y-1">
                                                <div className="flex justify-between items-center text-xs text-slate-300">
                                                    <span>Parent</span>
                                                    <button onClick={() => addKeyframe(img.id, 'parentId' as any, img.parentId)} title="Force Key" className="text-slate-500 hover:text-blue-400 p-0.5 rounded"><GitCommit className="w-3 h-3" /></button>
                                                </div>
                                                <select
                                                    value={img.parentId || ""}
                                                    onChange={(e) => {
                                                        const newPid = e.target.value || null; // e.target.value is string, empty = World
                                                        // Cast to string or undefined/null
                                                        const targetPid = newPid === "" ? undefined : newPid;

                                                        if (targetPid === img.parentId) return;

                                                        const TR = (d: number) => d * Math.PI / 180;

                                                        // 1. Get Current World Transform
                                                        let wx = img.x, wy = img.y, wr = img.rotation;
                                                        // NOTE: 'trackers' here is from React Render. 
                                                        // For robust calculation during playback/scrub, we should arguably use 'lastPointsRef.current' 
                                                        // but 'trackers' usually reflects 'activePoints' due to render loop logic unless pure React update lag.
                                                        // Safest is to find parent in 'trackers' which is what is visible.
                                                        const oldP = trackers.find(t => t.id === img.parentId);
                                                        if (oldP) {
                                                            const pr = TR(oldP.rotation || 0);
                                                            const rc = Math.cos(pr), rs = Math.sin(pr);
                                                            wx = oldP.x + (img.x * rc - img.y * rs);
                                                            wy = oldP.y + (img.x * rs + img.y * rc);
                                                            wr = (img.rotation + (oldP.rotation || 0));
                                                        }

                                                        // 2. Get New Parent Transform
                                                        let npx = 0, npy = 0, npr = 0;
                                                        // Find new parent in same list
                                                        if (targetPid) {
                                                            const newP = trackers.find(t => t.id === targetPid);
                                                            if (!newP) return; // Should not happen if select options are correct
                                                            npx = newP.x; npy = newP.y; npr = newP.rotation || 0;
                                                        }

                                                        // 3. Compute New Local
                                                        const nprRad = TR(npr);
                                                        const nrc = Math.cos(nprRad), nrs = Math.sin(nprRad);

                                                        const dx = wx - npx;
                                                        const dy = wy - npy;

                                                        // Rotate (dx, dy) by -npr (Inverse Rotation)
                                                        // Rot Matrix: [c -s; s c]. Inv: [c s; -s c]
                                                        const nlx = dx * nrc + dy * nrs;
                                                        const nly = -dx * nrs + dy * nrc;
                                                        const nlr = wr - npr;

                                                        // 4. Update
                                                        // We set isManual=true so it sticks until next keyframe logic overrides it
                                                        // 'parentId' is technically a string, so we cast if needed (interface has string|undefined)
                                                        const updated = { ...img, parentId: targetPid as string, x: nlx, y: nly, rotation: nlr, isManual: true };

                                                        // Update State & Cache
                                                        setImages(prev => prev.map(i => i.id === img.id ? updated : i));
                                                        renderedImagesRef.current = images.map(i => i.id === img.id ? updated : i); // Immediate visual

                                                        const last = lastImagesRef.current.get(img.id);
                                                        if (last) lastImagesRef.current.set(img.id, { ...last, ...updated });
                                                        else lastImagesRef.current.set(img.id, updated);

                                                        const key = getKeyFromTime(videoRef.current?.currentTime || currentTime);
                                                        const cached = imageCacheRef.current.get(key) || [];
                                                        // We must ensure we don't duplicate
                                                        const newCached = cached.filter(c => c.id !== img.id);
                                                        newCached.push(updated);
                                                        imageCacheRef.current.set(key, newCached);
                                                    }}
                                                    className="w-full bg-slate-700 text-xs text-white rounded p-1"
                                                >
                                                    <option value="">None (World)</option>
                                                    {trackers.map(t => (
                                                        <option key={t.id} value={t.id}>Tracker {t.id}</option>
                                                    ))}
                                                </select>
                                            </div>
                                            <div className="flex flex-col space-y-1">
                                                <div className="flex justify-between items-center text-xs text-slate-300">
                                                    <span>Opacity</span>
                                                    <div className="flex items-center space-x-2">
                                                        <span>{(img.opacity).toFixed(2)}</span>
                                                        <button onClick={() => addKeyframe(img.id, 'opacity', img.opacity)} title="Add Keyframe" className="text-slate-500 hover:text-blue-400 p-0.5 rounded"><GitCommit className="w-3 h-3" /></button>
                                                    </div>
                                                </div>
                                                <input
                                                    type="range" min="0" max="1" step="0.05"
                                                    value={img.opacity}
                                                    onChange={(e) => {
                                                        const val = parseFloat(e.target.value);
                                                        setImages(prev => prev.map(i => i.id === img.id ? { ...i, opacity: val } : i));
                                                        // Note: We don't auto-key unless dragging stops usually, but here we update 'last' for persistence
                                                        const last = lastImagesRef.current.get(img.id);
                                                        if (last) {
                                                            const updated = { ...last, opacity: val };
                                                            lastImagesRef.current.set(img.id, updated);
                                                            // Auto-update current frame cache if playing/paused? 
                                                            // Better to let user key it manually or implicit 'auto-key' logic if we implemented that.
                                                            // For now, mirroring previous behavior: update cache too.
                                                            const key = getKeyFromTime(videoRef.current?.currentTime || currentTime);
                                                            const cached = imageCacheRef.current.get(key) || images;
                                                            const idx = cached.findIndex(c => c.id === img.id);
                                                            const newCached = [...cached];
                                                            if (idx >= 0) newCached[idx] = updated; else newCached.push(updated);
                                                            imageCacheRef.current.set(key, newCached);
                                                        }
                                                    }}
                                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                                                />
                                            </div>
                                            <div className="flex flex-col space-y-1">
                                                <div className="flex justify-between items-center text-xs text-slate-300">
                                                    <span>Scale</span>
                                                    <div className="flex items-center space-x-2">
                                                        <span>{Math.round(img.width)}x{Math.round(img.height)}</span>
                                                        <button onClick={() => addKeyframe(img.id, 'width', img.width)} title="Add Keyframe" className="text-slate-500 hover:text-blue-400 p-0.5 rounded"><GitCommit className="w-3 h-3" /></button>
                                                    </div>
                                                </div>
                                                <input
                                                    type="range"
                                                    min={10} max={1000} step={10}
                                                    value={img.width}
                                                    onChange={(e) => {
                                                        const newW = parseFloat(e.target.value);
                                                        const newH = newW / (img.aspectRatio || 1);
                                                        setImages(prev => prev.map(i => i.id === img.id ? { ...i, width: newW, height: newH, isManual: true } : i));
                                                        const last = lastImagesRef.current.get(img.id);
                                                        if (last) {
                                                            const updated = { ...last, width: newW, height: newH, isManual: true };
                                                            lastImagesRef.current.set(img.id, updated);
                                                            const key = getKeyFromTime(videoRef.current?.currentTime || currentTime);
                                                            const cached = imageCacheRef.current.get(key) || images;
                                                            const idx = cached.findIndex(c => c.id === img.id);
                                                            const newCached = [...cached];
                                                            if (idx >= 0) newCached[idx] = updated; else newCached.push(updated);
                                                            imageCacheRef.current.set(key, newCached);
                                                        }
                                                    }}
                                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                                                />
                                            </div>
                                            <div className="flex flex-col space-y-1">
                                                <div className="flex justify-between items-center text-xs text-slate-300">
                                                    <span>Rotation</span>
                                                    <div className="flex items-center space-x-2">
                                                        <span>{Math.round(img.rotation)}°</span>
                                                        <button onClick={() => addKeyframe(img.id, 'rotation', img.rotation)} title="Add Keyframe" className="text-slate-500 hover:text-blue-400 p-0.5 rounded"><GitCommit className="w-3 h-3" /></button>
                                                    </div>
                                                </div>
                                                <input
                                                    type="range" min="-180" max="180" step="1"
                                                    value={img.rotation}
                                                    onChange={(e) => {
                                                        const val = parseFloat(e.target.value);
                                                        setImages(prev => prev.map(i => i.id === img.id ? { ...i, rotation: val, isManual: true } : i));
                                                        const last = lastImagesRef.current.get(img.id);
                                                        if (last) {
                                                            const updated = { ...last, rotation: val, isManual: true };
                                                            lastImagesRef.current.set(img.id, updated);
                                                            const key = getKeyFromTime(videoRef.current?.currentTime || currentTime);
                                                            const cached = imageCacheRef.current.get(key) || images;
                                                            const idx = cached.findIndex(c => c.id === img.id);
                                                            const newCached = [...cached];
                                                            if (idx >= 0) newCached[idx] = updated; else newCached.push(updated);
                                                            imageCacheRef.current.set(key, newCached);
                                                        }
                                                    }}
                                                    className="w-full h-1 bg-slate-700 rounded-lg appearance-none cursor-pointer"
                                                />
                                            </div>
                                        </div>
                                    );
                                })()}
                            </div>
                        )}

                        <div className="flex-1 overflow-y-auto p-2 space-y-1">
                            {trackers.length === 0 && masks.length === 0 && (
                                <div className="text-center text-slate-600 text-xs py-4">No trackers added</div>
                            )}

                            {/* Trackers List */}
                            {trackers.map(t => (
                                <div
                                    key={t.id}
                                    className={`flex items-center p-2 rounded text-xs cursor-pointer group ${selectedTrackerId === t.id ? 'bg-blue-600/20 border border-blue-500/30' : 'hover:bg-slate-800 border border-transparent'}`}
                                    onClick={() => handleTrackerSelect(t.id)}
                                >
                                    <div className="w-3 h-3 rounded-full mr-2 shrink-0" style={{ backgroundColor: t.color }}></div>
                                    <span className={`flex-1 truncate ${selectedTrackerId === t.id ? 'text-blue-100' : 'text-slate-300'}`}>
                                        Tracker {t.id} {t.isStabilizer === false && <span className="text-[10px] text-indigo-400 bg-indigo-400/10 px-1 rounded ml-1">PARENT</span>}
                                    </span>

                                    {errorTrackerId === t.id && <AlertTriangle className="w-3 h-3 text-red-500 mr-2" />}

                                    <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button onClick={(e) => { e.stopPropagation(); toggleTrackerInfluence(t.id); }} className={`p-1 hover:bg-slate-700 rounded ${trackerInfluence[t.id] === false ? 'text-slate-600' : 'text-slate-400'}`}>
                                            <Magnet className="w-3 h-3" />
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); toggleTrackerVisibility(t.id); }} className={`p-1 hover:bg-slate-700 rounded ${trackerVisibility[t.id] === false ? 'text-slate-600' : 'text-slate-400'}`}>
                                            {trackerVisibility[t.id] === false ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); deleteTracker(t.id); }} className="p-1 hover:bg-red-900/50 hover:text-red-400 rounded text-slate-600">
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                </div>
                            ))}

                            {/* Masks List */}
                            {masks.map(m => (
                                <div
                                    key={m.id}
                                    className={`flex items-center p-2 rounded text-xs cursor-pointer group ${selectedMaskId === m.id ? 'bg-purple-600/20 border border-purple-500/30' : 'hover:bg-slate-800 border border-transparent'}`}
                                    onClick={() => handleMaskSelect(m.id)}
                                >
                                    <div className={`w-3 h-3 mr-2 shrink-0 ${m.type === 'circle' ? 'rounded-full' : 'rounded-sm'}`} style={{ border: `1px solid ${m.color}` }}></div>
                                    <span className={`flex-1 truncate ${selectedMaskId === m.id ? 'text-purple-100' : 'text-slate-300'}`}>Mask {m.id}</span>

                                    <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button onClick={(e) => { e.stopPropagation(); deleteMask(m.id); }} className="p-1 hover:bg-red-900/50 hover:text-red-400 rounded text-slate-600">
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                </div>
                            ))}

                            {/* Images List */}
                            {images.map(img => (
                                <div
                                    key={img.id}
                                    className={`flex items-center p-2 rounded text-xs cursor-pointer group ${selectedImageId === img.id ? 'bg-pink-600/20 border border-pink-500/30' : 'hover:bg-slate-800 border border-transparent'}`}
                                    onClick={() => handleImageSelect(img.id)}
                                >
                                    <ImageIcon className={`w-3 h-3 mr-2 shrink-0 ${selectedImageId === img.id ? 'text-pink-400' : 'text-slate-400'}`} />
                                    <span className={`flex-1 truncate ${selectedImageId === img.id ? 'text-pink-100' : 'text-slate-300'}`}>Image {img.id}</span>
                                    <div className="flex items-center space-x-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button onClick={(e) => { e.stopPropagation(); deleteImage(img.id); }} className="p-1 hover:bg-red-900/50 hover:text-red-400 rounded text-slate-600">
                                            <Trash2 className="w-3 h-3" />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
        </div >
    );
};

export default VideoWorkspace;