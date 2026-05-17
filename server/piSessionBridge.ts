import {
  PiRunnerCore,
  type ClientMessage,
  type PiRunnerCoreOptions
} from "./runnerCore";

export type {
  ClientMessage,
  DisconnectBehavior,
  PersistedSessionReader,
  PiProcessLike,
  PiRunnerCoreOptions
} from "./runnerCore";

export type PiSessionBridgeOptions = PiRunnerCoreOptions;

export class PiSessionBridge {
  private readonly runnerCore: PiRunnerCore;

  constructor(options: PiSessionBridgeOptions) {
    this.runnerCore = new PiRunnerCore(options);
  }

  async handleClientMessage(message: ClientMessage): Promise<void> {
    await this.runnerCore.handleClientMessage(message);
  }

  dispose(): void {
    this.runnerCore.dispose();
  }
}
