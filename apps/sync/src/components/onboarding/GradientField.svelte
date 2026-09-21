<script lang="ts">
  /**
   * The living background behind the first-run intro: four very soft colour
   * bodies drifting under a dark veil, the way a brand wallpaper reads through
   * heavy blur. The bodies take their cast from the mesh anchors and their
   * shift from the HQ brand spectrum, so the surface stays calm while its
   * colour still travels across the film.
   *
   * Rendered with raw WebGL (no library, no bundle cost) as a single
   * fullscreen triangle. Everything that can fail — no WebGL, a lost context,
   * a machine that prefers reduced motion — falls back to a static CSS
   * gradient that uses the same colours, so the surface is never blank.
   */
  import { onDestroy, onMount } from 'svelte';
  import { VEIL_DEFAULT, meshStops } from '../../lib/intro-sequence';
  // The mesh itself: the HQ brand wallpaper, downscaled and pre-blurred to
  // 512px so it reads as a soft colour field at any window size and costs
  // under 5 KB. Bundled, never fetched — the packaged app's CSP blocks remote
  // assets.
  import meshUrl from '../../assets/intro-mesh.webp';

  interface Props {
    /** 0..1 along the brand spectrum. Drives the colour of the field. */
    hue?: number;
    /** 0..1 — how bright the colour bodies burn. Ramps up during the overture. */
    intensity?: number;
    /**
     * 0..1 — how much dark scrim sits over the mesh. Tuned per scene so dense
     * copy reads without the field having to change colour.
     */
    veil?: number;
    /** Freeze the field (reduced motion, or the window went to the background). */
    still?: boolean;
  }

  let {
    hue = 0,
    intensity = 1,
    veil = VEIL_DEFAULT,
    still = false,
  }: Props = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let usingWebgl = $state(false);

  const VERT = `#version 300 es
  void main() {
    // Fullscreen triangle — no vertex buffer needed.
    vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
    gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  }`;

  const FRAG = `#version 300 es
  precision highp float;
  out vec4 fragColor;

  uniform vec2 u_res;
  uniform float u_time;
  uniform float u_intensity;
  uniform float u_veil;    // 0..1 — how much dark scrim sits over the mesh
  uniform sampler2D u_tex; // the blurred wallpaper
  uniform float u_texOk;   // 1 once the wallpaper has decoded, 0 before
  uniform float u_texAspect;
  uniform vec2 u_mouse;   // -1..1, eased; the whole field leans toward it
  uniform vec3 u_c0;
  uniform vec3 u_c1;
  uniform vec3 u_c2;
  uniform vec3 u_c3;

  // Soft radial body: gaussian falloff so bodies blend instead of stacking
  // into hard-edged discs.
  float body(vec2 uv, vec2 at, float radius) {
    float d = length(uv - at) / radius;
    return exp(-d * d);
  }

  // Cheap value noise for the grain pass — banding on a large dark gradient
  // is the single thing that makes this read as "cheap", so it gets dithered.
  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_res;
    float aspect = u_res.x / max(u_res.y, 1.0);
    vec2 p = vec2((uv.x - 0.5) * aspect, uv.y - 0.5);

    float t = u_time;
    // Mouse gravity: the colour bodies lean a little toward the cursor, the
    // light leans a little more. Enough to feel alive, never enough to steer.
    vec2 lean = u_mouse * vec2(0.06, 0.045);
    p -= lean;

    // A slow, very low-frequency warp. It bends the bodies out of perfect
    // circles the way a photographed gradient never is, and costs nothing.
    vec2 warped = p + vec2(
      sin(p.y * 1.55 + t * 0.047),
      cos(p.x * 1.35 - t * 0.041)
    ) * 0.07;

    // Four bodies on slow, mutually-prime orbits so the field never visibly
    // loops back to a pose the viewer has already seen. They are deliberately
    // larger than the frame: at this scale the eye reads a single continuous
    // field rather than four blobs sharing a rectangle.
    vec2 a0 = vec2(sin(t * 0.041) * 0.26 - 0.54, cos(t * 0.049) * 0.18 + 0.16);
    vec2 a1 = vec2(cos(t * 0.035) * 0.26 + 0.58, sin(t * 0.029) * 0.20 - 0.14);
    vec2 a2 = vec2(sin(t * 0.026) * 0.30 + 0.08, cos(t * 0.038) * 0.14 + 0.52);
    vec2 a3 = vec2(cos(t * 0.031) * 0.30 - 0.12, sin(t * 0.023) * 0.14 - 0.50);

    float b0 = body(warped, a0, 0.98);
    float b1 = body(warped, a1, 0.92);
    float b2 = body(warped, a2, 0.86);
    float b3 = body(warped, a3, 0.90);

    vec3 tint = vec3(0.0);
    tint += u_c0 * b0;
    tint += u_c1 * b1;
    tint += u_c2 * b2;
    tint += u_c3 * b3;
    // Normalise by total coverage so overlapping bodies average instead of
    // summing — summing is what produced hot, plastic-looking cores.
    float cover = b0 + b1 + b2 + b3;
    tint /= max(cover, 0.85);

    // The wallpaper, cover-fitted, drifting very slowly and leaning with the
    // cursor. This is the shape of the field; the bodies above only say what
    // colour it is at this moment in the film.
    float viewAspect = aspect;
    vec2 scale = viewAspect > u_texAspect
      ? vec2(1.0, u_texAspect / viewAspect)
      : vec2(viewAspect / u_texAspect, 1.0);
    vec2 wuv = (uv - 0.5) / (scale * (1.06 + 0.03 * sin(t * 0.017)));
    wuv += vec2(sin(t * 0.012) * 0.012, cos(t * 0.0097) * 0.010);
    wuv += u_mouse * vec2(0.012, -0.010);
    wuv = clamp(wuv + 0.5, vec2(0.0), vec2(1.0));
    vec3 wall = texture(u_tex, wuv).rgb;
    float wl = dot(wall, vec3(0.299, 0.587, 0.114));

    // Colourise: the photograph keeps its structure, the hue comes from the
    // drifting bodies. That is the whole trick — her mesh, our colour shift.
    vec3 photo = mix(wall, tint * (0.35 + wl * 1.25), 0.55);
    // With no wallpaper (decode failed, or it has not arrived yet) the bodies
    // stand in on their own, which is what the field used to be.
    vec3 col = mix(tint * 1.5, photo, u_texOk) * u_intensity;

    // What is left of the god rays: one wide light high in the frame, sampled
    // across five angles so nothing reads as a shaft. It is a change in
    // brightness across the field, not a graphic.
    vec2 lp = vec2(sin(t * 0.03) * 0.18 + u_mouse.x * 0.12, 0.92 - u_mouse.y * 0.03);
    vec2 ld = warped - lp;
    float ang = atan(ld.y, ld.x);
    float dist = length(ld);
    float wash = 0.0;
    for (int i = -2; i <= 2; i++) {
      float a = ang + float(i) * 0.09;
      float s1 = sin(a * 3.1 + t * 0.05) * 0.5 + 0.5;
      float s2 = sin(a * 1.7 - t * 0.037 + 1.7) * 0.5 + 0.5;
      wash += s1 * s2;
    }
    wash /= 5.0;
    float reach = smoothstep(2.1, 0.1, dist) * (0.8 + 0.2 * sin(t * 0.11));
    col += mix(u_c0, vec3(1.0), 0.45) * wash * reach * 0.16 * u_intensity;

    // A broad bloom where that light sits — the soft sun from the horizon
    // concept, held under the veil so it never becomes a disc.
    float bloom = exp(-dist * dist * 1.5);
    col += mix(vec3(1.0), u_c1, 0.45) * bloom * 0.14 * u_intensity;

    // A slow band drifting across the upper third, in the current hue.
    float band = exp(-pow((warped.y - 0.20 - sin(warped.x * 1.1 + t * 0.06) * 0.10) * 3.4, 2.0));
    col += mix(u_c1, u_c2, sin(t * 0.04) * 0.5 + 0.5) * band * 0.09 * u_intensity;

    // Overlapping bodies average toward grey; pull saturation back up a
    // little so the field reads as colour rather than as a smudge — but far
    // less than a punchy gradient would, because the reference is a
    // photograph seen through heavy blur.
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, 1.26);
    col = max(col, vec3(0.0));

    // Vignette pulls the eye to the centred copy.
    // Keep the colour bodies away from burning out under the type: a very
    // wide, very gentle dip toward the centre. Wide enough that it never reads
    // as a shape — a visible dark oval behind the copy is exactly what this
    // must not become.
    float centre = smoothstep(1.7, 0.0, length(p * vec2(0.5, 1.0)));
    col *= mix(1.0, 0.9, centre);

    // A light touch of edge falloff keeps the frame from looking like a
    // rectangle of colour pasted onto the window.
    float edge = smoothstep(1.5, 0.6, length(p * vec2(0.85, 1.05)));
    col *= mix(0.84, 1.0, edge);

    // Filmic-ish rolloff keeps the hot centres from clipping to flat white.
    col = col / (col + vec3(1.0)) * 1.42;

    // The veil: the same move as a black scrim over a blurred wallpaper. It
    // is the last thing applied, so every layer above loses contrast together
    // and the surface stays one piece.
    vec3 scrim = vec3(0.012, 0.013, 0.019);
    col = mix(col, scrim, clamp(u_veil, 0.0, 1.0) * 0.78);

    // Dither: ±1/255 of noise, enough to break 8-bit banding.
    col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;

    fragColor = vec4(col, 1.0);
  }`;

  let gl: WebGL2RenderingContext | null = null;
  let meshTexture: WebGLTexture | null = null;
  let meshReady = false;
  let meshAspect = 512 / 332;
  let meshImage: HTMLImageElement | null = null;
  let program: WebGLProgram | null = null;
  let raf = 0;
  let start = 0;
  let frozenTime = 0;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let resizeObserver: ResizeObserver | null = null;
  const mouse = { x: 0, y: 0 };
  const mouseTarget = { x: 0, y: 0 };

  function onPointer(event: PointerEvent) {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    mouseTarget.x = (event.clientX / w) * 2 - 1;
    // Flip so +y is up, matching the shader's coordinate frame.
    mouseTarget.y = -((event.clientY / h) * 2 - 1);
  }

  function compile(context: WebGL2RenderingContext, type: number, source: string) {
    const shader = context.createShader(type);
    if (!shader) throw new Error('GradientField: could not create shader');
    context.shaderSource(shader, source);
    context.compileShader(shader);
    if (!context.getShaderParameter(shader, context.COMPILE_STATUS)) {
      const log = context.getShaderInfoLog(shader);
      context.deleteShader(shader);
      throw new Error(`GradientField: shader compile failed: ${log}`);
    }
    return shader;
  }

  /**
   * Upload the bundled wallpaper as a texture. Failure is not fatal: the
   * shader keeps `u_texOk` at 0 and draws the procedural bodies instead, so a
   * missing or undecodable asset costs the photograph's softness and nothing
   * else.
   */
  function loadMesh(context: WebGL2RenderingContext) {
    const texture = context.createTexture();
    if (!texture) {
      console.warn('GradientField: could not create mesh texture');
      return;
    }
    meshTexture = texture;
    context.bindTexture(context.TEXTURE_2D, texture);
    // One opaque pixel stands in until the image decodes, so the first frames
    // are never sampled from uninitialised memory.
    context.texImage2D(
      context.TEXTURE_2D, 0, context.RGBA, 1, 1, 0,
      context.RGBA, context.UNSIGNED_BYTE, new Uint8Array([10, 12, 20, 255]),
    );
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_S, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_WRAP_T, context.CLAMP_TO_EDGE);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MIN_FILTER, context.LINEAR);
    context.texParameteri(context.TEXTURE_2D, context.TEXTURE_MAG_FILTER, context.LINEAR);

    const image = new Image();
    meshImage = image;
    image.onload = () => {
      if (!gl || !meshTexture) return;
      try {
        meshAspect = image.naturalWidth / Math.max(1, image.naturalHeight);
        gl.bindTexture(gl.TEXTURE_2D, meshTexture);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
        meshReady = true;
      } catch (err) {
        console.warn('GradientField: mesh upload failed, using the drawn field', err);
      }
    };
    image.onerror = (err) => {
      console.warn('GradientField: mesh image failed to load, using the drawn field', err);
    };
    image.src = meshUrl;
  }

  function resize() {
    if (!canvas || !gl) return;
    // Cap DPR at 2: the field is all low-frequency colour, so a 3x buffer
    // costs fill rate for no visible gain on a laptop GPU.
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width === width && canvas.height === height) return;
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
  }

  function frame(now: number) {
    if (!gl || !program) return;
    if (start === 0) start = now;
    const elapsed = still ? frozenTime : (now - start) / 1000;
    if (!still) frozenTime = elapsed;

    resize();
    gl.useProgram(program);
    gl.uniform2f(uniforms.u_res, canvas?.width ?? 1, canvas?.height ?? 1);
    gl.uniform1f(uniforms.u_time, elapsed);
    gl.uniform1f(uniforms.u_intensity, intensity);
    gl.uniform1f(uniforms.u_veil, veil);
    gl.uniform1f(uniforms.u_texOk, meshReady ? 1 : 0);
    gl.uniform1f(uniforms.u_texAspect, meshAspect);
    // Ease toward the cursor so the field drifts rather than snaps.
    mouse.x += (mouseTarget.x - mouse.x) * 0.035;
    mouse.y += (mouseTarget.y - mouse.y) * 0.035;
    gl.uniform2f(uniforms.u_mouse, mouse.x, mouse.y);

    // Four samples spread across the spectrum, offset from the current hue and
    // blended toward the mesh anchors, so the bodies are related but never
    // identical and the whole field keeps the wallpaper's cast.
    const stops = meshStops(hue);
    gl.uniform3f(uniforms.u_c0, ...stops[0]);
    gl.uniform3f(uniforms.u_c1, ...stops[1]);
    gl.uniform3f(uniforms.u_c2, ...stops[2]);
    gl.uniform3f(uniforms.u_c3, ...stops[3]);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    raf = requestAnimationFrame(frame);
  }

  onMount(() => {
    if (!canvas) return;
    let context: WebGL2RenderingContext | null = null;
    try {
      context = canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        powerPreference: 'low-power',
        // The intro is composited over a transparent Tauri window; asking for
        // a preserved buffer would cost a copy per frame for nothing.
        preserveDrawingBuffer: false,
      });
    } catch (err) {
      console.warn('GradientField: webgl2 unavailable, using CSS fallback', err);
    }
    if (!context) return;

    try {
      const vs = compile(context, context.VERTEX_SHADER, VERT);
      const fs = compile(context, context.FRAGMENT_SHADER, FRAG);
      const prog = context.createProgram();
      if (!prog) throw new Error('GradientField: could not create program');
      context.attachShader(prog, vs);
      context.attachShader(prog, fs);
      context.linkProgram(prog);
      if (!context.getProgramParameter(prog, context.LINK_STATUS)) {
        throw new Error(
          `GradientField: link failed: ${context.getProgramInfoLog(prog)}`,
        );
      }
      context.deleteShader(vs);
      context.deleteShader(fs);

      gl = context;
      program = prog;
      for (const name of [
        'u_res',
        'u_time',
        'u_intensity',
        'u_veil',
        'u_tex',
        'u_texOk',
        'u_texAspect',
        'u_mouse',
        'u_c0',
        'u_c1',
        'u_c2',
        'u_c3',
      ]) {
        uniforms[name] = context.getUniformLocation(prog, name);
      }
      context.useProgram(prog);
      context.uniform1i(context.getUniformLocation(prog, 'u_tex'), 0);
      context.activeTexture(context.TEXTURE0);
      loadMesh(context);

      usingWebgl = true;
      resize();
      raf = requestAnimationFrame(frame);
    } catch (err) {
      // Never leave the surface blank — report and fall back to CSS.
      console.warn('GradientField: falling back to CSS gradient', err);
      gl = null;
      program = null;
      usingWebgl = false;
      return;
    }

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => resize());
      resizeObserver.observe(canvas);
    }

    canvas.addEventListener('webglcontextlost', handleContextLost);
    window.addEventListener('pointermove', onPointer, { passive: true });
  });

  function handleContextLost(event: Event) {
    // A lost context is recoverable-ish but not worth the machinery here:
    // stop the loop, log it, and let the CSS fallback show through.
    event.preventDefault();
    console.warn('GradientField: webgl context lost, showing CSS fallback');
    cancelAnimationFrame(raf);
    raf = 0;
    gl = null;
    program = null;
    usingWebgl = false;
  }

  onDestroy(() => {
    if (raf) cancelAnimationFrame(raf);
    if (meshImage) {
      meshImage.onload = null;
      meshImage.onerror = null;
      meshImage = null;
    }
    resizeObserver?.disconnect();
    canvas?.removeEventListener('webglcontextlost', handleContextLost);
    window.removeEventListener('pointermove', onPointer);
    gl = null;
    program = null;
  });

  // Fallback colours track the same mesh position as the shader would, so the
  // CSS path is the same surface at lower fidelity rather than a second look.
  const css = $derived.by(() => {
    const toCss = ([r, g, b]: [number, number, number]) =>
      `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
    const stops = meshStops(hue);
    return {
      a: toCss(stops[0]),
      b: toCss(stops[1]),
      c: toCss(stops[2]),
      d: toCss(stops[3]),
      veil: Math.max(0, Math.min(1, veil)).toFixed(3),
    };
  });

</script>

<div
  class="field"
  aria-hidden="true"
  style={`--fa:${css.a}; --fb:${css.b}; --fc:${css.c}; --fd:${css.d}; --veil:${css.veil}; --mesh:url(${meshUrl});`}
>
  <canvas bind:this={canvas} class="gl" class:live={usingWebgl}></canvas>
  <!-- The scrim. On the WebGL path the shader has already applied it, so this
       only shows over the CSS fallback. -->
  <div class="scrim" class:hidden={usingWebgl}></div>
</div>

<style>
  .field {
    position: absolute;
    inset: 0;
    overflow: hidden;
    /* The same wallpaper the shader samples, under the same hue-tinted
       bodies. The bodies are far larger than the frame and heavily
       overlapped: the fallback has no blur pass, so the softness has to come
       from the geometry and from the image already being soft. */
    background:
      radial-gradient(120% 110% at 14% 26%, color-mix(in srgb, var(--fa) 78%, transparent), transparent 72%),
      radial-gradient(115% 105% at 86% 22%, color-mix(in srgb, var(--fb) 74%, transparent), transparent 72%),
      radial-gradient(125% 115% at 56% 92%, color-mix(in srgb, var(--fc) 70%, transparent), transparent 74%),
      radial-gradient(110% 100% at 30% 78%, color-mix(in srgb, var(--fd) 66%, transparent), transparent 74%),
      var(--mesh) center / cover no-repeat,
      #0b0b0e;
    transition: background 1.2s linear;
  }

  .scrim {
    position: absolute;
    inset: 0;
    background: rgb(3 3 5 / calc(var(--veil, 0.58) * 0.78));
    transition: background 1.2s linear, opacity 0.6s ease;
  }

  .scrim.hidden {
    opacity: 0;
  }

  .gl {
    display: block;
    width: 100%;
    height: 100%;
    opacity: 0;
    transition: opacity 0.6s ease;
  }

  .gl.live {
    opacity: 1;
  }
</style>
