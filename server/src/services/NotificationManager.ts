import { Response } from 'express';

export interface NotificationClient {
  userId: string;
  /** The store this connection is scoped to, so store-wide events can be targeted. */
  storeId?: string;
  isRoot: boolean;
  isAdmin: boolean;
  res: Response;
}

export class NotificationManager {
  private static instance: NotificationManager;
  private clients: Set<NotificationClient> = new Set();

  private constructor() {
    // Keep-alive heartbeat interval to avoid TCP/Proxy connection drop
    setInterval(() => {
      this.broadcastPing();
    }, 30000).unref();
  }

  public static getInstance(): NotificationManager {
    if (!NotificationManager.instance) {
      NotificationManager.instance = new NotificationManager();
    }
    return NotificationManager.instance;
  }

  /**
   * Registers a client connection for SSE updates.
   * Returns a cleanup function to invoke on socket close.
   */
  public addClient(
    userId: string,
    isRoot: boolean,
    res: Response,
    isAdmin: boolean = false,
    storeId?: string,
  ): () => void {
    const client: NotificationClient = { userId, storeId, isRoot, isAdmin: isAdmin || isRoot, res };
    this.clients.add(client);
    
    // Send initial handshake acknowledgement
    this.sendEventToClient(client, 'handshake', { connected: true, userId });

    return () => {
      this.clients.delete(client);
    };
  }

  /**
   * Dispatches a named SSE event to a specific client response handle.
   */
  private sendEventToClient(client: NotificationClient, event: string, data: any) {
    try {
      client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error(`Failed to send SSE event to client ${client.userId}:`, err);
      this.clients.delete(client);
    }
  }

  /**
   * Sends a real-time notification to a specific user.
   */
  public sendToUser(userId: string, event: string, data: any) {
    for (const client of this.clients) {
      if (client.userId === userId) {
        this.sendEventToClient(client, event, data);
      }
    }
  }

  /**
   * Sends a real-time notification to everyone connected from one store.
   *
   * Used for events that belong to the store rather than to a person — a
   * publicly reported issue, for instance, is news for whoever is around to
   * act on it, not for one nominated owner.
   */
  public sendToStore(storeId: string, event: string, data: any) {
    if (!storeId) return;
    for (const client of this.clients) {
      if (client.storeId === storeId) {
        this.sendEventToClient(client, event, data);
      }
    }
  }

  /**
   * Sends a real-time notification to all connected root administrators.
   */
  public sendToRootAdmins(event: string, data: any) {
    for (const client of this.clients) {
      if (client.isRoot) {
        this.sendEventToClient(client, event, data);
      }
    }
  }

  /**
   * Sends a real-time notification to all connected administrators (role admin
   * or root).
   */
  public sendToAdmins(event: string, data: any) {
    for (const client of this.clients) {
      if (client.isAdmin) {
        this.sendEventToClient(client, event, data);
      }
    }
  }

  /**
   * Broadcasts a notification to all connected clients.
   */
  public broadcast(event: string, data: any) {
    for (const client of this.clients) {
      this.sendEventToClient(client, event, data);
    }
  }

  /**
   * Sends an SSE comment comment format to keep persistent connections active.
   */
  private broadcastPing() {
    for (const client of this.clients) {
      try {
        client.res.write(': ping\n\n');
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export const notificationManager = NotificationManager.getInstance();
