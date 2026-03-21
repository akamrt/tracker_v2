
import { ImageAttachment, KeyframeConfig, TrackingPoint, MaskObject } from '../types';

// Solves B_x(t) = targetX for t using Newton-Raphson
// P0=0, P3=1. P1, P2 are X-coordinates of control points
export const solveBezierT = (xTarget: number, x1: number, x2: number): number => {
    let t = xTarget;
    // Newton iterations
    for (let i = 0; i < 5; i++) {
        // x(t) = (1-t)^3*0 + 3(1-t)^2*t*x1 + 3(1-t)*t^2*x2 + t^3*1
        const invT = 1 - t;
        const xEst = 3 * invT * invT * t * x1 + 3 * invT * t * t * x2 + t * t * t;
        if (Math.abs(xEst - xTarget) < 0.001) return t;

        // Derivative dx/dt
        // x'(t) = 3(1-t)^2*x1 + 6(1-t)*t*(x2-x1) + 3t^2(1-x2) -- Simplified
        // Let's use generic derivative formula for cubic bezier
        // A = 1 - 3*x2 + 3*x1
        // B = 3*x2 - 6*x1
        // C = 3*x1
        // x(t) = At^3 + Bt^2 + Ct
        // x'(t) = 3At^2 + 2Bt + C
        const A = 1 - 3 * x2 + 3 * x1;
        const B = 3 * x2 - 6 * x1;
        const C = 3 * x1;
        const slope = 3 * A * t * t + 2 * B * t + C;
        if (Math.abs(slope) < 0.0001) break;
        t -= (xEst - xTarget) / slope;
    }
    return Math.max(0, Math.min(1, t));
};

export const bezierInterp = (
    v0: number, v1: number,
    t0: number, t1: number,
    currentT: number,
    config0?: KeyframeConfig, config1?: KeyframeConfig,
    prop?: string
): number => {
    const dt = t1 - t0;
    if (dt <= 0) return v1;
    const progress = (currentT - t0) / dt;

    // Default Linear Tangents if missing
    // Linear out: x = dt/3, y = dv/3?
    // Actually linear means handle aligns with line P0-P3.
    // Normalized handle X is usually 1/3?

    // Config0 Out
    let p1x = 1 / 3;
    let p1y = (v1 - v0) / 3;

    // Config1 In
    let p2x = 2 / 3; // Normalized (1 - 1/3) -> relative to P0? 
    // Normalized X domain is 0..1. 
    // P1x is abs coord in norm space. P2x is abs coord in norm space.
    let p2y = v1 - (v1 - v0) / 3; // v0 + 2/3 dv

    // Retrieve custom tangents if available
    // Note: Tangents in config are {x, y} relative to the Key.
    // x is in 'frames', y is in 'value'.
    // We normalize them.

    if (config0 && config0.outTangent) {
        p1x = config0.outTangent.x / dt;
        p1y = config0.outTangent.y; // Keep absolute Y offset
    } else {
        // Default Linear (implicit)?
        // Actually, if we want default linear, we use the linear slope
        p1y = (v1 - v0) * p1x; // y = slope * x_norm * dt ? no.
        // dy/dx = (v1-v0)/dt. 
        // dy_handle = slope * dx_handle. dx_handle = p1x * dt.
        // So p1y = (v1-v0)/dt * p1x * dt = (v1-v0)*p1x
    }

    if (config1 && config1.inTangent) {
        // inTangent x is usually negative relative to P3.
        // P2x_norm = (dt + inTangent.x) / dt = 1 + inTangent.x/dt
        p2x = 1 + config1.inTangent.x / dt;
        p2y = v1 + config1.inTangent.y; // Absolute Y relative to v1?
        // Wait, p2y is absolute value coordinate for Bezier calculation?
        // Standard Bezier formula uses P0, P1, P2, P3 as absolute control points.
        // So P1_y = v0 + outTangent.y
        // P2_y = v1 + inTangent.y
    } else {
        // Default Linear
        const p2x_rel = - (1 / 3); // Relative x (-1/3)
        // p2y = v1 + slope * (dx) = v1 + (v1-v0)/dt * (-1/3 * dt) = v1 - (v1-v0)/3
        p2x = 2 / 3;
        p2y = v0 + (v1 - v0) * (2 / 3);
    }

    // Recalculate P1y absolute
    // Note: My logic above for p1y was mixing absolute/relative
    // Let's refine.
    // P0 = v0. 
    // P1 = v0 + outTangentY. (If config provided).
    // If not provided, P1 = v0 + (v1-v0)/3.

    let P1y = v0 + (v1 - v0) * (1 / 3);
    if (config0 && config0.outTangent) P1y = v0 + config0.outTangent.y;

    let P2y = v0 + (v1 - v0) * (2 / 3);
    if (config1 && config1.inTangent) P2y = v1 + config1.inTangent.y;

    // Solve t param
    const tParam = solveBezierT(progress, p1x, p2x);

    // Calc Y
    // B_y(t) = (1-t)^3*v0 + 3(1-t)^2*t*P1y + 3(1-t)*t^2*P2y + t^3*v1
    const invT = 1 - tParam;
    return (invT * invT * invT * v0) +
        (3 * invT * invT * tParam * P1y) +
        (3 * invT * tParam * tParam * P2y) +
        (tParam * tParam * tParam * v1);
};


