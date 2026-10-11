import { BoundingBox, Color, Mat4, Quat, Vec3 } from 'playcanvas';

import { Backdrop } from './backdrop';
import {
    ClipVolume,
    LayerSpec,
    UpAxis,
    Vec3 as Triple,
    clipVolumeMatrix,
    layerRotation,
    parseBackground,
    parseClipVolumes,
    parseLayerSpecs,
    parsePose,
    poseToWorld,
    upAxis as parseUpAxis,
    worldToFrame
} from './frame';
import { Element, ElementType } from '../element';
import { Events } from '../events';
import { IndexRanges } from '../index-ranges';
import { MappedReadFileSystem } from '../io';
import { Scene } from '../scene';
import { Splat } from '../splat';
import { State } from '../splat-state';

// Host layers: the embedding page's layers as scene elements of the editor.
//
// A layer is one splat file with an id the host chose. It is an ordinary
// editor layer (it is in the scene panel, it can be selected, erased,
// transformed and exported like any other); this registry only remembers which
// element answers to which id, so the host can show, hide, frame and clip by
// id. A layer that starts hidden is not fetched until it is first shown.

type LayerState = 'idle' | 'loading' | 'loaded' | 'failed';

type Entry = {
    spec: LayerSpec;
    state: LayerState;
    visible: boolean;
    splat: Splat | null;
    error: string | null;
    // static rows this registry locked for a clip volume. By row, not by
    // instance: deleting gaussians renumbers the instances, never the rows.
    clipped: Uint8Array | null;
    numClipped: number;
};

type HostEvent = Record<string, unknown> & { event: string };

const triple = (v: Vec3): Triple => [v.x, v.y, v.z];

class HostLayers {
    private scene: Scene;
    private events: Events;
    private notify: (event: HostEvent) => void;
    private backdrop: Backdrop;
    private entries = new Map<string, Entry>();
    private up: UpAxis = 'y';
    private volumes: ClipVolume[] = [];
    private ghost = false;
    private savedLockedClr: Color | null = null;
    // one file is read at a time: two large reads at once double the peak memory
    private chain: Promise<unknown> = Promise.resolve();
    private loadingId: string | null = null;
    private lastProgress = 0;

    constructor(scene: Scene, events: Events, notify: (event: HostEvent) => void) {
        this.scene = scene;
        this.events = events;
        this.notify = notify;
        this.backdrop = new Backdrop(scene);

        // the loader reports what it has read through the editor's own progress events
        events.on('progressUpdate', (update: { text?: string, progress?: number }) => {
            if (!this.loadingId) return;
            const now = performance.now();
            if (now - this.lastProgress < 100 && (update.progress ?? 0) < 100) return;
            this.lastProgress = now;
            this.notify({
                event: 'layer-progress',
                layerId: this.loadingId,
                text: update.text ?? null,
                progress: typeof update.progress === 'number' ? update.progress : null
            });
        });

        // a layer deleted in the scene panel goes back to not loaded
        events.on('scene.elementDestroyed', (element: Element) => {
            if (element.type !== ElementType.splat) return;
            this.entries.forEach((entry) => {
                if (entry.splat === element) {
                    entry.splat = null;
                    entry.state = 'idle';
                    entry.visible = false;
                    entry.clipped = null;
                    entry.numClipped = 0;
                    this.notify({ event: 'layer', layer: this.describe(entry) });
                }
            });
        });

        // visibility switched in the scene panel is the layer's visibility
        events.on('splat.visibility', (splat: Splat) => {
            this.entries.forEach((entry) => {
                if (entry.splat === splat && entry.visible !== splat.visible) {
                    entry.visible = splat.visible;
                    this.notify({ event: 'layer', layer: this.describe(entry) });
                }
            });
        });
    }

    get upAxis() {
        return this.up;
    }

