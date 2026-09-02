# Escape From Larpov — Architecture Contract

**Status:** binding  
**Runtime:** modern evergreen browsers, HTML5, Three.js r180, WebGL2  
**Primary target:** stable 60 Hz simulation with a zero-allocation hot path

This document is the architectural authority for EFL. Later agents MUST preserve these contracts. If a requirement cannot be met, update this document in the same commit and describe the migration; do not introduce a silent second convention.

The words **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## 1. Non-negotiable rules

1. EFL is a procedural game. Repository and runtime code MUST NOT depend on authored textures, meshes, animations, fonts, music, impulse responses, or sound files. Geometry is generated with Three.js buffer geometry, visual detail is generated in shaders or code-created `CanvasTexture`/`DataTexture` objects, and sound is synthesized with Web Audio nodes.
2. `three` is the only runtime package. Vite is a build-time tool. Adding a runtime dependency requires an architecture revision.
3. WebGL2 is mandatory. There is no WebGL1 fallback. Failure to create a WebGL2 context is a hard, user-visible startup error.
4. There is exactly one `Engine`, one engine clock, one `Input`, and one `EventBus` per running game instance.
5. No subsystem owns a `requestAnimationFrame` loop. No gameplay code may call `performance.now()`, `Date.now()`, `THREE.Clock`, or use DOM event timestamps as game time. The RAF timestamp enters only `EngineClock`; every system consumes the resulting `EngineFrame`.
6. Simulation runs at a fixed step. Rendering may interpolate, but it MUST NOT mutate authoritative gameplay state.
7. The main loop, fixed-step methods, render methods, input sampling, event dispatch, raycasts, and collision queries MUST produce zero steady-state JavaScript allocations. Allocate and warm pools during initialization or loading.
8. Subsystems MUST communicate through the service contracts below or the global event bus. They MUST NOT import concrete instances from another subsystem.
9. Every resource owner is responsible for deterministic cleanup through `dispose()`.
10. All random gameplay decisions MUST use a seeded PRNG service owned by `world`; `Math.random()` is forbidden in simulation code.

## 2. Runtime layers and ownership

```text
DOM / Browser APIs
  └─ core: EngineClock, Engine, Input, EventBus
       ├─ render
       ├─ materials
       ├─ sky
       ├─ physics
       ├─ world
       ├─ player
       ├─ weapons
       ├─ fx
       ├─ ai
       ├─ ui
       └─ audio
```

Core owns scheduling and shared services. Subsystems own domain state. Ownership is exclusive:

- `Engine` owns the WebGL2 context, `THREE.WebGLRenderer`, default MRT G-buffer, frame object, lifecycle, and resize propagation.
- `render` is the only subsystem allowed to issue render passes or change the renderer's active target/state.
- `physics` is the only subsystem allowed to integrate bodies or mutate the collision broadphase.
- `world` owns the seed, procedural level description, chunk lifetime, and static environment entities.
- `player`, `weapons`, and `ai` own authoritative gameplay state in their domains.
- `materials`, `sky`, and `fx` own GPU resources they create.
- `ui` owns its DOM subtree. `audio` owns its `AudioContext` and Web Audio graph.

## 3. Coordinate, unit, and identity contract

- Three.js right-handed coordinates are used: **+Y up**, **-Z forward**, **+X right**.
- One world unit is one meter. Time is seconds. Velocity is meters/second. Mass is kilograms. Angles are radians.
- Directions and normals passed across boundaries MUST be normalized.
- Runtime entities use stable unsigned integer IDs. `0` means “no entity”. IDs, not object references, cross event boundaries.
- Public query APIs accept caller-owned output objects (`out`) and return a boolean/status or the same output reference. They MUST NOT create vectors, arrays, hit records, or iterators per call.
- Three.js objects passed in an event payload are read-only for the duration of synchronous dispatch and MUST NOT be retained. A listener that needs the value later copies it into a pool it owns.

## 4. Unified timing contract

`EngineClock` is the sole time authority.

Default policy:

- fixed delta: `1 / 60` seconds;
- maximum accepted frame delta: `0.1` seconds;
- maximum fixed steps per rendered frame: `5`;
- excess backlog is dropped after the step cap to prevent a spiral of death;
- rendering uses `simulationTime + accumulator` as interpolated `elapsed` time.

Every hot-path call receives the same sealed, engine-owned `EngineFrame` object. Its fields are mutated in place:

