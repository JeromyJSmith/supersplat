import { PROJECTION_ORTHOGRAPHIC } from 'playcanvas';

import { BackgroundSpec, GRADIENT_STOPS } from './frame';
import { Scene } from '../scene';

// The scene's background for an embedding page: nothing, a drawn sky, or an
// equirectangular picture seen from the editor's own camera.
//
// The editor has no skybox of its own. Its viewport canvas is cleared to
// transparent and the page's background colour shows through it, so a
// background is whatever sits behind that canvas. This one is a second canvas
// under the viewport, redrawn with the camera of every frame the scene renders:
// one full-screen triangle, no depth, no engine state touched. It is a view
// aid: image, video and viewer exports do not include it (they use the
// background colour, as before).

const vertexGLSL = /* glsl */`#version 300 es
out vec2 ndc;
void main() {
    // one triangle that covers the viewport
    vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)) * 2.0 - 1.0;
    ndc = p;
    gl_Position = vec4(p, 0.0, 1.0);
}`;

// kept in step with equirectUv and gradientColor in frame.ts
const fragmentGLSL = /* glsl */`#version 300 es
precision highp float;
in vec2 ndc;
out vec4 color;
uniform mat3 cameraRotation;   // camera to world
uniform vec2 tanHalf;          // tan(half fov) across and up
uniform int mode;              // 1 picture, 2 drawn
uniform sampler2D picture;
uniform vec4 stops[${GRADIENT_STOPS.length}];   // rgb, v

const float PI = 3.141592653589793;

vec3 drawn(float v) {
    for (int i = 1; i < ${GRADIENT_STOPS.length}; ++i) {
        if (v <= stops[i].w) {
            float k = (v - stops[i - 1].w) / (stops[i].w - stops[i - 1].w);
            return mix(stops[i - 1].rgb, stops[i].rgb, clamp(k, 0.0, 1.0));
        }
    }
    return stops[${GRADIENT_STOPS.length - 1}].rgb;
}

void main() {
    vec3 dir = normalize(cameraRotation * vec3(ndc.x * tanHalf.x, ndc.y * tanHalf.y, -1.0));
    float u = atan(dir.z, dir.x) / (2.0 * PI) + 0.5;
    float v = acos(clamp(dir.y, -1.0, 1.0)) / PI;
    if (mode == 1) {
        // textureLod: the seam of u would otherwise pick the smallest mip
        color = vec4(textureLod(picture, vec2(u, v), 0.0).rgb, 1.0);
    } else {
        color = vec4(drawn(v), 1.0);
    }
}`;

class Backdrop {
    private scene: Scene;
    private canvas: HTMLCanvasElement;
    private gl: WebGL2RenderingContext | null = null;
    private program: WebGLProgram | null = null;
    private texture: WebGLTexture | null = null;
    private spec: BackgroundSpec = { kind: 'none' };
    private pictureSize: [number, number] | null = null;
    // a later request wins over a picture still being fetched
    private generation = 0;

    constructor(scene: Scene) {
        this.scene = scene;

        const container = document.getElementById('canvas-container');
        this.canvas = document.createElement('canvas');
        this.canvas.id = 'host-backdrop';
        Object.assign(this.canvas.style, {
            position: 'absolute',
            left: '0',
            top: '0',
            width: '100%',
            height: '100%',
            zIndex: '-1',
            pointerEvents: 'none',
            display: 'none'
        });
        // the container becomes its own stacking context, so "behind the
        // viewport" cannot fall behind the page as well
        container.style.isolation = 'isolate';
        container.style.position = container.style.position || 'relative';
        container.insertBefore(this.canvas, container.firstChild);

        scene.events.on('prerender', () => this.draw());
    }

    get state() {
        return { ...this.spec, pictureSize: this.pictureSize };
    }

    private context() {
        if (this.gl) return this.gl;
        const gl = this.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
        if (!gl) {
            throw new Error('HOST_BACKGROUND_UNAVAILABLE: this browser gives no WebGL2 context for the background');
        }
        const compile = (type: number, source: string) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error(`HOST_BACKGROUND_UNAVAILABLE: ${gl.getShaderInfoLog(shader)}`);
            }
            return shader;
        };
        const program = gl.createProgram();
        gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexGLSL));
        gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentGLSL));
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(`HOST_BACKGROUND_UNAVAILABLE: ${gl.getProgramInfoLog(program)}`);
        }
        gl.useProgram(program);
        gl.uniform4fv(gl.getUniformLocation(program, 'stops'), GRADIENT_STOPS.flatMap(s => [...s.rgb, s.v]));
        gl.uniform1i(gl.getUniformLocation(program, 'picture'), 0);
        // WebGL2 needs a bound vertex array even when the shader takes no attribute
        gl.bindVertexArray(gl.createVertexArray());
        this.gl = gl;
        this.program = program;
        return gl;
    }

    async set(spec: BackgroundSpec) {
        const generation = ++this.generation;
        if (spec.kind === 'none') {
            this.spec = spec;
            this.pictureSize = null;
            this.canvas.style.display = 'none';
            this.scene.forceRender = true;
            return this.state;
        }

        const gl = this.context();
        if (spec.kind === 'panorama') {
            const response = await fetch(spec.url);
            if (!response.ok) {
                throw new Error(`HOST_BACKGROUND_FETCH_FAILED: ${response.status} for the picture`);
            }
            const bitmap = await createImageBitmap(await response.blob());
            if (generation !== this.generation) {
                bitmap.close();
                return this.state;
            }
            const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
            if (bitmap.width > limit || bitmap.height > limit) {
                bitmap.close();
                throw new Error(`HOST_BACKGROUND_TOO_LARGE: ${bitmap.width} x ${bitmap.height}, this device takes ${limit}`);
            }
            this.texture ??= gl.createTexture();
            gl.activeTexture(gl.TEXTURE0);
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            this.pictureSize = [bitmap.width, bitmap.height];
            bitmap.close();
        } else {
            this.pictureSize = null;
        }

        this.spec = spec;
        this.canvas.style.display = 'block';
        this.scene.forceRender = true;
        this.draw();
        return this.state;
    }

    private draw() {
        if (this.spec.kind === 'none' || !this.gl) return;
        const { gl, program, canvas, scene } = this;
        const { width, height } = scene.canvas;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);

        const entity = scene.camera.mainCamera;
        const camera = entity.camera;
        const m = entity.getWorldTransform().data;
        gl.useProgram(program);
        gl.uniformMatrix3fv(gl.getUniformLocation(program, 'cameraRotation'), false, [
            m[0], m[1], m[2],
            m[4], m[5], m[6],
            m[8], m[9], m[10]
        ]);
        // An orthographic view looks one way everywhere: the background is then
        // the one colour straight ahead.
        const p = camera.projectionMatrix.data;
        const ortho = camera.projection === PROJECTION_ORTHOGRAPHIC;
        gl.uniform2f(gl.getUniformLocation(program, 'tanHalf'), ortho ? 0 : 1 / p[0], ortho ? 0 : 1 / p[5]);
        gl.uniform1i(gl.getUniformLocation(program, 'mode'), this.spec.kind === 'panorama' ? 1 : 2);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
}

export { Backdrop };