    private describe(entry: Entry) {
        const { spec, splat } = entry;
        const bound = (box: BoundingBox | null) => {
            if (!box || !splat || splat.numSplats === 0) return null;
            return { min: triple(box.getMin()), max: triple(box.getMax()) };
        };
        const world = bound(splat?.worldBound ?? null);
        // the same box in the host's frame: turning the eight corners keeps it axis aligned
        const frame = world && ((): { min: Triple, max: Triple } => {
            const a = worldToFrame(world.min, this.up);
            const b = worldToFrame(world.max, this.up);
            return {
                min: [0, 1, 2].map(i => Math.min(a[i], b[i])) as Triple,
                max: [0, 1, 2].map(i => Math.max(a[i], b[i])) as Triple
            };
        })();
        return {
            id: spec.id,
            name: splat?.name ?? spec.name,
            group: spec.group,
            filename: spec.filename,
            state: entry.state,
            visible: entry.visible,
            error: entry.error,
            numSplats: splat?.numSplats ?? 0,
            numSelected: splat?.numSelected ?? 0,
            numLocked: splat?.numLocked ?? 0,
            numDeleted: splat?.numDeleted ?? 0,
            numClipped: entry.numClipped,
            boundsWorld: world,
            boundsFrame: frame
        };
    }

    list() {
        return {
            ok: true,
            upAxis: this.up,
            layers: Array.from(this.entries.values(), entry => this.describe(entry)),
            clipVolumes: this.volumes.map(v => v.id),
            background: this.backdrop.state
        };
    }

    private entry(id: unknown) {
        const entry = typeof id === 'string' ? this.entries.get(id) : undefined;
        if (!entry) {
            throw new Error(`HOST_LAYER_UNKNOWN: ${String(id)}`);
        }
        return entry;
    }

    // read one layer's file and add it to the scene. Never raises: a failure is
    // the layer's state, with its reason, and the other layers go on.
    private async fetchLayer(entry: Entry) {
        if (entry.state === 'loaded' || entry.state === 'loading') return;
        const { scene } = this;
        const { spec } = entry;
        entry.state = 'loading';
        entry.error = null;
        this.loadingId = spec.id;
        this.notify({ event: 'layer', layer: this.describe(entry) });
        try {
            const url = new URL(spec.url, window.location.href).href;
            const fileSystem = new MappedReadFileSystem(new URL('.', url).href);
            // by its whole url, as the editor's own import by url does: the
            // loader picks the reader from the name's ending
            const splat = await scene.assetLoader.load(url, fileSystem, false);
            if (!splat) {
                throw new Error('the load was cancelled');
            }
            splat.resource.fileSources = fileSystem.sources;
            const load = splat.entity.getLocalRotation();
            const q = layerRotation([load.x, load.y, load.z, load.w], this.up);
            splat.entity.setLocalRotation(new Quat(q[0], q[1], q[2], q[3]));
            // set before it joins the scene, so a hidden layer never shows for a frame
            splat.visible = entry.visible;
            await scene.add(splat);
            splat.name = spec.name;
            entry.splat = splat;
            entry.state = 'loaded';
            await this.clipEntry(entry);
        } catch (error) {
            entry.splat = null;
            entry.state = 'failed';
            entry.error = `${(error as Error)?.message ?? error}`;
        } finally {
            this.loadingId = null;
            scene.forceRender = true;
            this.notify({ event: 'layer', layer: this.describe(entry) });
        }
    }

    private queue<T>(task: () => Promise<T>): Promise<T> {
        const next = this.chain.then(task, task);
        this.chain = next.catch((): void => undefined);
        return next;
    }

    // supersplat:load-layers
    async load(data: any) {
        const { layers, skipped } = parseLayerSpecs(data.layers);
        const up = parseUpAxis(data.upAxis);
        if (this.entries.size > 0 && up !== this.up && Array.from(this.entries.values()).some(e => e.splat)) {
            throw new Error('HOST_UP_AXIS_CHANGED: layers are loaded with another up axis; send replace: true');
        }
        if (data.replace === true) {
            await this.queue(() => {
                this.entries.forEach(entry => entry.splat?.destroy());
                this.entries.clear();
                return Promise.resolve();
            });
        }
        this.up = up;
        const added: Entry[] = [];
        layers.forEach((spec) => {
            const known = this.entries.get(spec.id);
            if (known) {
                // the same id again is the same layer: only its file may not change
                if (known.spec.url !== spec.url && known.splat) {
                    throw new Error(`HOST_LAYER_FILE_CHANGED: ${spec.id}`);
                }
                known.spec = spec;
                return;
            }
            const entry: Entry = {
                spec, state: 'idle', visible: spec.visible, splat: null, error: null, clipped: null, numClipped: 0
            };
            this.entries.set(spec.id, entry);
            added.push(entry);
        });
        const wanted = added.filter(entry => entry.visible);
        const work = this.queue(async () => {
            for (const entry of wanted) {
                await this.fetchLayer(entry);
            }
        });
        if (data.wait !== false) {
            await work;
            if (wanted.some(entry => entry.splat) && data.frame !== false) {
                this.events.fire('camera.focus');
            }
        }
        return { ...this.list(), skipped };
    }

