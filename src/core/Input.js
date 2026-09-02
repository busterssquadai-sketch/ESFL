export const InputAction = Object.freeze({
  MOVE_FORWARD: 0,
  MOVE_BACKWARD: 1,
  MOVE_LEFT: 2,
  MOVE_RIGHT: 3,
  JUMP: 4,
  CROUCH: 5,
  SPRINT: 6,
  LEAN_LEFT: 7,
  LEAN_RIGHT: 8,
  RELOAD: 9,
  FIRE: 10,
  AIM: 11,
});

export const INPUT_ACTION_COUNT = 12;

const KEY_SLOT_COUNT = 12;
const DIAGONAL_SCALE = Math.SQRT1_2;
const RAW_POINTER_LOCK_OPTIONS = Object.freeze({ unadjustedMovement: true });
const NON_PASSIVE_OPTIONS = Object.freeze({ passive: false });

const KEY_SLOT_ACTION = new Uint8Array([
  InputAction.MOVE_FORWARD,
  InputAction.MOVE_BACKWARD,
  InputAction.MOVE_LEFT,
  InputAction.MOVE_RIGHT,
  InputAction.JUMP,
  InputAction.CROUCH,
  InputAction.CROUCH,
  InputAction.SPRINT,
  InputAction.SPRINT,
  InputAction.LEAN_LEFT,
  InputAction.LEAN_RIGHT,
  InputAction.RELOAD,
]);

function getKeySlot(code) {
  switch (code) {
    case 'KeyW':
      return 0;
    case 'KeyS':
      return 1;
    case 'KeyA':
      return 2;
    case 'KeyD':
      return 3;
    case 'Space':
      return 4;
    case 'ControlLeft':
      return 5;
    case 'ControlRight':
      return 6;
    case 'ShiftLeft':
      return 7;
    case 'ShiftRight':
      return 8;
    case 'KeyQ':
      return 9;
    case 'KeyE':
      return 10;
    case 'KeyR':
      return 11;
    default:
      return -1;
  }
}

function getMouseAction(button) {
  if (button === 0) {
    return InputAction.FIRE;
  }
  if (button === 2) {
    return InputAction.AIM;
  }
  return -1;
}

function assertAction(action) {
  if (!Number.isInteger(action) || action < 0 || action >= INPUT_ACTION_COUNT) {
    throw new RangeError(`Invalid input action: ${action}`);
  }
}

function clampSigned(value, limit) {
  if (value > limit) {
    return limit;
  }
  if (value < -limit) {
    return -limit;
  }
  return value;
}

export class Input {
  constructor(options = {}) {
    const canvas = options.canvas;
    if (!canvas || typeof canvas.addEventListener !== 'function') {
      throw new TypeError('Input requires an HTML canvas element.');
    }

    const ownerDocument = canvas.ownerDocument;
    const ownerWindow = ownerDocument?.defaultView;
    if (!ownerDocument || !ownerWindow) {
      throw new Error('Input requires a canvas attached to a browser document.');
    }

    this.canvas = canvas;
    this.document = ownerDocument;
    this.window = ownerWindow;
    this.enabled = options.enabled !== false;
    this.rawMouse = options.rawMouse !== false;
    this.sensitivity = options.sensitivity ?? 0.002;
    this.invertY = options.invertY === true;
    this.maxLookDelta = options.maxLookDelta ?? Math.PI * 0.5;

    if (!Number.isFinite(this.sensitivity) || this.sensitivity <= 0) {
      throw new RangeError('Input sensitivity must be a positive finite number.');
    }
    if (!Number.isFinite(this.maxLookDelta) || this.maxLookDelta <= 0) {
      throw new RangeError('maxLookDelta must be a positive finite number.');
    }

    this.isLocked = false;
    this.moveX = 0;
    this.moveY = 0;
    this.lean = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
    this._held = new Uint8Array(INPUT_ACTION_COUNT);
    this._pressed = new Uint8Array(INPUT_ACTION_COUNT);
    this._released = new Uint8Array(INPUT_ACTION_COUNT);
    this._pendingPressed = new Uint8Array(INPUT_ACTION_COUNT);
    this._pendingReleased = new Uint8Array(INPUT_ACTION_COUNT);
    this._actionSourceCount = new Uint8Array(INPUT_ACTION_COUNT);
    this._keyDown = new Uint8Array(KEY_SLOT_COUNT);
    this._mouseDown = new Uint8Array(3);
    this._pendingLookX = 0;
    this._pendingLookY = 0;
    this._pendingWheel = 0;
    this._attached = false;
    this._rawLockRequestPending = false;
    this._basicLockRequestPending = false;

    this._onKeyDownBound = this._onKeyDown.bind(this);
    this._onKeyUpBound = this._onKeyUp.bind(this);
    this._onPointerDownBound = this._onPointerDown.bind(this);
    this._onPointerUpBound = this._onPointerUp.bind(this);
    this._onMouseMoveBound = this._onMouseMove.bind(this);
    this._onWheelBound = this._onWheel.bind(this);
    this._onContextMenuBound = this._onContextMenu.bind(this);
    this._onPointerLockChangeBound = this._onPointerLockChange.bind(this);
    this._onPointerLockErrorBound = this._onPointerLockError.bind(this);
    this._onWindowBlurBound = this._onWindowBlur.bind(this);
    this._onVisibilityChangeBound = this._onVisibilityChange.bind(this);
    this._onRawLockRejectedBound = this._onRawLockRejected.bind(this);
    this._onBasicLockRejectedBound = this._onBasicLockRejected.bind(this);

    if (options.autoAttach === true) {
      this.attach();
    }
  }

