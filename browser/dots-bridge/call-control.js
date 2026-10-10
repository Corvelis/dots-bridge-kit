(() => {
  const labels = {
    start: /^(Start call|Call your dot|通話を開始|電話をかける)$/i,
    end: /^(End call|End voice call|Hang up|通話を終了|通話終了)$/i,
    mute: /^(Mute|Mute microphone|Mute mic|マイクをミュート|ミュート)$/i,
    unmute: /^(Unmute|Unmute microphone|Unmute mic|マイクのミュートを解除|ミュートを解除)$/i,
    connecting: /^(Connecting[. …]*|Calling[. …]*|Starting call[. …]*|接続中[. …]*|発信中[. …]*)$/i,
    profile: /^(あなたのdotのプロフィールを開く|Open (?:your )?dot(?:['’]s)? profile)$/i,
    profileToggle: /^(プロフィールの表示を切り替え|Toggle profile visibility)$/i,
  };
  class DotsCallControl {
    constructor({ document, location, storage, report, timeoutMs = 15000 }) {
      Object.assign(this, { document, location, storage, report, timeoutMs });
      this.storageKey = `dots-kit-call:${location.href}`; this.url = location.href;
      this.commands = new Map(); this.queue = Promise.resolve();
    }
    get ownedSession() { try { return this.storage.getItem(this.storageKey); } catch { return null; } }
    controls() {
      const visible = el => el.getClientRects().length > 0 && el.getAttribute("aria-hidden") !== "true";
      const elements = [...this.document.querySelectorAll('button, [role="button"]')].filter(visible);
      const matching = matcher => elements.filter(el => matcher.test(el.getAttribute("aria-label") || el.innerText?.trim() || ""));
      const find = matcher => matching(matcher).find(el => el.innerText?.trim()) ?? matching(matcher)[0];
      // The header icon has the same aria-label as the working profile call
      // action. Only the profile's text-bearing action is a ready Start control.
      const start = matching(labels.start).find(el => el.innerText?.trim());
      const profile = find(labels.profile) ?? matching(labels.profileToggle).find(el => el.getAttribute("aria-pressed") === "false");
      return { start, end: find(labels.end), mute: find(labels.mute), unmute: find(labels.unmute), connecting: find(labels.connecting), profile };
    }
    snapshot() {
      const controls = this.controls();
      const state = this.location.href !== this.url ? "unknown"
        : controls.connecting ? "connecting"
        : controls.end && (controls.mute || controls.unmute) ? "active"
        : controls.start && controls.start.getAttribute("aria-pressed") !== "true" && !controls.end ? "idle"
        : controls.start?.getAttribute("aria-pressed") === "true" || controls.end ? "connecting" : "unknown";
      return { state, url: this.location.href, ownedSession: this.ownedSession,
        muted: controls.unmute ? true : controls.mute ? false : null };
    }
    monitor() { this.timer = setInterval(() => this.report({ type: "voice.state", snapshot: this.snapshot() }), 2000); }
    execute(command) {
      if (!String(command.id || "").startsWith("disconnect-") && command.url === this.url && this.location.href === this.url) this.connected();
      if (this.commands.has(command.id)) return this.commands.get(command.id);
      const result = this.queue.then(() => this.run(command)).then(snapshot => ({ type: "voice.result", id: command.id, snapshot }),
        error => ({ type: "voice.result", id: command.id, error: error.message }));
      this.queue = result; this.commands.set(command.id, result);
      if (this.commands.size > 64) this.commands.delete(this.commands.keys().next().value);
      result.then(message => this.report(message)); return result;
    }
    async run(command) {
      if (command.url !== this.url || this.location.href !== this.url) throw new Error("The browser is no longer displaying the configured dot");
      if (command.action === "status") return this.snapshot();
      if (command.action === "prepare") {
        if (this.snapshot().state !== "unknown") return this.snapshot();
        const opener = this.controls().profile;
        if (!opener || opener.disabled || opener.getAttribute("aria-disabled") === "true") throw new Error("Dot call controls and profile opener are unavailable");
        // Reveal controls only. The server checks idle/ownership again before
        // changing the audio route or sending a separate Start command.
        opener.click();
        const deadline = Date.now() + this.timeoutMs;
        while (Date.now() < deadline) {
          if (this.location.href !== this.url) throw new Error("Dot page changed while preparing call controls");
          const snapshot = this.snapshot();
          if (snapshot.state !== "unknown") return snapshot;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error("Dot call controls were not revealed; profile command was not repeated");
      }
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(command.sessionId || "")) throw new Error("Invalid call session");
      const before = this.snapshot(), controls = this.controls();
      if (command.action === "start") {
        if (before.state !== "idle" || before.ownedSession) throw new Error("A call is already present; it was not attached or restarted");
        if (controls.start.disabled || controls.start.getAttribute("aria-disabled") === "true") throw new Error("Dot call button is disabled");
        // Ownership is saved before pressing Start, including uncertain outcomes.
        this.storage.setItem(this.storageKey, command.sessionId);
        controls.start.click();
        return this.waitFor("active");
      }
      if (command.action === "stop") {
        if (before.state === "idle") {
          // Do not clear a different bridge session's recovery marker.
          if (before.ownedSession && before.ownedSession !== command.sessionId) throw new Error("Another session owns the call marker");
          this.storage.removeItem(this.storageKey); return this.snapshot();
        }
        if (before.ownedSession !== command.sessionId) throw new Error("This bridge did not start the visible call");
        if (!controls.end || controls.end.disabled) throw new Error("The call end button cannot be confirmed; stop it in Chrome");
        controls.end.click(); const result = await this.waitFor("idle");
        this.storage.removeItem(this.storageKey); return { ...result, ownedSession: null };
      }
      throw new Error("Unsupported call command");
    }
    async waitFor(expected) {
      const deadline = Date.now() + this.timeoutMs;
      while (Date.now() < deadline) {
        if (this.location.href !== this.url) throw new Error("Dot page changed while controlling its call");
        const state = this.snapshot();
        if (state.state === expected) {
          if (expected === "active" && state.muted !== false) throw new Error("Dot call is muted; unmute it in Chrome before retrying cleanup");
          return state;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Call ${expected} state was not confirmed; command was not repeated`);
    }
    connected() {
      if (this.disconnectTimer) {
        clearTimeout(this.disconnectTimer); this.disconnectTimer = null;
        this.diagnostic("control-recovered", {});
      }
      // A lost port cannot deliver its own failure report. Replay only these
      // small operational records when the native connection becomes ready.
      try {
        const name = `${this.storageKey}:diagnostics`, pending = JSON.parse(this.storage.getItem(name) || "[]");
        this.storage.removeItem(name);
        if (Array.isArray(pending)) for (const packet of pending.slice(-8)) this.report(packet);
      } catch { /* Diagnostics do not affect call control. */ }
    }
    diagnostic(event, detail) {
      const packet = { type: "voice.diagnostic", event, observedAt: Date.now(), graceMs: 60000, ...detail };
      try {
        const name = `${this.storageKey}:diagnostics`, pending = JSON.parse(this.storage.getItem(name) || "[]");
        this.storage.setItem(name, JSON.stringify([...(Array.isArray(pending) ? pending : []), packet].slice(-8)));
      } catch { /* Storage may be disabled. */ }
      this.report(packet);
    }
    disconnect(reason = "extension-disconnected") {
      // A native-host restart is recoverable. Preserve the call for one minute.
      const owned = this.ownedSession;
      if (!owned || this.disconnectTimer) return;
      this.diagnostic("control-disconnected", { reason });
      this.disconnectTimer = setTimeout(() => {
        this.disconnectTimer = null;
        if (this.ownedSession !== owned || this.location.href !== this.url) return;
        this.diagnostic("control-recovery-timeout", { sessionId: owned });
        void this.execute({ id: `disconnect-${Date.now()}`, action: "stop", sessionId: owned, url: this.url });
      }, 60000);
    }
    close() { clearInterval(this.timer); this.disconnect("page-hidden"); }
  }
  globalThis.DotsCallControl = DotsCallControl;
})();
