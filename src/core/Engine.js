import * as THREE from 'three';
import { Input } from './Input.js';

export const EngineState = Object.freeze({
  CREATED: 'created',
  INITIALIZING: 'initializing',
  READY: 'ready',
  RUNNING: 'running',
  STOPPED: 'stopped',
  CONTEXT_LOST: 'context_lost',
  ERROR: 'error',
  DISPOSING: 'disposing',
  DISPOSED: 'disposed',
});

export const SUBSYSTEM_IDS = Object.freeze([
  'render',
  'materials',
  'sky',
  'physics',
  'world',
  'player',
  'weapons',
  'fx',
  'ai',
  'ui',
  'audio',
]);

const SUBSYSTEM_INDEX = Object.freeze({
  render: 0,
  materials: 1,
  sky: 2,
  physics: 3,
  world: 4,
  player: 5,
  weapons: 6,
  fx: 7,
  ai: 8,
  ui: 9,
  audio: 10,
});

const FIXED_UPDATE_ORDER = Object.freeze(['world', 'ai', 'player', 'weapons']);
const POST_PHYSICS_ORDER = Object.freeze(['world', 'player', 'weapons', 'ai']);
const FRAME_UPDATE_ORDER = Object.freeze([
  'materials',
  'sky',
  'world',
  'physics',
  'player',
  'weapons',
  'fx',
  'ai',
  'ui',
  'audio',
  'render',
]);

const DEFAULT_CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: false,
  antialias: false,
  depth: true,
  stencil: false,
  desynchronized: true,
  failIfMajorPerformanceCaveat: true,
  powerPreference: 'high-performance',
  premultipliedAlpha: false,
  preserveDrawingBuffer: false,
});

const DEFAULT_FIXED_DELTA = 1 / 60;
const DEFAULT_MAX_FRAME_DELTA = 0.1;
const DEFAULT_MAX_SUB_STEPS = 5;
const DEFAULT_MAX_PIXEL_RATIO = 2;
const DEFAULT_MRT_COUNT = 3;

function assertPositiveFinite(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
}

function callOptional(system, method, argument) {
  const callback = system[method];
  if (typeof callback === 'function') {
    callback.call(system, argument);
  }
}

export class EngineClock {
  constructor(options = {}) {
    const fixedDelta = options.fixedDelta ?? DEFAULT_FIXED_DELTA;
    const maxFrameDelta = options.maxFrameDelta ?? DEFAULT_MAX_FRAME_DELTA;
    const maxSubSteps = options.maxSubSteps ?? DEFAULT_MAX_SUB_STEPS;
    const timeScale = options.timeScale ?? 1;

    assertPositiveFinite(fixedDelta, 'fixedDelta');
    assertPositiveFinite(maxFrameDelta, 'maxFrameDelta');

    if (!Number.isInteger(maxSubSteps) || maxSubSteps < 1) {
      throw new RangeError('maxSubSteps must be a positive integer.');
    }
    if (!Number.isFinite(timeScale) || timeScale < 0) {
      throw new RangeError('timeScale must be a non-negative finite number.');
    }

    this.fixedDelta = fixedDelta;
    this.maxFrameDelta = maxFrameDelta;
    this.maxSubSteps = maxSubSteps;
    this.timeScale = timeScale;
    this.frameDelta = 0;
    this.unscaledDelta = 0;
    this.accumulator = 0;
    this.simulationTime = 0;
    this.renderTime = 0;
    this.droppedTime = 0;
    this.frameIndex = 0;
    this.fixedStepIndex = 0;
    this._lastRafMilliseconds = 0;
    this._hasRafSample = false;
  }