  attach() {
    if (this._attached) {
      return this;
    }
    if (this.canvas.tabIndex < 0) {
      this.canvas.tabIndex = 0;
    }

    this.window.addEventListener('keydown', this._onKeyDownBound, false);
    this.window.addEventListener('keyup', this._onKeyUpBound, false);
    this.window.addEventListener('blur', this._onWindowBlurBound, false);
    this.canvas.addEventListener(
      'pointerdown',
      this._onPointerDownBound,
      NON_PASSIVE_OPTIONS,
    );
    this.document.addEventListener(
      'pointerup',
      this._onPointerUpBound,
      NON_PASSIVE_OPTIONS,
    );
    this.document.addEventListener('mousemove', this._onMouseMoveBound, false);
    this.canvas.addEventListener('wheel', this._onWheelBound, NON_PASSIVE_OPTIONS);
    this.canvas.addEventListener(
      'contextmenu',
      this._onContextMenuBound,
      NON_PASSIVE_OPTIONS,
    );
    this.document.addEventListener(
      'pointerlockchange',
      this._onPointerLockChangeBound,
      false,
    );
    this.document.addEventListener(
      'pointerlockerror',
      this._onPointerLockErrorBound,
      false,
    );
    this.document.addEventListener(
      'visibilitychange',
      this._onVisibilityChangeBound,
      false,
    );

    this.isLocked = this.document.pointerLockElement === this.canvas;
    this._attached = true;
    return this;
  }

  detach() {
    if (!this._attached) {
      return this;
    }

    this.window.removeEventListener('keydown', this._onKeyDownBound, false);
    this.window.removeEventListener('keyup', this._onKeyUpBound, false);
    this.window.removeEventListener('blur', this._onWindowBlurBound, false);
    this.canvas.removeEventListener('pointerdown', this._onPointerDownBound, false);
    this.document.removeEventListener('pointerup', this._onPointerUpBound, false);
    this.document.removeEventListener('mousemove', this._onMouseMoveBound, false);
    this.canvas.removeEventListener('wheel', this._onWheelBound, false);
    this.canvas.removeEventListener('contextmenu', this._onContextMenuBound, false);
    this.document.removeEventListener(
      'pointerlockchange',
      this._onPointerLockChangeBound,
      false,
    );
    this.document.removeEventListener(
      'pointerlockerror',
      this._onPointerLockErrorBound,
      false,
    );
    this.document.removeEventListener(
      'visibilitychange',
      this._onVisibilityChangeBound,
      false,
    );

    this._attached = false;
    this.reset();
    return this;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    if (this.enabled === next) {
      return;
    }
    this.enabled = next;
    if (!next) {
      this.reset();
      this.exitPointerLock();
    }
  }

