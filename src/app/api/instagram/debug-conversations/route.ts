import { and, desc, eq } from 'drizzle-orm';
import { NextRequest, NextResponse } from 'next/server';
import { db, resolvePostgresUrl } from '@/drizzle';
import { instagramConnections, instagramMessages } from '@/drizzle/schema/instagram';
import {
  buildConversationMessagesUrl,
  buildConversationsUrl,
  redactAccessTokenFromUrl,
  summarizeConversationMessages,
  summarizeConversations,
} from '@/lib/instagram/debugConversations';
import { requireInternalApiKey } from '@/lib/security/internalApiAuth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const GRAPH_VERSION = 'v25.0';

async function parseJsonOrText(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function compactError(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'unknown error';
  const root = payload as Record<string, unknown>;
  const nested = root.error && typeof root.error === 'object' ? (root.error as Record<string, unknown>) : null;
  const message =
    (typeof nested?.message === 'string' && nested.message) ||
    (typeof root.message === 'string' && root.message) ||
    (typeof root.error_description === 'string' && root.error_description) ||
    'unknown error';
  const code =
    (typeof nested?.code === 'number' && nested.code) ||
    (typeof root.code === 'number' && root.code) ||
    null;
  return code ? `${message} (code: ${code})` : message;
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), 1), max);
}

function toIso(value: Date | string | null | undefined): string | null {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
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
  const conversationLimit = parseLimit(request.nextUrl.searchParams.get('conversationLimit'), 5, 25);
  const messageLimit = parseLimit(request.nextUrl.searchParams.get('messageLimit'), 5, 25);
  const includeMessageText = request.nextUrl.searchParams.get('includeMessageText') === 'true';

  const connectionRows = await db
    .select({
      igAccountId: instagramConnections.igAccountId,
      igUsername: instagramConnections.igUsername,
      provider: instagramConnections.provider,
      status: instagramConnections.status,
      webhookVerified: instagramConnections.webhookVerified,
      accessToken: instagramConnections.accessToken,
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

  if (!connection.accessToken) {
    return NextResponse.json(
      {
        startedAt,
        igAccountId: connection.igAccountId,
        error: 'Connected instagram account has no access token stored',
      },
      { status: 409 }
    );
  }

  const latestDbMessages = await db
    .select({
      platformMessageId: instagramMessages.platformMessageId,
      messageKind: instagramMessages.messageKind,
      direction: instagramMessages.direction,
      threadKey: instagramMessages.threadKey,
      senderIgId: instagramMessages.senderIgId,
      recipientIgId: instagramMessages.recipientIgId,
      hasText: instagramMessages.messageText,
      sentAt: instagramMessages.sentAt,
      createdAt: instagramMessages.createdAt,
    })
    .from(instagramMessages)
    .where(and(eq(instagramMessages.igAccountId, connection.igAccountId), eq(instagramMessages.messageKind, 'dm')))
    .orderBy(desc(instagramMessages.createdAt))
    .limit(10);

  const graphChecks: Array<Record<string, unknown>> = [];
  const conversationsUrl = buildConversationsUrl({
    graphVersion: GRAPH_VERSION,
    accessToken: connection.accessToken,
    limit: conversationLimit,
  });

  let conversationsSummary = null;
  let messageSummaries: Array<Record<string, unknown>> = [];

  try {
    const conversationsResp = await fetch(conversationsUrl.toString(), { method: 'GET' });
    const conversationsPayload = await parseJsonOrText(conversationsResp);
    graphChecks.push({
      name: 'graph_conversations',
      ok: conversationsResp.ok,
      status: conversationsResp.status,
      url: redactAccessTokenFromUrl(conversationsUrl.toString()),
      detail: conversationsResp.ok ? 'Able to read Instagram conversations' : compactError(conversationsPayload),
    });

    if (conversationsResp.ok) {
      conversationsSummary = summarizeConversations(conversationsPayload);
      const conversationIds = conversationsSummary.conversations
        .map((conversation) => conversation.id)
        .filter((id) => id !== 'unknown')
        .slice(0, 3);

      messageSummaries = await Promise.all(
        conversationIds.map(async (conversationId) => {
          const messagesUrl = buildConversationMessagesUrl({
            graphVersion: GRAPH_VERSION,
            conversationId,
            accessToken: connection.accessToken || '',
            limit: messageLimit,
          });
          const messagesResp = await fetch(messagesUrl.toString(), { method: 'GET' });
          const messagesPayload = await parseJsonOrText(messagesResp);
          return {
            conversationId,
            ok: messagesResp.ok,
            status: messagesResp.status,
            url: redactAccessTokenFromUrl(messagesUrl.toString()),
            detail: messagesResp.ok ? 'Able to read conversation messages' : compactError(messagesPayload),
            summary: messagesResp.ok
              ? summarizeConversationMessages(messagesPayload, { includeMessageText, previewChars: 120 })
              : null,
          };
        })
      );
    }
  } catch (error) {
    graphChecks.push({
      name: 'graph_conversations',
      ok: false,
      url: redactAccessTokenFromUrl(conversationsUrl.toString()),
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  console.log('Instagram debug conversations check', {
    startedAt,
    igAccountId: connection.igAccountId,
    graphChecks: graphChecks.map((check) => ({
      name: check.name,
      ok: check.ok,
      status: check.status || null,
      detail: check.detail || null,
    })),
    conversationCount: conversationsSummary?.count || 0,
    messageConversationChecks: messageSummaries.length,
  });

  return NextResponse.json({
    startedAt,
    graphVersion: GRAPH_VERSION,
    connection: {
      igAccountId: connection.igAccountId,
      igUsername: connection.igUsername,
      provider: connection.provider,
      status: connection.status,
      webhookVerified: connection.webhookVerified,
      updatedAt: toIso(connection.updatedAt),
      hasAccessToken: Boolean(connection.accessToken),
    },
    graph: {
      checks: graphChecks,
      conversations: conversationsSummary,
      messagesByConversation: messageSummaries,
    },
    localDatabase: {
      latestDmMessages: latestDbMessages.map((row) => ({
        platformMessageId: row.platformMessageId,
        direction: row.direction,
        threadKey: row.threadKey,
        senderIgId: row.senderIgId,
        recipientIgId: row.recipientIgId,
        hasText: Boolean(row.hasText),
        sentAt: toIso(row.sentAt),
        createdAt: toIso(row.createdAt),
      })),
    },
    interpretation: {
      graphHasMessages: messageSummaries.some((item) => {
        const summary = item.summary as { count?: number } | null;
        return Boolean(summary && typeof summary.count === 'number' && summary.count > 0);
      }),
      localDbHasDmMessages: latestDbMessages.length > 0,
      note:
        'If Graph has recent messages but localDatabase.latestDmMessages does not update after a live DM, the issue is webhook delivery/subscription rather than DM visibility.',
    },
    usage: {
      endpoint: '/api/instagram/debug-conversations',
      query: {
        igAccountId: 'optional',
        conversationLimit: 'optional 1..25, default 5',
        messageLimit: 'optional 1..25, default 5',
        includeMessageText: 'optional true; default false to avoid PII in diagnostics',
      },
      keyHeader: 'x-debug-key',
      keyQuery: 'key',
    },
  });
  } catch (error) {
    const detail = errorDetail(error);
    console.error('Instagram debug conversations route error:', { startedAt, detail });
    return NextResponse.json(
      {
        startedAt,
        error: 'debug_conversations_failed',
        detail,
      },
      { status: 500 }
    );
  }
}