  setTimeScale(value) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError('timeScale must be a non-negative finite number.');
    }
    this.timeScale = value;
  }

  beginFrame(rafMilliseconds) {
    if (!Number.isFinite(rafMilliseconds)) {
      throw new TypeError('requestAnimationFrame supplied an invalid timestamp.');
    }

    let unscaledDelta = 0;
    if (this._hasRafSample) {
      unscaledDelta = (rafMilliseconds - this._lastRafMilliseconds) * 0.001;
      if (unscaledDelta < 0) {
        unscaledDelta = 0;
      } else if (unscaledDelta > this.maxFrameDelta) {
        unscaledDelta = this.maxFrameDelta;
      }
    } else {
      this._hasRafSample = true;
    }

    this._lastRafMilliseconds = rafMilliseconds;
    this.unscaledDelta = unscaledDelta;
    this.frameDelta = unscaledDelta * this.timeScale;
    this.accumulator += this.frameDelta;
    this.frameIndex += 1;
  }

  getPendingStepCount() {
    let count = Math.floor(this.accumulator / this.fixedDelta);
    if (count > this.maxSubSteps) {
      count = this.maxSubSteps;
    }
    return count;
  }

  consumeFixedStep() {
    this.accumulator -= this.fixedDelta;
    if (this.accumulator < 0) {
      this.accumulator = 0;
    }
    this.simulationTime += this.fixedDelta;
    this.fixedStepIndex += 1;
  }

  finishFrame() {
    if (this.accumulator >= this.fixedDelta) {
      const retained = this.accumulator % this.fixedDelta;
      this.droppedTime += this.accumulator - retained;
      this.accumulator = retained;
    }
    this.renderTime = this.simulationTime + this.accumulator;
  }

  pauseSampling() {
    this._hasRafSample = false;
    this._lastRafMilliseconds = 0;
    this.frameDelta = 0;
    this.unscaledDelta = 0;
  }

  reset(keepSimulationTime = false) {
    this.pauseSampling();
    this.accumulator = 0;
    this.renderTime = 0;
    this.droppedTime = 0;
    this.frameIndex = 0;
    if (!keepSimulationTime) {
      this.simulationTime = 0;
      this.fixedStepIndex = 0;
    } else {
      this.renderTime = this.simulationTime;
    }
  }
}

export class Engine {
  constructor(options = {}) {
    const canvas = options.canvas;
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('Engine requires a canvas-like object with getContext().');
    }