    // supersplat:set-layer-visible
    async setVisible(data: any) {
        const entry = this.entry(data.layerId);
        if (typeof data.visible !== 'boolean') {
            throw new Error('HOST_VISIBLE_INVALID: visible must be true or false');
        }
        entry.visible = data.visible;
        if (entry.splat) {
            entry.splat.visible = data.visible;
        } else if (data.visible) {
            await this.queue(() => this.fetchLayer(entry));
        }
        this.scene.forceRender = true;
        return { ok: entry.state !== 'failed', error: entry.error ?? undefined, layer: this.describe(entry) };
    }

    private pose() {
        const world = this.events.invoke('camera.getPose') as {
            position: { x: number, y: number, z: number },
            target: { x: number, y: number, z: number },
            fov: number
        };
        const position: Triple = [world.position.x, world.position.y, world.position.z];
        const target: Triple = [world.target.x, world.target.y, world.target.z];
        return {
            fov: world.fov,
            world: { position, target },
            frame: { position: worldToFrame(position, this.up), target: worldToFrame(target, this.up) }
        };
    }

    // supersplat:get-camera-pose
    getPose() {
        return { ok: true, upAxis: this.up, pose: this.pose() };
    }

    // supersplat:set-camera-pose
    setPose(data: any) {
        const spec = parsePose(data);
        const { position, target } = poseToWorld(spec, this.up);
        const pose: { position: Vec3, target: Vec3, fov?: number } = {
            position: new Vec3(position),
            target: new Vec3(target)
        };
        if (spec.fov !== null) pose.fov = spec.fov;
        // speed 0: the camera is there on the next frame, not flown to
        this.events.fire('camera.setPose', pose, 0);
        this.scene.forceRender = true;
        return this.getPose();
    }

    // supersplat:frame-layer
    frame(data: any) {
        const entry = this.entry(data.layerId);
        const splat = entry.splat;
        if (!splat) {
            throw new Error(`HOST_LAYER_NOT_LOADED: ${entry.spec.id}`);
        }
        this.events.fire('selection', splat);
        const bound = splat.worldBound;
        this.scene.camera.focus({
            focalPoint: bound.center.clone(),
            radius: bound.halfExtents.length(),
            speed: 0
        });
        this.scene.forceRender = true;
        return { ...this.getPose(), layer: this.describe(entry) };
    }

    // supersplat:set-background
    async setBackground(data: any) {
        const background = await this.backdrop.set(parseBackground(data));
        return { ok: true, background };
    }

    // Bring one layer's locked bits to the current volumes: first unlock what
    // this registry locked before, then lock what is inside a volume now. Bits
    // a person set by hand (Hide Selection) are never touched: only instances
    // that were not locked are taken, and only those are given back.
    private async clipEntry(entry: Entry) {
        const { scene } = this;
        const splat = entry.splat;
        if (!splat) return;
        const volumes = this.volumes.filter(v => v.appliesTo.includes(entry.spec.id));
        if (volumes.length === 0 && !entry.clipped) return;

        await scene.commandQueue.enqueue(async () => {
            if (!splat.scene) return;
            const { instances } = splat;
            const { flags, sourceRow } = instances;

            if (entry.clipped) {
                const rows = entry.clipped;
                instances.clearBits(
                    IndexRanges.fromPredicate(instances.count, i => rows[sourceRow[i]] === 1 && (flags[i] & State.locked) !== 0),
                    State.locked
                );
                entry.clipped = null;
                entry.numClipped = 0;
            }

            if (volumes.length > 0) {
                const hits = new Uint8Array(instances.count);
                for (const volume of volumes) {
                    const transform = new Mat4();
                    transform.set(clipVolumeMatrix(volume, this.up));
                    // the editor's own box test, on the gpu: centres only (footprint 0)
                    const mask = await scene.dataProcessor.intersect({ box: { transform, footprint: 0 } }, splat);
                    for (let i = 0; i < hits.length; ++i) {
                        if (mask[i] === 255) hits[i] = 1;
                    }
                    scene.dataProcessor.releaseMask(mask);
                }
                const rows = new Uint8Array(splat.resource.numRows);
                let count = 0;
                const ranges = IndexRanges.fromPredicate(instances.count, (i) => {
                    if (hits[i] !== 1 || (flags[i] & State.locked) !== 0) return false;
                    rows[sourceRow[i]] = 1;
                    count++;
                    return true;
                });
                // a hidden gaussian is not left selected: a delete would skip it,
                // and the count of selected ones would name things nobody sees
                instances.clearBits(ranges, State.selected);
                instances.setBits(ranges, State.locked);
                entry.clipped = rows;
                entry.numClipped = count;
            }

            await splat.updateState();
        });
    }

