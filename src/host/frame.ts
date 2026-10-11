// Host API, pure part: what the embedding page sends (layers, clip volumes, a
// camera pose, a background) checked and turned into the editor's own space.
// Nothing here imports the engine, so it runs under `bun test` (test/host-frame.test.ts).
//
// ONE coordinate rule. A host that works in a surveyed site frame sends
// `upAxis: 'z'`: metres, x east, y grid north, z up. The editor's world is the
// engine's: y up, right handed. The rule is a quarter turn about x:
//
//     world = (x, z, -y)        frame = (x, -z, y)
//
// so east stays +x, up becomes +y and north becomes -z. A host whose data is
// already y up sends `upAxis: 'y'` and nothing is turned. Every layer loaded
// through the host API carries this turn on its own element (see
// layerRotation); positions, targets and clip volumes are turned by the same
// functions, so a point given in the frame lands on the splat it names.

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
type UpAxis = 'y' | 'z';

// 1: import, scene-stats, export. 2: layers, camera pose, background, clip volumes, events.
const HOST_API_VERSION = 2;

const UP_AXES: readonly UpAxis[] = ['y', 'z'];

const frameToWorld = ([a, b, c]: Vec3, up: UpAxis): Vec3 => (up === 'z' ? [a, c, -b] : [a, b, c]);

const worldToFrame = ([x, y, z]: Vec3, up: UpAxis): Vec3 => (up === 'z' ? [x, -z, y] : [x, y, z]);

// the same turn as a quaternion (x, y, z, w): -90 degrees about x for a z-up frame
const frameQuat = (up: UpAxis): Quat => (up === 'z' ? [-Math.SQRT1_2, 0, 0, Math.SQRT1_2] : [0, 0, 0, 1]);

const quatMul = (a: Quat, b: Quat): Quat => [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
];

const quatRotate = (q: Quat, v: Vec3): Vec3 => {
    const [x, y, z, w] = q;
    const [vx, vy, vz] = v;
    const tx = 2 * (y * vz - z * vy);
    const ty = 2 * (z * vx - x * vz);
    const tz = 2 * (x * vy - y * vx);
    return [
        vx + w * tx + (y * tz - z * ty),
        vy + w * ty + (z * tx - x * tz),
        vz + w * tz + (x * ty - y * tx)
    ];
};

// The rotation the loader gives a PLY: half a turn about z, which stands the
// usual y-down training output upright. Its own inverse.
const PLY_LOAD_ROTATION: Quat = [0, 0, 1, 0];