```js
{
  frame,             // rendered-frame sequence number
  fixedStep,         // authoritative simulation-step sequence number
  delta,             // fixed delta in fixed phase; scaled frame delta otherwise
  unscaledDelta,     // clamped wall delta from RAF
  fixedDelta,
  elapsed,           // simulation time in fixed phase; interpolated engine time otherwise
  simulationTime,
  alpha,             // accumulator / fixedDelta, [0, 1)
  substep,
  substepCount,
  width,
  height,
  bufferWidth,
  bufferHeight,
  pixelRatio,
  isFixedStep
}
```

Shader `uTime`, animation, recoil, particles, UI transitions, AI timers, and audio event conversion MUST derive from `frame.elapsed` or `frame.simulationTime`. `AudioContext.currentTime` MAY be used only as the Web Audio scheduling destination after converting from engine time.

Fixed-step order is strict:

1. `Input.beginFixedStep(frame)` drains accumulated mouse input.
2. `world.fixedUpdate`, `ai.fixedUpdate`, `player.fixedUpdate`, `weapons.fixedUpdate` prepare commands/forces.
3. `physics.fixedUpdate` integrates exactly one fixed step.
4. `world.postPhysics`, `player.postPhysics`, `weapons.postPhysics`, `ai.postPhysics` consume results.
5. After all substeps, visual `update` and `lateUpdate` phases run once, then `render.render(frame)` runs once.

## 5. Event Bus contract

### 5.1 One bus

The application MUST create one synchronous Event Bus and inject it into `Engine`. No subsystem may create a private domain bus. The required interface is:

```js
class EventBus {
  on(type, listener, owner = null) {}
  off(type, listener, owner = null) {}
  emit(type, payload) {}
  clearOwner(owner) {}
  dispose() {}
}
```

Rules:

- Dispatch is synchronous and registration-ordered.
- A listener signature is `(payload) => void`; listeners MUST NOT mutate or retain payloads.
- Subscription changes during dispatch take effect after the current dispatch.
- Duplicate `(type, listener, owner)` registrations are rejected.
- Exceptions are not swallowed; they reach `Engine`'s fatal-error boundary.
- High-frequency publishers reuse preallocated payload objects.
- Wildcards, string prefixes, and subsystem-local aliases are forbidden.
- `clearOwner(system)` is called during subsystem disposal.
- Event names are lower-case `snake_case` constants. Ad-hoc event strings are forbidden.

### 5.2 Global vocabulary

These four events are the initial complete global vocabulary:

#### `bullet_fired`

Published once when a shot becomes authoritative, before impact processing.

```js
{
  shotId,            // uint32
  ownerId,           // uint32
  weaponId,          // uint32
  origin,             // read-only THREE.Vector3
  direction,          // normalized read-only THREE.Vector3
  muzzleVelocity,     // m/s; 0 for hitscan
  simulationTime      // seconds
}
```

Publisher: `weapons`. Consumers: `fx`, `audio`, `ai`, optionally `physics` for projectile spawning.

#### `player_damaged`

Published after health/armor has accepted damage.

```js
{
  playerId,
  sourceId,
  amount,
  damageType,         // 'ballistic' | 'impact' | 'environmental'
  hitPoint,           // read-only THREE.Vector3
  hitNormal,          // normalized read-only THREE.Vector3
  remainingHealth,
  simulationTime
}
```

Publisher: `player`. Consumers: `ui`, `fx`, `audio`, `ai`.

#### `surface_impact`

Published for an authoritative projectile or physical impact that warrants feedback.

```js
{
  surface,            // one SurfaceType value
  point,              // read-only THREE.Vector3
  normal,             // normalized read-only THREE.Vector3
  impulse,
  projectileId,
  sourceId,
  simulationTime
}
```

Publisher: `physics` or `weapons` (never both for the same impact). Consumers: `fx`, `audio`, `ai`.

#### `state_changed`

Published for meaningful finite-state transitions; not for continuously changing values.

```js
{
  scope,              // 'engine' | 'player' | 'weapon' | 'ai' | 'ui' | 'world'
  entityId,           // uint32, or 0 for a singleton
  previous,
  next,
  reason,
  simulationTime
}
```

Publishers: state owners. Consumers: any interested subsystem.

Adding an event requires defining one canonical name, exact payload schema, publisher, consumers, ownership semantics, and frequency here first.

## 6. Global surface types

There are exactly six initial surface identifiers:

```js
export const SurfaceType = Object.freeze({
  CONCRETE: 'concrete',
  METAL: 'metal',
  WOOD: 'wood',
  FLESH: 'flesh',
  PLASTER: 'plaster',
  GLASS: 'glass',
});
```

