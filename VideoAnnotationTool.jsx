import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
    Play,
    Pause,
    Volume2,
    VolumeX,
    Settings,
    ChevronRight,
    ChevronLeft,
    Repeat,
    Maximize,
    Zap,
    PenTool,
    Eraser,
    Trash2,
    Undo,
    Redo,
    Palette,
    Brush,
    Download,
    Scissors,
    XCircle,
    Search,
    Focus,
    Layers,
    Droplet,
    SkipForward,
    SkipBack,
    Hand,
    MousePointer2,
    Copy,
    Sidebar,
    ClipboardCopy,
    Clipboard,
    ArrowLeft,
    ArrowRight,
    MoveLeft,
    MoveRight,
    BoxSelect,
    Type,
    X,
    FileImage,
    Film,
    Images,
    CheckCircle2,
    Plus,
    Eye,
    EyeOff,
    Lock,
    Unlock,
    GripVertical
} from 'lucide-react';

const FPS = 24;
const DRAWING_CANVAS_WIDTH = 1920;
const DRAWING_CANVAS_HEIGHT = 1080;

const FONTS = [
    { name: 'Sans Serif', value: 'sans-serif' },
    { name: 'Serif', value: 'serif' },
    { name: 'Monospace', value: 'monospace' },
    { name: 'Arial', value: 'Arial, sans-serif' },
    { name: 'Verdana', value: 'Verdana, sans-serif' },
    { name: 'Times New Roman', value: '"Times New Roman", serif' },
    { name: 'Georgia', value: 'Georgia, serif' },
    { name: 'Courier New', value: '"Courier New", monospace' },
    { name: 'Brush Script', value: '"Brush Script MT", cursive' }
];

// --- GEOMETRY HELPERS ---

const getStrokesBounds = (strokes) => {
    if (!strokes || strokes.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    strokes.forEach(stroke => {
        // Handle Text Objects
        if (stroke.type === 'text') {
            const p = stroke.points[0];
            // Estimate text bounds (approximate since we don't have canvas context here)
            const width = stroke.text.length * stroke.size * 0.6;
            const height = stroke.size;
            if (p.x < minX) minX = p.x;
            if (p.x + width > maxX) maxX = p.x + width;
            if (p.y - height / 2 < minY) minY = p.y - height / 2;
            if (p.y + height / 2 > maxY) maxY = p.y + height / 2;
        } else {
            // Handle Line Strokes
            stroke.points.forEach(p => {
                if (p.x < minX) minX = p.x;
                if (p.x > maxX) maxX = p.x;
                if (p.y < minY) minY = p.y;
                if (p.y > maxY) maxY = p.y;
            });
        }
    });

    if (minX === Infinity) return null;
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY, cx: minX + (maxX - minX) / 2, cy: minY + (maxY - minY) / 2 };
};

const pointInPoly = (point, vs) => {
    let x = point.x, y = point.y;
    let inside = false;
    for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
        let xi = vs[i].x, yi = vs[i].y;
        let xj = vs[j].x, yj = vs[j].y;
        let intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
        if (intersect) inside = !inside;
    }
    return inside;
};

const getLineIntersection = (p1, p2, p3, p4) => {
    const x1 = p1.x, y1 = p1.y, x2 = p2.x, y2 = p2.y;
    const x3 = p3.x, y3 = p3.y, x4 = p4.x, y4 = p4.y;

    const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
    if (denom === 0) return null;

    const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
    const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;

    if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) {
        return {
            x: x1 + ua * (x2 - x1),
            y: y1 + ua * (y2 - y1)
        };
    }
    return null;
};

const getBoxIntersection = (p1, p2, box) => {
    const edges = [
        [{ x: box.minX, y: box.minY }, { x: box.maxX, y: box.minY }],
        [{ x: box.maxX, y: box.minY }, { x: box.maxX, y: box.maxY }],
        [{ x: box.maxX, y: box.maxY }, { x: box.minX, y: box.maxY }],
        [{ x: box.minX, y: box.maxY }, { x: box.minX, y: box.minY }]
    ];

    for (const edge of edges) {
        const hit = getLineIntersection(p1, p2, edge[0], edge[1]);
        if (hit) return hit;
    }
    return null;
};

// Simple Hit Test for strokes
const isPointInStroke = (point, stroke) => {
    if (stroke.type === 'text') {
        const b = getStrokesBounds([stroke]);
        const padding = 10;
        return (b && point.x >= b.x - padding && point.x <= b.x + b.w + padding && point.y >= b.y - padding && point.y <= b.y + b.h + padding);
    }

    // For lines: Bounding box check first
    const b = getStrokesBounds([stroke]);
    if (!b || point.x < b.x - 15 || point.x > b.x + b.w + 15 || point.y < b.y - 15 || point.y > b.y + b.h + 15) return false;

    // Detailed point check (inexact but functional for UI)
    const threshold = Math.max(10, stroke.size);
    for (let i = 0; i < stroke.points.length; i += 2) { // Skip every other point for perf
        const p = stroke.points[i];
        if (Math.abs(p.x - point.x) < threshold && Math.abs(p.y - point.y) < threshold) return true;
    }
    return false;
}

