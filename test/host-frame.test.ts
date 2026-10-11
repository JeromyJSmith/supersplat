// The host API's pure part (src/host/frame.ts): run with `bun test`.
import { describe, expect, test } from 'bun:test';

import {
    GRADIENT_STOPS,
    HOST_API_VERSION,
    PLY_LOAD_ROTATION,
    clipVolumeMatrix,
    equirectUv,
    frameQuat,
    frameToWorld,
    gradientColor,
    layerRotation,
    parseBackground,
    parseClipVolumes,
    parseLayerSpecs,
    parsePose,
    pointInVolume,
    poseToWorld,
    quatMul,
    quatRotate,
    turnAboutUp,
    upAxis,
    worldToFrame,
    type ClipVolume,
    type Quat,
    type Vec3
} from '../src/host/frame';

const close = (a: readonly number[], b: readonly number[], digits = 9) => {
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], digits));
};

// column-major 4x4 times a point
const apply = (m: number[], [x, y, z]: Vec3): Vec3 => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
];

describe('the frame rule', () => {
    test('the version the ready message carries', () => {
        expect(HOST_API_VERSION).toBe(2);
    });

    test('a z-up site frame: east stays x, up becomes y, north becomes -z', () => {
        // 3 m east, 4 m north, 5 m up
        expect(frameToWorld([3, 4, 5], 'z')).toEqual([3, 5, -4]);
        expect(frameToWorld([1, 0, 0], 'z')).toEqual([1, 0, -0]);
        expect(frameToWorld([0, 0, 1], 'z')).toEqual([0, 1, -0]);
        expect(frameToWorld([0, 1, 0], 'z')).toEqual([0, 0, -1]);
    });

    test('a y-up frame is the world', () => {
        expect(frameToWorld([3, 4, 5], 'y')).toEqual([3, 4, 5]);
        expect(worldToFrame([3, 4, 5], 'y')).toEqual([3, 4, 5]);
    });

    test('there and back', () => {
        const point: Vec3 = [-12.5, 7.25, 3.125];
        expect(worldToFrame(frameToWorld(point, 'z'), 'z')).toEqual(point);
        expect(frameToWorld(worldToFrame(point, 'z'), 'z')).toEqual(point);
    });

    test('the quaternion is the same turn as the function', () => {
        const point: Vec3 = [3, 4, 5];
        close(quatRotate(frameQuat('z'), point), frameToWorld(point, 'z'));
        close(quatRotate(frameQuat('y'), point), point);
        // a unit quaternion
        close([Math.hypot(...frameQuat('z'))], [1]);
    });

    test('a PLY layer is turned by the frame rule alone', () => {
        // the loader's half turn about z is taken out again: a row (3, 4, 5) of the
        // file is the frame point (3, 4, 5) and lands on the world point (3, 5, -4)
        const rotation = layerRotation(PLY_LOAD_ROTATION, 'z');
        close(quatRotate(rotation, [3, 4, 5]), [3, 5, -4]);
        close(quatRotate(layerRotation(PLY_LOAD_ROTATION, 'y'), [3, 4, 5]), [3, 4, 5]);
    });

    test('another format keeps its own correction under the frame turn', () => {
        // a reader that leaves rows a quarter turn about y away from a PLY's rows
        const quarterY: Quat = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
        const load = quatMul(PLY_LOAD_ROTATION, quarterY);
        const expected = frameToWorld(quatRotate(quarterY, [1, 2, 3]), 'z');
        close(quatRotate(layerRotation(load, 'z'), [1, 2, 3]), expected);
    });

    test('upAxis takes y or z and nothing else', () => {
        expect(upAxis('z')).toBe('z');
        expect(upAxis('y')).toBe('y');
        expect(() => upAxis('x')).toThrow('HOST_UP_AXIS_INVALID');
        expect(() => upAxis(undefined)).toThrow('HOST_UP_AXIS_INVALID');
    });
});

