import { Events } from './events';
import type { SceneExportOptions } from './export-options';
import { HOST_API_VERSION } from './host/frame';
import { HostLayers, watchSceneState, type HostEvent } from './host/layers';
import type { Scene } from './scene';
import type { Splat } from './splat';

const IS_SCENE_DIRTY = 'supersplat:is-scene-dirty';
const NAVIGATE_HOME = 'supersplat:navigate-home';

// Host API: lets the page that embeds the editor load a file, read what is in
// the scene and take an export, without reaching into the editor's globals.
// Documented in README.md ("Embedding the editor in an iframe").
const READY = 'supersplat:ready';
const IMPORT = 'supersplat:import';
const SCENE_STATS = 'supersplat:scene-stats';
const EXPORT = 'supersplat:export';

// Host API version 2: the host's layers as scene elements, the camera, the
// background and clip volumes (src/host/), and what the editor reports without
// being asked.
const HOST_INFO = 'supersplat:host-info';
const LOAD_LAYERS = 'supersplat:load-layers';
const SET_LAYER_VISIBLE = 'supersplat:set-layer-visible';
const LIST_LAYERS = 'supersplat:list-layers';
const FRAME_LAYER = 'supersplat:frame-layer';
const SET_CAMERA_POSE = 'supersplat:set-camera-pose';
const GET_CAMERA_POSE = 'supersplat:get-camera-pose';
const SET_BACKGROUND = 'supersplat:set-background';
const APPLY_CLIP_VOLUMES = 'supersplat:apply-clip-volumes';
const SHOW_EXPORT = 'supersplat:show-export';
const EVENT = 'supersplat:event';

// the editor's own export dialogs (File > Export), with every option they carry
const EXPORT_DIALOGS = ['ply', 'splat', 'sog', 'spz', 'viewer'];

const LAYER_REQUESTS = [
    LOAD_LAYERS, SET_LAYER_VISIBLE, LIST_LAYERS, FRAME_LAYER, SET_CAMERA_POSE, GET_CAMERA_POSE, SET_BACKGROUND,
    APPLY_CLIP_VOLUMES
];
const HOST_REQUESTS = [SCENE_STATS, IMPORT, EXPORT, HOST_INFO, SHOW_EXPORT, ...LAYER_REQUESTS];

// set once the scene exists (registerHostLayers); requests before that are refused
let hostLayers: HostLayers | null = null;

type HostExportType = 'ply' | 'compressedPly' | 'splat' | 'sog' | 'spz';

const HOST_EXPORT_TYPES: readonly HostExportType[] = ['ply', 'compressedPly', 'splat', 'sog', 'spz'];

const HOST_EXPORT_EXTENSIONS: Record<HostExportType, string> = {
    ply: '.ply',
    compressedPly: '.compressed.ply',
    splat: '.splat',
    sog: '.sog',
    spz: '.spz'
};

interface SplatStats {
    name: string;
    filename: string | null;
    visible: boolean;
    numSplats: number;
    numSelected: number;
    numLocked: number;
    numDeleted: number;
}

interface SceneStats {
    dirty: boolean;
    documentName: string | null;
    selection: string | null;
    splats: SplatStats[];
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const messageId = (data: any) => (isString(data.id) || typeof data.id === 'number' ? data.id : null);

const sceneStats = (events: Events): SceneStats => {
    const splats = (events.invoke('scene.allSplats') ?? []) as Splat[];
    const selection = events.invoke('selection') as Splat | null;
    return {
        dirty: !!events.invoke('scene.dirty'),
        documentName: (events.invoke('doc.name') as string) ?? null,
        selection: selection?.name ?? null,
        splats: splats.map(splat => ({
            name: splat.name,
            filename: splat.filename ?? null,
            visible: splat.visible,
            numSplats: splat.numSplats,
            numSelected: splat.numSelected,
            numLocked: splat.numLocked,
            numDeleted: splat.numDeleted
        }))
    };
};

// An in-memory stand-in for the file stream the writers expect, so an export
// can be handed to the host instead of to a file picker or a download.
class MemoryStream {
    private chunks: Uint8Array[] = [];

    private length = 0;

