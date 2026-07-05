import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { TokenService } from '../auth/token.service';

export interface RtEmit {
  room: string; // e.g. `event:<uuid>`
  event: string; // e.g. 'event.status' | 'bid.activity' | 'event.awarded'
  data: Record<string, unknown>;
}

// Live updates for the bid table / event statuses. Only NON-SENSITIVE payloads are
// broadcast (statuses, participation counts, award facts) — amounts always travel
// through the RLS-guarded REST API, never through the socket.
@Injectable()
@WebSocketGateway({ namespace: '/rt', cors: { origin: true, credentials: true } })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Server;

  constructor(private readonly tokens: TokenService) {}

  handleConnection(client: Socket): void {
    try {
      const token = (client.handshake.auth?.token as string) ?? '';
      client.data.auth = this.tokens.verifyAccess(token);
    } catch {
      client.disconnect(true);
    }
  }

  @SubscribeMessage('join')
  join(client: Socket, eventId: string): { ok: boolean } {
    if (typeof eventId === 'string' && /^[0-9a-f-]{36}$/.test(eventId)) {
      void client.join(`event:${eventId}`);
      return { ok: true };
    }
    return { ok: false };
  }

  @OnEvent('rt.emit')
  onEmit(payload: RtEmit): void {
    this.server.to(payload.room).emit(payload.event, payload.data);
  }
}

@Global()
@Module({ providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