describe('layers', () => {
    test('manifest rows: splats become layers, the rest are skipped with a reason', () => {
        const { layers, skipped } = parseLayerSpecs([
            { id: 'near', label: 'Near', file: 'near.ply', default_visible: true, group: 'Picture', kind: 'splat', url: 'http://h/near.ply' },
            { id: 'far', label: 'Far', file: 'far.sog', default_visible: false, kind: 'splat', url: 'http://h/far.sog' },
            { id: 'scan', label: 'Scan', file: 'scan.bin', kind: 'points', url: 'http://h/scan.bin' },
            { id: 'ground', file: 'ground.glb', kind: 'collision' },
            { id: 'sky', file: null, kind: 'drawn' }
        ]);
        expect(layers).toEqual([
            { id: 'near', name: 'Near', group: 'Picture', url: 'http://h/near.ply', filename: 'near.ply', visible: true },
            { id: 'far', name: 'Far', group: null, url: 'http://h/far.sog', filename: 'far.sog', visible: false }
        ]);
        expect(skipped.map(s => [s.id, s.kind])).toEqual([['scan', 'points'], ['ground', 'collision'], ['sky', 'drawn']]);
    });

    test('a row without a kind is a splat only by its file name', () => {
        const { layers, skipped } = parseLayerSpecs([
            { id: 'a', filename: 'a.spz', url: 'u' },
            { id: 'b', filename: 'b.jpg', url: 'u' }
        ]);
        expect(layers.map(l => [l.id, l.name, l.visible])).toEqual([['a', 'a', true]]);
        expect(skipped).toEqual([{ id: 'b', kind: 'unknown', reason: 'not a Gaussian splat layer: the editor shows splats only' }]);
    });

    test('what is refused', () => {
        expect(() => parseLayerSpecs({})).toThrow('HOST_LAYERS_INVALID');
        expect(() => parseLayerSpecs([{ name: 'x' }])).toThrow('HOST_LAYER_INVALID');
        expect(() => parseLayerSpecs([{ id: 'a', kind: 'splat', file: 'a.ply' }])).toThrow('HOST_LAYER_URL_REQUIRED');
        expect(() => parseLayerSpecs([{ id: 'a', kind: 'splat', file: 'a.txt', url: 'u' }])).toThrow('HOST_LAYER_FILE_INVALID');
        const twice = [{ id: 'a', file: 'a.ply', url: 'u' }, { id: 'a', file: 'b.ply', url: 'v' }];
        expect(() => parseLayerSpecs(twice)).toThrow('HOST_LAYER_DUPLICATE');
    });
});