// The rotation of a host layer's element. `loadRotation` is what the loader
// returned for the file (it differs by format, because each reader leaves the
// rows in its own axes); taking the PLY one out of it leaves the format's own
// correction, and the frame turn goes on top. For a PLY this is frameQuat(up).
const layerRotation = (loadRotation: Quat, up: UpAxis): Quat => {
    return quatMul(frameQuat(up), quatMul(PLY_LOAD_ROTATION, loadRotation));
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const fail = (code: string, detail?: string): never => {
    throw new Error(detail ? `${code}: ${detail}` : code);
};

const vec3 = (value: unknown, code: string): Vec3 => {
    if (!Array.isArray(value) || value.length !== 3 || !value.every(n => typeof n === 'number' && Number.isFinite(n))) {
        return fail(code, 'three finite numbers are required');
    }
    return [value[0], value[1], value[2]];
};

const upAxis = (value: unknown): UpAxis => {
    return UP_AXES.includes(value as UpAxis) ? value as UpAxis : fail('HOST_UP_AXIS_INVALID', 'upAxis must be "y" or "z"');
};

// ---- layers

const SPLAT_KIND = 'splat';

// a file the editor's loader reads as one Gaussian splat layer
const SPLAT_FILE = /\.(?:ply|sog|spz|splat|ksplat)$/i;

type LayerSpec = {
    id: string;
    name: string;
    group: string | null;
    url: string;
    filename: string;
    visible: boolean;
};

type SkippedLayer = { id: string, kind: string, reason: string };

// A host sends its manifest's rows as they are, plus a `url` for each file.
// The manifest's spellings are read beside the plain ones: `label` for the
// name, `file` for the file name, `default_visible` for the first visibility.
// Only splat layers become scene elements: every other kind is answered as
// skipped with its reason, never dropped silently.
const parseLayerSpecs = (value: unknown): { layers: LayerSpec[], skipped: SkippedLayer[] } => {
    if (!Array.isArray(value)) {
        return fail('HOST_LAYERS_INVALID', 'layers must be a list');
    }
    const layers: LayerSpec[] = [];
    const skipped: SkippedLayer[] = [];
    const seen = new Set<string>();
    value.forEach((row, index) => {
        if (!isRecord(row) || !isText(row.id)) {
            return fail('HOST_LAYER_INVALID', `layer ${index} has no id`);
        }
        const id = row.id;
        if (seen.has(id)) {
            return fail('HOST_LAYER_DUPLICATE', id);
        }
        seen.add(id);
        const filename = isText(row.filename) ? row.filename : isText(row.file) ? row.file : null;
        const kind = isText(row.kind) ? row.kind : (filename && SPLAT_FILE.test(filename) ? SPLAT_KIND : 'unknown');
        if (kind !== SPLAT_KIND) {
            skipped.push({ id, kind, reason: 'not a Gaussian splat layer: the editor shows splats only' });
            return;
        }
        if (!isText(row.url)) {
            return fail('HOST_LAYER_URL_REQUIRED', id);
        }
        if (!filename || !SPLAT_FILE.test(filename)) {
            return fail('HOST_LAYER_FILE_INVALID', `${id}: a file name ending in .ply, .sog, .spz, .splat or .ksplat is required`);
        }
        const visible = typeof row.visible === 'boolean' ? row.visible :
            typeof row.default_visible === 'boolean' ? row.default_visible : true;
        layers.push({
            id,
            name: isText(row.name) ? row.name : isText(row.label) ? row.label : id,
            group: isText(row.group) ? row.group : null,
            url: row.url,
            filename,
            visible
        });
    });
    return { layers, skipped };
};

// ---- clip volumes

type ClipVolume = {
    id: string;
    centre: Vec3;
    halfSize: Vec3;
    // degrees, counter-clockwise seen from above, about the frame's up axis
    yawDeg: number;
    // ids of the layers whose splats the volume hides
    appliesTo: string[];
};

// Oriented boxes in the host's frame. The manifest's spellings (`centre_m`,
// `half_size_m`, `yaw_deg_ccw_about_up`, `applies_to`) are read beside the plain ones.
const parseClipVolumes = (value: unknown): ClipVolume[] => {
    if (!Array.isArray(value)) {
        return fail('HOST_CLIP_VOLUMES_INVALID', 'volumes must be a list');
    }
    const seen = new Set<string>();
    return value.map((row, index) => {
        if (!isRecord(row) || !isText(row.id)) {
            return fail('HOST_CLIP_VOLUME_INVALID', `volume ${index} has no id`);
        }
        if (seen.has(row.id)) {
            return fail('HOST_CLIP_VOLUME_DUPLICATE', row.id);
        }
        seen.add(row.id);
        const halfSize = vec3(row.halfSize ?? row.half_size_m, 'HOST_CLIP_VOLUME_INVALID');
        if (halfSize.some(h => h <= 0)) {
            return fail('HOST_CLIP_VOLUME_INVALID', `${row.id}: every half size must be above zero`);
        }
        const yaw = row.yawDeg ?? row.yaw_deg_ccw_about_up ?? 0;
        if (typeof yaw !== 'number' || !Number.isFinite(yaw)) {
            return fail('HOST_CLIP_VOLUME_INVALID', `${row.id}: yaw must be a number of degrees`);
        }
        const applies = row.appliesTo ?? row.applies_to;
        if (!Array.isArray(applies) || applies.length === 0 || !applies.every(isText)) {
            return fail('HOST_CLIP_VOLUME_INVALID', `${row.id}: appliesTo must name at least one layer`);
        }
        return {
            id: row.id,
            centre: vec3(row.centre ?? row.centre_m, 'HOST_CLIP_VOLUME_INVALID'),
            halfSize,
            yawDeg: yaw,
            appliesTo: applies as string[]
        };
    });
};

// turn a frame vector about the frame's up axis, counter-clockwise seen from above
const turnAboutUp = ([a, b, c]: Vec3, degrees: number, up: UpAxis): Vec3 => {
    const t = degrees * Math.PI / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    return up === 'z' ?
        [a * cos - b * sin, a * sin + b * cos, c] :
        [a * cos + c * sin, b, -a * sin + c * cos];
};

// The matrix that carries the unit cube (side 1, centred on the origin) onto the
// volume in the editor's world: 16 numbers, column major, as the engine's Mat4
// stores them. This is the transform the editor's own box selection takes.
const clipVolumeMatrix = (volume: ClipVolume, up: UpAxis): number[] => {
    const axis = (index: number): Vec3 => {
        const v: Vec3 = [0, 0, 0];
        v[index] = 2 * volume.halfSize[index];
        return frameToWorld(turnAboutUp(v, volume.yawDeg, up), up);
    };
    const [x, y, z] = [axis(0), axis(1), axis(2)];
    const t = frameToWorld(volume.centre, up);
    return [
        x[0], x[1], x[2], 0,
        y[0], y[1], y[2], 0,
        z[0], z[1], z[2], 0,
        t[0], t[1], t[2], 1
    ];
};

// whether a point of the frame is inside the volume (the box's faces included)
const pointInVolume = (point: Vec3, volume: ClipVolume, up: UpAxis): boolean => {
    const local = turnAboutUp([
        point[0] - volume.centre[0],
        point[1] - volume.centre[1],
        point[2] - volume.centre[2]
    ], -volume.yawDeg, up);
    return local.every((v, i) => Math.abs(v) <= volume.halfSize[i]);
};

// ---- camera

type PoseSpace = 'frame' | 'world';

type PoseSpec = { position: Vec3, target: Vec3, fov: number | null, space: PoseSpace };

// A camera position and the point it looks at, in the host's frame unless
// `space: 'world'`. The manifest's `viewpoint` block is sent as it is.
const parsePose = (value: unknown): PoseSpec => {
    if (!isRecord(value)) {
        return fail('HOST_POSE_INVALID', 'a pose with position and target is required');
    }
    const position = vec3(value.position, 'HOST_POSE_INVALID');
    const target = vec3(value.target, 'HOST_POSE_INVALID');
    if (position.every((v, i) => v === target[i])) {
        return fail('HOST_POSE_INVALID', 'position and target are the same point');
    }
    const space = value.space === undefined ? 'frame' : value.space;
    if (space !== 'frame' && space !== 'world') {
        return fail('HOST_POSE_INVALID', 'space must be "frame" or "world"');
    }
    const fov = value.fov === undefined || value.fov === null ? null : value.fov;
    if (fov !== null && (typeof fov !== 'number' || !(fov > 0 && fov < 180))) {
        return fail('HOST_POSE_INVALID', 'fov must be between 0 and 180 degrees');
    }
    return { position, target, fov: fov as number | null, space };
};

const poseToWorld = (pose: PoseSpec, up: UpAxis): { position: Vec3, target: Vec3 } => {
    return pose.space === 'world' ?
        { position: pose.position, target: pose.target } :
        { position: frameToWorld(pose.position, up), target: frameToWorld(pose.target, up) };
};

// ---- background

type BackgroundSpec = { kind: 'none' } | { kind: 'gradient' } | { kind: 'panorama', url: string };

const BACKGROUND_KINDS = ['none', 'panorama', 'gradient'] as const;

const parseBackground = (value: unknown): BackgroundSpec => {
    if (!isRecord(value) || !BACKGROUND_KINDS.includes(value.kind as any)) {
        return fail('HOST_BACKGROUND_INVALID', `kind must be one of ${BACKGROUND_KINDS.join(', ')}`);
    }
    if (value.kind === 'panorama') {
        return isText(value.url) ? { kind: 'panorama', url: value.url } : fail('HOST_BACKGROUND_URL_REQUIRED');
    }
    return { kind: value.kind as 'none' | 'gradient' };
};

// Where a world direction falls on an equirectangular picture: u across from
// the left edge, v down from the top row. The picture's convention is the
// world's: x east, y up, z south; the column is the longitude atan2(z, x) and
// the top row is straight up. Kept in step with the shader in backdrop.ts.
const equirectUv = ([x, y, z]: Vec3): [number, number] => {
    const length = Math.hypot(x, y, z);
    const u = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
    const v = Math.acos(Math.max(-1, Math.min(1, y / length))) / Math.PI;
    return [u, v];
};

// The drawn sky, as colour stops down the picture (v from 0 at the zenith to 1
// at the nadir): blue overhead, pale at the horizon, ground below it.
const GRADIENT_STOPS: readonly { v: number, rgb: Vec3 }[] = [
    { v: 0, rgb: [0x5f / 255, 0x97 / 255, 0xd6 / 255] },
    { v: 0.5, rgb: [0xb9 / 255, 0xd4 / 255, 0xee / 255] },
    { v: 0.52, rgb: [0x8f / 255, 0x96 / 255, 0x89 / 255] },
    { v: 1, rgb: [0x5d / 255, 0x62 / 255, 0x58 / 255] }
];

const gradientColor = (v: number): Vec3 => {
    const t = Math.max(0, Math.min(1, v));
    for (let i = 1; i < GRADIENT_STOPS.length; ++i) {
        const a = GRADIENT_STOPS[i - 1];
        const b = GRADIENT_STOPS[i];
        if (t <= b.v) {
            const k = (t - a.v) / (b.v - a.v);
            return [0, 1, 2].map(c => a.rgb[c] + (b.rgb[c] - a.rgb[c]) * k) as Vec3;
        }
    }
    return GRADIENT_STOPS[GRADIENT_STOPS.length - 1].rgb;
};

export {
    HOST_API_VERSION,
    GRADIENT_STOPS,
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
    worldToFrame
};

export type { BackgroundSpec, ClipVolume, LayerSpec, PoseSpace, PoseSpec, Quat, SkippedLayer, UpAxis, Vec3 };
