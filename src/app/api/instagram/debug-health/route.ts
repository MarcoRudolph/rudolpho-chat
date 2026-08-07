import { and, desc, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db, resolvePostgresUrl } from '@/drizzle';
import {
  instagramConnections,
  instagramDeliveryAudit,
  instagramDmPending,
  instagramMessages,
} from '@/drizzle/schema/instagram';
import { requireInternalApiKey } from '@/lib/security/internalApiAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  return null;
}

function msSince(value: Date | string | null | undefined): number | null {
  if (value instanceof Date) return Date.now() - value.getTime();
  if (typeof value === 'string') {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) ? Date.now() - timestamp : null;
  }
  return null;
}

function errorDetail(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = (error as Error & { cause?: unknown }).cause;
  const causeMessage =
    cause && typeof cause === 'object' && 'message' in cause
      ? String((cause as { message?: unknown }).message || '')
      : '';
  return causeMessage && !error.message.includes(causeMessage)
    ? `${error.message}; cause: ${causeMessage}`
    : error.message;
}

export async function GET(request: NextRequest) {
  const startedAt = new Date().toISOString();
  try {
    const authError = requireInternalApiKey(request, {
      secrets: [
        process.env.INSTAGRAM_DEBUG_KEY,
        process.env.META_DEBUG_KEY,
        process.env.INTERNAL_API_SECRET,
        process.env.ADMIN_SECRET,
      ],
      context: 'instagram debug',
    });
    if (authError) return authError;

    if (!resolvePostgresUrl()) {
      return NextResponse.json(
        { error: 'POSTGRES_URL not configured in runtime environment' },
        { status: 500 }
      );
    }

    const requestedIgAccountId = request.nextUrl.searchParams.get('igAccountId');
    const connectionRows = await db
      .select({
        igAccountId: instagramConnections.igAccountId,
        provider: instagramConnections.provider,
        status: instagramConnections.status,
        webhookVerified: instagramConnections.webhookVerified,
        updatedAt: instagramConnections.updatedAt,
      })
      .from(instagramConnections)
      .where(
        requestedIgAccountId
          ? and(eq(instagramConnections.igAccountId, requestedIgAccountId), eq(instagramConnections.status, 'connected'))
          : eq(instagramConnections.status, 'connected')
      )
      .orderBy(desc(instagramConnections.updatedAt))
      .limit(1);

    const connection = connectionRows[0] || null;
    if (!connection) {
      return NextResponse.json(
        {
          startedAt,
          error: requestedIgAccountId
            ? `No connected instagram_connections row for igAccountId=${requestedIgAccountId}`
            : 'No connected instagram_connections row found',
        },
        { status: 404 }
      );
    }

    const latestIncomingRows = await db
      .select({
        platformMessageId: instagramMessages.platformMessageId,
        threadKey: instagramMessages.threadKey,
        sentAt: instagramMessages.sentAt,
        createdAt: instagramMessages.createdAt,
      })
      .from(instagramMessages)
      .where(
        and(
          eq(instagramMessages.igAccountId, connection.igAccountId),
          eq(instagramMessages.messageKind, 'dm'),
          eq(instagramMessages.direction, 'incoming')
        )
      )
      .orderBy(desc(instagramMessages.createdAt))
      .limit(1);

    const latestOutgoingRows = await db
      .select({
        platformMessageId: instagramMessages.platformMessageId,
        threadKey: instagramMessages.threadKey,
        sentAt: instagramMessages.sentAt,
        createdAt: instagramMessages.createdAt,
      })
      .from(instagramMessages)
      .where(
        and(
          eq(instagramMessages.igAccountId, connection.igAccountId),
          eq(instagramMessages.messageKind, 'dm'),
          eq(instagramMessages.direction, 'outgoing')
        )
      )
      .orderBy(desc(instagramMessages.createdAt))
      .limit(1);

    const pendingRows = await db
      .select({
        id: instagramDmPending.id,
        status: instagramDmPending.status,
        threadKey: instagramDmPending.threadKey,
        createdAt: instagramDmPending.createdAt,
        processedAt: instagramDmPending.processedAt,
        errorMessage: instagramDmPending.errorMessage,
      })
      .from(instagramDmPending)
      .where(eq(instagramDmPending.igAccountId, connection.igAccountId))
      .orderBy(desc(instagramDmPending.createdAt))
      .limit(100);

    const latestDeliveryRows = await db
      .select({
        status: instagramDeliveryAudit.status,
        direction: instagramDeliveryAudit.direction,
        threadKey: instagramDeliveryAudit.threadKey,
        providerMessageId: instagramDeliveryAudit.providerMessageId,
        errorCode: instagramDeliveryAudit.errorCode,
        errorType: instagramDeliveryAudit.errorType,
        errorMessage: instagramDeliveryAudit.errorMessage,
        retryCount: instagramDeliveryAudit.retryCount,
        createdAt: instagramDeliveryAudit.createdAt,
      })
      .from(instagramDeliveryAudit)
      .where(eq(instagramDeliveryAudit.igAccountId, connection.igAccountId))
      .orderBy(desc(instagramDeliveryAudit.createdAt))
      .limit(1);

    const counts = { pending: 0, processing: 0, done: 0, failed: 0 };
    for (const row of pendingRows) {
      if (row.status === 'pending') counts.pending += 1;
      else if (row.status === 'processing') counts.processing += 1;
      else if (row.status === 'done') counts.done += 1;
      else if (row.status === 'failed') counts.failed += 1;
    }

    const latestIncoming = latestIncomingRows[0] || null;
    const latestOutgoing = latestOutgoingRows[0] || null;
    const latestDelivery = latestDeliveryRows[0] || null;
    const latestPending = pendingRows[0] || null;

    const stage1Ok = Boolean(latestIncoming);
    const stage2Ok = Boolean(latestPending);
    const stage3Ok = counts.done > 0 || counts.processing > 0 || counts.pending > 0;
    const stage4Ok = Boolean(latestOutgoing) || latestDelivery?.status === 'succeeded';

    const warnings: string[] = [];
    if (stage1Ok && counts.pending > 0 && !stage4Ok) {
      warnings.push('Inbound DMs are ingested but no outbound delivery yet; check /api/instagram/process-pending cron execution.');
    }
    if (counts.failed > 0) {
      warnings.push('There are failed rows in instagram_dm_pending; inspect latestFailedPending.errorMessage.');
    }
    if (latestDelivery?.status === 'failed') {
      warnings.push('Latest instagram_delivery_audit entry is failed; check errorCode/errorType/errorMessage.');
    }

    return NextResponse.json({
      startedAt,
      igAccountId: connection.igAccountId,
      provider: connection.provider,
      connectionStatus: connection.status,
      webhookVerified: connection.webhookVerified,
      connectionUpdatedAt: toIso(connection.updatedAt),
      stages: {
        webhookIngest: {
          ok: stage1Ok,
          latestIncomingMessageId: latestIncoming?.platformMessageId || null,
          latestIncomingThreadKey: latestIncoming?.threadKey || null,
          latestIncomingCreatedAt: toIso(latestIncoming?.createdAt),
          latestIncomingAgeMs: msSince(latestIncoming?.createdAt),
        },
        enqueuePending: {
          ok: stage2Ok,
          latestPendingId: latestPending?.id || null,
          latestPendingStatus: latestPending?.status || null,
          latestPendingThreadKey: latestPending?.threadKey || null,
          latestPendingCreatedAt: toIso(latestPending?.createdAt),
        },
        pendingProcessor: {
          ok: stage3Ok,
          counts,
          latestFailedPending:
            pendingRows.find((row) => row.status === 'failed')
              ? {
                  id: pendingRows.find((row) => row.status === 'failed')?.id || null,
                  threadKey: pendingRows.find((row) => row.status === 'failed')?.threadKey || null,
                  errorMessage: pendingRows.find((row) => row.status === 'failed')?.errorMessage || null,
                  processedAt: toIso(pendingRows.find((row) => row.status === 'failed')?.processedAt),
                }
              : null,
        },
        outboundDelivery: {
          ok: stage4Ok,
          latestOutgoingMessageId: latestOutgoing?.platformMessageId || null,
          latestOutgoingThreadKey: latestOutgoing?.threadKey || null,
          latestOutgoingCreatedAt: toIso(latestOutgoing?.createdAt),
          latestDeliveryAudit: latestDelivery
            ? {
                status: latestDelivery.status,
                direction: latestDelivery.direction,
                threadKey: latestDelivery.threadKey,
                providerMessageId: latestDelivery.providerMessageId,
                errorCode: latestDelivery.errorCode,
                errorType: latestDelivery.errorType,
                errorMessage: latestDelivery.errorMessage,
                retryCount: latestDelivery.retryCount,
                createdAt: toIso(latestDelivery.createdAt),
              }
            : null,
        },
      },
      warnings,
      usage: {
        endpoint: '/api/instagram/debug-health',
        query: { igAccountId: 'optional' },
        keyHeader: 'x-debug-key',
        keyQuery: 'key',
      },
    });
  } catch (error) {
    const message = errorDetail(error);
    console.error('Debug-health route error:', { message, startedAt });
    return NextResponse.json(
      {
        startedAt,
        error: 'debug_health_failed',
        detail: message,
      },
      { status: 500 }
    );
  }
}