`concrete`, `metal`, `wood`, `flesh`, `plaster`, and `glass` are shared semantic IDs across procedural materials, collision data, penetration/ricochet physics, impact FX, footsteps, and synthesized audio. Alternate spellings and subsystem-specific surface enums are forbidden.

Every collidable primitive MUST have a surface type when registered with `physics`. Every visible environment mesh MUST expose the same value at `object.userData.surface`. Composite objects split collision primitives by surface. Unknown/missing values are startup or generation errors, not a seventh “default” surface.

Recommended semantic tendencies (tuning remains data-driven):

| Surface | Physical tendency | Visual tendency | Synthesized audio tendency |
|---|---|---|---|
| `concrete` | hard, low penetration | aggregate/noise, chipped edge | short broadband crack |
| `metal` | hard, ricochet-prone | anisotropic/oxidized | resonant ping + noise |
| `wood` | penetrable, splintering | directional grain | filtered knock/splinter |
| `flesh` | soft, energy-absorbing | subsurface-like procedural shading | damp low transient |
| `plaster` | brittle, dusty | fine porous noise | dry snap + noise tail |
| `glass` | brittle, transmissive | procedural distortion | high chime + shard burst |

## 7. Shared service object

`Engine` injects one frozen service object into every `init(services)` call:

```js
{
  engine,
  clock,
  frame,
  canvas,
  gl,
  renderer,
  gBuffer,
  capabilities,
  eventBus,
  input,
  subsystems
}
```

`services` is immutable. Objects referenced by it remain owned by their declared owner. A subsystem caches service references during `init`; it MUST NOT perform service discovery in the hot path.

All eleven subsystem instances are registered before `Engine.init()`. Each has a unique canonical `id`, `init(services)`, and `dispose()`. `init` MAY be asynchronous. Per-frame lifecycle methods MUST be synchronous.

## 8. The eleven subsystem contracts

### 8.1 `render`

**Owns:** main `THREE.Scene`, active camera selection, render graph, culling policy, post-processing targets other than the engine G-buffer.  
**Depends on:** engine renderer/G-buffer; later consumes `materials`, `sky`, `world`, `fx` roots.

Required API:

```js
init(services)
getScene()                         // stable THREE.Scene reference
setActiveCamera(camera)
getActiveCamera()                  // stable reference; no fallback allocation
resize(width, height, pixelRatio, bufferWidth, bufferHeight)
update(frame)                      // visibility and pass preparation only
render(frame)                      // the only place that issues renderer passes
dispose()
```

`render` MUST explicitly set render targets, viewport, scissor, clear state, and restore a documented baseline. It MUST support the engine-provided MRT target. Other systems may add/remove owned `Object3D` roots only during init, load/unload, or deferred queues—not while the scene is traversed.

### 8.2 `materials`

**Owns:** all shared procedural `Material`, shader chunks, generated textures, material uniforms, and material cache.  
**Depends on:** `render` capabilities and global surfaces.

Required API:

```js
init(services)
warmup(renderer, scene, camera)
getSurfaceMaterial(surfaceType, variantId) // cached stable reference
getDepthMaterial(surfaceType, variantId)   // cached stable reference
update(frame)                              // writes shared uniforms in place
dispose()
```

Materials MUST be keyed by global surface type plus a numeric variant. They MUST NOT be cloned per mesh. Time uniforms use `frame.elapsed`. Shader code MUST be deterministic for a given world seed and object seed.

### 8.3 `sky`

**Owns:** procedural atmosphere mesh/material, sun/moon state, fog/exposure recommendations.  
**Depends on:** `render`, `materials`, world seed.

Required API:

```js
init(services)
setPreset(presetId, transitionSeconds)
getSunDirection(outVector3)        // writes to caller-owned output
getAmbientState(outState)          // writes numbers into caller-owned object
update(frame)
dispose()
```

The sky MUST be analytic/procedural; image cubemaps and downloaded weather textures are forbidden. It may recommend exposure/fog but `render` owns applying renderer state.

### 8.4 `world`

**Owns:** seed/PRNG, level grammar, procedural chunks, static entity IDs, spawn points, and static render roots.  
**Depends on:** `render`, `materials`, `physics`, `sky`.

Required API:

```js
init(services)
generate(seed)                     // deterministic for seed + version
getSeed()
getSpawn(spawnId, outTransform)    // no allocation
getSurfaceAt(position, outResult)  // no allocation
fixedUpdate(frame)                 // queues chunk/body changes before physics
postPhysics(frame)
update(frame)                      // visual interpolation/streaming commits
dispose()
```

Chunk generation may allocate off the hot path. Chunk activation/deactivation is committed at safe phase boundaries. A chunk owns and disposes its render objects, static colliders, and pooled metadata together.

