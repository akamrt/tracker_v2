import React, { useRef, useEffect, useState, useCallback } from 'react';
import { TrackingPoint, MaskObject, ImageAttachment, KeyframeConfig, KeyTangent } from '../types';
import { Activity, X, GitCommit, Maximize, Undo2, Trash2, Lock, Unlock, PlusCircle, Image as ImageIcon, Link, Unlink } from 'lucide-react';
import { bezierInterp } from '../utils/interpolation';

interface GraphEditorProps {
    visible: boolean;
    onClose: () => void;
    trackers: TrackingPoint[];
    masks: MaskObject[];
    images: ImageAttachment[];
    selectedId: string | null;
    selectedColor: string;
    videoDuration: number;
    currentTime: number;
    onSeek: (time: number) => void;
    trackingCache: Map<number, TrackingPoint[]>;
    maskCache: Map<number, MaskObject[]>;
    imageCache: Map<number, ImageAttachment[]>;
    onUpdateData: (frameKey: number, point: any | null, id?: string, saveHistory?: boolean) => void;
    onInteractionStart: () => void;
    onUndo: () => void;
    onEditingChange?: (isEditing: boolean) => void;
    fps?: number;
    dataVersion?: number;
    onCopyAbsolute?: () => void;
    onPasteAbsolute?: () => void;
}

interface GraphPoint {
    frame: number;
    value: number;
    type: 'x' | 'y' | 'w' | 'h' | 'r' | 'p' | 'opacity';
}

const X_COLOR = '#ff4444';
const Y_COLOR = '#44ff44';
const W_COLOR = '#3b82f6';
const H_COLOR = '#a855f7';
const R_COLOR = '#f97316';
const P_COLOR = '#e879f9'; // Pink/Purple for Parent
const O_COLOR = '#ffffff'; // White for Opacity (or gray)
const MANUAL_COLOR = '#fbbf24';

