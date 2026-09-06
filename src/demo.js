const files = {
'Nebula.Core/Rendering/ParticleSystem.cs': `using System.Numerics;
using Nebula.Core.Models;

namespace Nebula.Core.Rendering;

/// <summary>
/// A deterministic particle simulation with zero-allocation updates.
/// Separates simulation state from the rendering pipeline.
/// </summary>
public sealed class ParticleSystem
{
    private readonly Particle[] _particles;
    private readonly Random _random;
    private float _elapsed;

    public int Count => _particles.Length;
    public ReadOnlySpan<Particle> Particles => _particles;

    public ParticleSystem(int capacity = 2_048, int seed = 42)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(capacity);

        _particles = new Particle[capacity];
        _random = new Random(seed);

        Initialize();
    }

    public void Update(float deltaTime)
    {
        _elapsed += Math.Clamp(deltaTime, 0f, 0.1f);

        for (var i = 0; i < _particles.Length; i++)
        {
            ref var particle = ref _particles[i];
            var angle = particle.Phase + _elapsed * particle.Speed;
            var radius = particle.Radius;

            particle.Position = new Vector3(
                MathF.Cos(angle) * radius,
                MathF.Sin(angle * 0.5f) * radius * 0.25f,
                MathF.Sin(angle) * radius);

            particle.Opacity = 0.4f + 0.6f * MathF.Abs(
                MathF.Sin(_elapsed + particle.Phase));
        }
    }

    private void Initialize()
    {
        for (var i = 0; i < _particles.Length; i++)
        {
            _particles[i] = new Particle
            {
                Phase = _random.NextSingle() * MathF.Tau,
                Radius = 0.2f + _random.NextSingle() * 0.8f,
                Speed = 0.15f + _random.NextSingle() * 0.35f,
                Opacity = 1f,
                Position = Vector3.Zero
            };
        }
    }

    public void Reset()
    {
        _elapsed = 0f;
        Initialize();
    }
}
`,
'Nebula.Core/Models/Particle.cs': `using System.Numerics;

namespace Nebula.Core.Models;

public struct Particle
{
    public Vector3 Position;
    public float Phase;
    public float Radius;
    public float Speed;
    public float Opacity;
}
`,
'Nebula.Core/Program.cs': `using Nebula.Core.Rendering;

// C# source is editable in Forge Studio.
// Build this project with the .NET SDK outside the browser.
var system = new ParticleSystem(capacity: 2_048);
system.Update(1f / 60f);

Console.WriteLine($"Simulating {system.Count:N0} particles.");
`,
'Nebula.Core/Nebula.Core.csproj': `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>12</LangVersion>
  </PropertyGroup>
</Project>
`,
'Nebula.Web/index.html': `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Nebula — An experiment in motion</title>
    <link rel="stylesheet" href="./styles.css">
</head>
<body>
    <main>
        <header>
            <span class="brand"><span class="orb">✳</span> NEBULA</span>
            <span class="badge"><i></i> LIVE EXPERIMENT</span>
        </header>
        <section class="intro">
            <div class="eyebrow">A LITTLE CODE. INFINITE POSSIBILITIES.</div>
            <h1>Your next big idea,<br><em>in motion.</em></h1>
            <p>An interactive particle field, built with pure JavaScript.</p>
        </section>
        <section class="stage">
            <canvas id="scene" aria-label="Animated orbital particle field"></canvas>
            <div class="stage-caption"><span>ORBITAL FIELD / 001</span><span id="backend">INITIALIZING</span></div>
        </section>
        <section class="controls">
            <div><label for="count">Particle count</label><output id="count-label">2,048</output></div>
            <input id="count" type="range" min="128" max="4096" step="128" value="2048">
            <div class="actions"><button id="toggle">Ⅱ Pause simulation</button><button id="reset">↺ Reset</button></div>
        </section>
        <footer>MADE IN FORGE STUDIO <span>NO FRAMEWORKS. JUST POSSIBILITIES.</span></footer>
    </main>
    <script type="module" src="./src/app.js"></script>
</body>
</html>
`,
'Nebula.Web/styles.css': `:root { color-scheme: dark; font-family: Inter, system-ui, sans-serif; background: #101117; color: #f0eef8; }
* { box-sizing: border-box; }
body { margin: 0; }
main { max-width: 900px; margin: 0 auto; padding: 26px; }
header, .controls > div, footer, .stage-caption { display: flex; align-items: center; justify-content: space-between; }
.brand { font-size: 12px; font-weight: 700; letter-spacing: 3px; display: flex; align-items: center; gap: 8px; }
.orb { color: #b49ae8; font-size: 23px; }
.badge { font-size: 8px; letter-spacing: 1.4px; color: #9b98ad; }
.badge i { display: inline-block; width: 5px; height: 5px; background: #99d9b1; border-radius: 50%; margin-right: 5px; }
.intro { padding-top: 35px; }
.eyebrow { color: #9c90b5; font-size: 8px; letter-spacing: 1.5px; }
h1 { font-size: clamp(27px, 5vw, 44px); font-weight: 500; letter-spacing: -1.8px; line-height: 1.15; margin: 18px 0 12px; }
h1 em { font-style: normal; color: #b2a0db; }
p { font-size: 11px; color: #8e8b9c; line-height: 1.8; }
.stage { position: relative; height: 230px; margin: 26px 0; border: 1px solid #292535; border-radius: 10px; overflow: hidden; background: #12121d; }
canvas { width: 100%; height: 100%; display: block; }
.stage-caption { position: absolute; bottom: 12px; left: 14px; right: 14px; font-size: 7px; letter-spacing: 1.3px; color: #777185; pointer-events: none; }
.controls label { color: #aaa5ba; font-size: 11px; }
output { font-family: monospace; font-size: 11px; color: #cec0f0; }
input[type=range] { width: 100%; height: 3px; margin: 20px 0 24px; accent-color: #a790d4; }
.actions { display: flex; gap: 9px; }
button { cursor: pointer; border: 1px solid #3a324b; background: #242030; color: #d6cce8; padding: 11px 18px; border-radius: 6px; font: 11px system-ui; }
button:first-child { flex: 1; background: #b49ad9; border-color: #b49ad9; color: #20172e; }
button:hover { filter: brightness(1.12); }
footer { border-top: 1px solid #28232f; padding-top: 21px; margin-top: 34px; font-size: 7px; letter-spacing: 1.3px; color: #82758f; gap: 15px; }
footer span { text-align: right; color: #57505f; }
@media (max-width: 440px) { main { padding: 21px; } .badge { font-size: 7px; } footer span { display: none; } }
`,
'Nebula.Web/src/app.js': `import { ParticleStage } from './stage.js';
import { clamp } from './math.js';

/**
 * Nebula: a small experiment in motion.
 * Open the preview with F5. Every control is live.
 */
async function main() {
    const canvas = document.querySelector('#scene');
    const stage = new ParticleStage(canvas);
    await stage.initialize();

    document.querySelector('#backend').textContent = stage.backend;

    const count = document.querySelector('#count');
    const label = document.querySelector('#count-label');
    const toggle = document.querySelector('#toggle');

    count.addEventListener('input', () => {
        stage.count = clamp(Number(count.value), 128, 4096);
        label.textContent = stage.count.toLocaleString();
    });

    toggle.addEventListener('click', () => {
        stage.paused = !stage.paused;
        toggle.textContent = stage.paused
            ? '▶ Resume simulation'
            : 'Ⅱ Pause simulation';
    });

    document.querySelector('#reset').addEventListener('click', () => {
        stage.time = 0;
        stage.paused = false;
        toggle.textContent = 'Ⅱ Pause simulation';
        console.info('Particle simulation reset.');
    });

    stage.start();
    console.info('Nebula is running with ' + stage.backend + '.');
    console.info('Try changing the particle count or editing styles.css.');
}

main().catch(console.error);
`,
'Nebula.Web/src/math.js': `/** Clamp a finite value to the inclusive range [min, max]. */
export function clamp(value, min, max) {
    if (min > max) throw new RangeError('min must not exceed max');
    return Math.min(max, Math.max(min, value));
}

/** Linear interpolation. */
export function lerp(a, b, t) {
    return a + (b - a) * t;
}

/** Smooth Hermite interpolation, clamped to the unit interval. */
export function smoothstep(edge0, edge1, value) {
    if (edge0 === edge1) return value < edge0 ? 0 : 1;
    const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
}

/** Deterministic xorshift32 pseudo-random stream. */
export function seededRandom(seed = 42) {
    let state = seed || 1;
    return () => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return (state >>> 0) / 4294967296;
    };
}
`,
'Nebula.Web/src/stage.js': `import { seededRandom } from './math.js';

const shader = \`
struct Out { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) alpha: f32 };
@vertex fn vs(@builtin(vertex_index) v: u32, @location(0) data: vec4f) -> Out {
    let corners = array<vec2f, 6>(vec2f(-1,-1), vec2f(1,-1), vec2f(-1,1), vec2f(-1,1), vec2f(1,-1), vec2f(1,1));
    var out: Out;
    out.position = vec4f(data.xy + corners[v] * data.z, 0, 1);
    out.uv = corners[v]; out.alpha = data.w;
    return out;
}
@fragment fn fs(input: Out) -> @location(0) vec4f {
    let alpha = pow(max(0.0, 1.0 - length(input.uv)), 1.5) * input.alpha;
    return vec4f(0.7, 0.56, 0.92, alpha);
}
\`;

export class ParticleStage {
    constructor(canvas) {
        this.canvas = canvas;
        this.count = 2048;
        this.time = 0;
        this.paused = false;
        this.data = new Float32Array(4096 * 4);
        const random = seededRandom(42);
        this.particles = Array.from({ length: 4096 }, () => ({
            phase: random() * Math.PI * 2,
            radius: 0.22 + random() * 0.6,
            speed: 0.1 + random() * 0.25,
            tilt: random() * 0.9 - 0.45
        }));
    }

    async initialize() {
        try {
            const adapter = await navigator.gpu?.requestAdapter();
            if (!adapter) throw new Error('No GPU adapter');
            this.device = await adapter.requestDevice();
            this.context = this.canvas.getContext('webgpu');
            const format = navigator.gpu.getPreferredCanvasFormat();
            this.context.configure({ device: this.device, format });
            const module = this.device.createShaderModule({ code: shader });
            this.pipeline = this.device.createRenderPipeline({
                layout: 'auto',
                vertex: { module, entryPoint: 'vs', buffers: [{
                    arrayStride: 16, stepMode: 'instance',
                    attributes: [{ shaderLocation: 0, format: 'float32x4', offset: 0 }]
                }] },
                fragment: { module, entryPoint: 'fs', targets: [{ format, blend: {
                    color: { srcFactor: 'src-alpha', dstFactor: 'one' },
                    alpha: { srcFactor: 'one', dstFactor: 'one' }
                } }] }
            });
            this.buffer = this.device.createBuffer({
                size: this.data.byteLength,
                usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
            });
            this.backend = 'WEBGPU';
            this.device.lost.then(() => this.fallback());
        } catch {
            this.fallback();
        }
    }

    fallback() {
        if (this.backend === 'CANVAS 2D') return;
        if (this.context) {
            const next = this.canvas.cloneNode();
            this.canvas.replaceWith(next);
            this.canvas = next;
        }
        this.context = this.canvas.getContext('2d');
        this.backend = 'CANVAS 2D';
        const label = document.querySelector('#backend');
        if (label) label.textContent = this.backend;
    }

    start() {
        let last = performance.now();
        const frame = now => {
            if (!this.paused) this.time += Math.min((now - last) / 1000, 0.05);
            last = now;
            this.render();
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    }

    render() {
        const dpr = Math.min(devicePixelRatio, 2);
        const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
        const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
        if (this.canvas.width !== width) this.canvas.width = width;
        if (this.canvas.height !== height) this.canvas.height = height;
        for (let i = 0; i < this.count; i++) {
            const p = this.particles[i];
            const angle = p.phase + this.time * p.speed;
            this.data.set([
                Math.cos(angle) * p.radius,
                Math.sin(angle) * p.radius * 0.52 + Math.sin(angle * 2) * p.tilt * 0.22,
                0.004 + (i % 3) * 0.002,
                0.25 + (Math.sin(angle) + 1) * 0.32
            ], i * 4);
        }
        if (this.backend === 'WEBGPU') {
            const gpu = this.device;
            gpu.queue.writeBuffer(this.buffer, 0, this.data);
            const encoder = gpu.createCommandEncoder();
            const pass = encoder.beginRenderPass({ colorAttachments: [{
                view: this.context.getCurrentTexture().createView(),
                clearValue: { r: 0.071, g: 0.071, b: 0.114, a: 1 },
                loadOp: 'clear', storeOp: 'store'
            }] });
            pass.setPipeline(this.pipeline);
            pass.setVertexBuffer(0, this.buffer);
            pass.draw(6, this.count);
            pass.end();
            gpu.queue.submit([encoder.finish()]);
        } else {
            const ctx = this.context;
            ctx.fillStyle = '#12121d';
            ctx.fillRect(0, 0, width, height);
            for (let i = 0; i < this.count; i++) {
                const [x, y, size, alpha] = this.data.subarray(i * 4, i * 4 + 4);
                ctx.fillStyle = 'rgba(182,145,235,' + alpha + ')';
                ctx.beginPath();
                ctx.arc((x + 1) * width / 2, (1 - y) * height / 2, size * width / 3, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }
}
`,
'Nebula.Web/tests/math.test.js': `import { clamp, lerp, smoothstep, seededRandom } from '../src/math.js';

// Run with Test > Run All Tests, or enter "test" in the terminal.
// The test and assert globals are provided by the isolated test worker.
test('clamp keeps an in-range value', () => {
    assert.equal(clamp(5, 0, 10), 5);
});

test('clamp enforces both boundaries', () => {
    assert.equal(clamp(-4, 0, 10), 0);
    assert.equal(clamp(18, 0, 10), 10);
});

test('clamp rejects an inverted range', () => {
    assert.throws(() => clamp(5, 10, 0));
});

test('lerp interpolates the midpoint', () => {
    assert.equal(lerp(10, 20, 0.5), 15);
});

test('smoothstep is continuous at both boundaries', () => {
    assert.equal(smoothstep(0, 1, -1), 0);
    assert.equal(smoothstep(0, 1, 0.5), 0.5);
    assert.equal(smoothstep(0, 1, 2), 1);
});

test('a seed produces a repeatable random stream', () => {
    const a = seededRandom(42);
    const b = seededRandom(42);
    for (let i = 0; i < 100; i++) assert.equal(a(), b());
});

test('random values stay in the unit interval', () => {
    const random = seededRandom(123);
    for (let i = 0; i < 1000; i++) {
        const value = random();
        assert(value >= 0 && value < 1, 'Value outside [0, 1)');
    }
});
`,
'scripts/diagnostics.js': `// A standalone script for the trace debugger.
// Run > Trace Current JavaScript pauses before each top-level statement.
// F10 steps. F8 continues. Click the gutter to set a source breakpoint.

const project = 'Nebula';
const particleCount = 2048;
const bytesPerParticle = 32;
const memoryBytes = particleCount * bytesPerParticle;

console.log('Project:', project);
console.log('Particle memory:', memoryBytes / 1024, 'KiB');

const samples = [16.1, 16.4, 15.9, 16.3, 16.0];
const average = samples.reduce((sum, value) => sum + value, 0) / samples.length;
const framesPerSecond = 1000 / average;

console.log('Mean frame time:', average.toFixed(2), 'ms');
console.log('Estimated throughput:', framesPerSecond.toFixed(1), 'fps');
console.log('Diagnostics complete.');
`,
'.editorconfig': `root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 4
insert_final_newline = true
`,
'.gitignore': `bin/
obj/
node_modules/
.DS_Store
`,
'README.md': `# Nebula

An interactive particle experiment, and your first Forge Studio workspace.

## Try it

- F5: launch the Nebula.Web browser preview.
- Ctrl+Shift+B: validate JavaScript and JSON sources.
- Test > Run All Tests: execute seven real tests in an isolated worker.
- Open scripts/diagnostics.js and choose Run > Trace Current JavaScript.
- Ctrl+P: open a file. Ctrl+Shift+P: run a command.
- Ctrl+S: save to browser storage; explicit saves write imported disk handles.
- File > Export Workspace: keep a portable .forge.json backup.
- File > Export Project ZIP: get the actual source tree.

## Projects

Nebula.Web runs entirely in the browser with ES modules and WebGPU / Canvas 2D.
Nebula.Core is editable C# source. Compilation requires a local .NET 8+ SDK;
Forge Studio does not emulate Roslyn, MSBuild, NuGet, or a CLR runtime.

## About execution

Browser previews run in an opaque-origin sandboxed iframe. JavaScript scripts,
unit tests, and the trace debugger execute in a terminable Worker created by a
separate sandbox. Only run code you trust. Trace mode stops at top-level
statements, not inside functions. It is not a full VM debugger.

## About saving

Auto-recovery uses IndexedDB and does not silently write to your disk.
Local changes compare against a workspace baseline, not a Git repository.
Export backups regularly; clearing browser site data removes local workspaces.
`
};
export const demoWorkspace={format:'forge-workspace',version:1,name:'Nebula',
 activePath:'Nebula.Core/Rendering/ParticleSystem.cs',
 tabs:['Nebula.Core/Rendering/ParticleSystem.cs','Nebula.Web/src/app.js','Nebula.Web/index.html','Nebula.Web/styles.css'],
 files:Object.entries(files).map(([path,text])=>({path,text}))};
