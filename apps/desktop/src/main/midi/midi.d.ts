declare module 'midi' {
  import { EventEmitter } from 'events';

  export class Input extends EventEmitter {
    constructor();
    getPortCount(): number;
    getPortName(port: number): string;
    openPort(port: number): void;
    closePort(): void;
    on(event: 'message', listener: (deltaTime: number, message: number[]) => void): this;
  }

  export class Output extends EventEmitter {
    constructor();
    getPortCount(): number;
    getPortName(port: number): string;
    openPort(port: number): void;
    closePort(): void;
    sendMessage(message: number[]): void;
  }
}