// --- EXPORT MODAL COMPONENT ---
const ExportModal = ({ isOpen, onClose, onExport, range, totalFrames }) => {
    const [mode, setMode] = useState('frame'); // frame, sequence, video
    const [prefix, setPrefix] = useState('bunny');
    const [startIndex, setStartIndex] = useState(1);
    const [scale, setScale] = useState(1);
    const [format, setFormat] = useState('png'); // png, jpeg, mp4 (for video)
    const [bitrate, setBitrate] = useState(25); // Mbps
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState(0);

    if (!isOpen) return null;

    const handleAction = async () => {
        setIsExporting(true);
        setProgress(0);
        await onExport({
            mode,
            prefix,
            startIndex: parseInt(startIndex),
            scale: parseFloat(scale),
            format,
            bitrate: bitrate * 1000000, // Convert Mbps to bps
            setProgress
        });
        setIsExporting(false);
        onClose();
    };

    return (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm">
            <div className="bg-neutral-900 border border-neutral-700 rounded-lg w-[480px] shadow-2xl overflow-hidden">
                <div className="p-4 border-b border-neutral-700 flex justify-between items-center bg-neutral-800">
                    <h2 className="text-white font-bold flex items-center gap-2"><Download size={18} /> Export</h2>
                    <button onClick={onClose} className="text-neutral-400 hover:text-white"><X size={18} /></button>
                </div>

                <div className="p-6 flex flex-col gap-6">
                    {/* Mode Selection */}
                    <div className="grid grid-cols-3 gap-2">
                        <button onClick={() => setMode('frame')} className={`flex flex-col items-center gap-2 p-3 rounded border transition-all ${mode === 'frame' ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:bg-neutral-750'}`}>
                            <FileImage size={24} />
                            <span className="text-xs font-bold">Current Frame</span>
                        </button>
                        <button onClick={() => setMode('sequence')} className={`flex flex-col items-center gap-2 p-3 rounded border transition-all ${mode === 'sequence' ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:bg-neutral-750'}`}>
                            <Images size={24} />
                            <span className="text-xs font-bold">Image Sequence</span>
                        </button>
                        <button onClick={() => setMode('video')} className={`flex flex-col items-center gap-2 p-3 rounded border transition-all ${mode === 'video' ? 'bg-orange-500/20 border-orange-500 text-orange-400' : 'bg-neutral-800 border-neutral-700 text-neutral-400 hover:bg-neutral-750'}`}>
                            <Film size={24} />
                            <span className="text-xs font-bold">Video</span>
                        </button>
                    </div>

                    {/* Options */}
                    <div className="flex flex-col gap-4">
                        <div className="grid grid-cols-2 gap-4">
                            <div className="flex flex-col gap-1.5">
                                <label className="text-xs font-bold text-neutral-500 uppercase">File Prefix</label>
                                <input type="text" value={prefix} onChange={e => setPrefix(e.target.value)} className="bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-sm text-white focus:border-orange-500 outline-none" />
                            </div>
                            {mode !== 'video' && mode !== 'frame' && (
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-xs font-bold text-neutral-500 uppercase">Start Index</label>
                                    <input type="number" value={startIndex} onChange={e => setStartIndex(e.target.value)} className="bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-sm text-white focus:border-orange-500 outline-none" />
                                </div>
                            )}
                        </div>

                        {mode !== 'video' ? (
                            <div className="grid grid-cols-2 gap-4">
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-xs font-bold text-neutral-500 uppercase">Scale / Res</label>
                                    <select value={scale} onChange={e => setScale(e.target.value)} className="bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-sm text-white focus:border-orange-500 outline-none">
                                        <option value="0.25">25% (480x270)</option>
                                        <option value="0.5">50% (960x540)</option>
                                        <option value="1">100% (1920x1080)</option>
                                        <option value="2">200% (4K)</option>
                                    </select>
                                </div>
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-xs font-bold text-neutral-500 uppercase">Format</label>
                                    <select value={format} onChange={e => setFormat(e.target.value)} className="bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-sm text-white focus:border-orange-500 outline-none">
                                        <option value="png">PNG</option>
                                        <option value="jpeg">JPEG</option>
                                    </select>
                                </div>
                            </div>
                        ) : (
                            <div className="grid grid-cols-2 gap-4">
                                <div className="flex flex-col gap-1.5">
                                    <label className="text-xs font-bold text-neutral-500 uppercase">Bitrate (Quality)</label>
                                    <select value={bitrate} onChange={e => setBitrate(Number(e.target.value))} className="bg-neutral-800 border border-neutral-600 rounded px-2 py-1.5 text-sm text-white focus:border-orange-500 outline-none">
                                        <option value={5}>5 Mbps (Low)</option>
                                        <option value={8}>8 Mbps (Standard)</option>
                                        <option value={25}>25 Mbps (High)</option>
                                        <option value={50}>50 Mbps (Ultra)</option>
                                    </select>
                                </div>
                            </div>
                        )}

                        {mode === 'sequence' && (
                            <div className="text-xs text-neutral-500 bg-neutral-800 p-2 rounded border border-neutral-700">
                                Exporting range: <span className="text-white font-mono">{range.start}</span> to <span className="text-white font-mono">{range.end}</span> ({range.end - range.start} frames).
                                Browser may ask to allow multiple downloads.
                            </div>
                        )}
                        {mode === 'video' && (
                            <div className="text-xs text-neutral-500 bg-neutral-800 p-2 rounded border border-neutral-700">
                                Will record the viewport playback. Ensure loop is off for best results.
                            </div>
                        )}
                    </div>

                    <button
                        onClick={handleAction}
                        disabled={isExporting}
                        className="w-full py-3 bg-orange-600 hover:bg-orange-500 text-white font-bold rounded flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {isExporting ? `Exporting... ${progress > 0 ? `${progress}%` : ''}` : 'Export Files'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default function App() {
    // --- REFS ---
    const videoRef = useRef(null);
    const canvasRef = useRef(null);
    const annotationRef = useRef(null);
    const containerRef = useRef(null);
    const timelineRef = useRef(null);
    const animationFrameRef = useRef(null);

    const audioContextRef = useRef(null);
    const audioBufferRef = useRef(null);
    const audioSourceNodeRef = useRef(null);

    const frameCache = useRef(new Map());
    const annotations = useRef(new Map());
    const clipboard = useRef(null);

    // --- SCRUBBING REFS ---
    const currentTimeRef = useRef(0);
    const lastVideoSeek = useRef(0);

    // --- HISTORY STATE ---
    const undoStack = useRef([]);
    const redoStack = useRef([]);

    // --- STATE ---
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentFrame, setCurrentFrame] = useState(0);
    const [totalFrames, setTotalFrames] = useState(0);
    const [duration, setDuration] = useState(0);
    const [playbackSpeed, setPlaybackSpeed] = useState(1);
    const [volume, setVolume] = useState(1);
    const [isMuted, setIsMuted] = useState(false);
    const [isScrubbing, setIsScrubbing] = useState(false);
    const [isLooping, setIsLooping] = useState(true);

    const [rangeStart, setRangeStart] = useState(0);
    const [rangeEnd, setRangeEnd] = useState(0);
    const [isRangeActive, setIsRangeActive] = useState(false);
    const [isZoomedToRange, setIsZoomedToRange] = useState(false);

    const [viewTransform, setViewTransform] = useState({ k: 1, x: 0, y: 0 });
    const [isPanning, setIsPanning] = useState(false);
    const lastPanPosition = useRef({ x: 0, y: 0 });

    const [isCaching, setIsCaching] = useState(false);
    const [cacheProgress, setCacheProgress] = useState(0);
    const [hasCached, setHasCached] = useState(false);

    const [selectedTool, setSelectedTool] = useState('brush');
    const [brushColor, setBrushColor] = useState('#e11d48');
    const [brushSize, setBrushSize] = useState(15);
    const [brushOpacity, setBrushOpacity] = useState(1);
    const [currentFont, setCurrentFont] = useState('sans-serif');

    // -- TEXT TOOL STATE --
    const [activeText, setActiveText] = useState(null);

    // -- ONION SKIN STATE --
    const [isOnionSkin, setIsOnionSkin] = useState(false);
    const [onionFramesBefore, setOnionFramesBefore] = useState(2);
    const [onionFramesAfter, setOnionFramesAfter] = useState(2);

    const [isDrawing, setIsDrawing] = useState(false);
    const [hasAnnotations, setHasAnnotations] = useState(false);

    const [cursorPos, setCursorPos] = useState(null);
    const [renderScale, setRenderScale] = useState(1);

    // -- EXPORT STATE --
    const [isExportModalOpen, setIsExportModalOpen] = useState(false);

    // -- SIDE PANEL STATE --
    const [isPanelOpen, setIsPanelOpen] = useState(true);
    const [isLayersPanelOpen, setIsLayersPanelOpen] = useState(false); // NEW: Layer Panel Toggle
    const [videoSrc, setVideoSrc] = useState("https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4");

    // --- LAYERS STATE ---
    const [layers, setLayers] = useState([{ id: 'layer-1', name: 'Layer 1', visible: true, locked: false, opacity: 1 }]);
    const [activeLayerId, setActiveLayerId] = useState('layer-1');

    // --- SELECTION & TRANSFORM STATE ---
    const selectionRef = useRef({
        active: false,
        indices: [],
        originalStrokes: [],
        bounds: null,
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        marqueeStart: null,
        marqueeCurrent: null,
        dragMode: null,
        dragStart: null,
        pendingStrokes: null // NEW: Stores slice data before move commit
    });
    const [selectionActive, setSelectionActive] = useState(false);

    // --- HELPERS ---
    const timeToFrame = (time) => Math.floor(time * FPS);
    const frameToTime = (frame) => frame / FPS;

    const formatTimecode = (frame) => {
        const seconds = Math.floor(frame / FPS);
        const f = frame % FPS;
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${f.toString().padStart(2, '0')}`;
    };

    const hasStrokes = useCallback((frame) => {
        const s = annotations.current.get(frame);
        return s && s.length > 0;
    }, []);

    // --- HISTORY SYSTEM ---
    const saveUndoState = useCallback(() => {
        const currentState = JSON.stringify(Array.from(annotations.current.entries()));
        undoStack.current.push(currentState);
        if (undoStack.current.length > 50) undoStack.current.shift();
        redoStack.current = [];
    }, []);

    const performUndo = useCallback(() => {
        if (undoStack.current.length === 0) return;

        const currentState = JSON.stringify(Array.from(annotations.current.entries()));
        redoStack.current.push(currentState);

        const previousStateJson = undoStack.current.pop();
        annotations.current = new Map(JSON.parse(previousStateJson));

        selectionRef.current.active = false;
        selectionRef.current.pendingStrokes = null; // Clear pending on undo
        setSelectionActive(false);

        setHasAnnotations(p => !p);
        renderAnnotations(currentFrame);
    }, [currentFrame]);

    const performRedo = useCallback(() => {
        if (redoStack.current.length === 0) return;

        const currentState = JSON.stringify(Array.from(annotations.current.entries()));
        undoStack.current.push(currentState);

        const nextStateJson = redoStack.current.pop();
        annotations.current = new Map(JSON.parse(nextStateJson));

        selectionRef.current.active = false;
        setSelectionActive(false);

        setHasAnnotations(p => !p);
        renderAnnotations(currentFrame);
    }, [currentFrame]);

    // --- AUDIO ---
    const initAudio = () => {
        if (!audioContextRef.current) {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            audioContextRef.current = new AudioContext();
        }
        if (audioContextRef.current.state === 'suspended') {
            audioContextRef.current.resume();
        }
    };

    const loadAudio = async (url) => {
        try {
            const response = await fetch(url);
            const arrayBuffer = await response.arrayBuffer();
            if (audioContextRef.current) {
                const decodedAudio = await audioContextRef.current.decodeAudioData(arrayBuffer);
                audioBufferRef.current = decodedAudio;
            }
        } catch (e) {
            console.error("Audio Load Failed", e);
        }
    };

    const playScrubSound = useCallback((time) => {
        if (!audioBufferRef.current || !audioContextRef.current || isMuted) return;
        if (audioSourceNodeRef.current) {
            try { audioSourceNodeRef.current.stop(); } catch (e) { }
        }
        const source = audioContextRef.current.createBufferSource();
        source.buffer = audioBufferRef.current;
        const gainNode = audioContextRef.current.createGain();
        source.connect(gainNode);
        gainNode.connect(audioContextRef.current.destination);
        gainNode.gain.value = volume;
        const duration = 0.08;
        source.start(0, time);
        source.stop(audioContextRef.current.currentTime + duration);
        gainNode.gain.setValueAtTime(volume, audioContextRef.current.currentTime);
        gainNode.gain.exponentialRampToValueAtTime(0.001, audioContextRef.current.currentTime + duration);
        audioSourceNodeRef.current = source;
    }, [volume, isMuted]);


    // --- RENDERING ---

    const drawStroke = useCallback((ctx, stroke, isGhost, colorOverride = null) => {
        // HANDLE TEXT
        if (stroke.type === 'text') {
            const fontSize = stroke.size;
            const fontFamily = stroke.fontFamily || 'sans-serif'; // NEW: Use stored font
            ctx.font = `bold ${fontSize}px ${fontFamily}`;

            if (isGhost) {
                ctx.globalAlpha = ctx.globalAlpha * 0.5;
            }

            ctx.fillStyle = colorOverride || stroke.color;
            ctx.textBaseline = 'middle';

            if (stroke.points && stroke.points.length > 0) {
                ctx.fillText(stroke.text, stroke.points[0].x, stroke.points[0].y);
            }

            // Reset
            ctx.globalAlpha = 1.0;
            return;
        }

        // HANDLE LINES (Standard)
        ctx.beginPath();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = stroke.size;

        if (stroke.tool === 'eraser') {
            if (!isGhost) {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.strokeStyle = 'rgba(0,0,0,1)';
            } else {
                return;
            }
        } else {
            ctx.globalCompositeOperation = 'source-over';
            const currentAlpha = ctx.globalAlpha;
            ctx.globalAlpha = (stroke.opacity || 1) * currentAlpha;
            ctx.strokeStyle = colorOverride || stroke.color;
        }

        if (stroke.points.length > 0) {
            ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
            for (let i = 1; i < stroke.points.length; i++) {
                ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
            }
        }
        ctx.stroke();

        ctx.globalAlpha = 1.0;
        ctx.globalCompositeOperation = 'source-over';
    }, []);

    const getTransformedPoint = (p, center, t) => {
        let x = center.x + (p.x - center.x) * t.scaleX;
        let y = center.y + (p.y - center.y) * t.scaleY;

        if (t.rotation !== 0) {
            const cos = Math.cos(t.rotation);
            const sin = Math.sin(t.rotation);
            const dx = x - center.x;
            const dy = y - center.y;
            x = center.x + (dx * cos - dy * sin);
            y = center.y + (dx * sin + dy * cos);
        }

        x += t.x;
        y += t.y;

        return { x, y };
    };

    const renderAnnotations = useCallback((frame, contextOverride = null, scale = 1) => {
        const canvas = annotationRef.current;
        if (!canvas && !contextOverride) return;

        // Support drawing to external context (for export)
        const ctx = contextOverride || canvas.getContext('2d');
        const sel = selectionRef.current;

        // If drawing to main canvas, clear it. If export context, we assume it's clear or handled.
        if (!contextOverride) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        }

        if (scale !== 1) {
            ctx.save();
            ctx.scale(scale, scale);
        }

        if (isOnionSkin && !contextOverride) {
            for (let i = onionFramesBefore; i >= 1; i--) {
                const prevFrame = frame - i;
                if (prevFrame >= 0) {
                    const prevStrokes = annotations.current.get(prevFrame) || [];
                    const onionOpacity = 0.3 * (1 - (i / (onionFramesBefore + 1)));
                    prevStrokes.forEach(stroke => {
                        ctx.globalAlpha = onionOpacity;
                        drawStroke(ctx, stroke, true, '#ef4444');
                    });
                }
            }
            for (let i = onionFramesAfter; i >= 1; i--) {
                const nextFrame = frame + i;
                if (nextFrame <= totalFrames) {
                    const nextStrokes = annotations.current.get(nextFrame) || [];
                    const onionOpacity = 0.3 * (1 - (i / (onionFramesAfter + 1)));
                    nextStrokes.forEach(stroke => {
                        ctx.globalAlpha = onionOpacity;
                        drawStroke(ctx, stroke, true, '#3b82f6');
                    });
                }
            }
            ctx.globalAlpha = 1.0;
        }

        // UPDATED: Use pending strokes if they exist (visual preview of slice)
        let frameStrokes = annotations.current.get(frame) || [];
        if (sel.active && sel.pendingStrokes && frame === currentFrame) {
            frameStrokes = sel.pendingStrokes;
        }

        // --- LAYERED RENDERING ---
        // We map strokes to their original indices to support selection by index, 
        // but sort them by layer hierarchy for drawing.

        // 1. Create a map of layer ID to layer object for fast lookup
        const layerMap = new Map(layers.map(l => [l.id, l]));

        // 2. Attach original index and determine sort order
        const strokesWithMeta = frameStrokes.map((s, i) => ({ stroke: s, index: i, layerId: s.layerId || 'layer-1' }));

        // 3. Sort: First by Layer Index (Stacking order), then by creation time (array index)
        strokesWithMeta.sort((a, b) => {
            const layerIdxA = layers.findIndex(l => l.id === a.layerId);
            const layerIdxB = layers.findIndex(l => l.id === b.layerId);
            // Default to bottom if layer missing
            const idxA = layerIdxA === -1 ? 0 : layerIdxA;
            const idxB = layerIdxB === -1 ? 0 : layerIdxB;

            if (idxA !== idxB) return idxA - idxB;
            return a.index - b.index;
        });

        // 4. Render
        strokesWithMeta.forEach(({ stroke, index, layerId }) => {
            const layer = layerMap.get(layerId);
            // Skip hidden layers
            if (layer && !layer.visible) return;

            // Apply Layer Opacity
            // drawStroke uses current globalAlpha as a base, so we set it here
            ctx.globalAlpha = layer && layer.opacity !== undefined ? layer.opacity : 1;

            // Only show selection GUI if not exporting (contextOverride null)
            if (!contextOverride && sel.active && sel.indices.includes(index)) {
                const originalStroke = sel.originalStrokes[sel.indices.indexOf(index)];
                if (originalStroke) {
                    const t = sel.transform;
                    const center = { x: sel.bounds.cx, y: sel.bounds.cy };
                    const transformedPoints = originalStroke.points.map(p => getTransformedPoint(p, center, t));

                    // NEW: Calculate scaled size for preview
                    const avgScale = (Math.abs(t.scaleX) + Math.abs(t.scaleY)) / 2;
                    const scaledSize = Math.max(1, originalStroke.size * avgScale);

                    // Render transformed stroke/text with new size
                    drawStroke(ctx, { ...originalStroke, points: transformedPoints, size: scaledSize }, false, null);
                } else {
                    drawStroke(ctx, stroke, false, null);
                }
            } else {
                drawStroke(ctx, stroke, false, null);
            }
        });

        if (!contextOverride && sel.dragMode === 'marquee' && sel.marqueeStart && sel.marqueeCurrent) {
            const x = Math.min(sel.marqueeStart.x, sel.marqueeCurrent.x);
            const y = Math.min(sel.marqueeStart.y, sel.marqueeCurrent.y);
            const w = Math.abs(sel.marqueeCurrent.x - sel.marqueeStart.x);
            const h = Math.abs(sel.marqueeCurrent.y - sel.marqueeStart.y);

            ctx.save();
            ctx.setLineDash([5, 5]);
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = 'rgba(59, 130, 246, 0.1)';
            ctx.fillRect(x, y, w, h);
            ctx.restore();
        }

        if (!contextOverride && sel.active && sel.bounds) {
            const t = sel.transform;
            const b = sel.bounds;
            const center = { x: b.cx, y: b.cy };

            const tl = getTransformedPoint({ x: b.x, y: b.y }, center, t);
            const tr = getTransformedPoint({ x: b.x + b.w, y: b.y }, center, t);
            const br = getTransformedPoint({ x: b.x + b.w, y: b.y + b.h }, center, t);
            const bl = getTransformedPoint({ x: b.x, y: b.y + b.h }, center, t);
            const tm = getTransformedPoint({ x: b.cx, y: b.y }, center, t);

            ctx.save();
            ctx.beginPath();
            ctx.moveTo(tl.x, tl.y);
            ctx.lineTo(tr.x, tr.y);
            ctx.lineTo(br.x, br.y);
            ctx.lineTo(bl.x, bl.y);
            ctx.closePath();

            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.stroke();

            const handles = [tl, tr, br, bl,
                getTransformedPoint({ x: b.cx, y: b.y }, center, t),
                getTransformedPoint({ x: b.x + b.w, y: b.cy }, center, t),
                getTransformedPoint({ x: b.cx, y: b.y + b.h }, center, t),
                getTransformedPoint({ x: b.x, y: b.cy }, center, t)
            ];

            ctx.fillStyle = '#fff';
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 1;

            handles.forEach(p => {
                ctx.beginPath();
                ctx.rect(p.x - 6, p.y - 6, 12, 12);
                ctx.fill();
                ctx.stroke();
            });

            const rotHandle = getTransformedPoint({ x: b.cx, y: b.y - 40 }, center, t);
            ctx.beginPath();
            ctx.moveTo(tm.x, tm.y);
            ctx.lineTo(rotHandle.x, rotHandle.y);
            ctx.strokeStyle = '#3b82f6';
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(rotHandle.x, rotHandle.y, 6, 0, Math.PI * 2);
            ctx.fillStyle = '#fff';
            ctx.fill();
            ctx.stroke();

            ctx.restore();
        }

        if (scale !== 1) {
            ctx.restore();
        }

    }, [isOnionSkin, onionFramesBefore, onionFramesAfter, drawStroke, totalFrames, layers, currentFrame]);

    useEffect(() => {
        renderAnnotations(currentFrame);
    }, [isOnionSkin, onionFramesBefore, onionFramesAfter, currentFrame, renderAnnotations, selectionActive, hasAnnotations, activeText, layers]);

    // --- COORDINATES ---
    const getCanvasCoordinates = (e) => {
        const container = containerRef.current;
        if (!container) return null;

        const rect = container.getBoundingClientRect();
        const videoAspect = DRAWING_CANVAS_WIDTH / DRAWING_CANVAS_HEIGHT;
        const containerAspect = rect.width / rect.height;

        let baseRenderWidth, baseRenderHeight, baseOffsetX, baseOffsetY;

        if (containerAspect > videoAspect) {
            baseRenderHeight = rect.height;
            baseRenderWidth = rect.height * videoAspect;
            baseOffsetX = (rect.width - baseRenderWidth) / 2;
            baseOffsetY = 0;
        } else {
            baseRenderWidth = rect.width;
            baseRenderHeight = rect.width / videoAspect;
            baseOffsetX = 0;
            baseOffsetY = (rect.height - baseRenderHeight) / 2;
        }

        const currentScale = (baseRenderWidth / DRAWING_CANVAS_WIDTH) * viewTransform.k;
        if (Math.abs(currentScale - renderScale) > 0.01) {
            setRenderScale(currentScale);
        }

        const clientX = e.clientX - rect.left;
        const clientY = e.clientY - rect.top;

        const transformedX = (clientX - viewTransform.x) / viewTransform.k;
        const transformedY = (clientY - viewTransform.y) / viewTransform.k;

        const x = ((transformedX - baseOffsetX) / baseRenderWidth) * DRAWING_CANVAS_WIDTH;
        const y = ((transformedY - baseOffsetY) / baseRenderHeight) * DRAWING_CANVAS_HEIGHT;

        return { x, y };
    };

    // --- MOUSE HANDLERS ---
    const handleMouseDown = (e) => {
        const coords = getCanvasCoordinates(e);
        if (!coords) return;

        if (selectedTool === 'hand' || e.button === 1 || e.getModifierState('Space')) {
            setIsPanning(true);
            lastPanPosition.current = { x: e.clientX, y: e.clientY };
            return;
        }

        // GLOBAL: If text is active, confirm it first (Clicking outside).
        if (activeText) {
            confirmText();
            return;
        }

        const sel = selectionRef.current;

        // --- TEXT TOOL START ---
        if (selectedTool === 'text') {
            // Finalize any previous text first if active (safety)
            if (activeText) {
                confirmText();
                return;
            }

            // Check if active layer is locked/hidden
            const activeLayer = layers.find(l => l.id === activeLayerId);
            if (activeLayer && (activeLayer.locked || !activeLayer.visible)) return;

            // HIT TEST: Check if clicking on existing text to edit
            const currentStrokes = annotations.current.get(currentFrame) || [];

            // Reverse iterate to find top-most clickable
            // We need to respect visual layer order for clicks
            const clickableStrokes = currentStrokes.map((s, i) => ({ s, i, layerId: s.layerId || 'layer-1' }))
                .filter(item => {
                    const l = layers.find(lay => lay.id === item.layerId);
                    return l && l.visible && !l.locked;
                })
                .sort((a, b) => {
                    const idxA = layers.findIndex(l => l.id === a.layerId);
                    const idxB = layers.findIndex(l => l.id === b.layerId);
                    return (idxA - idxB) || (a.i - b.i);
                })
                .reverse();

            for (let item of clickableStrokes) {
                const stroke = item.s;
                const index = item.i;
                if (stroke.type === 'text') {
                    const b = getStrokesBounds([stroke]);
                    const padding = 10;
                    if (b &&
                        coords.x >= b.x - padding &&
                        coords.x <= b.x + b.w + padding &&
                        coords.y >= b.y - padding &&
                        coords.y <= b.y + b.h + padding) {

                        saveUndoState();
                        const newStrokes = [...currentStrokes];
                        newStrokes.splice(index, 1);

                        if (newStrokes.length === 0) {
                            annotations.current.delete(currentFrame);
                        } else {
                            annotations.current.set(currentFrame, newStrokes);
                        }

                        setBrushColor(stroke.color);
                        setBrushSize(Math.max(1, Math.floor(stroke.size / 2)));
                        setCurrentFont(stroke.fontFamily || 'sans-serif');

                        setIsPlaying(false);
                        setActiveText({
                            x: stroke.points[0].x,
                            y: stroke.points[0].y,
                            val: stroke.text,
                            layerId: stroke.layerId // Preserve layer
                        });

                        renderAnnotations(currentFrame);
                        setHasAnnotations(p => !p);
                        return;
                    }
                }
            }

            setIsPlaying(false);
            setActiveText({ x: coords.x, y: coords.y, val: '', layerId: activeLayerId });
            return;
        }

        if (selectedTool === 'select' || selectedTool === 'pointer') {
            // We wait to save undo until we confirm an action (move vs deselect)

            if (sel.active && sel.bounds) {
                const t = sel.transform;
                const b = sel.bounds;
                const center = { x: b.cx, y: b.cy };

                const handles = {
                    'rotate': getTransformedPoint({ x: b.cx, y: b.y - 40 }, center, t),
                    'scale_tl': getTransformedPoint({ x: b.x, y: b.y }, center, t),
                    'scale_tr': getTransformedPoint({ x: b.x + b.w, y: b.y }, center, t),
                    'scale_br': getTransformedPoint({ x: b.x + b.w, y: b.y + b.h }, center, t),
                    'scale_bl': getTransformedPoint({ x: b.x, y: b.y + b.h }, center, t),
                    'scale_t': getTransformedPoint({ x: b.cx, y: b.y }, center, t),
                    'scale_r': getTransformedPoint({ x: b.x + b.w, y: b.cy }, center, t),
                    'scale_b': getTransformedPoint({ x: b.cx, y: b.y + b.h }, center, t),
                    'scale_l': getTransformedPoint({ x: b.x, y: b.cy }, center, t),
                };

                const hitDist = 20 / viewTransform.k;

                for (const [mode, p] of Object.entries(handles)) {
                    if (Math.hypot(p.x - coords.x, p.y - coords.y) < hitDist) {
                        // COMMIT PENDING SLICE IFEXISTS
                        if (sel.pendingStrokes) {
                            saveUndoState();
                            annotations.current.set(currentFrame, sel.pendingStrokes);
                            sel.pendingStrokes = null;
                        } else {
                            saveUndoState();
                        }

                        sel.dragMode = mode;
                        sel.dragStart = coords;
                        return;
                    }
                }

                const poly = [
                    handles.scale_tl, handles.scale_tr, handles.scale_br, handles.scale_bl
                ];
                if (pointInPoly(coords, poly)) {
                    // COMMIT PENDING SLICE IFEXISTS
                    if (sel.pendingStrokes) {
                        saveUndoState();
                        annotations.current.set(currentFrame, sel.pendingStrokes);
                        sel.pendingStrokes = null;
                    } else {
                        saveUndoState();
                    }

                    sel.dragMode = 'move';
                    sel.dragStart = coords;
                    return;
                }
            }

            // POINTER TOOL: HIT TEST LOGIC FOR CLICK SELECTION
            if (selectedTool === 'pointer') {
                const currentStrokes = annotations.current.get(currentFrame) || [];

                // Sort for Hit Testing (Top to Bottom visual order)
                const clickableStrokes = currentStrokes.map((s, i) => ({ s, i, layerId: s.layerId || 'layer-1' }))
                    .filter(item => {
                        const l = layers.find(lay => lay.id === item.layerId);
                        return l && l.visible && !l.locked;
                    })
                    .sort((a, b) => {
                        const idxA = layers.findIndex(l => l.id === a.layerId);
                        const idxB = layers.findIndex(l => l.id === b.layerId);
                        return (idxA - idxB) || (a.i - b.i);
                    })
                    .reverse(); // Hit top item first

                for (let item of clickableStrokes) {
                    if (isPointInStroke(coords, item.s)) {
                        // Found hit
                        sel.active = true;
                        sel.indices = [item.i]; // Use original index
                        sel.originalStrokes = JSON.parse(JSON.stringify([item.s]));
                        sel.bounds = getStrokesBounds(sel.originalStrokes);
                        sel.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
                        setSelectionActive(true);

                        // Pointer select doesn't use pending slice, just select full object
                        sel.pendingStrokes = null;

                        renderAnnotations(currentFrame);
                        return;
                    }
                }
            }

            // If we got here, we missed handles/body -> Deselect or New Marquee
            sel.active = false;
            sel.indices = [];
            sel.bounds = null;
            sel.pendingStrokes = null; // DISCARD PENDING SLICE
            sel.dragMode = 'marquee';
            sel.marqueeStart = coords;
            sel.marqueeCurrent = coords;
            sel.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
            setSelectionActive(false);
            renderAnnotations(currentFrame);
            return;
        }

        startDrawing(e);
    };

    const handleMouseMove = (e) => {
        setCursorPos({ x: e.clientX, y: e.clientY });
        const coords = getCanvasCoordinates(e);
        if (!coords) return;

        if (isPanning) {
            const dx = e.clientX - lastPanPosition.current.x;
            const dy = e.clientY - lastPanPosition.current.y;
            setViewTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
            lastPanPosition.current = { x: e.clientX, y: e.clientY };
            return;
        }

        const sel = selectionRef.current;

        if (sel.dragMode === 'marquee') {
            sel.marqueeCurrent = coords;
            renderAnnotations(currentFrame);
            return;
        }

        if (sel.dragMode && sel.active) {
            const dx = coords.x - sel.dragStart.x;
            const dy = coords.y - sel.dragStart.y;
            const b = sel.bounds;

            if (sel.dragMode === 'move') {
                sel.transform.x += dx;
                sel.transform.y += dy;
            } else if (sel.dragMode === 'rotate') {
                const cx = b.cx + sel.transform.x;
                const cy = b.cy + sel.transform.y;
                const angleStart = Math.atan2(sel.dragStart.y - cy, sel.dragStart.x - cx);
                const angleNow = Math.atan2(coords.y - cy, coords.x - cx);
                sel.transform.rotation += (angleNow - angleStart);
            } else if (sel.dragMode.startsWith('scale')) {
                const isRight = sel.dragMode.includes('r');
                const isLeft = sel.dragMode.includes('l');
                const isBottom = sel.dragMode.includes('b');
                const isTop = sel.dragMode.includes('t');

                if (isRight) sel.transform.scaleX += (dx / b.w);
                if (isLeft) sel.transform.scaleX -= (dx / b.w);
                if (isBottom) sel.transform.scaleY += (dy / b.h);
                if (isTop) sel.transform.scaleY -= (dy / b.h);
            }

            sel.dragStart = coords;
            renderAnnotations(currentFrame);
            return;
        }

        draw(e);
    };

    const handleMouseUp = () => {
        if (isPanning) {
            setIsPanning(false);
            return;
        }

        const sel = selectionRef.current;

        if (sel.dragMode === 'marquee') {
            // --- UPDATED SLICING LOGIC WITH INTERPOLATION ---
            const minX = Math.min(sel.marqueeStart.x, sel.marqueeCurrent.x);
            const maxX = Math.max(sel.marqueeStart.x, sel.marqueeCurrent.x);
            const minY = Math.min(sel.marqueeStart.y, sel.marqueeCurrent.y);
            const maxY = Math.max(sel.marqueeStart.y, sel.marqueeCurrent.y);
            const box = { minX, maxX, minY, maxY };

            const currentStrokes = annotations.current.get(currentFrame) || [];
            const nextStrokes = [];
            const nextIndices = [];

            currentStrokes.forEach((stroke) => {
                // Layer check for marquee
                const layer = layers.find(l => l.id === (stroke.layerId || 'layer-1'));
                if (layer && (layer.locked || !layer.visible)) {
                    nextStrokes.push(stroke);
                    return;
                }

                // 1. Check bounds for fast accept/reject
                const b = getStrokesBounds([stroke]);
                if (!b) return;

                // Fully Outside?
                if (b.x > maxX || b.x + b.w < minX || b.y > maxY || b.y + b.h < minY) {
                    nextStrokes.push(stroke);
                    return;
                }

                // Fully Inside?
                if (b.x >= minX && b.x + b.w <= maxX && b.y >= minY && b.y + b.h <= maxY) {
                    nextStrokes.push(stroke);
                    nextIndices.push(nextStrokes.length - 1);
                    return;
                }

                // If it's a Text object and we intersected but didn't fully contain, treat as included for simplicity?
                if (stroke.type === 'text') {
                    if (stroke.points[0].x >= minX && stroke.points[0].x <= maxX && stroke.points[0].y >= minY && stroke.points[0].y <= maxY) {
                        nextStrokes.push(stroke);
                        nextIndices.push(nextStrokes.length - 1);
                    } else {
                        nextStrokes.push(stroke);
                    }
                    return;
                }

                // 2. Intersection - SPLIT STROKE WITH INTERPOLATION
                let currentPoints = [];
                let currentIsInside = null;

                for (let i = 0; i < stroke.points.length; i++) {
                    const p = stroke.points[i];
                    const isInside = p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY;

                    if (i === 0) {
                        currentIsInside = isInside;
                        currentPoints.push(p);
                    } else {
                        const prevP = stroke.points[i - 1];

                        if (isInside === currentIsInside) {
                            currentPoints.push(p);
                        } else {
                            // Find Intersection
                            const hit = getBoxIntersection(prevP, p, box);
                            const cutPoint = hit || { x: (prevP.x + p.x) / 2, y: (prevP.y + p.y) / 2 };

                            // Finish current segment with the intersection point
                            currentPoints.push(cutPoint);
                            if (currentPoints.length > 0) {
                                nextStrokes.push({ ...stroke, points: currentPoints });
                                if (currentIsInside) nextIndices.push(nextStrokes.length - 1);
                            }

                            // Start new segment with the SAME intersection point (eliminates gap)
                            currentPoints = [cutPoint, p];
                            currentIsInside = isInside;
                        }
                    }
                }

                // Flush last segment
                if (currentPoints.length > 0) {
                    nextStrokes.push({ ...stroke, points: currentPoints });
                    if (currentIsInside) nextIndices.push(nextStrokes.length - 1);
                }
            });

            // Update State (LAZY COMMIT)
            if (nextIndices.length > 0) {
                sel.active = true;
                sel.indices = nextIndices;
                sel.originalStrokes = JSON.parse(JSON.stringify(nextIndices.map(i => nextStrokes[i])));
                sel.bounds = getStrokesBounds(sel.originalStrokes);
                setSelectionActive(true);

                // STORE PENDING SLICE, DO NOT COMMIT TO MAIN MAP YET
                sel.pendingStrokes = nextStrokes;
            } else {
                sel.active = false;
                setSelectionActive(false);
                sel.pendingStrokes = null;
            }

            sel.dragMode = null;
            renderAnnotations(currentFrame);
            return;
        }

        if (sel.dragMode && sel.active) {
            const currentStrokes = annotations.current.get(currentFrame);
            const t = sel.transform;
            const center = { x: sel.bounds.cx, y: sel.bounds.cy };

            // NEW: Calculate final scale factor
            const avgScale = (Math.abs(t.scaleX) + Math.abs(t.scaleY)) / 2;

            sel.indices.forEach((strokeIndex, i) => {
                const original = sel.originalStrokes[i];
                const transformedPoints = original.points.map(p => getTransformedPoint(p, center, t));
                currentStrokes[strokeIndex].points = transformedPoints;

                // NEW: Persist the scaled size
                currentStrokes[strokeIndex].size = Math.max(1, original.size * avgScale);
            });

            // Reset transform but keep selection active
            const newSelectedStrokes = sel.indices.map(i => currentStrokes[i]);
            sel.originalStrokes = JSON.parse(JSON.stringify(newSelectedStrokes));
            sel.bounds = getStrokesBounds(newSelectedStrokes);
            sel.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };

            sel.dragMode = null;
            renderAnnotations(currentFrame);
            return;
        }

        stopDrawing();
    };

    const handleViewportWheel = (e) => {
        e.preventDefault();
        const container = containerRef.current;
        if (!container) return;
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const worldX = (mouseX - viewTransform.x) / viewTransform.k;
        const worldY = (mouseY - viewTransform.y) / viewTransform.k;
        const zoomSensitivity = 0.001;
        const delta = -e.deltaY * zoomSensitivity;
        const newScale = Math.max(0.1, Math.min(10, viewTransform.k * (1 + delta)));
        const newX = mouseX - worldX * newScale;
        const newY = mouseY - worldY * newScale;
        setViewTransform({ k: newScale, x: newX, y: newY });
    };

    const handleTimelineWheel = (e) => {
        e.stopPropagation();
        e.preventDefault();
        const direction = Math.sign(e.deltaY);
        stepFrame(direction);
    };

    // --- DRAWING STATE ---
    const startDrawing = (e) => {
        if (isPlaying) setIsPlaying(false);

        // Validate Layer
        const activeLayer = layers.find(l => l.id === activeLayerId);
        if (!activeLayer || !activeLayer.visible || activeLayer.locked) return;

        // Save State before drawing starts
        saveUndoState();

        const coords = getCanvasCoordinates(e);
        if (!coords) return;
        setIsDrawing(true);

        const newStroke = {
            tool: selectedTool,
            color: brushColor,
            size: brushSize,
            opacity: brushOpacity,
            points: [{ x: coords.x, y: coords.y }],
            layerId: activeLayerId // NEW: Assign to active layer
        };

        const currentStrokes = annotations.current.get(currentFrame) || [];
        annotations.current.set(currentFrame, [...currentStrokes, newStroke]);
        renderAnnotations(currentFrame);
    };

    const draw = (e) => {
        if (!isDrawing) return;
        const coords = getCanvasCoordinates(e);
        if (!coords) return;
        const currentStrokes = annotations.current.get(currentFrame);
        if (currentStrokes && currentStrokes.length > 0) {
            const activeStroke = currentStrokes[currentStrokes.length - 1];
            activeStroke.points.push({ x: coords.x, y: coords.y });
            renderAnnotations(currentFrame);
        }
    };

    const stopDrawing = () => {
        setIsDrawing(false);
        setHasAnnotations(prev => !prev);
    };

    // --- TEXT TOOL HANDLERS ---
    const confirmText = () => {
        if (!activeText || !activeText.val.trim()) {
            setActiveText(null);
            return;
        }

        saveUndoState();
        const newTextStroke = {
            type: 'text',
            tool: 'text',
            text: activeText.val,
            color: brushColor,
            size: brushSize * 2, // Text is often smaller than brush strokes if 1:1, so scaling up slightly
            fontFamily: currentFont, // NEW: Save font
            points: [{ x: activeText.x, y: activeText.y }], // Origin
            layerId: activeText.layerId || activeLayerId // Use stored layer if editing, else active
        };

        const currentStrokes = annotations.current.get(currentFrame) || [];
        annotations.current.set(currentFrame, [...currentStrokes, newTextStroke]);
        setActiveText(null);
        renderAnnotations(currentFrame);
        setHasAnnotations(prev => !prev);
    };

    const handleTextKeyDown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            confirmText();
        }
        if (e.key === 'Escape') {
            setActiveText(null);
        }
        e.stopPropagation(); // Prevent app shortcuts
    };

    // --- DELETE FUNCTION ---
    const clearCurrentFrame = () => {
        saveUndoState();

        const sel = selectionRef.current;

        // Check if there is an active selection to delete specifically
        if (sel.active && sel.indices.length > 0) {
            const currentStrokes = annotations.current.get(currentFrame) || [];
            // Filter out the selected indices
            const remainingStrokes = currentStrokes.filter((_, index) => !sel.indices.includes(index));

            if (remainingStrokes.length === 0) {
                annotations.current.delete(currentFrame);
            } else {
                annotations.current.set(currentFrame, remainingStrokes);
            }
        } else {
            // No selection, delete everything in the frame
            annotations.current.delete(currentFrame);
        }

        // Always clear selection state after a delete
        sel.active = false;
        sel.indices = [];
        sel.bounds = null;
        sel.transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 };
        setSelectionActive(false);

        renderAnnotations(currentFrame);
        setHasAnnotations(prev => !prev);
    };

    const undoLastStroke = () => {
        saveUndoState();
        const strokes = annotations.current.get(currentFrame) || [];
        if (strokes.length > 0) {
            strokes.pop();
            annotations.current.set(currentFrame, [...strokes]);
            renderAnnotations(currentFrame);
        }
    };

    // --- DUPLICATION / MANIPULATION ---
    const copyToNextFrame = () => {
        saveUndoState();
        const currentStrokes = annotations.current.get(currentFrame);
        if (!currentStrokes || currentStrokes.length === 0) return;

        const nextFrame = currentFrame + 1;
        if (nextFrame > totalFrames) return;

        const sel = selectionRef.current;
        let strokesToCopy;

        // Check if we have a selection to copy specifically
        if (sel.active && sel.indices.length > 0) {
            strokesToCopy = currentStrokes.filter((_, index) => sel.indices.includes(index));
        } else {
            strokesToCopy = currentStrokes;
        }

        const strokesCopy = JSON.parse(JSON.stringify(strokesToCopy));
        const nextStrokes = annotations.current.get(nextFrame) || [];
        annotations.current.set(nextFrame, [...nextStrokes, ...strokesCopy]);

        setHasAnnotations(prev => !prev);
        stepFrame(1);
    };

    const copyFromPrevFrame = () => {
        saveUndoState();
        const prevFrame = currentFrame - 1;
        if (prevFrame < 0) return;
        const prevStrokes = annotations.current.get(prevFrame);
        if (!prevStrokes || prevStrokes.length === 0) return;

        const strokesCopy = JSON.parse(JSON.stringify(prevStrokes));
        const currentStrokes = annotations.current.get(currentFrame) || [];
        annotations.current.set(currentFrame, [...currentStrokes, ...strokesCopy]);
        renderAnnotations(currentFrame);
        setHasAnnotations(prev => !prev);
    };

    const handleCopy = () => {
        const s = annotations.current.get(currentFrame);
        if (s && s.length > 0) {
            clipboard.current = JSON.parse(JSON.stringify(s));
            setHasAnnotations(p => !p);
        }
    };

    const handlePaste = () => {
        if (!clipboard.current) return;
        saveUndoState();
        const current = annotations.current.get(currentFrame) || [];
        const pasted = JSON.parse(JSON.stringify(clipboard.current));
        annotations.current.set(currentFrame, [...current, ...pasted]);
        renderAnnotations(currentFrame);
        setHasAnnotations(p => !p);
    };

    // UPDATED: Handle Color Change
    const handleColorChange = (e) => {
        const newColor = e.target.value;
        setBrushColor(newColor);

        const sel = selectionRef.current;
        if (sel.active && sel.indices.length > 0) {
            // If pending slice exists, commit it first so we can color the sliced parts
            if (sel.pendingStrokes) {
                saveUndoState();
                annotations.current.set(currentFrame, sel.pendingStrokes);
                sel.pendingStrokes = null;
            } else {
                saveUndoState();
            }

            const currentStrokes = annotations.current.get(currentFrame) || [];
            sel.indices.forEach((index, i) => {
                if (currentStrokes[index]) {
                    currentStrokes[index].color = newColor;
                    if (sel.originalStrokes[i]) sel.originalStrokes[i].color = newColor;
                }
            });
            renderAnnotations(currentFrame);
        }
    };

    // NEW: Handle Size Change (Affects Brush Size AND Selection)
    const handleSizeChange = (e) => {
        const newSize = parseInt(e.target.value);
        setBrushSize(newSize);

        const sel = selectionRef.current;
        if (sel.active && sel.indices.length > 0) {
            // Commit pending first
            if (sel.pendingStrokes) {
                saveUndoState();
                annotations.current.set(currentFrame, sel.pendingStrokes);
                sel.pendingStrokes = null;
            } else {
                saveUndoState();
            }

            const currentStrokes = annotations.current.get(currentFrame) || [];
            sel.indices.forEach((index, i) => {
                if (currentStrokes[index]) {
                    // Apply ratio: Text is usually 2x brush size in this logic
                    const targetSize = currentStrokes[index].type === 'text' ? newSize * 2 : newSize;
                    currentStrokes[index].size = targetSize;
                    if (sel.originalStrokes[i]) sel.originalStrokes[i].size = targetSize;
                }
            });
            renderAnnotations(currentFrame);
        }
    };

    // NEW: Handle Font Change
    const handleFontChange = (e) => {
        const newFont = e.target.value;
        setCurrentFont(newFont);

        const sel = selectionRef.current;
        if (sel.active && sel.indices.length > 0) {
            // Commit pending first
            if (sel.pendingStrokes) {
                saveUndoState();
                annotations.current.set(currentFrame, sel.pendingStrokes);
                sel.pendingStrokes = null;
            } else {
                saveUndoState();
            }

            const currentStrokes = annotations.current.get(currentFrame) || [];
            sel.indices.forEach((index, i) => {
                if (currentStrokes[index] && currentStrokes[index].type === 'text') {
                    currentStrokes[index].fontFamily = newFont;
                    if (sel.originalStrokes[i]) sel.originalStrokes[i].fontFamily = newFont;
                }
            });
            renderAnnotations(currentFrame);
        }
    };

    const moveKeyframe = (direction) => {
        saveUndoState();
        const currentStrokes = annotations.current.get(currentFrame);
        if (!currentStrokes || currentStrokes.length === 0) return;

        const targetFrame = currentFrame + direction;
        if (targetFrame < 0 || targetFrame > totalFrames) return;

        const sel = selectionRef.current;

        // 1. If Selection Active: Move ONLY selected items
        if (sel.active && sel.indices.length > 0) {
            const strokesToMove = currentStrokes.filter((_, index) => sel.indices.includes(index));
            const strokesToKeep = currentStrokes.filter((_, index) => !sel.indices.includes(index));

            // Add to target
            const targetStrokes = annotations.current.get(targetFrame) || [];
            annotations.current.set(targetFrame, [...targetStrokes, ...strokesToMove]);

            // Update current
            if (strokesToKeep.length === 0) {
                annotations.current.delete(currentFrame);
            } else {
                annotations.current.set(currentFrame, strokesToKeep);
            }
        }
        // 2. No Selection: Move EVERYTHING
        else {
            const targetStrokes = annotations.current.get(targetFrame) || [];
            annotations.current.set(targetFrame, [...targetStrokes, ...currentStrokes]);
            annotations.current.delete(currentFrame);
        }

        // Clear selection since items have moved
        sel.active = false;
        sel.indices = [];
        sel.bounds = null;
        setSelectionActive(false);

        renderAnnotations(currentFrame);
        seekToFrame(targetFrame);
        setHasAnnotations(p => !p);
    };

    // --- LAYER MANAGEMENT ---
    const addLayer = () => {
        const newId = `layer-${Date.now()}`;
        setLayers(prev => [...prev, { id: newId, name: `Layer ${prev.length + 1}`, visible: true, locked: false, opacity: 1 }]);
        setActiveLayerId(newId);
    };

    const deleteLayer = (id) => {
        if (layers.length <= 1) return; // Prevent deleting last layer

        saveUndoState(); // Save state before deletion

        // 1. Clear active selection to prevent errors with deleted objects
        const sel = selectionRef.current;
        if (sel.active) {
            sel.active = false;
            sel.indices = [];
            sel.bounds = null;
            setSelectionActive(false);
        }

        // 2. Iterate through all frames and remove strokes belonging to this layer
        for (const [frame, strokes] of annotations.current.entries()) {
            const newStrokes = strokes.filter(s => {
                // Default to layer-1 for old/legacy strokes
                const strokeLayer = s.layerId || 'layer-1';
                return strokeLayer !== id;
            });

            if (newStrokes.length !== strokes.length) {
                if (newStrokes.length === 0) {
                    annotations.current.delete(frame);
                } else {
                    annotations.current.set(frame, newStrokes);
                }
            }
        }

        // 3. Update Layer State
        const remainingLayers = layers.filter(l => l.id !== id);
        setLayers(remainingLayers);

        // 4. Switch active layer if the current one was deleted
        if (activeLayerId === id) {
            setActiveLayerId(remainingLayers[0].id);
        }

        // 5. Refresh UI
        renderAnnotations(currentFrame);
        setHasAnnotations(prev => !prev);
    };

    const toggleLayerVisible = (id) => {
        setLayers(prev => prev.map(l => l.id === id ? { ...l, visible: !l.visible } : l));
    };

    const toggleLayerLock = (id) => {
        setLayers(prev => prev.map(l => l.id === id ? { ...l, locked: !l.locked } : l));
    };

    const updateLayerName = (id, newName) => {
        setLayers(prev => prev.map(l => l.id === id ? { ...l, name: newName } : l));
    };

    const updateLayerOpacity = (id, opacity) => {
        setLayers(prev => prev.map(l => l.id === id ? { ...l, opacity: parseFloat(opacity) } : l));
    };

    // --- ENGINE ---
    const onLoadedMetadata = () => {
        if (videoRef.current) {
            const dur = videoRef.current.duration;
            setDuration(dur);
            const total = Math.floor(dur * FPS);
            setTotalFrames(total);
            setRangeEnd(total);
            frameCache.current.clear();
            setHasCached(false);
            setCacheProgress(0);
        }
    };

    const cacheFrames = async () => {
        if (!videoRef.current) return;
        initAudio();
        setIsCaching(true);
        setIsPlaying(false);
        const vid = videoRef.current;

        if (videoSrc) loadAudio(videoSrc);

        const start = isRangeActive ? rangeStart : 0;
        const end = isRangeActive ? rangeEnd : totalFrames;
        const totalToCache = end - start;
        const limitFrames = Math.min(totalToCache, 240);

        for (let i = 0; i < limitFrames; i++) {
            const frameIndex = start + i;
            vid.currentTime = frameToTime(frameIndex) + 0.01;
            await new Promise(r => {
                const onSeeked = () => { vid.removeEventListener('seeked', onSeeked); r(); };
                vid.addEventListener('seeked', onSeeked);
            });
            try {
                const bitmap = await createImageBitmap(vid);
                frameCache.current.set(frameIndex, bitmap);
            } catch (e) { console.error(e); }
            setCacheProgress(Math.round(((i + 1) / limitFrames) * 100));
        }
        setIsCaching(false);
        setHasCached(true);
        vid.currentTime = frameToTime(start);
        setCurrentFrame(start);
    };

    // --- EXPORT LOGIC ---
    const handleExport = async ({ mode, prefix, startIndex, scale, format, bitrate, setProgress }) => {
        setIsPlaying(false);
        const vid = videoRef.current;
        if (!vid) return;

        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = DRAWING_CANVAS_WIDTH * scale;
        exportCanvas.height = DRAWING_CANVAS_HEIGHT * scale;
        const ctx = exportCanvas.getContext('2d');

        const start = isRangeActive ? rangeStart : 0;
        const end = isRangeActive ? rangeEnd : totalFrames;
        const total = end - start;

        // Helper to generate filename
        const getFilename = (i) => {
            const num = (startIndex + i).toString().padStart(4, '0');
            return `${prefix}_${num}.${format}`;
        };

        // Helper to capture a frame
        const captureFrame = async (frameIdx) => {
            // Seek to frame
            vid.currentTime = frameToTime(frameIdx) + 0.01;
            await new Promise(r => {
                const onSeeked = () => { vid.removeEventListener('seeked', onSeeked); r(); };
                vid.addEventListener('seeked', onSeeked);
            });

            // Clear
            ctx.clearRect(0, 0, exportCanvas.width, exportCanvas.height);

            // Draw Video
            ctx.drawImage(vid, 0, 0, exportCanvas.width, exportCanvas.height);

            // Draw Annotations (re-using renderAnnotations logic but pointing to our context)
            renderAnnotations(frameIdx, ctx, scale);
        };

        if (mode === 'frame') {
            await captureFrame(currentFrame);
            const link = document.createElement('a');
            link.download = getFilename(0);
            link.href = exportCanvas.toDataURL(`image/${format}`);
            link.click();
            setProgress(100);
        }
        else if (mode === 'sequence') {
            for (let i = 0; i <= total; i++) {
                const frameIdx = start + i;
                await captureFrame(frameIdx);

                const link = document.createElement('a');
                link.download = getFilename(i);
                link.href = exportCanvas.toDataURL(`image/${format}`);
                link.click();

                setProgress(Math.round((i / total) * 100));
                // Small delay to prevent browser choking
                await new Promise(r => setTimeout(r, 100));
            }
        }
        else if (mode === 'video') {
            const stream = exportCanvas.captureStream(FPS);

            const options = {
                mimeType: 'video/webm;codecs=vp9',
                videoBitsPerSecond: bitrate || 25000000
            };

            if (!MediaRecorder.isTypeSupported(options.mimeType)) {
                delete options.mimeType;
            }

            const recorder = new MediaRecorder(stream, options);
            const chunks = [];

            recorder.ondataavailable = e => chunks.push(e.data);
            recorder.onstop = () => {
                const blob = new Blob(chunks, { type: 'video/webm' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.download = `${prefix}_video.webm`;
                link.href = url;
                link.click();
            };

            recorder.start();

            for (let i = 0; i <= total; i++) {
                const frameIdx = start + i;
                await captureFrame(frameIdx);
                setProgress(Math.round((i / total) * 100));
                await new Promise(r => setTimeout(r, 1000 / FPS));
            }

            recorder.stop();
        }

        // Restore state
        vid.currentTime = frameToTime(currentFrame);
    };

    const renderFrame = useCallback((frame) => {
        if ((isScrubbing || !isPlaying) && frameCache.current.has(frame) && canvasRef.current) {
            const ctx = canvasRef.current.getContext('2d');
            const bitmap = frameCache.current.get(frame);
            if (canvasRef.current.width !== bitmap.width) {
                canvasRef.current.width = bitmap.width;
                canvasRef.current.height = bitmap.height;
            }
            ctx.drawImage(bitmap, 0, 0);
            canvasRef.current.style.display = 'block';
            if (videoRef.current) videoRef.current.style.opacity = 0;
        } else {
            if (canvasRef.current) canvasRef.current.style.display = 'none';
            if (videoRef.current) videoRef.current.style.opacity = 1;
        }
        renderAnnotations(frame);
    }, [isScrubbing, isPlaying, renderAnnotations]);

    const updateState = useCallback(() => {
        if (videoRef.current) {
            const frame = timeToFrame(videoRef.current.currentTime);
            const effectiveEnd = isRangeActive ? rangeEnd : totalFrames;
            const effectiveStart = isRangeActive ? rangeStart : 0;

            if (frame >= effectiveEnd && isLooping) {
                videoRef.current.currentTime = frameToTime(effectiveStart);
                setCurrentFrame(effectiveStart);
            } else if (frame !== currentFrame) {
                setCurrentFrame(frame);
                renderFrame(frame);
            }
        }
    }, [currentFrame, renderFrame, isRangeActive, rangeEnd, rangeStart, totalFrames, isLooping]);

    // 1. Handle Video Element Play/Pause
    useEffect(() => {
        const vid = videoRef.current;
        if (!vid) return;

        if (isPlaying) {
            const playPromise = vid.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    if (error.name !== 'AbortError') {
                        console.error("Playback error:", error);
                    }
                });
            }
        } else {
            vid.pause();
        }
    }, [isPlaying]);

    // 2. Handle Animation Loop
    useEffect(() => {
        if (isPlaying) {
            animationFrameRef.current = requestAnimationFrame(function loop() {
                updateState();
                if (isPlaying) {
                    animationFrameRef.current = requestAnimationFrame(loop);
                }
            });
        } else {
            cancelAnimationFrame(animationFrameRef.current);
        }
        return () => cancelAnimationFrame(animationFrameRef.current);
    }, [isPlaying, updateState]);

    // 3. Handle Rendering when paused or seeking (manual updates)
    useEffect(() => {
        if (!isPlaying) {
            renderFrame(currentFrame);
        }
    }, [currentFrame, isPlaying, renderFrame]);

    useEffect(() => { if (videoRef.current) videoRef.current.playbackRate = playbackSpeed; }, [playbackSpeed]);
    useEffect(() => { if (videoRef.current) videoRef.current.volume = isMuted ? 0 : volume; }, [volume, isMuted]);

    const togglePlay = () => setIsPlaying(!isPlaying);

    const seekToFrame = (targetFrame) => {
        setIsPlaying(false);
        setCurrentFrame(targetFrame);
        if (hasCached) playScrubSound(frameToTime(targetFrame));

        if (frameCache.current.has(targetFrame)) {
            renderFrame(targetFrame);
            if (videoRef.current) videoRef.current.currentTime = frameToTime(targetFrame);
        } else if (videoRef.current) {
            videoRef.current.currentTime = frameToTime(targetFrame);
        }
        selectionRef.current.active = false;
        setSelectionActive(false);
    };

    const stepFrame = (direction) => {
        let newFrame = currentFrame + direction;
        const effectiveStart = isRangeActive ? rangeStart : 0;
        const effectiveEnd = isRangeActive ? rangeEnd : totalFrames;
        if (newFrame > effectiveEnd) newFrame = effectiveStart;
        if (newFrame < effectiveStart) newFrame = effectiveEnd;
        seekToFrame(newFrame);
    };

    const jumpToNextSketch = () => {
        const sortedFrames = [...annotations.current.keys()].sort((a, b) => a - b);
        const next = sortedFrames.find(f => f > currentFrame);
        if (next !== undefined) seekToFrame(next);
    };

    const jumpToPrevSketch = () => {
        const sortedFrames = [...annotations.current.keys()].sort((a, b) => a - b);
        const prev = sortedFrames.reverse().find(f => f < currentFrame);
        if (prev !== undefined) seekToFrame(prev);
    };

    // --- RANGE ---
    const setInPoint = () => { setRangeStart(currentFrame); setIsRangeActive(true); if (currentFrame >= rangeEnd) setRangeEnd(totalFrames); setIsZoomedToRange(true); };
    const setOutPoint = () => { setRangeEnd(currentFrame); setIsRangeActive(true); if (currentFrame <= rangeStart) setRangeStart(0); setIsZoomedToRange(true); };
    const clearRange = () => { setIsRangeActive(false); setRangeStart(0); setRangeEnd(totalFrames); setIsZoomedToRange(false); };
    const toggleZoomToRange = () => { if (!isRangeActive) return; setIsZoomedToRange(!isZoomedToRange); }

    const handleScrubMove = (e) => {
        if (!timelineRef.current) return;
        const rect = timelineRef.current.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        const percentage = x / rect.width;
        let targetFrame;
        if (isZoomedToRange && isRangeActive) {
            const rangeDuration = rangeEnd - rangeStart;
            targetFrame = Math.floor(rangeStart + (percentage * rangeDuration));
        } else {
            targetFrame = Math.floor(percentage * totalFrames);
        }

        // --- OPTIMIZED SCRUBBING ---
        const time = frameToTime(targetFrame);
        currentTimeRef.current = time;

        setCurrentFrame(targetFrame); // UI Update

        // Immediate Render (Try Cache)
        renderFrame(targetFrame);

        // Throttle Video Element (prevents hanging)
        const now = performance.now();
        if (now - lastVideoSeek.current > 50) {
            if (videoRef.current) videoRef.current.currentTime = time;
            lastVideoSeek.current = now;
        }
    };

    const handleTimelineMouseDown = (e) => {
        setIsPlaying(false);
        setIsScrubbing(true);
        handleScrubMove(e);
        const onMouseMove = (ev) => handleScrubMove(ev);
        const onMouseUp = () => {
            setIsScrubbing(false);
            // Final Sync ensure we land exactly where we stopped
            if (videoRef.current) videoRef.current.currentTime = currentTimeRef.current;
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };
        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.target.tagName === 'INPUT') return;
            switch (e.code) {
                case 'Space': if (!isPanning && !isDrawing) { e.preventDefault(); togglePlay(); } break;
                case 'ArrowLeft': e.preventDefault(); stepFrame(e.shiftKey ? -10 : -1); break;
                case 'ArrowRight': e.preventDefault(); stepFrame(e.shiftKey ? 10 : 1); break;
                case 'KeyJ': setPlaybackSpeed(prev => Math.max(0.25, prev / 2)); break;
                case 'KeyL': setPlaybackSpeed(prev => Math.min(4, prev * 2)); break;
                case 'KeyK': setPlaybackSpeed(1); break;
                case 'KeyZ':
                    if (e.metaKey || e.ctrlKey) {
                        e.preventDefault();
                        if (e.shiftKey) performRedo();
                        else performUndo();
                    } break;
                case 'KeyI': setInPoint(); break;
                case 'KeyO': setOutPoint(); break;
                case 'KeyX': clearRange(); break;
                case 'KeyH': setSelectedTool('hand'); break;
                case 'KeyB': setSelectedTool('brush'); break;
                case 'KeyE': setSelectedTool('eraser'); break;
                case 'KeyS': setSelectedTool('select'); break;
                case 'KeyT': setSelectedTool('text'); break;
                case 'KeyV': setSelectedTool('pointer'); break; // New Shortcut
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isPlaying, currentFrame, totalFrames, rangeStart, rangeEnd, isRangeActive, isPanning, isDrawing, hasCached, performUndo, performRedo]);

    const getLeftPercent = (frame) => {
        if (isZoomedToRange && isRangeActive) return ((frame - rangeStart) / (rangeEnd - rangeStart)) * 100;
        return (frame / totalFrames) * 100;
    };
    const isVisible = (frame) => {
        if (!isZoomedToRange) return true;
        return frame >= rangeStart && frame <= rangeEnd;
    };

    const frameHasData = hasStrokes(currentFrame);

    // UPDATED: Calculate exact screen position for the text overlay
    const getOverlayPosition = (x, y) => {
        const container = containerRef.current;
        if (!container) return { left: 0, top: 0 };

        const rect = container.getBoundingClientRect();
        const videoAspect = DRAWING_CANVAS_WIDTH / DRAWING_CANVAS_HEIGHT;
        const containerAspect = rect.width / rect.height;
        let baseRenderWidth, baseRenderHeight, baseOffsetX, baseOffsetY;

        if (containerAspect > videoAspect) {
            baseRenderHeight = rect.height;
            baseRenderWidth = rect.height * videoAspect;
            baseOffsetX = (rect.width - baseRenderWidth) / 2;
            baseOffsetY = 0;
        } else {
            baseRenderWidth = rect.width;
            baseRenderHeight = rect.width / videoAspect;
            baseOffsetX = 0;
            baseOffsetY = (rect.height - baseRenderHeight) / 2;
        }

        // Percentage within the 1920x1080 canvas
        const pctX = x / DRAWING_CANVAS_WIDTH;
        const pctY = y / DRAWING_CANVAS_HEIGHT;

        // Coordinate relative to the container (before zoom)
        const baseX = baseOffsetX + pctX * baseRenderWidth;
        const baseY = baseOffsetY + pctY * baseRenderHeight;

        // Apply zoom/pan transform
        // Visual coordinate relative to container's top-left
        const visualX = baseX * viewTransform.k + viewTransform.x;
        const visualY = baseY * viewTransform.k + viewTransform.y;

        // Return absolute screen coordinates
        return {
            left: rect.left + visualX,
            top: rect.top + visualY
        };
    };

    return (
        <div className="flex flex-col h-screen bg-neutral-900 text-gray-200 font-sans selection:bg-orange-500 selection:text-white">
            {cursorPos && selectedTool !== 'hand' && selectedTool !== 'select' && selectedTool !== 'text' && selectedTool !== 'pointer' && !isPanning && (
                <div className="fixed pointer-events-none z-[100] rounded-full border border-white/80 shadow-sm mix-blend-difference" style={{ left: cursorPos.x, top: cursorPos.y, width: `${brushSize * renderScale}px`, height: `${brushSize * renderScale}px`, transform: 'translate(-50%, -50%)', backgroundColor: selectedTool === 'eraser' ? 'rgba(255,255,255,0.2)' : brushColor, borderColor: selectedTool === 'eraser' ? 'white' : brushColor }} />
            )}

            {/* EXPORT MODAL */}
            <ExportModal
                isOpen={isExportModalOpen}
                onClose={() => setIsExportModalOpen(false)}
                onExport={handleExport}
                range={{ start: isRangeActive ? rangeStart : 0, end: isRangeActive ? rangeEnd : totalFrames }}
                totalFrames={totalFrames}
            />

            <div className="bg-neutral-800 border-b border-neutral-700 flex flex-col shrink-0 z-20">
                <div className="h-12 flex items-center justify-between px-4 border-b border-neutral-700/50">
                    <div className="flex items-center gap-3"><div className="w-8 h-8 bg-orange-500 rounded flex items-center justify-center font-bold text-black text-xs">SK</div><h1 className="text-sm font-bold text-white leading-tight hidden md:block">Animation Review_v15_OnionControls.mp4</h1></div>
                    <div className="flex items-center gap-2">
                        <button onClick={cacheFrames} className={`flex items-center gap-2 px-3 py-1.5 rounded text-xs font-bold transition-colors ${hasCached ? 'bg-blue-900/30 text-blue-400 cursor-default' : 'bg-neutral-700 hover:bg-neutral-600 text-blue-400'}`}>{isCaching ? <div className="w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" /> : <Zap size={14} />}{isCaching ? `${cacheProgress}%` : hasCached ? 'CACHED' : 'CACHE RANGE'}</button>
                        <button onClick={() => setIsExportModalOpen(true)} className="p-2 hover:bg-neutral-700 rounded text-neutral-400 hover:text-white"><Download size={18} /></button>
                        <div className="w-px h-6 bg-neutral-700 mx-1" />
                        <button onClick={() => { setIsPanelOpen(!isPanelOpen); if (isLayersPanelOpen) setIsLayersPanelOpen(false); }} className={`p-2 rounded transition-colors ${isPanelOpen ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-700'}`}><Sidebar size={18} /></button>
                        <button onClick={() => { setIsLayersPanelOpen(!isLayersPanelOpen); if (isPanelOpen) setIsPanelOpen(false); }} className={`p-2 rounded transition-colors ${isLayersPanelOpen ? 'bg-neutral-700 text-white' : 'text-neutral-400 hover:bg-neutral-700'}`}><Layers size={18} /></button>
                    </div>
                </div>
                <div className="h-12 flex items-center justify-center gap-4 px-4 bg-neutral-850 shadow-inner">
                    <div className="flex items-center bg-neutral-900 rounded-md p-1 border border-neutral-700">
                        <button onClick={() => setSelectedTool('pointer')} className={`p-1.5 rounded ${selectedTool === 'pointer' ? 'bg-neutral-700 text-orange-400 shadow-sm' : 'text-neutral-400 hover:text-white'}`} title="Select (V)"><MousePointer2 size={18} /></button>
                        <button onClick={() => setSelectedTool('brush')} className={`p-1.5 rounded ${selectedTool === 'brush' ? 'bg-neutral-700 text-orange-400 shadow-sm' : 'text-neutral-400 hover:text-white'}`}><PenTool size={18} /></button>
                        <button onClick={() => setSelectedTool('eraser')} className={`p-1.5 rounded ${selectedTool === 'eraser' ? 'bg-neutral-700 text-orange-400 shadow-sm' : 'text-neutral-400 hover:text-white'}`}><Eraser size={18} /></button>
                        <button onClick={() => setSelectedTool('text')} className={`p-1.5 rounded ${selectedTool === 'text' ? 'bg-neutral-700 text-orange-400 shadow-sm' : 'text-neutral-400 hover:text-white'}`} title="Text Tool (T)"><Type size={18} /></button>
                        <button onClick={() => setSelectedTool('select')} className={`p-1.5 rounded ${selectedTool === 'select' ? 'bg-neutral-700 text-orange-400 shadow-sm' : 'text-neutral-400 hover:text-white'}`} title="Free Transform (S)"><BoxSelect size={18} /></button>
                        <button onClick={() => setSelectedTool('hand')} className={`p-1.5 rounded ${selectedTool === 'hand' ? 'bg-neutral-700 text-orange-400 shadow-sm' : 'text-neutral-400 hover:text-white'}`}><Hand size={18} /></button>
                    </div>
                    <div className="flex items-center gap-2 px-2 border-l border-neutral-700/50"><input type="color" value={brushColor} onChange={handleColorChange} className="w-6 h-6 bg-transparent border-0 cursor-pointer" /></div>
                    <div className="flex items-center gap-3 px-2 border-l border-neutral-700/50"><div className="flex flex-col justify-center w-20"><input type="range" min="1" max="100" value={brushSize} onChange={handleSizeChange} className="w-full accent-neutral-500 h-1 bg-neutral-700 rounded-lg" /></div><div className="flex flex-col justify-center w-20"><input type="range" min="1" max="100" value={brushOpacity * 100} onChange={(e) => setBrushOpacity(parseInt(e.target.value) / 100)} className="w-full accent-neutral-500 h-1 bg-neutral-700 rounded-lg" /></div></div>

                    <div className="flex items-center gap-2 px-2 border-l border-r border-neutral-700/50">
                        <button onClick={() => setIsOnionSkin(!isOnionSkin)} className={`flex items-center gap-2 p-1.5 rounded text-xs font-bold ${isOnionSkin ? 'text-white bg-neutral-700' : 'text-neutral-500 hover:text-neutral-300'}`}><Layers size={18} /> ONION</button>
                        {isOnionSkin && (
                            <div className="flex flex-col justify-center gap-1 w-20">
                                <div className="flex justify-between items-center text-[9px] font-bold text-red-400 leading-none">
                                    <span>PRE</span>
                                    <input type="number" min="0" max="10" className="w-8 bg-neutral-900 text-center rounded border border-neutral-700 p-0 text-white" value={onionFramesBefore} onChange={e => setOnionFramesBefore(parseInt(e.target.value))} />
                                </div>
                                <div className="flex justify-between items-center text-[9px] font-bold text-blue-400 leading-none">
                                    <span>POST</span>
                                    <input type="number" min="0" max="10" className="w-8 bg-neutral-900 text-center rounded border border-neutral-700 p-0 text-white" value={onionFramesAfter} onChange={e => setOnionFramesAfter(parseInt(e.target.value))} />
                                </div>
                            </div>
                        )}
                    </div>

                    <div className="flex items-center gap-1 pl-2"><button onClick={copyFromPrevFrame} className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-700 rounded"><div className="flex items-center"><ChevronLeft size={12} /><Copy size={16} /></div></button><button onClick={copyToNextFrame} className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-700 rounded"><div className="flex items-center"><Copy size={16} /><ChevronRight size={12} /></div></button><div className="w-px h-6 bg-neutral-700 mx-2" /><button onClick={performUndo} className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-700 rounded"><Undo size={18} /></button><button onClick={performRedo} className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-700 rounded"><Redo size={18} /></button><div className="w-px h-6 bg-neutral-700 mx-2" /><button onClick={clearCurrentFrame} className="p-1.5 text-red-400 hover:bg-red-900/30 rounded"><Trash2 size={18} /></button></div>
                    <div className="flex items-center gap-1 border-l border-neutral-700/50 pl-4 ml-4"><button onClick={setInPoint} className="px-2 py-1 text-xs bg-neutral-700 rounded hover:bg-neutral-600 font-mono text-neutral-300">IN</button><button onClick={setOutPoint} className="px-2 py-1 text-xs bg-neutral-700 rounded hover:bg-neutral-600 font-mono text-neutral-300">OUT</button><button onClick={clearRange} className="p-1.5 text-neutral-400 hover:text-red-400 rounded"><XCircle size={18} /></button></div>
                </div>
            </div>
            <div className="flex-1 flex overflow-hidden relative bg-[#1a1a1a]">
                <div ref={containerRef} className={`flex-1 flex items-center justify-center relative overflow-hidden bg-black select-none ${selectedTool === 'text' ? 'cursor-text' : selectedTool !== 'hand' && selectedTool !== 'select' && selectedTool !== 'text' && selectedTool !== 'pointer' && !isPanning ? 'cursor-none' : isPanning ? 'cursor-grabbing' : 'cursor-default'}`} onWheel={handleViewportWheel} onMouseDown={handleMouseDown} onMouseMove={handleMouseMove} onMouseUp={handleMouseUp} onMouseLeave={(e) => { handleMouseUp(e); setCursorPos(null); }}>
                    <div className="w-full h-full flex items-center justify-center relative origin-top-left" style={{ transform: `translate(${viewTransform.x}px, ${viewTransform.y}px) scale(${viewTransform.k})` }}>
                        <video ref={videoRef} src={videoSrc} crossOrigin="anonymous" className="absolute max-h-full max-w-full shadow-2xl pointer-events-none" onLoadedMetadata={onLoadedMetadata} onEnded={() => isLooping ? videoRef.current.play() : setIsPlaying(false)} loop={isLooping} playsInline controls={false} />
                        <canvas ref={canvasRef} className="absolute max-h-full max-w-full pointer-events-none hidden z-10" />
                        <canvas ref={annotationRef} width={DRAWING_CANVAS_WIDTH} height={DRAWING_CANVAS_HEIGHT} className="absolute w-full h-full z-50 cursor-crosshair object-contain pointer-events-none" />
                    </div>

                    {/* TEXT INPUT OVERLAY - FIXED POSITIONING */}
                    {activeText && (
                        <input
                            autoFocus
                            className="select-text cursor-text"
                            placeholder="Type..."
                            value={activeText.val}
                            onChange={(e) => setActiveText({ ...activeText, val: e.target.value })}
                            onMouseDown={(e) => e.stopPropagation()}
                            onKeyDown={handleTextKeyDown}
                            size={Math.max(10, activeText.val.length)}
                            style={{
                                position: 'fixed',
                                zIndex: 1000,
                                left: getOverlayPosition(activeText.x, activeText.y).left,
                                top: getOverlayPosition(activeText.x, activeText.y).top,
                                transform: 'translate(0, -50%)',
                                transformOrigin: 'top left',
                                color: brushColor,
                                fontFamily: currentFont, // NEW: Use active font
                                // Scale font size visually to match zoom level
                                fontSize: `${brushSize * 2 * viewTransform.k}px`,
                                fontWeight: 'bold',
                                background: 'rgba(0, 0, 0, 0.8)',
                                border: `2px solid ${brushColor}`,
                                borderRadius: '4px',
                                outline: 'none',
                                minWidth: '20px',
                                padding: '2px 6px',
                                boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.5)',
                                pointerEvents: 'auto'
                            }}
                        />
                    )}

                    {viewTransform.k !== 1 && <button onClick={() => setViewTransform({ k: 1, x: 0, y: 0 })} className="absolute top-4 right-4 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full border border-white/20 hover:bg-black/80 z-[100] cursor-pointer">Reset Zoom ({Math.round(viewTransform.k * 100)}%)</button>}
                    <div className="absolute top-4 left-4 flex flex-col gap-1 z-50 pointer-events-none"><div className="bg-black/50 px-2 py-1 rounded text-xs font-mono text-neutral-300 border border-white/10">{formatTimecode(currentFrame)} • {currentFrame} fr</div>{isRangeActive && <div className="bg-orange-500/20 px-2 py-1 rounded text-xs font-mono text-orange-200 border border-orange-500/30">RNG: {rangeStart}-{rangeEnd} ({rangeEnd - rangeStart} fr)</div>}</div>
                </div>

                {/* --- RIGHT SIDE PANEL: PROPERTIES --- */}
                {isPanelOpen && (
                    <div className="w-72 bg-neutral-900 border-l border-neutral-700 flex flex-col shrink-0 overflow-y-auto z-40">
                        <div className="p-3 border-b border-neutral-800 bg-neutral-850">
                            <h2 className="text-sm font-bold text-white flex items-center gap-2"><Settings size={14} /> Keyframe Properties</h2>
                        </div>

                        <div className="p-4 flex flex-col gap-6">
                            {/* NEW: Typography & Sizing Section */}
                            {(activeText || selectionActive) && (
                                <div className="flex flex-col gap-3 pb-4 border-b border-neutral-800">
                                    <div className="flex items-center justify-between">
                                        <label className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">Typography & Sizing</label>
                                    </div>

                                    <div className="flex flex-col gap-2">
                                        <label className="text-xs text-neutral-400">Font Family</label>
                                        <select
                                            value={currentFont}
                                            onChange={handleFontChange}
                                            className="bg-neutral-800 border border-neutral-700 text-white text-xs rounded p-2 focus:outline-none focus:border-orange-500"
                                        >
                                            {FONTS.map(f => <option key={f.value} value={f.value}>{f.name}</option>)}
                                        </select>
                                    </div>

                                    <div className="flex flex-col gap-2">
                                        <div className="flex justify-between items-center">
                                            <label className="text-xs text-neutral-400">Scale / Size</label>
                                            <span className="text-xs font-mono text-neutral-500">{brushSize}px</span>
                                        </div>
                                        <input
                                            type="range"
                                            min="1"
                                            max="100"
                                            value={brushSize}
                                            onChange={handleSizeChange}
                                            className="w-full accent-orange-500 h-1 bg-neutral-700 rounded-lg"
                                        />
                                    </div>
                                </div>
                            )}

                            <div className="flex flex-col gap-2">
                                <div className="flex justify-between items-center text-xs text-neutral-400">
                                    <span>Current Frame</span>
                                    <span className="font-mono text-white">{currentFrame}</span>
                                </div>
                                <div className="flex justify-between items-center text-xs text-neutral-400">
                                    <span>Has Drawing</span>
                                    <span className={`font-bold ${frameHasData ? 'text-green-400' : 'text-neutral-600'}`}>{frameHasData ? 'YES' : 'NO'}</span>
                                </div>
                            </div>

                            <div className="flex flex-col gap-2">
                                <label className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">Clipboard</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button onClick={handleCopy} disabled={!frameHasData} className="flex items-center justify-center gap-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs py-2 rounded border border-neutral-700 transition-colors">
                                        <ClipboardCopy size={14} /> Copy
                                    </button>
                                    <button onClick={handlePaste} disabled={!clipboard.current} className="flex items-center justify-center gap-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs py-2 rounded border border-neutral-700 transition-colors">
                                        <Clipboard size={14} /> Paste
                                    </button>
                                </div>
                            </div>

                            <div className="flex flex-col gap-2">
                                <label className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">Move Keyframe</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button onClick={() => moveKeyframe(-1)} disabled={!frameHasData} className="flex items-center justify-center gap-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs py-2 rounded border border-neutral-700 transition-colors">
                                        <MoveLeft size={14} /> Prev
                                    </button>
                                    <button onClick={() => moveKeyframe(1)} disabled={!frameHasData} className="flex items-center justify-center gap-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs py-2 rounded border border-neutral-700 transition-colors">
                                        Next <MoveRight size={14} />
                                    </button>
                                </div>
                                <p className="text-[10px] text-neutral-500 leading-tight">Shifts the drawing to the adjacent frame and clears the current one.</p>
                            </div>

                            <div className="flex flex-col gap-2">
                                <label className="text-[10px] font-bold text-neutral-500 uppercase tracking-wider">Clone to...</label>
                                <div className="grid grid-cols-2 gap-2">
                                    <button onClick={copyFromPrevFrame} className="flex items-center justify-center gap-2 bg-neutral-800 hover:bg-neutral-700 text-xs py-2 rounded border border-neutral-700 transition-colors">
                                        <ArrowLeft size={14} /> Pull Prev
                                    </button>
                                    <button onClick={copyToNextFrame} disabled={!frameHasData} className="flex items-center justify-center gap-2 bg-neutral-800 hover:bg-neutral-700 disabled:opacity-50 disabled:cursor-not-allowed text-xs py-2 rounded border border-neutral-700 transition-colors">
                                        Push Next <ArrowRight size={14} />
                                    </button>
                                </div>
                                <p className="text-[10px] text-neutral-500 leading-tight">Copies the drawing to the adjacent frame. "Pull Prev" grabs drawing from frame {currentFrame - 1}.</p>
                            </div>

                            <div className="h-px bg-neutral-800 my-2" />

                            <button onClick={clearCurrentFrame} disabled={!frameHasData} className="flex items-center justify-center gap-2 bg-red-900/20 hover:bg-red-900/40 text-red-400 disabled:opacity-50 disabled:cursor-not-allowed text-xs py-2 rounded border border-red-900/30 transition-colors w-full">
                                <Trash2 size={14} /> {selectionActive ? 'Delete Selection' : 'Delete Keyframe'}
                            </button>
                        </div>
                    </div>
                )}

                {/* --- RIGHT SIDE PANEL: LAYERS --- */}
                {isLayersPanelOpen && (
                    <div className="w-72 bg-neutral-900 border-l border-neutral-700 flex flex-col shrink-0 overflow-y-auto z-40">
                        <div className="p-3 border-b border-neutral-800 bg-neutral-850 flex justify-between items-center">
                            <h2 className="text-sm font-bold text-white flex items-center gap-2"><Layers size={14} /> Layers</h2>
                            <button onClick={addLayer} className="p-1 bg-neutral-800 hover:bg-neutral-700 text-white rounded"><Plus size={14} /></button>
                        </div>

                        <div className="flex flex-col">
                            {/* Reverse map to show Top layer at top of list */}
                            {[...layers].reverse().map((layer) => (
                                <div
                                    key={layer.id}
                                    onClick={() => setActiveLayerId(layer.id)}
                                    className={`p-2 flex items-center gap-2 border-b border-neutral-800 group cursor-pointer ${activeLayerId === layer.id ? 'bg-neutral-800' : 'hover:bg-neutral-850'}`}
                                >
                                    <div className="text-neutral-500 cursor-grab"><GripVertical size={12} /></div>
                                    <div className="flex-1 flex flex-col min-w-0">
                                        <input
                                            type="text"
                                            value={layer.name}
                                            onChange={(e) => updateLayerName(layer.id, e.target.value)}
                                            className={`bg-transparent text-sm outline-none w-full ${activeLayerId === layer.id ? 'text-white font-bold' : 'text-neutral-400'}`}
                                        />
                                    </div>

                                    {/* Opacity Control */}
                                    <div className="flex items-center gap-1 mr-1" title={`Layer Opacity: ${Math.round((layer.opacity ?? 1) * 100)}%`}>
                                        <span className="text-[9px] text-neutral-500 font-mono w-6 text-right">{Math.round((layer.opacity ?? 1) * 100)}%</span>
                                        <input
                                            type="range"
                                            min="0"
                                            max="1"
                                            step="0.1"
                                            value={layer.opacity ?? 1}
                                            onChange={(e) => updateLayerOpacity(layer.id, e.target.value)}
                                            onClick={(e) => e.stopPropagation()}
                                            className="w-12 h-1 bg-neutral-700 rounded-lg appearance-none cursor-pointer accent-neutral-400"
                                        />
                                    </div>

                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <button onClick={(e) => { e.stopPropagation(); toggleLayerVisible(layer.id); }} className={`p-1 rounded ${layer.visible ? 'text-neutral-400 hover:text-white' : 'text-neutral-600'}`}>
                                            {layer.visible ? <Eye size={14} /> : <EyeOff size={14} />}
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); toggleLayerLock(layer.id); }} className={`p-1 rounded ${layer.locked ? 'text-orange-400' : 'text-neutral-600 hover:text-neutral-400'}`}>
                                            {layer.locked ? <Lock size={14} /> : <Unlock size={14} />}
                                        </button>
                                        <button onClick={(e) => { e.stopPropagation(); deleteLayer(layer.id); }} className="p-1 text-neutral-600 hover:text-red-400 rounded">
                                            <Trash2 size={14} />
                                        </button>
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                )}
            </div>
            <div className="bg-neutral-800 border-t border-neutral-700 flex flex-col shrink-0 select-none z-30 cursor-default">
                <div ref={timelineRef} className="h-12 relative cursor-col-resize group bg-neutral-900 overflow-hidden border-b border-neutral-700" onMouseDown={handleTimelineMouseDown} onWheel={handleTimelineWheel}>
                    <div className="absolute inset-0 opacity-20 pointer-events-none" style={{ backgroundImage: 'linear-gradient(90deg, #555 1px, transparent 1px)', backgroundSize: '10px 100%' }} />
                    {!isZoomedToRange && isRangeActive && (<><div className="absolute top-0 bottom-0 left-0 bg-black/60 z-10 border-r border-orange-500/50" style={{ width: `${(rangeStart / totalFrames) * 100}%` }} /><div className="absolute top-0 bottom-0 right-0 bg-black/60 z-10 border-l border-orange-500/50" style={{ width: `${100 - ((rangeEnd / totalFrames) * 100)}%` }} /></>)}
                    {hasCached && <div className="absolute bottom-0 h-1 bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.8)] z-0 transition-all duration-300" style={{ left: isZoomedToRange && isRangeActive ? '0%' : `${(rangeStart / totalFrames) * 100}%`, width: isZoomedToRange && isRangeActive ? '100%' : `${((rangeEnd - rangeStart) / totalFrames) * 100}%` }} />}
                    {[...annotations.current.keys()].map(f => isVisible(f) && (
                        <div key={f} className="absolute bottom-4 w-1.5 h-1.5 rounded-full bg-pink-500 z-40 shadow-sm border border-black/20" style={{ left: `${getLeftPercent(f)}%` }} />
                    ))}
                    <div className="h-full bg-orange-500/10 border-r border-orange-500/50 transition-none pointer-events-none" style={{ width: `${getLeftPercent(currentFrame)}%` }} />
                    <div className="absolute top-0 bottom-0 w-px bg-orange-500 z-20 shadow-[0_0_10px_rgba(249,115,22,0.6)] pointer-events-none" style={{ left: `${getLeftPercent(currentFrame)}%` }}><div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[8px] border-t-orange-500 -ml-[6px]" /></div>
                </div>
                <div className="h-14 flex items-center justify-between px-4">
                    <div className="flex items-center gap-2">
                        <button onClick={jumpToPrevSketch} className="p-2 text-pink-400 hover:text-white hover:bg-neutral-700 rounded"><div className="flex items-center"><ChevronLeft size={14} /><PenTool size={14} /></div></button><button onClick={() => stepFrame(-1)} className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-700 rounded"><ChevronLeft size={20} /></button><button onClick={togglePlay} className="p-2 text-white hover:bg-neutral-700 rounded">{isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" />}</button><button onClick={() => stepFrame(1)} className="p-2 text-neutral-400 hover:text-white hover:bg-neutral-700 rounded"><ChevronRight size={20} /></button><button onClick={jumpToNextSketch} className="p-2 text-pink-400 hover:text-white hover:bg-neutral-700 rounded"><div className="flex items-center"><PenTool size={14} /><ChevronRight size={14} /></div></button><button onClick={() => setIsLooping(!isLooping)} className={`ml-2 p-2 rounded ${isLooping ? 'text-orange-500' : 'text-neutral-500'}`}><Repeat size={18} /></button>
                    </div>
                    <div className="flex items-center justify-center font-mono text-xl font-bold tracking-wider text-neutral-300"><span className="text-orange-500 w-16 text-right">{currentFrame}</span><span className="text-neutral-600 mx-2">/</span><span className="text-neutral-500 w-16 text-left">{totalFrames}</span></div>
                    <div className="flex items-center gap-4 w-[200px] justify-end">
                        <button onClick={toggleZoomToRange} disabled={!isRangeActive} className={`p-2 rounded transition-colors ${isZoomedToRange ? 'text-blue-400 bg-blue-500/20' : isRangeActive ? 'text-neutral-400 hover:text-white' : 'text-neutral-700 cursor-not-allowed'}`}>{isZoomedToRange ? <Focus size={18} /> : <Search size={18} />}</button>
                        <div className="flex items-center gap-2 group"><button onClick={() => setIsMuted(!isMuted)} className="text-neutral-400 hover:text-white">{isMuted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}</button><input type="range" min="0" max="1" step="0.1" value={isMuted ? 0 : volume} onChange={(e) => setVolume(parseFloat(e.target.value))} className="w-24 accent-orange-500 h-1 bg-neutral-600 rounded-lg" /></div>
                    </div>
                </div>
            </div>
        </div>
    );
}