### 8.5 `physics`

**Owns:** broadphase, colliders, dynamic bodies, trigger pairs, ray/sweep scratch memory, collision layers.  
**Depends on:** global surfaces only; it MUST NOT depend on visual meshes.

Required API:

```js
init(services)
addBody(bodyDescriptor)            // load/spawn phase; returns stable uint32 ID
removeBody(bodyId)                 // deferred if stepping
raycast(origin, direction, maxDistance, mask, outHit)
sweepCapsule(capsule, displacement, mask, outHit)
getBodyTransform(bodyId, outPosition, outQuaternion)
setKinematicTarget(bodyId, position, quaternion)
fixedUpdate(frame)                 // integrates exactly frame.fixedDelta
update(frame)                      // optional interpolation only
dispose()
```

Every hit writes `entityId`, `surface`, distance, point, and normal into caller-owned storage. Physics is deterministic for equal seed, inputs, and fixed-step sequence. It emits at most one `surface_impact` for a single authoritative impact.

### 8.6 `player`

**Owns:** local player state, health/armor/stamina, locomotion controller, stance, view angles, camera rig, and player body ID.  
**Depends on:** `input`, `physics`, `world`, `render`, `eventBus`.

Required API:

```js
init(services)
spawn(spawnTransform)
applyDamage(damageDescriptor)      // authoritative; emits player_damaged
getEntityId()
getViewTransform(outPosition, outQuaternion)
getState(outState)
fixedUpdate(frame)                 // consumes movement/action input
postPhysics(frame)                 // grounding and resolved transform
update(frame)                      // interpolates camera/view model
dispose()
```

Input is read, never owned. Jump/reload/fire edges are consumed once. Camera shake and lean are visual offsets and MUST NOT corrupt the authoritative body transform.

### 8.7 `weapons`

**Owns:** inventory, weapon finite-state machines, ammunition, recoil state, ballistic/projectile pools, and shot IDs.  
**Depends on:** `player`, `physics`, `world`, `eventBus`.

Required API:

```js
init(services)
equip(slotId)
requestReload()
getActiveWeaponId()
getState(outState)
fixedUpdate(frame)                 // authoritative fire/reload transitions
postPhysics(frame)                 // resolves projectile/body results
update(frame)                      // interpolated view-model/recoil visuals
dispose()
```

A valid shot emits exactly one `bullet_fired`. A resolved hit emits exactly one `surface_impact` from either `weapons` or `physics`, according to projectile ownership. Weapons MUST NOT call FX, UI, or audio directly.

### 8.8 `fx`

**Owns:** pooled muzzle flashes, tracers, impacts, decals, particles, camera effects, and their GPU buffers.  
**Depends on:** `render`, `materials`, `eventBus`.

Required API:

```js
init(services)
update(frame)
lateUpdate(frame)
dispose()
```

`fx` subscribes to `bullet_fired`, `surface_impact`, and `player_damaged`. All event handlers acquire preallocated pool entries; pool exhaustion drops the least important effect instead of allocating. FX is visual-only and MUST NOT influence authoritative physics.

### 8.9 `ai`

**Owns:** NPC IDs, perception memory, behavior state, navigation data, decision timers, and command buffers.  
**Depends on:** `world`, `physics`, `weapons`, `eventBus`, seeded PRNG streams.

Required API:

```js
init(services)
spawn(archetypeId, transform)      // returns stable entity ID
remove(entityId)                   // deferred at fixed-step boundary
setTarget(entityId, targetId)
getState(entityId, outState)
fixedUpdate(frame)                 // perception/decision and commands
postPhysics(frame)                 // resolved movement/perception
update(frame)                      // visual interpolation only
dispose()
```

AI decisions run on deterministic fixed-step budgets. Expensive perception is staggered by stable entity ID. AI may react to events but MUST query authoritative state before acting on delayed information.

### 8.10 `ui`

**Owns:** one DOM root, HUD, menus, accessibility labels, and presentation-only UI state.  
**Depends on:** `player`, `weapons`, `eventBus`, `input` lock state.

Required API:

```js
init(services)
setVisible(viewId, visible)
update(frame)
resize(width, height, pixelRatio, bufferWidth, bufferHeight)
dispose()
```

UI reads state through allocation-free snapshots and event handlers. DOM writes are coalesced and occur only when displayed values change. UI MUST NOT poll the DOM for gameplay state or drive authoritative state directly; requests go through declared commands/state transitions.

### 8.11 `audio`