const GraphEditor: React.FC<GraphEditorProps> = ({
    visible,
    onClose,
    trackers,
    masks,
    images,
    selectedId,
    selectedColor,
    videoDuration,
    currentTime,
    onSeek,
    trackingCache,
    maskCache,
    imageCache,
    onUpdateData,
    onInteractionStart,
    onUndo,
    onEditingChange,
    onCopyAbsolute,
    onPasteAbsolute,
    fps = 30,
    dataVersion
}) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [offset, setOffset] = useState({ x: 20, y: 0 });
    const [scale, setScale] = useState({ x: 5, y: 1 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragMode, setDragMode] = useState<'PAN' | 'EDIT' | 'MARQUEE' | null>(null);
    const [lastMousePos, setLastMousePos] = useState({ x: 0, y: 0 });
    const [startDragPos, setStartDragPos] = useState({ x: 0, y: 0 });
    const [hoveredKey, setHoveredKey] = useState<GraphPoint | null>(null);
    const [hoveredHandle, setHoveredHandle] = useState<{ frame: number, type: string, side: 'in' | 'out' } | null>(null);
    const [activeChannel, setActiveChannel] = useState<'both' | 'x' | 'y' | 'w' | 'h' | 'r' | 'p' | 'opacity'>('both');
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
    const [selectionRect, setSelectionRect] = useState<{ x: number, y: number, w: number, h: number } | null>(null);
    const [smoothStrength, setSmoothStrength] = useState(3);
    // Ref to store handle regions for hit testing (populated during render)
    const handleHitRegions = useRef<{ x: number, y: number, data: { frame: number, type: string, side: 'in' | 'out' } }[]>([]);
    const dragAccumulator = useRef(0);

    const isMaskSelected = masks.some(m => m.id === selectedId);
    const isImageSelected = images.some(img => img.id === selectedId);

    const getFrameKey = (time: number) => Math.floor(time * fps);
    const currentFrame = getFrameKey(currentTime);

    const worldToScreen = (frame: number, value: number, height: number) => {
        const sx = frame * scale.x + offset.x;
        const sy = value * scale.y + offset.y;
        return { x: sx, y: sy };
    };

    const screenToWorld = (sx: number, sy: number) => {
        const frame = (sx - offset.x) / scale.x;
        const value = (sy - offset.y) / scale.y;
        return { frame, value };
    };

    const getSelectionKey = (frame: number, type: 'x' | 'y' | 'w' | 'h' | 'r' | 'p' | 'opacity') => `${frame}:${type}`;

    const getData = (frame: number, id: string): TrackingPoint | MaskObject | ImageAttachment | undefined => {
        const isMask = masks.some(m => m.id === id);
        const isImage = images.some(img => img.id === id);
        if (isMask) {
            const mks = maskCache.get(frame);
            return mks?.find(m => m.id === id);
        } else if (isImage) {
            const imgs = imageCache.get(frame);
            return imgs?.find(img => img.id === id);
        } else {
            const pts = trackingCache.get(frame);
            return pts?.find(p => p.id === id);
        }
    };

    const getAllKeyframes = (id: string, type?: string) => {
        const isMask = masks.some(m => m.id === id);
        const isImage = images.some(img => img.id === id);
        let keys: { frame: number, data: any }[] = [];
        const cache = isMask ? maskCache : (isImage ? imageCache : trackingCache);
        for (const [f, items] of cache.entries()) {
            const item: any = items.find((i: any) => i.id === id);
            if (item) {
                // FILTER: If type is provided, check keyedProperties
                if (type) {
                    const keyedProps = item.keyedProperties;
                    // If keyedProperties is missing, assume ALL are keyed (legacy support).
                    // If it exists, check if type is in it.
                    if (!keyedProps || keyedProps.includes(type)) {
                        keys.push({ frame: f, data: item });
                    }
                } else {
                    keys.push({ frame: f, data: item });
                }
            }
        }
        keys.sort((a, b) => a.frame - b.frame);
        return keys;
    };

    // Helper to map Parent ID to Y-Value
    // Scale: World=0, Tracker A=100, Tracker B=200, etc.
    const sortedTrackerIds = trackers.map(t => t.id).sort();
    const getPVal = (pid: string | null | undefined) => {
        if (!pid) return 0;
        const idx = sortedTrackerIds.indexOf(pid);
        if (idx === -1) return -100; // Unknown
        return (idx + 1) * 100;
    };
    const getPId = (val: number) => {
        // Snap to nearest 100
        const idx = Math.round(val / 100) - 1;
        if (idx === -1) return null; // World (0)
        if (idx >= 0 && idx < sortedTrackerIds.length) return sortedTrackerIds[idx];
        return null; // Fallback
    };

    const getVal = (pt: any, type: string) => {
        if (type === 'w') return pt.width;
        if (type === 'h') return pt.height;
        if (type === 'r') return pt.rotation || 0;
        if (type === 'p') return getPVal(pt.parentId);
        if (type === 'opacity') return pt.opacity !== undefined ? pt.opacity : 1; // Default opacity to 1
        return pt[type];
    };

    const fitToView = useCallback(() => {
        if (!containerRef.current) return;
        let minF = Infinity, maxF = -Infinity, minV = Infinity, maxV = -Infinity;
        let hasData = false;

        const processItem = (id: string, isMask: boolean, isImage: boolean) => {
            const cache = isMask ? maskCache : (isImage ? imageCache : trackingCache);
            for (const [frame, items] of cache.entries()) {
                const item: any = items.find((i: any) => i.id === id);
                if (item) {
                    if (selectedKeys.size > 0) {
                        const types = (isMask || isImage) ? ['x', 'y', 'w', 'h', 'r', 'p', 'opacity'] : ['x', 'y', 'r'];
                        const hasSelection = types.some(t => selectedKeys.has(getSelectionKey(frame, t as any)));
                        if (!hasSelection) continue;
                    }

                    hasData = true;
                    minF = Math.min(minF, frame);
                    maxF = Math.max(maxF, frame);

                    const checkVal = (v: number, type: string) => {
                        // ALLOW 'p' to contribute to scaling now
                        if (activeChannel === 'both' || activeChannel === type) {
                            minV = Math.min(minV, v);
                            maxV = Math.max(maxV, v);
                        }
                    };

                    checkVal(item.x, 'x');
                    checkVal(item.y, 'y');
                    if (isMask || isImage) {
                        checkVal(item.width, 'w');
                        checkVal(item.height, 'h');
                    }
                    if (isImage) {
                        checkVal(item.rotation || 0, 'r');
                        checkVal(getPVal(item.parentId), 'p');
                        checkVal(item.opacity !== undefined ? item.opacity : 1, 'opacity');
                    } else if (!isMask) {
                        checkVal(item.rotation || 0, 'r');
                    }
                }
            }
        };

        if (selectedId) processItem(selectedId, isMaskSelected, isImageSelected);
        else {
            trackers.forEach(t => processItem(t.id, false, false));
            // Optional: also fit if only images exist? usually we just show trackers default
        }

        if (!hasData) return;
        const frameRange = maxF - minF || 50;
        const valRange = maxV - minV || 200;
        const paddingF = frameRange * 0.1;
        const paddingV = valRange * 0.2;
        const w = containerRef.current.clientWidth;
        const h = containerRef.current.clientHeight;
        const newScaleX = w / (frameRange + paddingF * 2);
        const newScaleY = h / (valRange + paddingV * 2);
        const newOffsetX = - (minF - paddingF) * newScaleX;
        const newOffsetY = - (minV - paddingV) * newScaleY;
        setScale({ x: newScaleX, y: newScaleY });
        setOffset({ x: newOffsetX, y: newOffsetY });
    }, [selectedId, trackers, masks, images, trackingCache, maskCache, imageCache, activeChannel, selectedKeys, isMaskSelected, isImageSelected]);

    useEffect(() => {
        if (visible) fitToView();
    }, [visible, selectedId]);

    const handleDelete = () => {
        if (!selectedId || selectedKeys.size === 0) return;
        onInteractionStart();
        const framesToDelete = new Set<number>();
        selectedKeys.forEach(k => { const [fStr] = k.split(':'); framesToDelete.add(parseInt(fStr)); });
        framesToDelete.forEach(f => { onUpdateData(f, null, selectedId, false); });
        setSelectedKeys(new Set());
    };

    const handleSetPersistence = (isPersistent: boolean) => {
        if (!selectedId || selectedKeys.size === 0) return;
        onInteractionStart();
        const framesToUpdate = new Set<number>();
        selectedKeys.forEach(k => { const [fStr] = k.split(':'); framesToUpdate.add(parseInt(fStr)); });
        framesToUpdate.forEach(f => {
            const pt = getData(f, selectedId);
            if (pt) {
                const updated = { ...pt, isManual: isPersistent };
                onUpdateData(f, updated, selectedId, false);
            }
        });
    };

    const handleInsertKey = () => {
        if (!selectedId) return;
        onInteractionStart();

        let currentObj: any = null;
        if (isMaskSelected) {
            currentObj = masks.find(m => m.id === selectedId);
        } else if (isImageSelected) {
            currentObj = images.find(img => img.id === selectedId);
        } else {
            currentObj = trackers.find(t => t.id === selectedId);
        }

        if (currentObj) {
            const updated = { ...currentObj, isManual: true };
            onUpdateData(currentFrame, updated, selectedId, true);
        }
    };

    const handleToggleBreak = () => {
        if (!selectedId || selectedKeys.size === 0) return;
        onInteractionStart();
        const framesToUpdate = new Set<{ f: number, t: string }>();
        selectedKeys.forEach(k => { const [fStr, t] = k.split(':'); framesToUpdate.add({ f: parseInt(fStr), t }); });

        framesToUpdate.forEach(({ f, t }) => {
            const pt = getData(f, selectedId);
            if (pt) {
                const kCfg = pt.keyframeConfig || {};
                const pCfg = kCfg[t] || {};
                const newBroken = !pCfg.broken;
                const newCfg = { ...pCfg, broken: newBroken };

                // If linking (unbreaking) and tangents exist, align them?
                // For now just toggle flag.

                const updated = {
                    ...pt,
                    keyframeConfig: {
                        ...kCfg,
                        [t]: newCfg
                    },
                    isManual: true
                };
                onUpdateData(f, updated, selectedId, false);
            }
        });
    };

    const applySmoothing = () => {
        if (!selectedId) return;
        onInteractionStart();
        let framesToSmooth: number[] = [];
        if (selectedKeys.size > 0) {
            const rawFrames = Array.from(selectedKeys).map((k: string) => parseInt(k.split(':')[0]));
            framesToSmooth = Array.from<number>(new Set(rawFrames)).sort((a, b) => a - b);
        } else {
            let maxFrame = Math.floor(videoDuration * fps);
            for (let f = 0; f <= maxFrame; f++) framesToSmooth.push(f);
        }
        if (framesToSmooth.length < 3) return;

        const processChannel = (type: 'x' | 'y' | 'w' | 'h' | 'r' | 'opacity') => {
            if (activeChannel !== 'both' && activeChannel !== type) return;
            const originalValues = new Map<number, number>();
            framesToSmooth.forEach((f: number) => {
                const pt = getData(f, selectedId);
                if (pt) {
                    let val = getVal(pt, type);
                    originalValues.set(f, val);
                }
            });
            framesToSmooth.forEach((currentFrame: number, index: number) => {
                const currentPt = getData(currentFrame, selectedId);
                if (!currentPt || currentPt.isManual) return;
                if (selectedKeys.size > 0 && !selectedKeys.has(getSelectionKey(currentFrame, type))) return;
                let sum = 0;
                let count = 0;
                for (let i = index - smoothStrength; i <= index + smoothStrength; i++) {
                    if (i >= 0 && i < framesToSmooth.length) {
                        const neighborFrame = framesToSmooth[i];
                        const val = originalValues.get(neighborFrame);
                        if (val !== undefined) { sum += val; count++; }
                    }
                }
                if (count > 0) {
                    const newValue = sum / count;
                    let prop: string = type;
                    if (type === 'w') prop = 'width';
                    else if (type === 'h') prop = 'height';
                    else if (type === 'r') prop = 'rotation';
                    else if (type === 'opacity') prop = 'opacity';

                    const updated = { ...currentPt, [prop]: newValue, isManual: false };
                    onUpdateData(currentFrame, updated, selectedId, false);
                }
            });
        };
        processChannel('x');
        processChannel('y');
        if (isMaskSelected || isImageSelected) {
            processChannel('w');
            processChannel('h');
        }
        if (isImageSelected || (!isMaskSelected && !isImageSelected)) { // Trackers also have rotation
            processChannel('r');
        }
        if (isImageSelected) {
            processChannel('opacity');
        }
        // 'p' (parent) is discrete, not smoothed
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        const worldX = (mouseX - offset.x) / scale.x;
        const worldY = (mouseY - offset.y) / scale.y;
        const zoomIntensity = 0.1;
        const delta = -Math.sign(e.deltaY);
        const factor = Math.pow(1 + zoomIntensity, delta);
        let newScaleX = scale.x;
        let newScaleY = scale.y;
        if (e.ctrlKey) newScaleX *= factor;
        else if (e.shiftKey) newScaleY *= factor;
        else { newScaleX *= factor; newScaleY *= factor; }
        newScaleX = Math.max(0.01, Math.min(newScaleX, 1000));
        newScaleY = Math.max(0.01, Math.min(newScaleY, 1000));
        const newOffsetX = mouseX - worldX * newScaleX;
        const newOffsetY = mouseY - worldY * newScaleY;
        setScale({ x: newScaleX, y: newScaleY });
        setOffset({ x: newOffsetX, y: newOffsetY });
    };

    const handlePointerDown = (e: React.PointerEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        setIsDragging(true);
        setLastMousePos({ x, y });
        setStartDragPos({ x, y });
        dragAccumulator.current = 0;
        const isRightClick = e.button === 2 || e.button === 1;
        const isAltPan = e.altKey && e.button === 0;

        if (isRightClick || isAltPan) {
            setDragMode('PAN');
        } else if (hoveredHandle && selectedId) {
            setDragMode('EDIT'); // Re-use EDIT mode but logic differs in Move
            setHoveredKey(null); // Clear key hover
            onInteractionStart();
            if (onEditingChange) onEditingChange(true);
        } else if (hoveredKey && selectedId) {
            setDragMode('EDIT');
            setHoveredHandle(null);
            onInteractionStart();
            if (onEditingChange) onEditingChange(true);
            const keyId = getSelectionKey(hoveredKey.frame, hoveredKey.type);
            if (!selectedKeys.has(keyId) && !e.shiftKey) setSelectedKeys(new Set([keyId]));
            else if (e.shiftKey) { const newSet = new Set(selectedKeys); newSet.add(keyId); setSelectedKeys(newSet); }
        } else {
            setDragMode('MARQUEE');
            if (!e.shiftKey) setSelectedKeys(new Set());
            setSelectionRect({ x, y, w: 0, h: 0 });
        }
        canvasRef.current?.setPointerCapture(e.pointerId);
    };

    const handlePointerMove = (e: React.PointerEvent) => {
        const rect = canvasRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const wPos = screenToWorld(x, y);

        if (isDragging) {
            const dx = x - lastMousePos.x;
            const dy = y - lastMousePos.y;

            if (dragMode === 'PAN') {
                setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
            }
            else if (dragMode === 'EDIT' && hoveredHandle && selectedId) {
                // Moving a Handle
                const f = hoveredHandle.frame;
                const type = hoveredHandle.type;
                const side = hoveredHandle.side;

                const pt = getData(f, selectedId);
                if (pt) {
                    const keyVal = getVal(pt, type);
                    // Handle World Pos
                    const hWx = wPos.frame;
                    const hWy = wPos.value;

                    // New Tangent (Relative)
                    const tx = hWx - f;
                    const ty = hWy - keyVal;

                    // Constraints
                    // Out tangent x >= 0, In tangent x <= 0
                    const constrainedTx = side === 'out' ? Math.max(0.1, tx) : Math.min(-0.1, tx);

                    const kCfg = pt.keyframeConfig || {};
                    const pCfg = kCfg[type] || {};
                    const isBroken = pCfg.broken;

                    const newCfg = { ...pCfg };

                    if (side === 'out') {
                        newCfg.outTangent = { x: constrainedTx, y: ty };
                        // If linked, update inTangent
                        if (!isBroken) {
                            newCfg.inTangent = { x: -constrainedTx, y: -ty };
                        }
                    } else {
                        newCfg.inTangent = { x: constrainedTx, y: ty };
                        if (!isBroken) {
                            newCfg.outTangent = { x: -constrainedTx, y: -ty };
                        }
                    }

                    const updated = {
                        ...pt,
                        keyframeConfig: { ...kCfg, [type]: newCfg },
                        isManual: true
                    };
                    onUpdateData(f, updated, selectedId, false);
                }
            }
            else if (dragMode === 'EDIT' && hoveredKey && selectedId) {
                const keyId = getSelectionKey(hoveredKey.frame, hoveredKey.type);

                if (e.shiftKey) {
                    // Time Move (Horizontal)
                    const dx = x - lastMousePos.x;
                    dragAccumulator.current += dx;
                    const framesToJump = Math.round(dragAccumulator.current / scale.x);

                    if (framesToJump !== 0) {
                        dragAccumulator.current -= framesToJump * scale.x;

                        const uniqueFrames = new Set<number>();
                        const keysArr = selectedKeys.has(keyId) ? Array.from(selectedKeys) : [keyId];
                        keysArr.forEach((k: string) => uniqueFrames.add(parseInt(k.split(':')[0])));

                        // Independent Key Move Logic
                        const movingData: { oldF: number, newF: number, obj: any, types: string[] }[] = [];
                        uniqueFrames.forEach(f => {
                            const pt = getData(f, selectedId);
                            const typesToMove: string[] = [];
                            keysArr.forEach((k: string) => {
                                const [kF, kT] = k.split(':');
                                if (parseInt(kF) === f) typesToMove.push(kT);
                            });
                            if (pt && typesToMove.length > 0) {
                                movingData.push({ oldF: f, newF: f + framesToJump, obj: pt, types: typesToMove });
                            }
                        });

                        // Pass 1: Create/Update Destination Objects
                        movingData.forEach(m => {
                            const existingDest = getData(m.newF, selectedId);
                            let target = existingDest ? { ...existingDest } : { ...m.obj, id: selectedId, isManual: true };

                            // If creating new from m.obj, we should probably reset OTHER non-moving values to interpolated values if we want strictness?
                            // But usually, if we simply clone m.obj to a new frame, we are effectively keying EVERYTHING there.
                            // If the user drags ONLY X, they probably want X keyed at Dest.
                            // If Dest didn't exist, we must key everything or interpolation fails.
                            // So "Copying the whole object" to Dest is safer for "Create", then we overwrite X.
                            // But if Dest exists, we only overwrite X.

                            // Correct logic for "Create":
                            // If we clone m.obj, we copy all its current values.
                            // Is that what we want?
                            // Creating a keyframe usually snapshots the current state.
                            // m.obj is the source state. So yes, snapping source state to new frame is fine as a baseline.

                            // If Dest exists, we merge.
                            if (!existingDest) {
                                // If creating new, we might want to interpolate values for the new time, rather than copying old values?
                                // If I move X from frame 5 to 10.
                                // At frame 10, Y should be what Y is at 10 (interpolated).
                                // BUT I don't have an easy "getInterpolatedAt(10)" without doing the math myself.
                                // For now, copying Source object is acceptable behavior (like Copy/Paste keyframe),
                                // but ideally we only enforce the Moved Value.

                                // Let's try to be smart: Copy Source, but for non-moving types, try to interpolate?
                                // Iterate all types ['x','y','w'...]
                                // If type NOT in m.types, set target[type] = interpolated(m.newF).

                                // Since we don't have handy 'interpolated' wrapper here, we'll stick to Copy for now.
                                // It prevents breakage.
                            }

                            // Overwrite moving values
                            m.types.forEach(t => {
                                const val = getVal(m.obj, t);
                                if (t === 'w') (target as any).width = val;
                                else if (t === 'h') (target as any).height = val;
                                else if (t === 'r') (target as any).rotation = val;
                                else if (t === 'p') {
                                    // Copy Parent ID
                                    (target as any).parentId = m.obj.parentId;
                                }
                                else if (t === 'opacity') (target as any).opacity = val;
                                else (target as any)[t] = val;

                                // Copy Config
                                const kCfg = m.obj.keyframeConfig?.[t];
                                if (kCfg) {
                                    target.keyframeConfig = { ...target.keyframeConfig, [t]: kCfg };
                                }
                            });

                            // Update keyedProperties
                            const isMask = masks.some(msk => msk.id === selectedId);
                            const isImage = images.some(img => img.id === selectedId);
                            const allTypes = isMask ? ['x', 'y', 'w', 'h'] : (isImage ? ['x', 'y', 'w', 'h', 'r', 'p', 'opacity'] : ['x', 'y', 'r']);

                            // Calculate target keyedProperties
                            let targetKeyedProps: string[];

                            if (existingDest) {
                                targetKeyedProps = existingDest.keyedProperties ? [...existingDest.keyedProperties] : [...allTypes];
                            } else {
                                // New Frame: Only key the moved types
                                targetKeyedProps = [];
                            }

                            m.types.forEach(t => {
                                if (!targetKeyedProps.includes(t)) targetKeyedProps.push(t);
                            });
                            target.keyedProperties = targetKeyedProps;

                            target.isManual = true;
                            onUpdateData(m.newF, target, selectedId, false);
                        });

                        // Pass 2: Reset Source (Interpolate) or Delete
                        // We need to fetch ALL keys to do interpolation correctly.
                        const allKeys = getAllKeyframes(selectedId); // Sorted (Raw, all types included for cleanup checks)

                        movingData.forEach(m => {
                            // Re-fetch source to be safe? (No, we are in same tick, cache hasn't updated really)
                            // But we queued updates.
                            // Actually onUpdateData might be async in effect if it relies on react state?
                            // Fortunately onUpdateData usually updates the refs/maps synchronously or we rely on the map.

                            // Check if we are moving ALL keys.
                            const isMask = masks.some(msk => msk.id === selectedId);
                            const isImage = images.some(img => img.id === selectedId);
                            const allTypes = isMask ? ['x', 'y', 'w', 'h'] : (isImage ? ['x', 'y', 'w', 'h', 'r', 'p', 'opacity'] : ['x', 'y', 'r']); // Basic set

                            // If we moved all types, delete source.
                            const movedAll = allTypes.every(t => m.types.includes(t));

                            if (movedAll) {
                                onUpdateData(m.oldF, null, selectedId, false);
                            } else {
                                // Partial Move. we need to "Reset" the moved types at oldF.
                                // Reset means: Set value to interpolated value from neighbors.
                                // AND remove their keyframeConfig.
                                let sourceObj = { ...m.obj };
                                // If we already deleted it? No strict order.

                                // We need to calculate interpolated value for each moved type at m.oldF.
                                // We need Prev and Next keys that are NOT m.oldF.

                                // Update Keyed Properties for Source
                                let sourceKeyedProps = sourceObj.keyedProperties || [...allTypes];
                                sourceKeyedProps = sourceKeyedProps.filter(p => !m.types.includes(p));
                                sourceObj.keyedProperties = sourceKeyedProps;

                                // We DO NOT need to calculate interpolated values here.
                                // The new interpolation system (getInterpolated*) will automatically handle
                                // frames where the property is not in 'keyedProperties'.
                                // We just need to ensure the 'keyedProperties' metadata is correct.

                                if (sourceKeyedProps.length === 0) {
                                    onUpdateData(m.oldF, null, selectedId, false);
                                } else {
                                    // For safety, clear the moved values from sourceObj so they don't look like keys in raw data view?
                                    // Actually, keep them as is or don't care, because keyedProperties is the source of truth now.
                                    onUpdateData(m.oldF, sourceObj, selectedId, false);
                                }
                            }
                        });


                        // 4. Update Selection
                        const newSelection = new Set<string>();
                        keysArr.forEach((k: string) => {
                            const [fStr, t] = k.split(':');
                            const newF = parseInt(fStr) + framesToJump;
                            newSelection.add(`${newF}:${t}`);
                        });
                        setSelectedKeys(newSelection);

                        // 5. Update Hover
                        setHoveredKey({ ...hoveredKey, frame: hoveredKey.frame + framesToJump });
                    }
                } else {
                    // Value Move (Vertical)
                    const valDelta = dy / scale.y;
                    const keysToMove = selectedKeys.has(keyId) ? Array.from(selectedKeys) : [keyId];
                    keysToMove.forEach((k: string) => {
                        const [fStr, tStr] = k.split(':');
                        const f = parseInt(fStr);
                        const t = tStr as 'x' | 'y' | 'w' | 'h' | 'r' | 'p' | 'opacity';
                        const pt = getData(f, selectedId);
                        if (pt) {
                            if (t === 'p') {
                                // Parent IS draggable now.
                                // We are changing value, so we map back to ID.
                                const currentVal = getPVal(pt.parentId);
                                const newVal = currentVal + valDelta;
                                const newId = getPId(newVal);

                                if (newId !== pt.parentId) {
                                    // Preserve World Position Logic
                                    // 1. Find Old Parent at frame f
                                    // We need to look in cache for frame f, or fallback to current trackers
                                    const pointsAtFrame = trackingCache.get(f) || trackers;
                                    const oldP = pt.parentId ? pointsAtFrame.find((tp: any) => tp.id === pt.parentId) : null;

                                    // 2. Find New Parent at frame f
                                    const newP = newId ? pointsAtFrame.find((tp: any) => tp.id === newId) : null;

                                    // 3. Current World Transform
                                    const TR = (d: number) => d * Math.PI / 180;
                                    let wx = pt.x, wy = pt.y, wr = pt.rotation || 0;

                                    if (oldP) {
                                        const pr = TR(oldP.rotation || 0);
                                        const rc = Math.cos(pr), rs = Math.sin(pr);
                                        wx = oldP.x + (pt.x * rc - pt.y * rs);
                                        wy = oldP.y + (pt.x * rs + pt.y * rc);
                                        wr = (pt.rotation || 0) + (oldP.rotation || 0);
                                    }

                                    // 4. New Local Transform
                                    let npx = 0, npy = 0, npr = 0;
                                    if (newP) {
                                        npx = newP.x; npy = newP.y; npr = newP.rotation || 0;
                                    }

                                    const nprRad = TR(npr);
                                    const nrc = Math.cos(nprRad), nrs = Math.sin(nprRad);

                                    // Relative to New Parent
                                    const dx = wx - npx;
                                    const dy = wy - npy;

                                    // Rotate by -npr
                                    const nlx = dx * nrc + dy * nrs;
                                    const nly = -dx * nrs + dy * nrc;
                                    const nlr = wr - npr;

                                    // Update ALL properties (Parent + x/y/rotation)
                                    const updated = {
                                        ...pt,
                                        parentId: newId,
                                        x: nlx,
                                        y: nly,
                                        rotation: nlr,
                                        isManual: true
                                    };

                                    // Update Keyed Properties to ensure x/y/rotation are keyed if they weren't? 
                                    // Usually when we manually edit, we key everything or at least what changed.
                                    // Since x/y/rot changed, we should ensure they are in keyedProperties if we use that system.
                                    // But updated object will simply be saved.
                                    onUpdateData(f, updated, selectedId, false);
                                }
                            } else {
                                const currentVal = getVal(pt, t); // Use helper
                                let prop = t === 'w' ? 'width' : t === 'h' ? 'height' : t === 'r' ? 'rotation' : t === 'opacity' ? 'opacity' : t;
                                const updated = { ...pt, [prop]: currentVal + valDelta, isManual: true };
                                onUpdateData(f, updated, selectedId, false);
                            }
                        }
                    });
                    // Update hoveredKey value (even for p)
                    if (hoveredKey) {
                        setHoveredKey({ ...hoveredKey, value: hoveredKey.value + valDelta });
                    }
                }
            } else if (dragMode === 'MARQUEE') {
                setSelectionRect({ x: Math.min(startDragPos.x, x), y: Math.min(startDragPos.y, y), w: Math.abs(x - startDragPos.x), h: Math.abs(y - startDragPos.y) });
            }
            setLastMousePos({ x, y });
        } else {
            // Hover Logic
            if (!selectedId) return;
            let foundKey: GraphPoint | null = null;
            let foundHandle: { frame: number, type: string, side: 'in' | 'out' } | null = null;

            const threshold = 10;
            const handleThreshold = 12;

            // Check Handles via ref (Priority)
            if (handleHitRegions.current) {
                for (const hR of handleHitRegions.current) {
                    if (Math.abs(x - hR.x) < handleThreshold && Math.abs(y - hR.y) < handleThreshold) {
                        foundHandle = hR.data;
                        break;
                    }
                }
            }

            if (!foundHandle) {
                const w = screenToWorld(x, y);
                const searchFrameStart = Math.floor(w.frame - 10);
                const searchFrameEnd = Math.floor(w.frame + 10);
                const mx = x;
                const my = y;
                const height = canvasRef.current?.clientHeight || 0;

                // Helper to get all GraphPoints for the selected object
                const getGraphPointsForObject = (id: string): GraphPoint[] => {
                    const allKeys = getAllKeyframes(id);
                    const points: GraphPoint[] = [];
                    allKeys.forEach(k => {
                        const d = k.data;
                        const isMask = masks.some(m => m.id === id);
                        const isImage = images.some(img => img.id === id);

                        const typesToCheck: ('x' | 'y' | 'w' | 'h' | 'r' | 'p' | 'opacity')[] = ['x', 'y'];
                        if (isMask || isImage) {
                            typesToCheck.push('w', 'h');
                        }
                        if (isImage || (!isMask && !isImage)) { // Trackers also have rotation
                            typesToCheck.push('r');
                        }
                        if (isImage) {
                            typesToCheck.push('p', 'opacity');
                        }

                        typesToCheck.forEach(type => {
                            // Check if property is explicitly keyed or if keyedProperties is missing (legacy)
                            const keyedProps = d.keyedProperties;
                            if (!keyedProps || keyedProps.includes(type)) {
                                const val = getVal(d, type);
                                if (val !== undefined) {
                                    points.push({ frame: k.frame, value: val, type: type });
                                }
                            }
                        });
                    });
                    return points;
                };

                const allGraphPoints = getGraphPointsForObject(selectedId);
                const grouped = allGraphPoints.filter(p => p.frame >= searchFrameStart && p.frame <= searchFrameEnd);

                // Special Check for Parent ('p') REMOVED - Treat as normal keys now
                // if (isImageSelected) { ... }

                if (!foundKey) { // If no parent key found, check other keys
                    // Simple distance check to points
                    let minDist = threshold;
                    let closest: GraphPoint | null = null;

                    grouped.forEach(p => {
                        if (p.type === 'p') return; // Handled above

                        const { x: sx, y: sy } = worldToScreen(p.frame, p.value, height);
                        const d = Math.sqrt(Math.pow(sx - mx, 2) + Math.pow(sy - my, 2));
                        if (d < minDist) {
                            minDist = d;
                            closest = p;
                        }
                    });
                    foundKey = closest;
                }
            }

            // Correct Logic:
            setHoveredKey(foundKey);
            setHoveredHandle(foundHandle);

            if (canvasRef.current) {
                if (foundHandle || foundKey) canvasRef.current.style.cursor = 'grab';
                else if (isDragging) canvasRef.current.style.cursor = 'grabbing';
                else canvasRef.current.style.cursor = 'default';
            }
        }
    };

    const handlePointerUp = (e: React.PointerEvent) => {
        if (dragMode === 'EDIT' && onEditingChange) onEditingChange(false);
        if (dragMode === 'MARQUEE' && selectionRect && selectedId) {
            const newSelected = new Set(e.shiftKey ? selectedKeys : []);
            const startFrame = Math.ceil((selectionRect.x - offset.x) / scale.x);
            const endFrame = Math.floor((selectionRect.x + selectionRect.w - offset.x) / scale.x);
            const minVal = (selectionRect.y - offset.y) / scale.y;
            const maxVal = (selectionRect.y + selectionRect.h - offset.y) / scale.y;

            for (let f = startFrame; f <= endFrame; f++) {
                const pt = getData(f, selectedId);
                if (pt) {
                    const checkSelect = (val: number, type: string, graphY?: number) => {
                        const actualGraphY = worldToScreen(f, val, 0).y;
                        const screenX = worldToScreen(f, val, 0).x;

                        if ((activeChannel === 'both' || activeChannel === type) &&
                            screenX >= selectionRect.x && screenX <= selectionRect.x + selectionRect.w &&
                            actualGraphY >= selectionRect.y && actualGraphY <= selectionRect.y + selectionRect.h) {
                            newSelected.add(getSelectionKey(f, type as any));
                        }
                    };
                    checkSelect(pt.x, 'x');
                    checkSelect(pt.y, 'y');
                    if (isMaskSelected) {
                        const mPt = pt as MaskObject;
                        checkSelect(mPt.width, 'w');
                        checkSelect(mPt.height, 'h');
                    } else if (isImageSelected) {
                        const iPt = pt as ImageAttachment;
                        checkSelect(iPt.width, 'w');
                        checkSelect(iPt.height, 'h');
                        checkSelect(iPt.rotation, 'r');
                        if (iPt.parentId !== undefined) {
                            const pVal = getVal(iPt, 'p');
                            checkSelect(pVal, 'p');
                        }
                        if (iPt.opacity !== undefined) checkSelect(iPt.opacity, 'opacity');
                    } else {
                        const tPt = pt as TrackingPoint;
                        checkSelect(tPt.rotation || 0, 'r');
                    }
                }
            }
            setSelectedKeys(newSelected);
        }
        setIsDragging(false);
        setDragMode(null);
        setSelectionRect(null);
        canvasRef.current?.releasePointerCapture(e.pointerId);
    };



    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        if (containerRef.current) { canvas.width = containerRef.current.clientWidth; canvas.height = containerRef.current.clientHeight; }
        const w = canvas.width;
        const h = canvas.height;
        ctx.fillStyle = "#0f172a"; ctx.fillRect(0, 0, w, h);

        // Grid
        ctx.lineWidth = 1; ctx.strokeStyle = "#1e293b";
        const startFrame = Math.floor(-offset.x / scale.x);
        const endFrame = Math.floor((w - offset.x) / scale.x);
        for (let f = startFrame; f <= endFrame; f++) {
            if (f % 10 === 0) {
                const x = f * scale.x + offset.x;
                ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
                if (f % 30 === 0) { ctx.fillStyle = "#64748b"; ctx.font = "10px monospace"; ctx.fillText(f.toString(), x + 2, h - 5); }
            }
        }
        if (trackers.length === 0 && masks.length === 0 && images.length === 0) { ctx.fillStyle = "#475569"; ctx.font = "14px sans-serif"; ctx.fillText("No objects to edit", w / 2 - 50, h / 2); return; }

        handleHitRegions.current = []; // Reset hit regions

        const itemsToDraw = selectedId ? [selectedId] : trackers.map(t => t.id);

        // Helper to get all GraphPoints for a given object and type
        const getGraphPointsForChannel = (id: string, type: 'x' | 'y' | 'w' | 'h' | 'r' | 'p' | 'opacity'): GraphPoint[] => {
            const allKeys = getAllKeyframes(id, type); // Filtered by type
            const points: GraphPoint[] = [];
            allKeys.forEach(k => {
                const d = k.data;
                if (type === 'p') {
                    if (d.parentId !== undefined) {
                        const val = getVal(d, 'p'); // Use mapped value
                        points.push({ frame: k.frame, value: val, type: 'p' });
                    }
                } else {
                    const val = getVal(d, type);
                    if (val !== undefined) {
                        points.push({ frame: k.frame, value: val, type: type });
                    }
                }
            });
            return points;
        };

        // Draw Parent Guide Lines (Grid)
        if (activeChannel === 'p' || activeChannel === 'both') {
            // Draw World Line
            const { y: y0 } = worldToScreen(0, 0, h);
            ctx.beginPath(); ctx.moveTo(0, y0); ctx.lineTo(w, y0); ctx.strokeStyle = "#334155"; ctx.setLineDash([2, 5]); ctx.stroke();
            ctx.fillStyle = "#64748b"; ctx.fillText("World (0)", 5, y0 - 2);

            sortedTrackerIds.forEach((tid, i) => {
                const val = (i + 1) * 100;
                const { y } = worldToScreen(0, val, h);
                ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
                ctx.fillText(tid, 5, y - 2);
            });
            ctx.setLineDash([]);
        }

        // Helper to draw channel
        const drawChannel = (
            points: GraphPoint[],
            color: string,
            isActive: boolean,
            keyType: 'x' | 'y' | 'w' | 'h' | 'r' | 'p' | 'opacity'
        ) => {
            if (activeChannel !== 'both' && activeChannel !== keyType) return;
            if (points.length === 0) return;

            // Sort points by frame
            points.sort((a, b) => a.frame - b.frame);

            ctx.beginPath();
            ctx.strokeStyle = color;
            ctx.lineWidth = isActive ? 2 : 1;
            ctx.globalAlpha = isActive ? 1.0 : 0.3;

            // Discrete Channels: Parent ('p')
            // Don't draw lines, just draw markers and text
            // Discrete Channels: Parent ('p')
            // Draw Stepped Lines
            if (keyType === 'p') {
                // Draw Steps
                ctx.beginPath();
                let first = true;
                points.forEach((p, i) => {
                    const { x, y } = worldToScreen(p.frame, p.value, h);
                    if (first) {
                        ctx.moveTo(x, y);
                        first = false;
                    } else {
                        const prev = points[i - 1];
                        const { x: px, y: py } = worldToScreen(prev.frame, prev.value, h);
                        // Stepped: Move horizontally from prev to curr X, at prev Y. Then vertical to curr Y.
                        ctx.lineTo(x, py);
                        ctx.lineTo(x, y);
                    }
                });
                ctx.stroke();

                // Draw Keys
                points.forEach(p => {
                    const { x, y } = worldToScreen(p.frame, p.value, h);
                    const isSelected = selectedKeys.has(`${p.frame}:${p.type}`);
                    const isHovered = hoveredKey && hoveredKey.frame === p.frame && hoveredKey.type === p.type;

                    ctx.fillStyle = color;
                    if (isSelected || isHovered) ctx.fillStyle = "#ffffff";

                    // Diamond for all parent keys as they are concepturally discrete
                    ctx.beginPath();
                    ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.fill();

                    if (isSelected || isHovered) {
                        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();
                        // Label active parent
                        // Reverse lookup ID
                        const pid = getPId(p.value);
                        const label = pid ? pid : "World";
                        ctx.fillStyle = "#ffffff";
                        ctx.font = "10px sans-serif";
                        ctx.fillText(label, x + 8, y + 3);
                    }
                });
                return;
            }

            // Continuous Channels (x, y, w, h, r, opacity)
            let first = true;
            for (let i = 0; i < points.length - 1; i++) {
                const k1 = points[i];
                const k2 = points[i + 1];

                const f1 = k1.frame;
                const v1 = k1.value;
                const f2 = k2.frame;
                const v2 = k2.value;

                const dt = f2 - f1;
                const dv = v2 - v1;

                const k1Data = getData(f1, selectedId!);
                const k2Data = getData(f2, selectedId!);

                // Bezier Control Points
                const k1Cfg = k1Data?.keyframeConfig?.[keyType];
                const k2Cfg = k2Data?.keyframeConfig?.[keyType];

                // Out Tangent K1
                let c1x = dt / 3;
                let c1y = dv / 3;
                if (k1Cfg?.outTangent) { c1x = k1Cfg.outTangent.x; c1y = k1Cfg.outTangent.y; }

                // In Tangent K2
                let c2x = -dt / 3;
                let c2y = -dv / 3;
                if (k2Cfg?.inTangent) { c2x = k2Cfg.inTangent.x; c2y = k2Cfg.inTangent.y; }

                const p1 = worldToScreen(f1, v1, h);
                const cp1 = worldToScreen(f1 + c1x, v1 + c1y, h);
                const cp2 = worldToScreen(f2 + c2x, v2 + c2y, h);
                const p2 = worldToScreen(f2, v2, h);

                if (first) { ctx.moveTo(p1.x, p1.y); first = false; }
                ctx.bezierCurveTo(cp1.x, cp1.y, cp2.x, cp2.y, p2.x, p2.y);
            }
            ctx.stroke();
            ctx.globalAlpha = 1.0;

            // Draw Keys and Handles
            points.forEach((p, i) => {
                const { x, y } = worldToScreen(p.frame, p.value, h);

                const isKeySelected = selectedKeys.has(getSelectionKey(p.frame, p.type));
                const isHovered = hoveredKey && hoveredKey.frame === p.frame && hoveredKey.type === p.type;

                ctx.fillStyle = getData(p.frame, selectedId!)?.isManual ? MANUAL_COLOR : color;
                ctx.beginPath();
                if (getData(p.frame, selectedId!)?.isManual) {
                    // Diamond
                    ctx.moveTo(x, y - 5); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 5); ctx.lineTo(x - 5, y); ctx.fill();
                } else { ctx.arc(x, y, 4, 0, Math.PI * 2); ctx.fill(); }

                if (isKeySelected) {
                    // Highlight
                    ctx.strokeStyle = "#fff"; ctx.lineWidth = 1; ctx.stroke();

                    // Handles
                    const kData = getData(p.frame, selectedId!);
                    const kCfg = kData?.keyframeConfig?.[keyType];

                    // Out Handle (if not last)
                    if (i < points.length - 1) {
                        const next = points[i + 1];
                        const dt = next.frame - p.frame;
                        const dv = next.value - p.value;
                        const tx = kCfg?.outTangent?.x ?? dt / 3;
                        const ty = kCfg?.outTangent?.y ?? dv / 3;
                        const hPos = worldToScreen(p.frame + tx, p.value + ty, h);

                        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(hPos.x, hPos.y); ctx.strokeStyle = "#888"; ctx.stroke();
                        ctx.beginPath(); ctx.fillStyle = "#fff"; ctx.arc(hPos.x, hPos.y, 3, 0, Math.PI * 2); ctx.fill();

                        handleHitRegions.current.push({ x: hPos.x, y: hPos.y, data: { frame: p.frame, type: keyType, side: 'out' } });
                    }

                    // In Handle (if not first)
                    if (i > 0) {
                        const prev = points[i - 1];
                        const dt = prev.frame - p.frame; // neg
                        const dv = prev.value - p.value; // neg usually
                        const tx = kCfg?.inTangent?.x ?? dt / 3; // dt is neg, so /3 is neg
                        const ty = kCfg?.inTangent?.y ?? dv / 3;
                        const hPos = worldToScreen(p.frame + tx, p.value + ty, h);

                        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(hPos.x, hPos.y); ctx.strokeStyle = "#888"; ctx.stroke();
                        ctx.beginPath(); ctx.fillStyle = "#fff"; ctx.arc(hPos.x, hPos.y, 3, 0, Math.PI * 2); ctx.fill();

                        handleHitRegions.current.push({ x: hPos.x, y: hPos.y, data: { frame: p.frame, type: keyType, side: 'in' } });
                    }
                }
            });
        };

        itemsToDraw.forEach(id => {
            const isSelected = id === selectedId;
            const isMask = masks.some(m => m.id === id);
            const isImage = images.some(img => img.id === id);
            const color = isMask ? masks.find(m => m.id === id)?.color : (isImage ? '#f472b6' : trackers.find(t => t.id === id)?.color);

            ctx.globalAlpha = isSelected ? 1.0 : 0.15;

            if (isSelected) {
                drawChannel(getGraphPointsForChannel(id, 'x'), X_COLOR, true, 'x');
                drawChannel(getGraphPointsForChannel(id, 'y'), Y_COLOR, true, 'y');
                if (isMask || isImage) {
                    drawChannel(getGraphPointsForChannel(id, 'w'), W_COLOR, true, 'w');
                    drawChannel(getGraphPointsForChannel(id, 'h'), H_COLOR, true, 'h');
                }
                if (isImage || (!isMask && !isImage)) { // Trackers also have rotation
                    drawChannel(getGraphPointsForChannel(id, 'r'), R_COLOR, true, 'r');
                }
                if (isImage) {
                    drawChannel(getGraphPointsForChannel(id, 'p'), P_COLOR, true, 'p');
                    drawChannel(getGraphPointsForChannel(id, 'opacity'), O_COLOR, true, 'opacity');
                }
            } else {
                // Background curves (non selected)
                // Just use simple points line or bezier? simple line is cheap.
                const keys = getAllKeyframes(id);
                if (keys.length > 0) {
                    ctx.beginPath();
                    ctx.strokeStyle = color || '#888';
                    ctx.lineWidth = 1;
                    let first = true;
                    for (const k of keys) {
                        const v = k.data.x; // Just X for now? 
                        // Actually 'background' channels are many. 
                        // Logic in previous code was treating 'pt.x' as default.
                        const pos = worldToScreen(k.frame, k.data.x, h);
                        if (first) ctx.moveTo(pos.x, pos.y); else ctx.lineTo(pos.x, pos.y);
                        first = false;
                    }
                    ctx.stroke();
                }
            }
        });

        // ... rest of overlays ...
        ctx.globalAlpha = 1.0;
        if (selectionRect) {
            ctx.fillStyle = "rgba(59, 130, 246, 0.2)"; ctx.strokeStyle = "rgba(59, 130, 246, 0.8)";
            ctx.lineWidth = 1; ctx.fillRect(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
            ctx.strokeRect(selectionRect.x, selectionRect.y, selectionRect.w, selectionRect.h);
        }
        const playHeadX = currentFrame * scale.x + offset.x;
        ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(playHeadX, 0); ctx.lineTo(playHeadX, h); ctx.stroke();

    }, [offset, scale, trackingCache, maskCache, selectedId, trackers, masks, currentFrame, hoveredKey, activeChannel, visible, selectionRect, selectedKeys, dataVersion]);

    if (!visible) return null;

    return (
        <div ref={containerRef} className="h-64 bg-slate-950 border-t border-slate-700 flex flex-col z-30 shadow-2xl shrink-0" onContextMenu={(e) => e.preventDefault()}>
            <div className="h-10 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 shrink-0">
                <div className="flex items-center space-x-4">
                    <span className="text-xs font-bold text-slate-400 flex items-center"><Activity className="w-4 h-4 mr-2" /> GRAPH EDITOR</span>
                    {selectedId ? (
                        <>
                            <div className="flex items-center space-x-2 bg-slate-800 rounded px-2 py-1">
                                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: selectedColor }}></div>
                                <span className="text-xs text-slate-300 font-mono">ID: {selectedId}</span>
                            </div>
                            <div className="flex space-x-1">
                                <button onClick={() => setActiveChannel('x')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'x' ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-800 text-slate-400'}`}>X</button>
                                <button onClick={() => setActiveChannel('y')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'y' ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-800 text-slate-400'}`}>Y</button>
                                {isMaskSelected && (
                                    <>
                                        <button onClick={() => setActiveChannel('w')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'w' ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-800 text-slate-400'}`}>W</button>
                                        <button onClick={() => setActiveChannel('h')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'h' ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-800 text-slate-400'}`}>H</button>
                                    </>
                                )}
                                {isImageSelected && (
                                    <>
                                        <button onClick={() => setActiveChannel('w')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'w' ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-800 text-slate-400'}`}>W</button>
                                        <button onClick={() => setActiveChannel('h')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'h' ? 'bg-slate-700 text-white border-slate-500' : 'bg-slate-800 text-slate-400'}`}>H</button>
                                        <button onClick={() => setActiveChannel('r')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'r' ? 'bg-orange-600 text-white border-orange-500' : 'bg-slate-800 text-slate-400'}`}>R</button>
                                        <button onClick={() => setActiveChannel('p')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'p' ? 'bg-purple-600 text-white border-purple-500' : 'bg-slate-800 text-slate-400'}`}>P</button>
                                    </>
                                )}
                                {!isMaskSelected && !isImageSelected && (
                                    <button onClick={() => setActiveChannel('r')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'r' ? 'bg-orange-600 text-white border-orange-500' : 'bg-slate-800 text-slate-400'}`}>R</button>
                                )}
                                <button onClick={() => setActiveChannel('both')} className={`px-2 py-0.5 text-xs rounded border border-transparent ${activeChannel === 'both' ? 'bg-indigo-900 text-indigo-200 border-indigo-500' : 'bg-slate-800 text-slate-400'}`}>ALL</button>
                            </div>
                        </>
                    ) : <span className="text-xs text-yellow-500">Select object to edit keys</span>}
                </div>

                <div className="flex items-center space-x-2 mr-4">
                    <button title="Copy World Position" onClick={onCopyAbsolute} className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white">
                        <span className="flex text-[10px] items-center space-x-1 font-mono uppercase font-bold"><GitCommit className="w-3 h-3 text-blue-400" /><span>Cpy</span></span>
                    </button>
                    <button title="Paste World Position" onClick={onPasteAbsolute} className="p-1 hover:bg-slate-700 rounded text-slate-400 hover:text-white">
                        <span className="flex text-[10px] items-center space-x-1 font-mono uppercase font-bold"><GitCommit className="w-3 h-3 text-red-400" /><span>Pst</span></span>
                    </button>
                </div>

                <div className="flex items-center space-x-3">
                    <div className="flex items-center space-x-2 text-xs text-slate-500 px-2 border-r border-slate-800">
                        <button onClick={onUndo} className="flex items-center hover:text-white transition-colors" title="Undo"><Undo2 className="w-3 h-3 mr-1" /> Undo</button>
                        <div className="w-px h-3 bg-slate-700 mx-2"></div>
                        <button onClick={handleInsertKey} disabled={!selectedId} className="flex items-center hover:text-green-400 transition-colors disabled:opacity-50" title="Insert Keyframe"><PlusCircle className="w-3 h-3 mr-1" /> Key</button>
                        <button onClick={handleToggleBreak} disabled={selectedKeys.size === 0} className="flex items-center hover:text-blue-400 transition-colors disabled:opacity-50" title="Link/Break Tangents"><Link className="w-3 h-3 mr-1" /> Break</button>

                        <button onClick={() => handleSetPersistence(true)} disabled={selectedKeys.size === 0} className="flex items-center hover:text-yellow-400 transition-colors disabled:opacity-50" title="Lock Keys"><Lock className="w-3 h-3 mr-1" /> Lock</button>
                        <button onClick={() => handleSetPersistence(false)} disabled={selectedKeys.size === 0} className="flex items-center hover:text-white transition-colors disabled:opacity-50" title="Unlock Keys"><Unlock className="w-3 h-3 mr-1" /> Unlock</button>
                        <div className="w-px h-3 bg-slate-700 mx-2"></div>
                        <button onClick={handleDelete} disabled={selectedKeys.size === 0} className="flex items-center hover:text-red-400 transition-colors disabled:opacity-50" title="Delete"><Trash2 className="w-3 h-3 mr-1" /> Delete</button>
                    </div>
                    <div className="flex items-center space-x-1 border-r border-slate-800 pr-3">
                        <span className="text-xs text-slate-500 mr-1">Smooth</span>
                        <input type="number" min="1" max="50" value={smoothStrength} onChange={(e) => setSmoothStrength(parseInt(e.target.value))} className="w-10 text-xs bg-slate-800 text-white border border-slate-700 rounded px-1" />
                        <button onClick={applySmoothing} disabled={!selectedId} className="text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-2 py-1 rounded flex items-center disabled:opacity-50"><GitCommit className="w-3 h-3 mr-1" /> Apply</button>
                    </div>
                    <div className="text-xs text-slate-500 flex space-x-2">
                        <button onClick={fitToView} className="flex items-center hover:text-white transition-colors" title="Fit View"><Maximize className="w-3 h-3 mr-1" /> Fit</button>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-slate-800 rounded text-slate-400"><X className="w-4 h-4" /></button>
                </div>
            </div>
            <div className="flex-1 relative cursor-crosshair overflow-hidden">
                <canvas ref={canvasRef} onWheel={handleWheel} onPointerDown={handlePointerDown} onPointerMove={handlePointerMove} onPointerUp={handlePointerUp} onPointerLeave={handlePointerUp} className="absolute inset-0 block touch-none" />
            </div>
        </div>
    );
};

export default GraphEditor;