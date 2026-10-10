interface ConnectionStatus { isDisconnected(): boolean; isConnected(): boolean; isInCase?: boolean }

/** Battery/wear updates on a connected device are not reconnections. */
export class DeviceConnectionLifecycle {
  private connected = false;
  private lost = false;
  constructor(private callbacks: { lost(): void; resume(rebuild: boolean): void }) {}
  handle(status: ConnectionStatus): void {
    if (status.isDisconnected() || status.isInCase) {
      if (!this.lost) this.callbacks.lost();
      this.connected = false; this.lost = true;
    } else if (status.isConnected() && !this.connected) {
      const rebuild = this.lost;
      this.connected = true; this.lost = false; this.callbacks.resume(rebuild);
    }
  }
}
