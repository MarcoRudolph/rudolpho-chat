import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/drizzle';
import { instagramDmPending } from '@/drizzle/schema/instagram';
import { recordInstagramMessage, type StoredMessageInput } from '@/lib/instagram/dmPipeline';
import { verifyInstagramWebhookChallenge } from '@/lib/instagram/webhookVerify';

export const runtime = 'nodejs';

type InstagramWebhookPayload = {
  object?: string;
  entry?: Array<{
    id?: string;
    time?: number;
    messaging?: InstagramMessagingEvent[];
    changes?: InstagramChangeEvent[];
  }>;
};

type InstagramMessagingEvent = {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: { mid?: string; text?: string };
};

type InstagramCommentValue = {
  id?: string;
  text?: string;
  created_time?: number | string;
  from?: { id?: string; username?: string };
  media?: { id?: string };
  media_id?: string;
  post_id?: string;
};

type InstagramChangeEvent = {
  field?: string;
  value?: InstagramCommentValue;
};

function parseTimestamp(input: number | string | undefined, fallbackMs?: number): string {
  const parsed = Number(input ?? fallbackMs ?? Date.now());
  if (!Number.isFinite(parsed)) {
    return new Date().toISOString();
  }
  const millis = parsed < 1_000_000_000_000 ? parsed * 1000 : parsed;
  return new Date(millis).toISOString();
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.trim().toLowerCase();
  const pairs = normalized.match(/.{1,2}/g) || [];
  const bytes = pairs.map((pair) => Number.parseInt(pair, 16));
  return new Uint8Array(bytes);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    const aByte = a[i] ?? 0;
    const bByte = b[i] ?? 0;
    diff |= aByte ^ bByte;
  }
  return diff === 0;
}

async function verifyRequestSignature(rawBody: string, signatureHeader: string, appSecret: string): Promise<boolean> {
  const [algorithm, signatureHex] = signatureHeader.split('=');
  if (algorithm !== 'sha256' || !signatureHex) {
    return false;
  }

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const digest = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expected = new Uint8Array(digest);
  const provided = hexToBytes(signatureHex);

  return timingSafeEqual(expected, provided);
}

function mapMessagingEvent(igAccountId: string, event: InstagramMessagingEvent): StoredMessageInput {
  const senderId = event.sender?.id || null;
  const recipientId = event.recipient?.id || null;
  const participantIgId = senderId === igAccountId ? recipientId : senderId;
  const threadKey = `dm:${participantIgId || senderId || recipientId || 'unknown'}`;
  const platformMessageId =
    event.message?.mid ||
    `dm-${igAccountId}-${event.timestamp || Date.now()}-${senderId || 'unknown'}-${recipientId || 'unknown'}`;
  const direction: StoredMessageInput['direction'] =
    senderId && senderId === igAccountId ? 'outgoing' : senderId ? 'incoming' : 'unknown';

  return {
    igAccountId,
    threadKey,
    platformMessageId,
    messageKind: 'dm',
    direction,
    senderIgId: senderId,
    recipientIgId: recipientId,
    messageText: event.message?.text || null,
    sentAt: parseTimestamp(event.timestamp),
    rawPayload: event,
    participantIgId: participantIgId || null,
  };
}

function mapCommentChange(
  igAccountId: string,
  entryTimestamp: number | undefined,
  change: InstagramChangeEvent
): StoredMessageInput | null {
  if (change.field !== 'comments' || !change.value) {
    return null;
  }

  const value = change.value;
  const senderId = value.from?.id || null;
  const mediaId = value.media?.id || value.media_id || value.post_id || igAccountId;
  const platformMessageId = value.id || `comment-${igAccountId}-${entryTimestamp || Date.now()}`;
  const direction: StoredMessageInput['direction'] =
    senderId && senderId === igAccountId ? 'outgoing' : senderId ? 'incoming' : 'unknown';

  return {
    igAccountId,
    threadKey: `comment:${mediaId}`,
    platformMessageId,
    messageKind: 'comment',
    direction,
    senderIgId: senderId,
    recipientIgId: igAccountId,
    messageText: value.text || null,
    sentAt: parseTimestamp(value.created_time, entryTimestamp),
    rawPayload: change,
    participantIgId: senderId,
  };
}

/**
 * Handles Meta webhook verification handshake.
 * Meta expects the raw challenge string as plain text on success.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get('hub.mode');
  const verifyToken = searchParams.get('hub.verify_token');
  const challenge = searchParams.get('hub.challenge');

  const verification = verifyInstagramWebhookChallenge({
    mode,
    verifyToken,
    challenge,
  });

  console.log('Instagram webhook verification request', {
    mode: mode || null,
    hasVerifyToken: Boolean(verifyToken),
    hasChallenge: Boolean(challenge),
    tokenSource: verification.tokenSource,
  });

  if (verification.ok) {
    console.log('Instagram webhook verification succeeded', {
      tokenSource: verification.tokenSource,
    });
    return new NextResponse(verification.challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  if (verification.reason === 'missing_server_verify_token') {
    console.error('Instagram webhook verification failed: missing server verify token');
    return NextResponse.json(
      { error: 'Webhook verify token is not configured on server' },
      { status: verification.status }
    );
  }

  console.error('Instagram webhook verification failed: token mismatch or invalid mode', {
    mode: mode || null,
    tokenSource: verification.tokenSource,
    tokenMatch: verification.tokenMatch,
    hasChallenge: verification.hasChallenge,
  });
  return NextResponse.json({ error: 'Webhook verification failed' }, { status: verification.status });
}

/**
 * Receives Instagram webhook events after subscription is verified.
 * For now, this route acknowledges receipt and logs minimal metadata.
 */