describe('clip volumes', () => {
    // a room 4 m by 10 m by 2 m, centred 1 m up, turned 30 degrees counter-clockwise
    const room: ClipVolume = { id: 'room', centre: [10, 20, 1], halfSize: [2, 5, 1], yawDeg: 30, appliesTo: ['near'] };

    test('the manifest spelling and the plain one read the same', () => {
        const manifest = parseClipVolumes([{
            id: 'room',
            centre_m: [10, 20, 1],
            half_size_m: [2, 5, 1],
            yaw_deg_ccw_about_up: 30,
            applies_to: ['near'],
            effect: 'hides splats whose centre is inside'
        }]);
        expect(manifest).toEqual([room]);
        expect(parseClipVolumes([{ id: 'room', centre: [10, 20, 1], halfSize: [2, 5, 1], yawDeg: 30, appliesTo: ['near'] }])).toEqual([room]);
        expect(parseClipVolumes([])).toEqual([]);
    });

    test('what is refused', () => {
        const base = { id: 'v', centre: [0, 0, 0], halfSize: [1, 1, 1], appliesTo: ['a'] };
        expect(() => parseClipVolumes(null)).toThrow('HOST_CLIP_VOLUMES_INVALID');
        expect(() => parseClipVolumes([{ ...base, halfSize: [1, 0, 1] }])).toThrow('HOST_CLIP_VOLUME_INVALID');
        expect(() => parseClipVolumes([{ ...base, centre: [0, 0] }])).toThrow('HOST_CLIP_VOLUME_INVALID');
        expect(() => parseClipVolumes([{ ...base, appliesTo: [] }])).toThrow('HOST_CLIP_VOLUME_INVALID');
        expect(() => parseClipVolumes([{ ...base, yawDeg: 'north' }])).toThrow('HOST_CLIP_VOLUME_INVALID');
        expect(() => parseClipVolumes([base, base])).toThrow('HOST_CLIP_VOLUME_DUPLICATE');
    });

    test('counter-clockwise seen from above', () => {
        // east turned a quarter turn is north
        close(turnAboutUp([1, 0, 0], 90, 'z'), [0, 1, 0]);
        // in a y-up frame "north" is -z
        close(turnAboutUp([1, 0, 0], 90, 'y'), [0, 0, -1]);
    });

    test('the matrix carries the unit cube onto the box in the world', () => {
        const m = clipVolumeMatrix(room, 'z');
        // the cube's centre is the box's centre
        close(apply(m, [0, 0, 0]), frameToWorld([10, 20, 1], 'z'));
        // the +x face centre: 2 m along the box's own x, which is east turned 30 degrees
        const c = Math.cos(Math.PI / 6);
        const s = Math.sin(Math.PI / 6);
        close(apply(m, [0.5, 0, 0]), frameToWorld([10 + 2 * c, 20 + 2 * s, 1], 'z'));
        // the +y face centre: 5 m along the box's own y
        close(apply(m, [0, 0.5, 0]), frameToWorld([10 - 5 * s, 20 + 5 * c, 1], 'z'));
        // the top face centre: 1 m up
        close(apply(m, [0, 0, 0.5]), frameToWorld([10, 20, 2], 'z'));
    });

    test('the matrix and the point test agree on a grid of points', () => {
        const m = clipVolumeMatrix(room, 'z');
        // invert by sampling: a point is inside when its cube coordinates are within a half
        const basis = [apply(m, [1, 0, 0]), apply(m, [0, 1, 0]), apply(m, [0, 0, 1])];
        const origin = apply(m, [0, 0, 0]);
        const axes = basis.map(b => b.map((v, i) => v - origin[i]));
        const cube = (world: Vec3) => axes.map((axis) => {
            const d = world.map((v, i) => v - origin[i]);
            return (d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2]) / (axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2);
        });
        let inside = 0;
        let total = 0;
        for (let x = 4; x <= 16; x += 0.5) {
            for (let y = 13; y <= 27; y += 0.5) {
                for (const z of [-0.5, 0.5, 1.5, 2.5]) {
                    const point: Vec3 = [x, y, z];
                    const byMatrix = cube(frameToWorld(point, 'z')).every(v => Math.abs(v) <= 0.5);
                    expect(pointInVolume(point, room, 'z')).toBe(byMatrix);
                    total++;
                    if (byMatrix) inside++;
                }
            }
        }
        // the box's plan is 40 m2 of the 168 m2 sampled, on two of the four heights
        expect(total).toBe(25 * 29 * 4);
        expect(inside).toBeGreaterThan(280);
        expect(inside).toBeLessThan(360);
    });

    test('known points of a turned box', () => {
        // on the box's long axis, 4.9 m from the centre: inside. The same distance east: outside.
        const c = Math.cos(Math.PI / 6);
        const s = Math.sin(Math.PI / 6);
        expect(pointInVolume([10 - 4.9 * s, 20 + 4.9 * c, 1], room, 'z')).toBe(true);
        expect(pointInVolume([10 + 4.9, 20, 1], room, 'z')).toBe(false);
        expect(pointInVolume([10, 20, 2.01], room, 'z')).toBe(false);
        expect(pointInVolume([10, 20, 2], room, 'z')).toBe(true);
    });
});

