import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import type { Server, Socket } from 'socket.io';
import { DataSource } from 'typeorm';
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

  constructor(
    private readonly tokens: TokenService,
    private readonly ds: DataSource,
  ) {}

  handleConnection(client: Socket): void {
    try {
      const token = (client.handshake.auth?.token as string) ?? '';
      client.data.auth = this.tokens.verifyAccess(token);
    } catch {
      client.disconnect(true);
    }
  }

  // Only join a room the caller is actually allowed to see (mirrors the se_select
  // RLS policy) — otherwise a logged-in user could subscribe to any event's feed.
  @SubscribeMessage('join')
  async join(client: Socket, eventId: string): Promise<{ ok: boolean }> {
    const auth = client.data.auth;
    if (!auth || typeof eventId !== 'string' || !/^[0-9a-f-]{36}$/.test(eventId)) return { ok: false };
    const visible = await this.ds.query(
      `SELECT 1 FROM sourcing_events e WHERE e.id = $1 AND (
         e.buyer_org_id = $2
         OR ($3 = 'SUPPLIER_USER' AND (
              (e.visibility = 'PUBLIC' AND e.status IN ('PUBLISHED','OPEN','CLOSED','OPENING','EVALUATION','AWARDED'))
              OR EXISTS (SELECT 1 FROM event_invitations ei WHERE ei.event_id = e.id AND ei.supplier_org_id = $2)
         ))
       ) LIMIT 1`,
      [eventId, auth.org_id, auth.role],
    );
    if (!visible.length) return { ok: false };
    void client.join(`event:${eventId}`);
    return { ok: true };
  }

  @OnEvent('rt.emit')
  onEmit(payload: RtEmit): void {
    this.server.to(payload.room).emit(payload.event, payload.data);
  }
}

@Global()
@Module({ providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
