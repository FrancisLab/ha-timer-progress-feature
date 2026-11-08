// Tile card feature for timer entities: a pill whose fill drains as the timer
// runs, with pause/resume and reset buttons over its end. Dragging the bar of
// a running timer sets its remaining time.
//
// Usage: features: [{ type: "custom:timer-progress", reset_action: "cancel" }]
//   reset_action: "cancel" (default) returns the timer to idle,
//                 "restart" starts it over from its full duration,
//                 "none" hides the reset button.
//   color:        bar color; defaults to the tile's state color.
//   icon_color:   button icon color; defaults to the primary text color.
//   Colors take an HA color name ("blue", "primary") or any CSS color.

const RESET_ACTIONS = {
  cancel: { icon: "mdi:refresh", label: "Reset" },
  restart: { icon: "mdi:restart", label: "Restart" },
};

// Horizontal movement before a press becomes a drag, so taps and vertical
// scrolls starting on the bar are left alone.
const DRAG_THRESHOLD_PX = 8;

const parseDuration = (value) => {
  if (!value) return 0;
  const [h, m, s] = String(value).split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * 1000;
};

// Matches the tile's countdown: M:SS under an hour, H:MM:SS above.
const formatSeconds = (total) => {
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
};

// Same convention as HA's own color options: names map to theme variables,
// falling back to the raw value so plain CSS colors work too.
const cssColor = (value) =>
  /^[a-z-]+$/.test(value) ? `var(--${value}-color, ${value})` : value;