    // Locked gaussians are drawn in the "locked" colour. While volumes are in
    // force that colour is made fully clear, so what a volume hides is gone
    // rather than a dark haze; `ghost: true` keeps the editor's own colour. The
    // person's colour is put back when the volumes are cleared, and neither
    // change is stored as their preference.
    private lockedColour(hide: boolean) {
        const { events } = this;
        const set = (clr: Color) => {
            events.fire('preferences.suspend');
            try {
                events.fire('setLockedClr', clr);
            } finally {
                events.fire('preferences.resume');
            }
        };
        if (hide && !this.savedLockedClr) {
            this.savedLockedClr = (events.invoke('lockedClr') as Color).clone();
            set(new Color(0, 0, 0, 0));
        } else if (!hide && this.savedLockedClr) {
            set(this.savedLockedClr);
            this.savedLockedClr = null;
        }
    }

    // supersplat:apply-clip-volumes
    async applyClipVolumes(data: any) {
        const volumes = parseClipVolumes(data.volumes);
        const unknown = volumes.flatMap(v => v.appliesTo).filter(id => !this.entries.has(id));
        if (unknown.length > 0) {
            throw new Error(`HOST_LAYER_UNKNOWN: ${Array.from(new Set(unknown)).join(', ')}`);
        }
        this.volumes = volumes;
        this.ghost = data.ghost === true;
        this.lockedColour(volumes.length > 0 && !this.ghost);
        await this.queue(async () => {
            for (const entry of this.entries.values()) {
                await this.clipEntry(entry);
            }
        });
        this.scene.forceRender = true;
        return {
            ok: true,
            volumes: volumes.map(v => v.id),
            ghost: this.ghost,
            layers: Array.from(this.entries.values(), entry => ({
                id: entry.spec.id,
                state: entry.state,
                numClipped: entry.numClipped,
                numLocked: entry.splat?.numLocked ?? 0,
                numSplats: entry.splat?.numSplats ?? 0
            }))
        };
    }
}

// What the host is told without asking: the scene's dirty flag, the selected
// layer and how many gaussians are selected, whenever any of them changes.
const watchSceneState = (events: Events, notify: (event: HostEvent) => void) => {
    let last = '';
    const read = () => {
        const splats = (events.invoke('scene.allSplats') ?? []) as Splat[];
        const selection = events.invoke('selection') as Splat | null;
        return {
            dirty: !!events.invoke('scene.dirty'),
            selection: selection?.name ?? null,
            numSelected: splats.reduce((sum, splat) => sum + splat.numSelected, 0),
            numSplats: splats.reduce((sum, splat) => sum + splat.numSplats, 0),
            numLayers: splats.length
        };
    };
    const check = () => {
        const state = read();
        const key = JSON.stringify(state);
        if (key !== last) {
            last = key;
            notify({ event: 'state', ...state });
        }
    };
    ['splat.stateChanged', 'selection.changed', 'scene.elementAdded', 'scene.elementRemoved', 'doc.saved'].forEach((name) => {
        events.on(name, () => setTimeout(check));
    });
    // undo, redo and an export move the dirty flag without any of the events above
    setInterval(check, 500);
};

export { HostLayers, watchSceneState };

export type { HostEvent };
