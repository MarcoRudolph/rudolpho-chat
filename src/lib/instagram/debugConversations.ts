export type GraphConversationSummary = {
  count: number;
  hasPaging: boolean;
  conversations: Array<{
    id: string;
    updatedTime: string | null;
  }>;
};

export type GraphConversationMessagesSummary = {
  count: number;
  messages: Array<{
    id: string;
    createdTime: string | null;
    fromId: string | null;
    toIds: string[];
    hasText: boolean;
    textLength: number;
    textPreview: string | null;
    attachmentCount: number;
  }>;
};

type GraphUrlInput = {
  graphVersion: string;
  accessToken: string;
  limit: number;
};

type ConversationMessagesUrlInput = GraphUrlInput & {
  conversationId: string;
};

type MessageSummaryOptions = {
  includeMessageText?: boolean;
  previewChars?: number;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return null;
}

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 5;
  return Math.min(Math.max(Math.trunc(limit), 1), 25);
}

function previewText(text: string, maxChars: number): string {
  const safeMax = Math.min(Math.max(Math.trunc(maxChars), 1), 500);
  if (text.length <= safeMax) return text;
  return `${text.slice(0, safeMax)}…`;
}

export function buildConversationsUrl(input: GraphUrlInput): URL {
  const url = new URL(`https://graph.instagram.com/${input.graphVersion}/me/conversations`);
  url.searchParams.set('platform', 'instagram');
  url.searchParams.set('access_token', input.accessToken);
  url.searchParams.set('limit', String(clampLimit(input.limit)));
  return url;
}

export function buildConversationMessagesUrl(input: ConversationMessagesUrlInput): URL {
  const url = new URL(
    `https://graph.instagram.com/${input.graphVersion}/${encodeURIComponent(input.conversationId)}`
  );
  const limit = clampLimit(input.limit);
  url.searchParams.set('fields', `messages.limit(${limit}){id,created_time,from,to,message,attachments}`);
  url.searchParams.set('access_token', input.accessToken);
  return url;
}

export function redactAccessTokenFromUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', '[REDACTED]');
    }
    return url.toString();
  } catch {
    return rawUrl.replace(/access_token=([^&]+)/, 'access_token=[REDACTED]');
  }
}

export function summarizeConversations(payload: unknown): GraphConversationSummary {
  const root = asRecord(payload);
  const rows = asArray(root?.data);
  return {
    count: rows.length,
    hasPaging: Boolean(root?.paging),
    conversations: rows.map((item) => {
      const row = asRecord(item);
      return {
        id: asString(row?.id) || 'unknown',
        updatedTime: asString(row?.updated_time),
      };
    }),
  };
}

export function summarizeConversationMessages(
  payload: unknown,
  options: MessageSummaryOptions = {}
): GraphConversationMessagesSummary {
  const root = asRecord(payload);
  const messagesRoot = asRecord(root?.messages);
  const rows = asArray(messagesRoot?.data);
  const previewChars = options.previewChars ?? 80;

  return {
    count: rows.length,
    messages: rows.map((item) => {
      const row = asRecord(item);
      const from = asRecord(row?.from);
      const to = asRecord(row?.to);
      const attachments = asRecord(row?.attachments);
      const text = asString(row?.message);
      const toIds = asArray(to?.data)
        .map((target) => asString(asRecord(target)?.id))
        .filter((id): id is string => Boolean(id));

      return {
        id: asString(row?.id) || 'unknown',
        createdTime: asString(row?.created_time),
        fromId: asString(from?.id),
        toIds,
        hasText: Boolean(text),
        textLength: text?.length || 0,
        textPreview: text && options.includeMessageText ? previewText(text, previewChars) : null,
        attachmentCount: asArray(attachments?.data).length,
      };
    }),
  };
}