export function newWorkspace(kind='web',name='Workspace'){
  if(kind==='demo')return structuredClone(demoWorkspace);
  const base=kind==='javascript'?{'main.js':`// Welcome to ${name}.\n// Run this file with Ctrl+F5.\n\nconst message = 'Hello from Forge Studio!';\nconsole.log(message);\n`}:kind==='dotnet'?{'Program.cs':`// C# editing workspace. Build with the .NET SDK locally.\nConsole.WriteLine("Hello from ${name.replace(/[^a-zA-Z0-9 _-]/g,'')}!");\n`,'App.csproj':'<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <OutputType>Exe</OutputType>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n'}:{'index.html':'<!doctype html>\n<html lang="en">\n<head>\n    <meta charset="utf-8">\n    <title>My app</title>\n    <link rel="stylesheet" href="./styles.css">\n</head>\n<body>\n    <h1>Hello, world.</h1>\n    <button id="hello">Click me</button>\n    <script type="module" src="./main.js"></script>\n</body>\n</html>\n','main.js':`document.querySelector('#hello').addEventListener('click', () => {\n    document.querySelector('h1').textContent = 'Built with Forge Studio.';\n    console.log('Your app is running.');\n});\n`,'styles.css':'body {\n    font-family: system-ui, sans-serif;\n    background: #17151f;\n    color: #e6dcfa;\n    padding: 48px;\n}\n\nbutton {\n    padding: 12px 24px;\n    border: none;\n    border-radius: 6px;\n    background: #b49ade;\n    cursor: pointer;\n}\n'};
  const paths=Object.keys(base);return {format:'forge-workspace',version:1,name,activePath:paths[0],tabs:paths.slice(0,3),files:Object.entries(base).map(([path,text])=>({path,text}))};
}
