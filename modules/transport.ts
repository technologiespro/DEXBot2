'use strict';

export interface TransportConnection {
  write(data: string): void;
  end(): void;
  destroy(): void;
  on(event: 'data', handler: (data: Buffer) => void): void;
  on(event: 'error', handler: (err: Error) => void): void;
  on(event: 'end', handler: () => void): void;
  on(event: 'connect', handler: () => void): void;
  setTimeout(ms: number, handler?: () => void): void;
}

export interface TransportServer {
  on(event: 'error', handler: (err: Error) => void): void;
  listen(path: string, handler?: () => void): void;
  close(): void;
}

export interface Transport {
  connect(path: string): TransportConnection;
  createServer(handler: (socket: TransportConnection) => void): TransportServer;
}

class NodeNetTransport implements Transport {
  private _net: any;
  constructor() {
    this._net = require('net');
  }

  connect(path: string): TransportConnection {
    return this._net.createConnection(path);
  }

  createServer(handler: (socket: TransportConnection) => void): TransportServer {
    return this._net.createServer(handler);
  }
}

class BrowserTransport implements Transport {
  connect(_path: string): TransportConnection {
    throw new Error('BrowserTransport: Unix socket IPC not available in browser');
  }

  createServer(_handler: (socket: TransportConnection) => void): TransportServer {
    throw new Error('BrowserTransport: Unix socket IPC not available in browser');
  }
}

let _instance: Transport | null = null;

export function getTransport(): Transport {
  if (!_instance) {
    try {
      require('net');
      _instance = new NodeNetTransport();
    } catch {
      _instance = new BrowserTransport();
    }
  }
  return _instance;
}

export function setTransport(impl: Transport | null): void {
  _instance = impl;
}

const transport = getTransport();
export { transport };