export const getInterpolatedImages = (
    currentTime: number,
    imageCache: Map<number, ImageAttachment[]>,
    fps: number,
    currentImages: ImageAttachment[]
): ImageAttachment[] => {
    // OPTIMIZATION: Early exit if no data to interpolate
    if (currentImages.length === 0 && imageCache.size === 0) {
        return [];
    }

    // OPTIMIZATION: If no cache, just return current images (no interpolation needed)
    if (imageCache.size === 0) {
        return currentImages;
    }

    const allImageIds = new Set<string>();
    for (const imgs of imageCache.values()) {
        imgs.forEach(img => allImageIds.add(img.id));
    }
    currentImages.forEach(img => allImageIds.add(img.id));

    const result: ImageAttachment[] = [];
    const currentFrame = currentTime * fps; // Floating point frame

    allImageIds.forEach(id => {
        // Collect all keyframes for this ID
        const keyframes: { frame: number; data: ImageAttachment }[] = [];
        for (const [key, imgs] of imageCache.entries()) {
            const img = imgs.find(i => i.id === id);
            if (img) keyframes.push({ frame: key, data: img });
        }
        keyframes.sort((a, b) => a.frame - b.frame);

        if (keyframes.length === 0) {
            const curr = currentImages.find(i => i.id === id);
            if (curr) result.push(curr);
            return;
        }

        // We need 'prev' and 'next' per property
        const props = ['x', 'y', 'width', 'height', 'rotation', 'opacity'];
        const interpolatedValues: any = {};

        // Find active parent (Step interpolation logic for parentId)
        // We scan backward to find the last defined parent state
        let activeKey = keyframes[0];
        for (let i = keyframes.length - 1; i >= 0; i--) {
            if (keyframes[i].frame <= currentFrame) {
                activeKey = keyframes[i];
                break;
            }
        }
        // If we are before the first keyframe, use the first keyframe?
        // Or simpler: activeKey is correct unless currentFrame < keyframes[0].frame

        props.forEach(prop => {
            // Find Prev: frame <= currentFrame AND keyed
            let prev: { frame: number, data: ImageAttachment } | null = null;
            let next: { frame: number, data: ImageAttachment } | null = null;

            // Search backward
            for (let i = keyframes.length - 1; i >= 0; i--) {
                const k = keyframes[i];
                if (k.frame <= currentFrame) {
                    const isKeyed = !k.data.keyedProperties || k.data.keyedProperties.includes(prop);
                    if (isKeyed) { prev = k; break; }
                }
            }

            // Search forward
            for (let i = 0; i < keyframes.length; i++) {
                const k = keyframes[i];
                if (k.frame > currentFrame) {
                    const isKeyed = !k.data.keyedProperties || k.data.keyedProperties.includes(prop);
                    if (isKeyed) { next = k; break; }
                }
            }

            // Check for Parent Switch Barrier
            // If interpolating between two keys with DIFFERENT parents, we MUST NOT interpolate.
            // We should hold the value of 'prev' (Step interpolation).
            let parentSwitch = false;
            if (prev && next && prev.data.parentId !== next.data.parentId) {
                parentSwitch = true;
            }

            // If only prev (hold)
            if (prev && !next) {
                interpolatedValues[prop] = (prev.data as any)[prop];
            }
            // If only next (hold - theoretically shouldn't happen for past if we have prev, but for start of timeline)
            else if (!prev && next) {
                interpolatedValues[prop] = (next.data as any)[prop];
            }
            // Interpolate
            else if (prev && next) {
                if (parentSwitch) {
                    // Force Step
                    interpolatedValues[prop] = (prev.data as any)[prop];
                } else {
                    const pCfg = prev.data.keyframeConfig || {};
                    const nCfg = next.data.keyframeConfig || {};
                    const pVal = (prev.data as any)[prop];
                    const nVal = (next.data as any)[prop];
                    interpolatedValues[prop] = bezierInterp(pVal, nVal, prev.frame, next.frame, currentFrame, pCfg[prop], nCfg[prop], prop);
                }
            }
            // Fallback to base (shouldn't happen if keyframes exist)
            else {
                interpolatedValues[prop] = (activeKey.data as any)[prop];
            }
        });

        const interpolated: ImageAttachment = {
            ...activeKey.data, // Inherit static props AND parentId from active key (Step behavior)
            ...interpolatedValues,
            isManual: false
        };

        result.push(interpolated);
    });

    return result;
};