class TimerProgressFeature extends HTMLElement {
  static getStubConfig() {
    return { type: "custom:timer-progress" };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" }).innerHTML = `
      <style>
        :host {
          --bar-color: var(--timer-bar-color, var(--feature-color));
          display: block;
        }
        .pill {
          position: relative;
          display: flex;
          justify-content: flex-end;
          padding-inline-end: 8px;
          height: var(--feature-height, 42px);
          border-radius: var(--feature-border-radius, 12px);
          overflow: hidden;
          /* Vertical swipes still scroll the page; horizontal ones are ours. */
          touch-action: pan-y;
          user-select: none;
          -webkit-user-select: none;
        }
        .pill.draggable { cursor: ew-resize; }
        .track, .fill { position: absolute; inset: 0; }
        .track { background: var(--bar-color); opacity: 0.2; }
        .fill {
          background: var(--bar-color);
          transform-origin: left center;
          transform: scaleX(0);
        }
        .label {
          position: relative;
          align-self: center;
          margin-inline-end: auto;
          padding-inline-start: 12px;
          font-weight: 500;
          font-variant-numeric: tabular-nums;
          color: var(--timer-icon-color, var(--primary-text-color));
          opacity: 0;
          transition: opacity 120ms ease-in-out;
        }
        .pill.dragging .label { opacity: 1; }
        button {
          all: unset;
          box-sizing: border-box;
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          /* Narrower than tall: keeps the icons close while the tap target
             still spans the pill's full height. */
          height: 100%;
          width: 30px;
          cursor: pointer;
          -webkit-tap-highlight-color: transparent;
          touch-action: manipulation;
        }
        button[hidden] { display: none; }
        button:disabled { cursor: default; opacity: 0.4; }
        button:focus-visible { box-shadow: inset 0 0 0 2px var(--timer-icon-color, var(--primary-text-color)); }
        @media (hover: hover) {
          button:not(:disabled):hover { background: rgba(0, 0, 0, 0.08); }
        }
        ha-icon {
          --mdc-icon-size: 28px;
          color: var(--timer-icon-color, var(--primary-text-color));
        }
      </style>
      <div class="pill">
        <div class="track"></div>
        <div class="fill"></div>
        <span class="label"></span>
        <button class="toggle"><ha-icon></ha-icon></button>
        <button class="reset"><ha-icon></ha-icon></button>
      </div>
    `;
    this._pill = this.shadowRoot.querySelector(".pill");
    this._toggle = this.shadowRoot.querySelector(".toggle");
    this._reset = this.shadowRoot.querySelector(".reset");
    this._fill = this.shadowRoot.querySelector(".fill");
    this._label = this.shadowRoot.querySelector(".label");

    this._toggle.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._callTimer(this._stateObj?.state === "active" ? "pause" : "start");
    });
    this._reset.addEventListener("click", (ev) => {
      ev.stopPropagation();
      // timer.start on an active or paused timer restarts it from its duration.
      this._callTimer(this._resetAction === "restart" ? "start" : "cancel");
    });

    this._pill.addEventListener("pointerdown", (ev) => this._onPointerDown(ev));
    this._pill.addEventListener("pointermove", (ev) => this._onPointerMove(ev));
    this._pill.addEventListener("pointerup", (ev) => this._onPointerUp(ev));
    this._pill.addEventListener("pointercancel", () => this._endDrag(false));
    // A drag must not also count as a tap on the tile behind the feature.
    this._pill.addEventListener("click", (ev) => ev.stopPropagation());
  }

  setConfig(config) {
    if (!config) throw new Error("Invalid configuration");
    const resetAction = config.reset_action ?? "cancel";
    if (resetAction !== "none" && !RESET_ACTIONS[resetAction]) {
      throw new Error(`Unknown reset_action: ${resetAction}`);
    }
    this._resetAction = resetAction;
    for (const [option, property] of [["color", "--timer-bar-color"], ["icon_color", "--timer-icon-color"]]) {
      if (config[option]) this.style.setProperty(property, cssColor(config[option]));
      else this.style.removeProperty(property);
    }
    this._update();
  }

  set hass(hass) {
    this._hass = hass;
    this._syncState();
  }

  // hui-card-feature assigns hass before context, so both setters resolve the
  // entity; otherwise the first render waits for an unrelated state change.
  set context(context) {
    this._entityId = context?.entity_id;
    this._syncState();
  }

  _syncState() {
    const stateObj = this._entityId && this._hass?.states[this._entityId];
    if (stateObj !== this._stateObj) {
      this._stateObj = stateObj;
      this._update();
    }
  }

  connectedCallback() {
    this._update();
  }

  disconnectedCallback() {
    this._animation?.cancel();
    this._press = undefined;
  }

  get _durationMs() {
    return parseDuration(this._stateObj?.attributes.duration);
  }

  get _remainingMs() {
    const { state, attributes } = this._stateObj;
    if (state === "active") return Math.max(0, Date.parse(attributes.finishes_at) - Date.now());
    if (state === "paused") return parseDuration(attributes.remaining);
    return 0;
  }

  _update() {
    const stateObj = this._stateObj;
    // Leave the fill where the finger is until the drag ends.
    if (!stateObj || !this.isConnected || this._press?.dragging) return;

    const { state } = stateObj;
    const unavailable = state === "unavailable";

    this._toggle.querySelector("ha-icon").icon = state === "active" ? "mdi:pause" : "mdi:play";
    this._toggle.setAttribute("aria-label", state === "active" ? "Pause" : "Start");
    this._toggle.disabled = unavailable;

    const reset = RESET_ACTIONS[this._resetAction];
    // Nothing to reset on an idle timer, so drop the button rather than grey it.
    this._reset.hidden = !reset || state === "idle";
    if (reset) {
      this._reset.querySelector("ha-icon").icon = reset.icon;
      this._reset.setAttribute("aria-label", reset.label);
      this._reset.disabled = unavailable;
    }

    // timer.change only accepts running timers.
    this._pill.classList.toggle("draggable", state === "active");

    const durationMs = this._durationMs;
    if (!durationMs || state === "idle") {
      this._showStatic(0);
    } else if (state === "paused") {
      this._showStatic(this._remainingMs / durationMs);
    } else if (state === "active") {
      this._showRunning(this._remainingMs, durationMs);
    }
  }

  _showStatic(ratio) {
    this._animation?.cancel();
    this._fill.style.transform = `scaleX(${Math.min(1, ratio)})`;
  }

  // Drive the fill with the Web Animations API instead of re-rendering on an
  // interval: the compositor drains it smoothly and no JS runs per frame.
  _showRunning(remainingMs, durationMs) {
    this._animation?.cancel();
    this._animation = this._fill.animate(
      [{ transform: `scaleX(${Math.min(1, remainingMs / durationMs)})` }, { transform: "scaleX(0)" }],
      { duration: remainingMs, easing: "linear", fill: "forwards" }
    );
  }

  _onPointerDown(ev) {
    if (ev.button !== 0 || this._stateObj?.state !== "active") return;
    if (ev.composedPath().some((el) => el instanceof HTMLButtonElement)) return;
    this._press = { id: ev.pointerId, startX: ev.clientX, startY: ev.clientY, dragging: false };
  }

  _onPointerMove(ev) {
    const press = this._press;
    if (!press || ev.pointerId !== press.id) return;

    if (!press.dragging) {
      const dx = Math.abs(ev.clientX - press.startX);
      const dy = Math.abs(ev.clientY - press.startY);
      if (dx < DRAG_THRESHOLD_PX || dx < dy) return;
      press.dragging = true;
      this._pill.setPointerCapture(ev.pointerId);
      this._pill.classList.add("dragging");
      this._animation?.cancel();
    }

    const { left, width } = this._pill.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (ev.clientX - left) / width));
    // HA rejects a change past the running duration; stay a second short so
    // client/server clock rounding can't push it over.
    const maxSeconds = Math.max(0, Math.floor(this._durationMs / 1000) - 1);
    press.targetSeconds = Math.min(maxSeconds, Math.round((ratio * this._durationMs) / 1000));
    this._fill.style.transform = `scaleX(${ratio})`;
    this._label.textContent = formatSeconds(press.targetSeconds);
  }

  _onPointerUp(ev) {
    if (this._press && ev.pointerId === this._press.id) this._endDrag(this._press.dragging);
  }

  _endDrag(commit) {
    const press = this._press;
    this._press = undefined;
    this._pill.classList.remove("dragging");
    if (press?.dragging && this._pill.hasPointerCapture(press.id)) {
      this._pill.releasePointerCapture(press.id);
    }
    if (!press?.dragging || !commit || this._stateObj?.state !== "active") {
      this._update();
      return;
    }

    const target = press.targetSeconds;
    if (target === 0) {
      this._callTimer("finish");
      return;
    }

    const delta = target - Math.round(this._remainingMs / 1000);
    if (delta === 0) {
      this._update();
      return;
    }
    // Show the new position right away rather than snapping back while the
    // state update makes its round trip; that update then re-syncs the fill.
    this._showRunning(target * 1000, this._durationMs);
    this._callTimer("change", { duration: delta });
  }

  async _callTimer(service, data = {}) {
    if (!this._hass || !this._entityId) return;
    try {
      await this._hass.callService("timer", service, { entity_id: this._entityId, ...data });
    } catch (err) {
      // HA shows its own toast for rejected calls; just undo the optimistic fill.
      this._update();
    }
  }
}

customElements.define("timer-progress", TimerProgressFeature);

window.customCardFeatures = window.customCardFeatures || [];
window.customCardFeatures.push({
  type: "timer-progress",
  name: "Timer progress",
  isSupported: (hass, context) => !!context.entity_id?.startsWith("timer."),
  configurable: false,
});