    const ownerDocument = canvas.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!ownerDocument || !ownerWindow) {
      throw new Error('Engine requires a canvas attached to a browser document.');
    }
    if (typeof ownerWindow.requestAnimationFrame !== 'function') {
      throw new Error('requestAnimationFrame is not available.');
    }

    const eventBus = options.eventBus;
    if (
      !eventBus ||
      typeof eventBus.on !== 'function' ||
      typeof eventBus.off !== 'function' ||
      typeof eventBus.emit !== 'function' ||
      typeof eventBus.clearOwner !== 'function'
    ) {
      throw new TypeError('Engine requires the single application EventBus.');
    }

    this.canvas = canvas;
    this.document = ownerDocument;
    this.window = ownerWindow;
    this.eventBus = eventBus;
    this.state = EngineState.CREATED;

    this.maxPixelRatio = options.maxPixelRatio ?? DEFAULT_MAX_PIXEL_RATIO;
    assertPositiveFinite(this.maxPixelRatio, 'maxPixelRatio');

    const contextAttributes = Object.assign(
      {},
      DEFAULT_CONTEXT_ATTRIBUTES,
      options.contextAttributes,
    );
    contextAttributes.antialias = false;
    contextAttributes.depth = true;

    const gl = canvas.getContext('webgl2', contextAttributes);
    if (!gl || typeof gl.drawBuffers !== 'function') {
      throw new Error('EFL requires a WebGL2-capable browser and GPU.');
    }
    this.gl = gl;

    const mrtCount = options.mrtCount ?? DEFAULT_MRT_COUNT;
    if (!Number.isInteger(mrtCount) || mrtCount < 2) {
      throw new RangeError('mrtCount must be an integer greater than one.');
    }

    const maxDrawBuffers = gl.getParameter(gl.MAX_DRAW_BUFFERS);
    const maxColorAttachments = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
    if (mrtCount > maxDrawBuffers || mrtCount > maxColorAttachments) {
      throw new Error(
        `GPU MRT limit is insufficient: requested ${mrtCount}, ` +
          `draw buffers ${maxDrawBuffers}, color attachments ${maxColorAttachments}.`,
      );
    }

    const colorBufferFloat = gl.getExtension('EXT_color_buffer_float');
    this.capabilities = Object.freeze({
      webgl2: true,
      mrt: true,
      mrtCount,
      maxDrawBuffers,
      maxColorAttachments,
      colorBufferFloat: colorBufferFloat !== null,
    });

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context: gl,
      alpha: contextAttributes.alpha,
      antialias: false,
      depth: true,
      stencil: contextAttributes.stencil,
      premultipliedAlpha: contextAttributes.premultipliedAlpha,
      preserveDrawingBuffer: contextAttributes.preserveDrawingBuffer,
      powerPreference: contextAttributes.powerPreference,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.renderer.autoClear = false;
    this.renderer.xr.enabled = false;
    this.renderer.shadowMap.enabled = false;

    const renderTargetType = colorBufferFloat
      ? THREE.HalfFloatType
      : THREE.UnsignedByteType;

    this.gBuffer = new THREE.WebGLRenderTarget(1, 1, {
      count: mrtCount,
      depthBuffer: true,
      stencilBuffer: false,
      type: renderTargetType,
      format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      samples: 0,
    });

    for (let index = 0; index < this.gBuffer.textures.length; index += 1) {
      const texture = this.gBuffer.textures[index];
      texture.name = `efl.gbuffer.${index}`;
      texture.colorSpace = THREE.NoColorSpace;
      texture.generateMipmaps = false;
    }

    const depthTexture = new THREE.DepthTexture(1, 1, THREE.UnsignedIntType);
    depthTexture.name = 'efl.gbuffer.depth';
    depthTexture.format = THREE.DepthFormat;
    depthTexture.type = THREE.UnsignedIntType;
    depthTexture.minFilter = THREE.NearestFilter;
    depthTexture.magFilter = THREE.NearestFilter;
    depthTexture.generateMipmaps = false;
    this.gBuffer.depthTexture = depthTexture;

    this.clock = new EngineClock(options.clock);
    this.frame = Object.seal({
      frame: 0,
      fixedStep: 0,
      delta: 0,
      unscaledDelta: 0,
      fixedDelta: this.clock.fixedDelta,
      elapsed: 0,
      simulationTime: 0,
      alpha: 0,
      substep: 0,
      substepCount: 0,
      width: 1,
      height: 1,
      bufferWidth: 1,
      bufferHeight: 1,
      pixelRatio: 1,
      isFixedStep: false,
    });

    this.input = options.input ?? new Input({ canvas });
    this._ownsInput = options.input === undefined;

    this.subsystems = Object.seal({
      render: null,
      materials: null,
      sky: null,
      physics: null,
      world: null,
      player: null,
      weapons: null,
      fx: null,
      ai: null,
      ui: null,
      audio: null,
    });

    this._lifecycleSystems = [];
    this._fixedSystems = [];
    this._postPhysicsSystems = [];
    this._updateSystems = [];
    this._lateUpdateSystems = [];
    this._resizeSystems = [];
    this._initializedCount = 0;
    this._startedCount = 0;

    const configuredSystems = options.subsystems;
    if (configuredSystems) {
      for (let index = 0; index < SUBSYSTEM_IDS.length; index += 1) {
        const id = SUBSYSTEM_IDS[index];
        if (configuredSystems[id]) {
          this.registerSubsystem(id, configuredSystems[id]);
        }
      }
    }

    this.services = Object.freeze({
      engine: this,
      clock: this.clock,
      frame: this.frame,
      canvas: this.canvas,
      gl: this.gl,
      renderer: this.renderer,
      gBuffer: this.gBuffer,
      capabilities: this.capabilities,
      eventBus: this.eventBus,
      input: this.input,
      subsystems: this.subsystems,
    });

    this._statePayload = {
      scope: 'engine',
      entityId: 0,
      previous: EngineState.CREATED,
      next: EngineState.CREATED,
      reason: 'constructed',
      simulationTime: 0,
    };

    this._rafHandle = 0;
    this._inFrame = false;
    this._stopRequested = false;
    this._stopReason = 'manual';
    this._fatalError = null;
    this._resumeAfterContextRestore = false;
    this._resizePending = true;
    this._listenersAttached = false;
    this._resizeObserver = null;
    this._onError = typeof options.onError === 'function' ? options.onError : null;
    this._tickBound = this._tick.bind(this);
    this._onResizeBound = this._onResize.bind(this);
    this._onContextLostBound = this._onContextLost.bind(this);
    this._onContextRestoredBound = this._onContextRestored.bind(this);
  }

  registerSubsystem(id, system) {
    if (this.state !== EngineState.CREATED) {
      throw new Error('Subsystems can only be registered before Engine.init().');
    }
    if (!Object.prototype.hasOwnProperty.call(SUBSYSTEM_INDEX, id)) {
      throw new Error(`Unknown subsystem id: ${id}`);
    }
    if (!system || typeof system !== 'object') {
      throw new TypeError(`Subsystem ${id} must be an object.`);
    }
    if (this.subsystems[id] !== null) {
      throw new Error(`Subsystem ${id} is already registered.`);
    }
    if (system.id !== undefined && system.id !== id) {
      throw new Error(`Subsystem id mismatch: expected ${id}, received ${system.id}.`);
    }
    this.subsystems[id] = system;
    return this;
  }

  getSubsystem(id) {
    if (!Object.prototype.hasOwnProperty.call(SUBSYSTEM_INDEX, id)) {
      return null;
    }
    return this.subsystems[id];
  }

  async init() {
    if (this.state !== EngineState.CREATED) {
      throw new Error(`Engine.init() is invalid while state is ${this.state}.`);
    }

    this._setState(EngineState.INITIALIZING, 'init');

    try {
      this._validateAndBuildSystemLists();
      Object.freeze(this.subsystems);
      this.input.attach();
      this._attachLifecycleListeners();

      for (let index = 0; index < this._lifecycleSystems.length; index += 1) {
        const system = this._lifecycleSystems[index];
        this._initializedCount = index + 1;
        const result = system.init(this.services);
        if (result && typeof result.then === 'function') {
          await result;
        }
      }

      this._measureAndResize(true);
      this._setState(EngineState.READY, 'initialized');
      return this;
    } catch (error) {
      this._disposeInitializedSystems();
      this._detachLifecycleListeners();
      this.input.detach();
      this._fatalError = error;
      this._setState(EngineState.ERROR, 'initialization_failed');
      throw error;
    }
  }

  start() {
    if (this.state !== EngineState.READY && this.state !== EngineState.STOPPED) {
      throw new Error(`Engine.start() is invalid while state is ${this.state}.`);
    }

    try {
      for (let index = 0; index < this._lifecycleSystems.length; index += 1) {
        const system = this._lifecycleSystems[index];
        callOptional(system, 'start', this.services);
        this._startedCount = index + 1;
      }
    } catch (error) {
      this._stopStartedSystems();
      this._fatalError = error;
      this._setState(EngineState.ERROR, 'start_failed');
      throw error;
    }

    this._stopRequested = false;
    this.clock.pauseSampling();
    this._setState(EngineState.RUNNING, 'start');
    this._rafHandle = this.window.requestAnimationFrame(this._tickBound);
    return this;
  }

  stop(reason = 'manual') {
    if (this.state !== EngineState.RUNNING) {
      return this;
    }
    if (this._inFrame) {
      this._stopRequested = true;
      this._stopReason = reason;
      return this;
    }
    this._stopNow(reason);
    return this;
  }

  resize(width, height, pixelRatio = this.window.devicePixelRatio || 1) {
    assertPositiveFinite(width, 'width');
    assertPositiveFinite(height, 'height');
    assertPositiveFinite(pixelRatio, 'pixelRatio');
    this._applyResize(width, height, pixelRatio, false);
  }

  dispose() {
    if (this.state === EngineState.DISPOSED) {
      return;
    }
    if (this._inFrame) {
      throw new Error('Engine.dispose() cannot run from inside a frame callback.');
    }
    if (this.state === EngineState.RUNNING) {
      this._stopNow('dispose');
    }

    this._setState(EngineState.DISPOSING, 'dispose');
    this._detachLifecycleListeners();
    this.input.detach();
    this._disposeInitializedSystems();
    this.gBuffer.dispose();
    this.renderer.dispose();
    if (this._ownsInput) {
      this.input.dispose();
    }
    this._setState(EngineState.DISPOSED, 'disposed');
  }

  _validateAndBuildSystemLists() {
    for (let index = 0; index < SUBSYSTEM_IDS.length; index += 1) {
      const id = SUBSYSTEM_IDS[index];
      const system = this.subsystems[id];
      if (!system) {
        throw new Error(`Required subsystem is missing: ${id}`);
      }
      if (typeof system.init !== 'function' || typeof system.dispose !== 'function') {
        throw new Error(`Subsystem ${id} must implement init() and dispose().`);
      }
      this._lifecycleSystems.push(system);
      if (typeof system.resize === 'function') {
        this._resizeSystems.push(system);
      }
    }

    const render = this.subsystems.render;
    if (typeof render.render !== 'function' || typeof render.resize !== 'function') {
      throw new Error('render must implement render() and resize().');
    }
    if (typeof this.subsystems.physics.fixedUpdate !== 'function') {
      throw new Error('physics must implement fixedUpdate().');
    }

    for (let index = 0; index < FIXED_UPDATE_ORDER.length; index += 1) {
      const system = this.subsystems[FIXED_UPDATE_ORDER[index]];
      if (typeof system.fixedUpdate === 'function') {
        this._fixedSystems.push(system);
      }
    }
    for (let index = 0; index < POST_PHYSICS_ORDER.length; index += 1) {
      const system = this.subsystems[POST_PHYSICS_ORDER[index]];
      if (typeof system.postPhysics === 'function') {
        this._postPhysicsSystems.push(system);
      }
    }
    for (let index = 0; index < FRAME_UPDATE_ORDER.length; index += 1) {
      const system = this.subsystems[FRAME_UPDATE_ORDER[index]];
      if (typeof system.update === 'function') {
        this._updateSystems.push(system);
      }
      if (typeof system.lateUpdate === 'function') {
        this._lateUpdateSystems.push(system);
      }
    }
  }

  _tick(rafMilliseconds) {
    this._rafHandle = 0;
    if (this.state !== EngineState.RUNNING) {
      return;
    }
    this._inFrame = true;

    try {
      this.clock.beginFrame(rafMilliseconds);
      this._syncRenderFrame();
      if (this._resizePending) {
        this._measureAndResize(false);
      }
      this.input.beginFrame(this.frame);

      const substepCount = this.clock.getPendingStepCount();
      this.frame.substepCount = substepCount;

      for (let substep = 0; substep < substepCount; substep += 1) {
        this.clock.consumeFixedStep();
        this._syncFixedFrame(substep, substepCount);
        this.input.beginFixedStep(this.frame);

        for (let index = 0; index < this._fixedSystems.length; index += 1) {
          this._fixedSystems[index].fixedUpdate(this.frame);
        }
        this.subsystems.physics.fixedUpdate(this.frame);
        for (let index = 0; index < this._postPhysicsSystems.length; index += 1) {
          this._postPhysicsSystems[index].postPhysics(this.frame);
        }
      }

      this.clock.finishFrame();
      this._syncRenderFrame();
      this.frame.substepCount = substepCount;

      for (let index = 0; index < this._updateSystems.length; index += 1) {
        this._updateSystems[index].update(this.frame);
      }
      for (let index = 0; index < this._lateUpdateSystems.length; index += 1) {
        this._lateUpdateSystems[index].lateUpdate(this.frame);
      }

      this.subsystems.render.render(this.frame);
      this.input.endFrame(substepCount > 0);
    } catch (error) {
      this._inFrame = false;
      this._handleFatalError(error);
      return;
    }

    this._inFrame = false;
    if (this._stopRequested) {
      const reason = this._stopReason;
      this._stopRequested = false;
      this._stopNow(reason);
      return;
    }
    if (this.state === EngineState.RUNNING) {
      this._rafHandle = this.window.requestAnimationFrame(this._tickBound);
    }
  }

  _syncFixedFrame(substep, substepCount) {
    const frame = this.frame;
    frame.frame = this.clock.frameIndex;
    frame.fixedStep = this.clock.fixedStepIndex;
    frame.delta = this.clock.fixedDelta;
    frame.unscaledDelta = this.clock.unscaledDelta;
    frame.elapsed = this.clock.simulationTime;
    frame.simulationTime = this.clock.simulationTime;
    frame.alpha = 0;
    frame.substep = substep;
    frame.substepCount = substepCount;
    frame.isFixedStep = true;
  }

  _syncRenderFrame() {
    const frame = this.frame;
    frame.frame = this.clock.frameIndex;
    frame.fixedStep = this.clock.fixedStepIndex;
    frame.delta = this.clock.frameDelta;
    frame.unscaledDelta = this.clock.unscaledDelta;
    frame.elapsed = this.clock.renderTime;
    frame.simulationTime = this.clock.simulationTime;
    frame.alpha = this.clock.accumulator / this.clock.fixedDelta;
    frame.substep = 0;
    frame.isFixedStep = false;
  }

  _stopNow(reason) {
    if (this._rafHandle !== 0) {
      this.window.cancelAnimationFrame(this._rafHandle);
      this._rafHandle = 0;
    }
    this._stopStartedSystems();
    this.clock.pauseSampling();
    this._setState(EngineState.STOPPED, reason);
  }

  _stopStartedSystems() {
    for (let index = this._startedCount - 1; index >= 0; index -= 1) {
      callOptional(this._lifecycleSystems[index], 'stop', this.services);
    }
    this._startedCount = 0;
  }

  _disposeInitializedSystems() {
    for (let index = this._initializedCount - 1; index >= 0; index -= 1) {
      try {
        this._lifecycleSystems[index].dispose();
      } catch (error) {
        if (this._fatalError === null) {
          this._fatalError = error;
        }
      }
    }
    this._initializedCount = 0;
  }

  _handleFatalError(error) {
    if (this._rafHandle !== 0) {
      this.window.cancelAnimationFrame(this._rafHandle);
      this._rafHandle = 0;
    }
    this._fatalError = error;
    this._stopStartedSystems();
    this.clock.pauseSampling();
    this._setState(EngineState.ERROR, 'frame_failed');
    if (this._onError) {
      this._onError(error, this);
    } else {
      console.error('EFL engine stopped after a fatal frame error.', error);
    }
  }

  _setState(next, reason) {
    const previous = this.state;
    if (previous === next) {
      return;
    }
    this.state = next;
    const payload = this._statePayload;
    if (!payload) {
      return;
    }
    payload.previous = previous;
    payload.next = next;
    payload.reason = reason;
    payload.simulationTime = this.clock?.simulationTime ?? 0;
    this.eventBus.emit('state_changed', payload);
  }

  _attachLifecycleListeners() {
    if (this._listenersAttached) {
      return;
    }
    this.canvas.addEventListener('webglcontextlost', this._onContextLostBound, false);
    this.canvas.addEventListener(
      'webglcontextrestored',
      this._onContextRestoredBound,
      false,
    );
    if (typeof this.window.ResizeObserver === 'function') {
      this._resizeObserver = new this.window.ResizeObserver(this._onResizeBound);
      this._resizeObserver.observe(this.canvas);
    } else {
      this.window.addEventListener('resize', this._onResizeBound, false);
    }
    this._listenersAttached = true;
  }

  _detachLifecycleListeners() {
    if (!this._listenersAttached) {
      return;
    }
    this.canvas.removeEventListener('webglcontextlost', this._onContextLostBound, false);
    this.canvas.removeEventListener(
      'webglcontextrestored',
      this._onContextRestoredBound,
      false,
    );
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    } else {
      this.window.removeEventListener('resize', this._onResizeBound, false);
    }
    this._listenersAttached = false;
  }

  _onResize() {
    this._resizePending = true;
    if (this.state === EngineState.READY || this.state === EngineState.STOPPED) {
      this._measureAndResize(false);
    }
  }

  _measureAndResize(force) {
    let pixelRatio = this.window.devicePixelRatio || 1;
    if (pixelRatio > this.maxPixelRatio) {
      pixelRatio = this.maxPixelRatio;
    }
    let width = this.canvas.clientWidth;
    let height = this.canvas.clientHeight;
    if (!Number.isFinite(width) || width <= 0) {
      width = this.canvas.width / pixelRatio;
    }
    if (!Number.isFinite(height) || height <= 0) {
      height = this.canvas.height / pixelRatio;
    }
    if (!Number.isFinite(width) || width <= 0) {
      width = 1;
    }
    if (!Number.isFinite(height) || height <= 0) {
      height = 1;
    }
    this._applyResize(width, height, pixelRatio, force);
  }

  _applyResize(width, height, pixelRatio, force) {
    let cappedPixelRatio = pixelRatio;
    if (cappedPixelRatio > this.maxPixelRatio) {
      cappedPixelRatio = this.maxPixelRatio;
    }
    const logicalWidth = Math.max(1, Math.round(width));
    const logicalHeight = Math.max(1, Math.round(height));
    const bufferWidth = Math.max(1, Math.floor(logicalWidth * cappedPixelRatio));
    const bufferHeight = Math.max(1, Math.floor(logicalHeight * cappedPixelRatio));
    const frame = this.frame;

    if (
      !force &&
      frame.width === logicalWidth &&
      frame.height === logicalHeight &&
      frame.bufferWidth === bufferWidth &&
      frame.bufferHeight === bufferHeight &&
      frame.pixelRatio === cappedPixelRatio
    ) {
      this._resizePending = false;
      return;
    }

    this.renderer.setPixelRatio(cappedPixelRatio);
    this.renderer.setSize(logicalWidth, logicalHeight, false);
    this.gBuffer.setSize(bufferWidth, bufferHeight);
    frame.width = logicalWidth;
    frame.height = logicalHeight;
    frame.bufferWidth = bufferWidth;
    frame.bufferHeight = bufferHeight;
    frame.pixelRatio = cappedPixelRatio;
    this._resizePending = false;

    if (this._initializedCount === this._lifecycleSystems.length) {
      for (let index = 0; index < this._resizeSystems.length; index += 1) {
        this._resizeSystems[index].resize(
          logicalWidth,
          logicalHeight,
          cappedPixelRatio,
          bufferWidth,
          bufferHeight,
        );
      }
    }
  }

  _onContextLost(event) {
    event.preventDefault();
    this._resumeAfterContextRestore = this.state === EngineState.RUNNING;
    if (this.state === EngineState.RUNNING) {
      this._stopNow('webgl_context_lost');
    }
    this._setState(EngineState.CONTEXT_LOST, 'webgl_context_lost');
  }

  _onContextRestored() {
    if (this.state !== EngineState.CONTEXT_LOST) {
      return;
    }
    for (let index = 0; index < this._initializedCount; index += 1) {
      callOptional(this._lifecycleSystems[index], 'onContextRestored', this.services);
    }
    this._measureAndResize(true);
    const shouldResume = this._resumeAfterContextRestore;
    this._resumeAfterContextRestore = false;
    this._setState(EngineState.STOPPED, 'webgl_context_restored');
    if (shouldResume) {
      this.start();
    }
  }
}

export default Engine;