    seek(_position: number) {
        return Promise.resolve();
    }

    write(data: ArrayBuffer | Uint8Array) {
        const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
        this.chunks.push(bytes);
        this.length += bytes.byteLength;
        return Promise.resolve();
    }

    truncate(_size: number) {
        return Promise.resolve();
    }

    close() {
        return Promise.resolve();
    }

    abort() {
        this.chunks = [];
        this.length = 0;
        return Promise.resolve();
    }

    toArrayBuffer() {
        const out = new Uint8Array(this.length);
        let offset = 0;
        for (const chunk of this.chunks) {
            out.set(chunk, offset);
            offset += chunk.byteLength;
        }
        return out.buffer;
    }
}

interface IsSceneDirtyQuery {
    type: typeof IS_SCENE_DIRTY;
}

interface IsSceneDirtyResponse {
    type: typeof IS_SCENE_DIRTY;
    result: boolean;
}

const isSceneDirtyQuery = (data: any): data is IsSceneDirtyQuery => {
    return (
        data &&
        typeof data === 'object' &&
        data.type === IS_SCENE_DIRTY
    );
};

const isEmbedded = () => window.parent !== window;

// The embedding page's origin: the referrer when the browser sends one, else
// our own origin (superspl.at serves the editor from the same host). Never '*'.
const hostOrigin = () => {
    try {
        return document.referrer ? new URL(document.referrer).origin : window.location.origin;
    } catch {
        return window.location.origin;
    }
};

// Requests that change the scene or hand data out are honoured only from the
// embedding page itself.
const isHostRequest = (event: MessageEvent) => {
    return isEmbedded() && event.source === window.parent && event.origin === hostOrigin();
};

const layerRequest = (layers: HostLayers, data: any): any => {
    switch (data.type) {
        case LOAD_LAYERS: return layers.load(data);
        case SET_LAYER_VISIBLE: return layers.setVisible(data);
        case LIST_LAYERS: return layers.list();
        case FRAME_LAYER: return layers.frame(data);
        case SET_CAMERA_POSE: return layers.setPose(data);
        case GET_CAMERA_POSE: return layers.getPose();
        case SET_BACKGROUND: return layers.setBackground(data);
        case APPLY_CLIP_VOLUMES: return layers.applyClipVolumes(data);
    }
};

const handleHostRequest = async (events: Events, data: any): Promise<{ result: any, transfer?: ArrayBuffer[] }> => {
    if (LAYER_REQUESTS.includes(data.type)) {
        if (!hostLayers) {
            return { result: { ok: false, error: 'HOST_NOT_READY: wait for supersplat:ready' } };
        }
        return { result: await layerRequest(hostLayers, data) };
    }
    switch (data.type) {
        case HOST_INFO:
            return {
                result: {
                    ok: true,
                    apiVersion: HOST_API_VERSION,
                    requests: HOST_REQUESTS,
                    exportTypes: HOST_EXPORT_TYPES,
                    exportDialogs: EXPORT_DIALOGS,
                    upAxis: hostLayers?.upAxis ?? null
                }
            };
        case SHOW_EXPORT: {
            if (!EXPORT_DIALOGS.includes(data.exportType)) {
                return { result: { ok: false, error: `exportType must be one of ${EXPORT_DIALOGS.join(', ')}` } };
            }
            if (events.invoke('scene.empty')) {
                return { result: { ok: false, error: 'the scene has no visible splats to export' } };
            }
            // not awaited: the dialog stays open until the person answers it
            events.invoke('scene.export', data.exportType);
            return { result: { ok: true, exportType: data.exportType } };
        }
        case SCENE_STATS:
            return { result: sceneStats(events) };
        case IMPORT: {
            if (!isString(data.url)) {
                return { result: { ok: false, error: 'url is required' } };
            }
            const url = new URL(data.url, window.location.href).href;
            const filename = isString(data.filename) ? data.filename : decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
            if (!filename) {
                return { result: { ok: false, error: 'filename is required when the url has none' } };
            }
            const imported = ((await events.invoke('import', [{ filename, url }])) ?? []) as Splat[];
            // A file loaded by URL is named by its whole URL; show the name the host gave instead.
            imported.forEach((splat) => {
                if (splat.name === url) splat.name = filename;
            });
            return {
                result: {
                    ok: imported.length > 0,
                    filename,
                    imported: imported.map(splat => splat.name),
                    stats: sceneStats(events)
                }
            };
        }
        case EXPORT: {
            const fileType = data.fileType as HostExportType;
            if (!HOST_EXPORT_TYPES.includes(fileType)) {
                return { result: { ok: false, error: `fileType must be one of ${HOST_EXPORT_TYPES.join(', ')}` } };
            }
            if (events.invoke('scene.empty')) {
                return { result: { ok: false, error: 'the scene has no visible splats to export' } };
            }
            const base = isString(data.filename) ? data.filename : ((events.invoke('doc.name') as string) || 'scene').replace(/\.ssproj$/i, '');
            const extension = HOST_EXPORT_EXTENSIONS[fileType];
            const filename = base.toLowerCase().endsWith(extension) ? base : `${base}${extension}`;
            const maxSHBands = Number.isInteger(data.maxSHBands) ? Math.min(3, Math.max(0, data.maxSHBands)) : 3;
            const options: SceneExportOptions = {
                filename,
                splatIdx: 'all',
                serializeSettings: { maxSHBands }
            };
            if (fileType === 'compressedPly') options.compressedPly = true;
            const stream = new MemoryStream();
            const written = await events.invoke('scene.write', fileType, options, stream) as boolean;
            if (!written) {
                return { result: { ok: false, error: 'the export did not complete' } };
            }
            const buffer = stream.toArrayBuffer();
            return {
                result: { ok: true, filename, fileType, byteLength: buffer.byteLength, data: buffer },
                transfer: [buffer]
            };
        }
        default:
            throw new Error(`unknown request ${data.type}`);
    }
};

const registerIframeApi = (events: Events) => {
    window.addEventListener('message', (event: MessageEvent) => {
        const source = event.source as Window | null;
        if (!source) {
            return;
        }

        if (isSceneDirtyQuery(event.data)) {
            const response: IsSceneDirtyResponse = {
                type: IS_SCENE_DIRTY,
                result: events.invoke('scene.dirty') as boolean
            };
            source.postMessage(response, event.origin);
            return;
        }

        const data = event.data;
        if (!data || typeof data !== 'object' || !HOST_REQUESTS.includes(data.type) || !isHostRequest(event)) {
            return;
        }

        const { type } = data;
        const id = messageId(data);
        handleHostRequest(events, data).then((reply) => {
            source.postMessage({ type, id, result: reply.result }, { targetOrigin: event.origin, transfer: reply.transfer ?? [] });
        }).catch((error) => {
            source.postMessage({ type, id, result: { ok: false, error: `${error?.message ?? error}` } }, event.origin);
        });
    });
};

// Tell the embedding page the editor can take requests. Call once the scene
// has started.
const announceReady = () => {
    if (isEmbedded()) {
        window.parent.postMessage({ type: READY, apiVersion: HOST_API_VERSION }, hostOrigin());
    }
};

// The host's layers, camera, background and clip volumes need the scene, which
// is built after the message listener is registered. Events go to the
// embedding page only, and only when there is one.
const registerHostLayers = (scene: Scene, events: Events) => {
    const notify = (event: HostEvent) => {
        if (isEmbedded()) {
            window.parent.postMessage({ type: EVENT, ...event }, hostOrigin());
        }
    };
    hostLayers = new HostLayers(scene, events, notify);
    if (isEmbedded()) {
        watchSceneState(events, notify);
    }
};

interface NavigateHomeRequest {
    type: typeof NAVIGATE_HOME;
}

// The menubar logo. Embedded (superspl.at/editor), the host decides how to
// leave — it owns navigation, the unsaved-changes guard and any transition.
// Standalone, go to the SuperSplat site directly.
const requestNavigateHome = () => {
    if (isEmbedded()) {
        const request: NavigateHomeRequest = { type: NAVIGATE_HOME };
        window.parent.postMessage(request, hostOrigin());
        return;
    }
    window.location.assign('https://superspl.at/');
};

export { announceReady, registerHostLayers, registerIframeApi, requestNavigateHome };