export const getInterpolatedTrackers = (
    currentTime: number,
    trackingCache: Map<number, TrackingPoint[]>,
    fps: number,
    currentTrackers: TrackingPoint[]
): TrackingPoint[] => {
    // OPTIMIZATION: Early exit if no data to interpolate
    if (currentTrackers.length === 0 && trackingCache.size === 0) {
        return [];
    }

    // OPTIMIZATION: If no cache, just return current trackers (no interpolation needed)
    if (trackingCache.size === 0) {
        return currentTrackers;
    }

    const allIds = new Set<string>();
    for (const ts of trackingCache.values()) {
        ts.forEach(t => allIds.add(t.id));
    }
    currentTrackers.forEach(t => allIds.add(t.id));

    const result: TrackingPoint[] = [];
    const currentFrame = currentTime * fps;

    allIds.forEach(id => {
        const keyframes: { frame: number; data: TrackingPoint }[] = [];
        for (const [key, ts] of trackingCache.entries()) {
            const t = ts.find(k => k.id === id);
            if (t) keyframes.push({ frame: key, data: t });
        }
        keyframes.sort((a, b) => a.frame - b.frame);

        if (keyframes.length === 0) {
            const curr = currentTrackers.find(t => t.id === id);
            if (curr) result.push(curr);
            return;
        }

        const props = ['x', 'y', 'rotation'];
        const interpolatedValues: any = {};

        // Find closest full keyframe for base properties
        let baseKey = keyframes[0];
        let minDist = Math.abs(currentFrame - baseKey.frame);
        for (const k of keyframes) {
            const d = Math.abs(currentFrame - k.frame);
            if (d < minDist) { minDist = d; baseKey = k; }
        }

        props.forEach(prop => {
            // Check if rotation is actually used/enabled? 
            if (prop === 'rotation' && baseKey.data.rotation === undefined) return;

            // Find Prev/Next respecting keyedProperties
            let prev: { frame: number, data: TrackingPoint } | null = null;
            let next: { frame: number, data: TrackingPoint } | null = null;

            for (let i = keyframes.length - 1; i >= 0; i--) {
                const k = keyframes[i];
                if (k.frame <= currentFrame) {
                    const isKeyed = !k.data.keyedProperties || k.data.keyedProperties.includes(prop);
                    if (isKeyed) { prev = k; break; }
                }
            }
            for (let i = 0; i < keyframes.length; i++) {
                const k = keyframes[i];
                if (k.frame > currentFrame) {
                    const isKeyed = !k.data.keyedProperties || k.data.keyedProperties.includes(prop);
                    if (isKeyed) { next = k; break; }
                }
            }

            if (prev && !next) interpolatedValues[prop] = (prev.data as any)[prop];
            else if (!prev && next) interpolatedValues[prop] = (next.data as any)[prop];
            else if (prev && next) {
                const pCfg = prev.data.keyframeConfig || {};
                const nCfg = next.data.keyframeConfig || {};
                const pVal = (prev.data as any)[prop] || 0;
                const nVal = (next.data as any)[prop] || 0;
                interpolatedValues[prop] = bezierInterp(pVal, nVal, prev.frame, next.frame, currentFrame, pCfg[prop], nCfg[prop], prop);
            } else {
                interpolatedValues[prop] = (baseKey.data as any)[prop];
            }
        });

        const interpolated: TrackingPoint = {
            ...baseKey.data,
            ...interpolatedValues,
            isManual: false // It's an interpolated/calculated point now
        };
        result.push(interpolated);
    });
    return result;
};