describe('camera pose', () => {
    test('a manifest viewpoint is read in the frame', () => {
        const pose = parsePose({ position: [0, -10, 2], target: [0, 0, 1] });
        expect(pose).toEqual({ position: [0, -10, 2], target: [0, 0, 1], fov: null, space: 'frame' });
        // 10 m south of the origin, 2 m up, looking north
        expect(poseToWorld(pose, 'z')).toEqual({ position: [0, 2, 10], target: [0, 1, -0] });
    });

    test('a world pose is not turned', () => {
        const pose = parsePose({ position: [1, 2, 3], target: [0, 0, 0], space: 'world', fov: 60 });
        expect(pose.fov).toBe(60);
        expect(poseToWorld(pose, 'z')).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
    });

    test('what is refused', () => {
        expect(() => parsePose(null)).toThrow('HOST_POSE_INVALID');
        expect(() => parsePose({ position: [0, 0, 0], target: [0, 0, 0] })).toThrow('HOST_POSE_INVALID');
        expect(() => parsePose({ position: [0, 0, 1], target: [0, 0] })).toThrow('HOST_POSE_INVALID');
        expect(() => parsePose({ position: [0, 0, 1], target: [0, 0, 0], space: 'site' })).toThrow('HOST_POSE_INVALID');
        expect(() => parsePose({ position: [0, 0, 1], target: [0, 0, 0], fov: 180 })).toThrow('HOST_POSE_INVALID');
        expect(() => parsePose({ position: [0, 0, Number.NaN], target: [0, 0, 0] })).toThrow('HOST_POSE_INVALID');
    });
});

describe('background', () => {
    test('the three kinds', () => {
        expect(parseBackground({ kind: 'none' })).toEqual({ kind: 'none' });
        expect(parseBackground({ kind: 'gradient', url: 'ignored' })).toEqual({ kind: 'gradient' });
        expect(parseBackground({ kind: 'panorama', url: 'http://h/sky.jpg' })).toEqual({ kind: 'panorama', url: 'http://h/sky.jpg' });
        expect(() => parseBackground({ kind: 'panorama' })).toThrow('HOST_BACKGROUND_URL_REQUIRED');
        expect(() => parseBackground({ kind: 'cube' })).toThrow('HOST_BACKGROUND_INVALID');
    });

    test('where a direction falls on the picture', () => {
        // straight up is the top row, straight down the bottom row, the horizon the middle row
        expect(equirectUv([0, 1, 0])[1]).toBe(0);
        expect(equirectUv([0, -1, 0])[1]).toBe(1);
        close([equirectUv([1, 0, 0])[1]], [0.5]);
        // east is the middle column; south (+z) a quarter of the width to its right; north to its left
        close(equirectUv([1, 0, 0]), [0.5, 0.5]);
        close(equirectUv([0, 0, 1]), [0.75, 0.5]);
        close(equirectUv([0, 0, -1]), [0.25, 0.5]);
        // length does not matter
        close(equirectUv([0, 0, -40]), [0.25, 0.5]);
        // north in the frame is the world's -z: the column a north-facing camera sees
        close(equirectUv(frameToWorld([0, 1, 0], 'z')), [0.25, 0.5]);
    });

    test('the drawn sky: blue overhead, pale at the horizon, ground below', () => {
        close(gradientColor(0), GRADIENT_STOPS[0].rgb);
        close(gradientColor(1), GRADIENT_STOPS[3].rgb);
        close(gradientColor(0.5), GRADIENT_STOPS[1].rgb);
        // half way up the sky is the mean of the zenith and the horizon colours
        close(gradientColor(0.25), GRADIENT_STOPS[0].rgb.map((v, i) => (v + GRADIENT_STOPS[1].rgb[i]) / 2));
        // more blue than red overhead, and out of range is clamped
        expect(gradientColor(0)[2]).toBeGreaterThan(gradientColor(0)[0]);
        close(gradientColor(-3), gradientColor(0));
        close(gradientColor(7), gradientColor(1));
    });
});
