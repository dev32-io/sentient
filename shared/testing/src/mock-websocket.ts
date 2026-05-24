/** Mock WebSocket for testing message handling */
export interface MockWebSocket {
  sentMessages: (string | ArrayBuffer)[];
  isClosed: boolean;
  closeCode?: number;
  closeReason?: string;
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  simulateMessage(data: string | ArrayBuffer): void;
  simulateClose(code?: number, reason?: string): void;
  onMessage?: (data: string | ArrayBuffer) => void;
  onClose?: (code: number, reason: string) => void;
}

export function createMockWebSocket(): MockWebSocket {
  const ws: MockWebSocket = {
    sentMessages: [],
    isClosed: false,

    send(data) {
      if (ws.isClosed) throw new Error("WebSocket is closed");
      ws.sentMessages.push(data);
    },

    close(code = 1000, reason = "") {
      ws.isClosed = true;
      ws.closeCode = code;
      ws.closeReason = reason;
    },

    simulateMessage(data) {
      ws.onMessage?.(data);
    },

    simulateClose(code = 1000, reason = "") {
      ws.isClosed = true;
      ws.onClose?.(code, reason);
    },
  };

  return ws;
}