export const getInterpolatedMasks = (
    currentTime: number,
    maskCache: Map<number, MaskObject[]>,
    fps: number,
    currentMasks: MaskObject[]
): MaskObject[] => {
    // OPTIMIZATION: Early exit if no data to interpolate
    if (currentMasks.length === 0 && maskCache.size === 0) {
        return [];
    }

    // OPTIMIZATION: If no cache, just return current masks (no interpolation needed)
    if (maskCache.size === 0) {
        return currentMasks;
    }

    const allIds = new Set<string>();
    for (const ms of maskCache.values()) {
        ms.forEach(m => allIds.add(m.id));
    }
    currentMasks.forEach(m => allIds.add(m.id));

    const result: MaskObject[] = [];
    const currentFrame = currentTime * fps;

    allIds.forEach(id => {
        const keyframes: { frame: number; data: MaskObject }[] = [];
        for (const [key, ms] of maskCache.entries()) {
            const m = ms.find(k => k.id === id);
            if (m) keyframes.push({ frame: key, data: m });
        }
        keyframes.sort((a, b) => a.frame - b.frame);

        if (keyframes.length === 0) {
            const curr = currentMasks.find(m => m.id === id);
            if (curr) result.push(curr);
            return;
        }

        const props = ['x', 'y', 'width', 'height'];
        const interpolatedValues: any = {};

        // Find base key
        let baseKey = keyframes[0];
        let minDist = Math.abs(currentFrame - baseKey.frame);
        for (const k of keyframes) {
            const d = Math.abs(currentFrame - k.frame);
            if (d < minDist) { minDist = d; baseKey = k; }
        }

        props.forEach(prop => {
            let prev: { frame: number, data: MaskObject } | null = null;
            let next: { frame: number, data: MaskObject } | null = null;

            for (let i = keyframes.length - 1; i >= 0; i--) {
                const k = keyframes[i];
                if (k.frame <= currentFrame) {
                    const isKeyed = !k.data.keyedProperties || k.data.keyedProperties.includes(prop);
                    if (isKeyed) { prev = k; break; }
                }
            }
            for (let i = 0; i < keyframes.length; i++) {
                const k = keyframes[i];
                if (k.frame > currentFrame) {
                    const isKeyed = !k.data.keyedProperties || k.data.keyedProperties.includes(prop);
                    if (isKeyed) { next = k; break; }
                }
            }

            if (prev && !next) interpolatedValues[prop] = (prev.data as any)[prop];
            else if (!prev && next) interpolatedValues[prop] = (next.data as any)[prop];
            else if (prev && next) {
                const pCfg = prev.data.keyframeConfig || {};
                const nCfg = next.data.keyframeConfig || {};
                const pVal = (prev.data as any)[prop];
                const nVal = (next.data as any)[prop];
                interpolatedValues[prop] = bezierInterp(pVal, nVal, prev.frame, next.frame, currentFrame, pCfg[prop], nCfg[prop], prop);
            } else {
                interpolatedValues[prop] = (baseKey.data as any)[prop];
            }
        });

        const interpolated: MaskObject = {
            ...baseKey.data,
            ...interpolatedValues,
            isManual: false
        };
        result.push(interpolated);
    });
    return result;
};
