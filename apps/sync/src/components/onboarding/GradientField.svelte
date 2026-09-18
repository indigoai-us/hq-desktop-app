<script lang="ts">
  /**
   * The living background behind the first-run intro: four soft colour bodies
   * drifting through a dark field, sampled from the HQ brand spectrum.
   *
   * Rendered with raw WebGL (no library, no bundle cost) as a single
   * fullscreen triangle. Everything that can fail — no WebGL, a lost context,
   * a machine that prefers reduced motion — falls back to a static CSS
   * gradient that uses the same colours, so the surface is never blank.
   */
  import { onDestroy, onMount } from 'svelte';
  import { sampleSpectrum, FIELD_SPECTRUM } from '../../lib/intro-sequence';

  interface Props {
    /** 0..1 along the brand spectrum. Drives the colour of the field. */
    hue?: number;
    /** 0..1 — how bright the colour bodies burn. Ramps up during the overture. */
    intensity?: number;
    /** Freeze the field (reduced motion, or the window went to the background). */
    still?: boolean;
  }

  let { hue = 0, intensity = 1, still = false }: Props = $props();

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

    // Four bodies on slow, mutually-prime orbits so the field never visibly
    // loops back to a pose the viewer has already seen.
    vec2 a0 = vec2(sin(t * 0.11) * 0.30 - 0.62, cos(t * 0.13) * 0.22 + 0.20);
    vec2 a1 = vec2(cos(t * 0.09) * 0.30 + 0.64, sin(t * 0.077) * 0.24 - 0.18);
    vec2 a2 = vec2(sin(t * 0.067) * 0.34 + 0.10, cos(t * 0.101) * 0.16 + 0.54);
    vec2 a3 = vec2(cos(t * 0.083) * 0.34 - 0.14, sin(t * 0.059) * 0.16 - 0.54);

    float b0 = body(p, a0, 0.46);
    float b1 = body(p, a1, 0.42);
    float b2 = body(p, a2, 0.38);
    float b3 = body(p, a3, 0.40);

    vec3 col = vec3(0.0);
    col += u_c0 * b0;
    col += u_c1 * b1;
    col += u_c2 * b2;
    col += u_c3 * b3;
    col *= u_intensity;

    // God rays: a light just above the top edge throws soft shafts down the
    // field. Two interfering angular waves give shafts that drift and breathe
    // instead of rotating like a fan; the pow() sharpens them into rays.
    vec2 lp = vec2(sin(t * 0.05) * 0.25, 0.92);
    vec2 ld = p - lp;
    float ang = atan(ld.y, ld.x);
    float dist = length(ld);
    float shaft = (sin(ang * 22.0 + t * 0.16) * 0.5 + 0.5)
                * (sin(ang * 9.0 - t * 0.11 + 1.7) * 0.5 + 0.5)
                * (sin(ang * 3.5 + t * 0.07) * 0.35 + 0.65);
    shaft = pow(shaft, 2.6);
    float reach = smoothstep(1.7, 0.05, dist) * smoothstep(-0.6, 0.35, -ld.y + 0.9);
    vec3 rayTint = mix(u_c0, vec3(1.0), 0.55);
    col += rayTint * shaft * reach * 0.42 * u_intensity;

    // A slow aurora band drifting across the upper third, in the current hue.
    float band = exp(-pow((p.y - 0.18 - sin(p.x * 1.3 + t * 0.12) * 0.09) * 5.5, 2.0));
    col += mix(u_c1, u_c2, sin(t * 0.08) * 0.5 + 0.5) * band * 0.16 * u_intensity;

    // Dark base so white type stays legible over every part of the field.
    vec3 base = vec3(0.032, 0.032, 0.044);
    col = base + col * 1.15;

    // Overlapping bodies average toward grey; pull saturation back up so the
    // field reads as brand colour rather than a smudge.
    float luma = dot(col, vec3(0.299, 0.587, 0.114));
    col = mix(vec3(luma), col, 1.45);
    col = max(col, vec3(0.0));

    // Vignette pulls the eye to the centred copy.
    // Keep the colour bodies away from burning out under the type: a very
    // wide, very gentle dip toward the centre. Wide enough that it never reads
    // as a shape — a visible dark oval behind the copy is exactly what this
    // must not become.
    float centre = smoothstep(1.6, 0.0, length(p * vec2(0.5, 1.0)));
    col *= mix(1.0, 0.86, centre);

    // A light touch of edge falloff keeps the frame from looking like a
    // rectangle of colour pasted onto the window.
    float edge = smoothstep(1.35, 0.55, length(p * vec2(0.85, 1.05)));
    col *= mix(0.78, 1.0, edge);

    // Filmic-ish rolloff keeps the hot centres from clipping to flat white.
    col = col / (col + vec3(1.0)) * 1.46;

    // Dither: ±1/255 of noise, enough to break 8-bit banding.
    col += (hash(gl_FragCoord.xy + fract(t)) - 0.5) / 255.0;

    fragColor = vec4(col, 1.0);
  }`;

  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let raf = 0;
  let start = 0;
  let frozenTime = 0;
  let uniforms: Record<string, WebGLUniformLocation | null> = {};
  let resizeObserver: ResizeObserver | null = null;

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

    // Four samples spread across the spectrum, offset from the current hue so
    // the bodies are related but never identical.
    const stops: Array<[number, number, number]> = [0, 0.18, 0.4, 0.62].map((offset) =>
      sampleSpectrum((hue + offset) % 1, FIELD_SPECTRUM),
    ) as Array<[number, number, number]>;
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
        'u_c0',
        'u_c1',
        'u_c2',
        'u_c3',
      ]) {
        uniforms[name] = context.getUniformLocation(prog, name);
      }
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
    resizeObserver?.disconnect();
    canvas?.removeEventListener('webglcontextlost', handleContextLost);
    gl = null;
    program = null;
  });

  // Fallback colours track the same spectrum position as the shader would.
  const css = $derived.by(() => {
    const toCss = (t: number) => {
      const [r, g, b] = sampleSpectrum(t % 1, FIELD_SPECTRUM);
      return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
    };
    return {
      a: toCss(hue),
      b: toCss(hue + 0.18),
      c: toCss(hue + 0.4),
    };
  });
</script>

<div
  class="field"
  aria-hidden="true"
  style={`--fa:${css.a}; --fb:${css.b}; --fc:${css.c};`}
>
  <canvas bind:this={canvas} class="gl" class:live={usingWebgl}></canvas>
</div>

<style>
  .field {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background:
      radial-gradient(60% 55% at 22% 32%, color-mix(in srgb, var(--fa) 62%, transparent), transparent 70%),
      radial-gradient(55% 50% at 78% 28%, color-mix(in srgb, var(--fb) 58%, transparent), transparent 70%),
      radial-gradient(60% 60% at 52% 84%, color-mix(in srgb, var(--fc) 54%, transparent), transparent 72%),
      #0b0b0e;
    transition: background 1.2s linear;
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