export async function POST(request: NextRequest) {
  try {
    const rawBody = await request.text();
    const signature = request.headers.get('x-hub-signature-256');
    const appSecret =
      process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET || process.env.FACEBOOK_APP_SECRET;

    console.log('Instagram webhook POST received', {
      hasSignature: Boolean(signature),
      hasAppSecret: Boolean(appSecret),
      rawBodyLength: rawBody.length,
    });

    if (signature && appSecret) {
      const validSignature = await verifyRequestSignature(rawBody, signature, appSecret);
      if (!validSignature) {
        console.error('Instagram webhook signature validation failed', {
          hasSignature: Boolean(signature),
          hasAppSecret: Boolean(appSecret),
          rawBodyLength: rawBody.length,
        });
        return NextResponse.json({ error: 'Invalid webhook signature' }, { status: 401 });
      }
    } else {
      console.warn('Instagram webhook signature check skipped', {
        hasSignature: Boolean(signature),
        hasAppSecret: Boolean(appSecret),
      });
    }

    const payload = JSON.parse(rawBody) as InstagramWebhookPayload;
    const entrySummaries = (payload.entry || []).slice(0, 5).map((entry) => ({
      igAccountId: String(entry.id || 'unknown'),
      messagingCount: entry.messaging?.length || 0,
      changesCount: entry.changes?.length || 0,
      hasMessaging: Array.isArray(entry.messaging),
      hasChanges: Array.isArray(entry.changes),
    }));

    console.log('Instagram webhook payload summary', {
      object: payload.object || 'unknown',
      entryCount: payload.entry?.length || 0,
      entrySummaries,
    });

    const eventType = payload.object || 'unknown';
    const events: StoredMessageInput[] = [];

    for (const entry of payload.entry || []) {
      const igAccountId = String(entry.id || 'unknown');

      for (const event of entry.messaging || []) {
        events.push(mapMessagingEvent(igAccountId, event));
      }

      for (const change of entry.changes || []) {
        const mapped = mapCommentChange(igAccountId, entry.time, change);
        if (mapped) {
          events.push(mapped);
        }
      }
    }

    let storedCount = 0;
    let duplicateCount = 0;
    let storeErrorCount = 0;
    let enqueuedCount = 0;
    const storeFailures: Array<{ platformMessageId: string; igAccountId: string; threadKey: string; error?: string }> = [];

    for (const event of events) {
      const { inserted, threadState, reason, errorMessage } = await recordInstagramMessage(event);
      if (inserted) {
        storedCount += 1;
      } else if (reason === 'duplicate') {
        duplicateCount += 1;
      } else {
        storeErrorCount += 1;
        storeFailures.push({
          platformMessageId: event.platformMessageId,
          igAccountId: event.igAccountId,
          threadKey: event.threadKey,
          error: errorMessage,
        });
        console.error('Instagram webhook failed to persist event', {
          platformMessageId: event.platformMessageId,
          igAccountId: event.igAccountId,
          threadKey: event.threadKey,
          reason,
          error: errorMessage,
        });
      }

      const isIncomingDm =
        event.messageKind === 'dm' && event.direction === 'incoming' && typeof event.messageText === 'string';

      if (isIncomingDm && inserted) {
        try {
          await db.insert(instagramDmPending).values({
            igAccountId: event.igAccountId,
            threadKey: event.threadKey,
            inboundPayload: event as unknown as Record<string, unknown>,
            threadState: threadState as unknown as Record<string, unknown>,
            status: 'pending',
          });
          enqueuedCount += 1;
        } catch (error) {
          console.error('Instagram webhook failed to enqueue DM for processing', {
            platformMessageId: event.platformMessageId,
            igAccountId: event.igAccountId,
            threadKey: event.threadKey,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    console.log('Instagram webhook received', {
      eventType,
      eventCount: events.length,
      storedCount,
      duplicateCount,
      storeErrorCount,
      enqueuedCount,
      dmCount: events.filter((item) => item.messageKind === 'dm').length,
      commentCount: events.filter((item) => item.messageKind === 'comment').length,
      entryCount: payload.entry?.length || 0,
    });

    return NextResponse.json({
      received: true,
      events: events.length,
      stored: storedCount,
      duplicates: duplicateCount,
      storeErrors: storeErrorCount,
      enqueued: enqueuedCount,
      storeFailures: storeFailures.slice(0, 3),
    });
  } catch (error) {
    console.error('Instagram webhook parse error:', error);
    return NextResponse.json({ error: 'Invalid webhook payload' }, { status: 400 });
  }
}