**Owns:** `AudioContext`, master graph, procedural synth voices, spatial emitters, and voice pools.  
**Depends on:** `eventBus`, `world` acoustics, `player` listener transform.

Required API:

```js
init(services)
unlock()                           // user gesture; resumes AudioContext
setMasterGain(value)
update(frame)                      // listener and pooled emitter updates
dispose()
```

Audio subscribes to `bullet_fired`, `surface_impact`, `player_damaged`, and selected `state_changed` transitions. Sound is synthesized at runtime with oscillators, filters, noise buffers generated in code, waveshapers, and delays. Fetching/decoding audio assets is forbidden. Voice exhaustion uses priority-based stealing, never allocation.

## 9. Input contract

`src/core/Input.js` is the only DOM input adapter. It owns listeners, pointer lock, action latches, and mouse accumulation. It exposes numeric `InputAction` IDs, held/pressed/released queries, movement axes, lean, and look deltas.

Bindings are canonical:

| Action | Binding |
|---|---|
| movement | W/A/S/D |
| jump | Space |
| crouch | Left/Right Ctrl |
| sprint | Left/Right Shift |
| lean | Q/E |
| reload | R |
| aim | RMB |
| fire | LMB |

Clicking the canvas requests pointer lock with `canvas.requestPointerLock`; raw mouse input is requested first and falls back safely. Gameplay input is captured only while the canvas owns pointer lock. Pointer-lock loss, blur, and hidden-document transitions clear held state to prevent stuck actions.

Engine calls `beginFrame` once, `beginFixedStep` before every fixed step, and `endFrame` once. Mouse deltas stay accumulated until a fixed step consumes them, so input is not lost on render frames without simulation steps.

## 10. Render and MRT contract

Engine creates a WebGL2 context explicitly and validates `MAX_DRAW_BUFFERS` and `MAX_COLOR_ATTACHMENTS`. The default G-buffer is a `THREE.WebGLRenderTarget` with multiple color attachments and one depth texture. Attachments are linear, nearest-filtered, mip-free render textures. Half-float is used only when `EXT_color_buffer_float` is available; otherwise the engine falls back to unsigned-byte attachments.

Default semantic attachment order:

1. albedo + opacity/mask;
2. encoded normal + roughness;
3. material parameters + emissive.

`render` may extend semantics only after updating this contract. G-buffer dimensions always equal drawing-buffer dimensions. DPR is capped by Engine configuration. Render targets resize only on a viewport change.

## 11. Allocation and performance policy

Forbidden in hot paths after warmup:

- `new`, object/array literals, spread syntax, closures, promises, generators, and array iterator helpers;
- `Vector3.clone()`, implicit result objects, template strings for changing labels, and per-frame uniform objects;
- adding/removing DOM nodes, compiling shaders, creating GPU resources, or growing pools;
- unbounded event queues or unbounded catch-up simulation.

Required patterns:

- typed arrays and structure-of-arrays for large homogeneous state;
- reusable `THREE.Vector*`, quaternion, matrix, ray, and hit scratch objects;
- fixed-capacity pools with explicit reset;
- indexed `for` loops over stable dense arrays;
- caller-owned `out` parameters;
- cached event listener functions and one bound RAF callback;
- load-time shader compilation and representative warmup draws.

Development profiling MAY instrument allocations, but production hot paths stay instrumentation-free. A feature that cannot respect its frame/pool budget degrades deterministically or is deferred; it does not allocate opportunistically.

## 12. Lifecycle and failure policy

Canonical states are `created → initializing → ready → running ↔ stopped → disposing → disposed`; `error` and `context_lost` are exceptional states. Engine publishes transitions through `state_changed`.

- Startup validates all eleven systems and their mandatory methods before running.
- A per-frame exception stops scheduling and transitions Engine to `error`; it is not silently swallowed.
- WebGL context loss stops simulation. Context restoration notifies systems, resizes targets, and resumes only if the engine was running before loss.
- `dispose()` runs in reverse initialization order, removes DOM listeners, clears bus subscriptions, disposes GPU/audio resources, and is idempotent.

## 13. Change checklist for future agents

Before merging a subsystem change, verify:

- It uses only the global clock, bus, surfaces, units, and IDs.
- It declares ownership and cleans every owned resource.
- It does not add an authored asset or runtime dependency.
- It allocates nothing in steady-state fixed/update/render/event/query paths.
- Queries use caller-owned output values.
- Events use the exact vocabulary and payload schema.
- Physics changes are fixed-step deterministic.
- Rendering changes preserve the MRT attachment contract.
- Input and state edges are consumed once.
- Context loss, resize, stop/restart, and dispose remain safe.