  setSensitivity(value) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new RangeError('Input sensitivity must be a positive finite number.');
    }
    this.sensitivity = value;
  }

  requestPointerLock() {
    if (
      !this.enabled ||
      this.document.pointerLockElement === this.canvas ||
      this._rawLockRequestPending ||
      this._basicLockRequestPending ||
      typeof this.canvas.requestPointerLock !== 'function'
    ) {
      return false;
    }

    if (this.rawMouse) {
      try {
        this._rawLockRequestPending = true;
        const result = this.canvas.requestPointerLock(RAW_POINTER_LOCK_OPTIONS);
        if (result && typeof result.catch === 'function') {
          result.catch(this._onRawLockRejectedBound);
        }
        return true;
      } catch {
        this._rawLockRequestPending = false;
      }
    }
    return this._requestBasicPointerLock();
  }

  exitPointerLock() {
    if (
      this.document.pointerLockElement === this.canvas &&
      typeof this.document.exitPointerLock === 'function'
    ) {
      this.document.exitPointerLock();
    }
  }

  beginFrame() {
    for (let action = 0; action < INPUT_ACTION_COUNT; action += 1) {
      if (this._pendingPressed[action] !== 0) {
        this._pressed[action] = 1;
        this._pendingPressed[action] = 0;
      }
      if (this._pendingReleased[action] !== 0) {
        this._released[action] = 1;
        this._pendingReleased[action] = 0;
      }
    }

    let moveX = this._held[InputAction.MOVE_RIGHT] - this._held[InputAction.MOVE_LEFT];
    let moveY =
      this._held[InputAction.MOVE_FORWARD] - this._held[InputAction.MOVE_BACKWARD];
    if (moveX !== 0 && moveY !== 0) {
      moveX *= DIAGONAL_SCALE;
      moveY *= DIAGONAL_SCALE;
    }
    this.moveX = moveX;
    this.moveY = moveY;
    this.lean =
      this._held[InputAction.LEAN_RIGHT] - this._held[InputAction.LEAN_LEFT];
  }

  beginFixedStep() {
    const verticalSign = this.invertY ? 1 : -1;
    this.lookX = clampSigned(
      this._pendingLookX * this.sensitivity,
      this.maxLookDelta,
    );
    this.lookY = clampSigned(
      this._pendingLookY * this.sensitivity * verticalSign,
      this.maxLookDelta,
    );
    this.wheel = this._pendingWheel;
    this._pendingLookX = 0;
    this._pendingLookY = 0;
    this._pendingWheel = 0;
  }

  endFrame(hadFixedStep) {
    if (!hadFixedStep) {
      return;
    }
    this._pressed.fill(0);
    this._released.fill(0);
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
  }

  isDown(action) {
    assertAction(action);
    return this._held[action] !== 0;
  }

  wasPressed(action) {
    assertAction(action);
    return this._pressed[action] !== 0;
  }

  wasReleased(action) {
    assertAction(action);
    return this._released[action] !== 0;
  }

  consumePressed(action) {
    assertAction(action);
    const value = this._pressed[action] !== 0;
    this._pressed[action] = 0;
    return value;
  }

  consumeReleased(action) {
    assertAction(action);
    const value = this._released[action] !== 0;
    this._released[action] = 0;
    return value;
  }

  reset() {
    for (let action = 0; action < INPUT_ACTION_COUNT; action += 1) {
      if (this._held[action] !== 0) {
        this._pendingReleased[action] = 1;
      }
    }
    this._held.fill(0);
    this._pressed.fill(0);
    this._pendingPressed.fill(0);
    this._actionSourceCount.fill(0);
    this._keyDown.fill(0);
    this._mouseDown.fill(0);
    this.moveX = 0;
    this.moveY = 0;
    this.lean = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.wheel = 0;
    this._pendingLookX = 0;
    this._pendingLookY = 0;
    this._pendingWheel = 0;
  }

  dispose() {
    this.exitPointerLock();
    this.detach();
  }

  _pressAction(action) {
    const count = this._actionSourceCount[action];
    if (count < 255) {
      this._actionSourceCount[action] = count + 1;
    }
    if (count === 0) {
      this._held[action] = 1;
      this._pendingPressed[action] = 1;
    }
  }

  _releaseAction(action) {
    const count = this._actionSourceCount[action];
    if (count === 0) {
      return;
    }
    const next = count - 1;
    this._actionSourceCount[action] = next;
    if (next === 0) {
      this._held[action] = 0;
      this._pendingReleased[action] = 1;
    }
  }

  _onKeyDown(event) {
    const slot = getKeySlot(event.code);
    if (slot < 0 || !this.enabled || !this.isLocked) {
      return;
    }
    event.preventDefault();
    if (this._keyDown[slot] !== 0) {
      return;
    }
    this._keyDown[slot] = 1;
    this._pressAction(KEY_SLOT_ACTION[slot]);
  }

  _onKeyUp(event) {
    const slot = getKeySlot(event.code);
    if (slot < 0 || this._keyDown[slot] === 0) {
      return;
    }
    event.preventDefault();
    this._keyDown[slot] = 0;
    this._releaseAction(KEY_SLOT_ACTION[slot]);
  }

  _onPointerDown(event) {
    if (!this.enabled) {
      return;
    }
    event.preventDefault();
    if (!this.isLocked) {
      if (event.button === 0) {
        this.canvas.focus({ preventScroll: true });
        this.requestPointerLock();
      }
      return;
    }

    const action = getMouseAction(event.button);
    if (action < 0 || event.button >= this._mouseDown.length) {
      return;
    }
    if (this._mouseDown[event.button] !== 0) {
      return;
    }
    this._mouseDown[event.button] = 1;
    this._pressAction(action);
  }

  _onPointerUp(event) {
    const action = getMouseAction(event.button);
    if (action < 0 || event.button >= this._mouseDown.length) {
      return;
    }
    if (this._mouseDown[event.button] === 0) {
      return;
    }
    event.preventDefault();
    this._mouseDown[event.button] = 0;
    this._releaseAction(action);
  }

  _onMouseMove(event) {
    if (!this.enabled || !this.isLocked) {
      return;
    }
    const movementX = Number.isFinite(event.movementX) ? event.movementX : 0;
    const movementY = Number.isFinite(event.movementY) ? event.movementY : 0;
    this._pendingLookX += movementX;
    this._pendingLookY += movementY;
  }

  _onWheel(event) {
    if (!this.enabled || !this.isLocked) {
      return;
    }
    event.preventDefault();
    if (Number.isFinite(event.deltaY)) {
      this._pendingWheel += event.deltaY;
    }
  }

  _onContextMenu(event) {
    event.preventDefault();
  }

  _onPointerLockChange() {
    const locked = this.document.pointerLockElement === this.canvas;
    this._rawLockRequestPending = false;
    this._basicLockRequestPending = false;
    if (this.isLocked && !locked) {
      this.reset();
    }
    this.isLocked = locked;
  }

  _onPointerLockError() {
    this._rawLockRequestPending = false;
    this._basicLockRequestPending = false;
    this.isLocked = this.document.pointerLockElement === this.canvas;
    if (!this.isLocked) {
      this.reset();
    }
  }

  _onWindowBlur() {
    this.reset();
  }

  _onVisibilityChange() {
    if (this.document.visibilityState !== 'visible') {
      this.reset();
    }
  }

  _onRawLockRejected() {
    this._rawLockRequestPending = false;
    if (this.document.pointerLockElement !== this.canvas) {
      this._requestBasicPointerLock();
    }
  }

  _onBasicLockRejected() {
    this._basicLockRequestPending = false;
  }

  _requestBasicPointerLock() {
    if (
      !this.enabled ||
      this.document.pointerLockElement === this.canvas ||
      this._basicLockRequestPending ||
      typeof this.canvas.requestPointerLock !== 'function'
    ) {
      return false;
    }
    try {
      this._basicLockRequestPending = true;
      const result = this.canvas.requestPointerLock();
      if (result && typeof result.catch === 'function') {
        result.catch(this._onBasicLockRejectedBound);
      }
      return true;
    } catch {
      this._basicLockRequestPending = false;
      return false;
    }
  }
}

export default Input;
