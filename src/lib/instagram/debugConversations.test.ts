import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildConversationMessagesUrl,
  buildConversationsUrl,
  redactAccessTokenFromUrl,
  summarizeConversationMessages,
  summarizeConversations,
} from './debugConversations';

test('builds Graph conversations URL with platform instagram and requested limit', () => {
  const url = buildConversationsUrl({ graphVersion: 'v25.0', accessToken: 'secret-token', limit: 3 });

  assert.equal(url.origin, 'https://graph.instagram.com');
  assert.equal(url.pathname, '/v25.0/me/conversations');
  assert.equal(url.searchParams.get('platform'), 'instagram');
  assert.equal(url.searchParams.get('limit'), '3');
  assert.equal(url.searchParams.get('access_token'), 'secret-token');
});

test('builds Graph messages URL for a specific conversation', () => {
  const url = buildConversationMessagesUrl({
    graphVersion: 'v25.0',
    conversationId: 'conv/unsafe id',
    accessToken: 'secret-token',
    limit: 5,
  });

  assert.equal(url.origin, 'https://graph.instagram.com');
  assert.equal(url.pathname, '/v25.0/conv%2Funsafe%20id');
  assert.equal(url.searchParams.get('fields'), 'messages.limit(5){id,created_time,from,to,message,attachments}');
  assert.equal(url.searchParams.get('access_token'), 'secret-token');
});

test('redacts access_token from URLs before logging or returning diagnostics', () => {
  const redacted = redactAccessTokenFromUrl(
    'https://graph.instagram.com/v25.0/me/conversations?platform=instagram&access_token=secret-token&limit=2'
  );

  assert.equal(
    redacted,
    'https://graph.instagram.com/v25.0/me/conversations?platform=instagram&access_token=%5BREDACTED%5D&limit=2'
  );
  assert.ok(!redacted.includes('secret-token'));
});

test('summarizes conversations without leaking raw payload fields', () => {
  const summary = summarizeConversations({
    data: [
      { id: 'conv-1', updated_time: '2026-05-24T01:02:03+0000', unexpected: 'hidden' },
      { id: 123, updated_time: null },
    ],
    paging: { cursors: { before: 'a', after: 'b' } },
  });

  assert.deepEqual(summary, {
    count: 2,
    hasPaging: true,
    conversations: [
      { id: 'conv-1', updatedTime: '2026-05-24T01:02:03+0000' },
      { id: '123', updatedTime: null },
    ],
  });
});

test('summarizes messages without text by default and with bounded preview when requested', () => {
  const payload = {
    messages: {
      data: [
        {
          id: 'msg-1',
          created_time: '2026-05-24T01:02:03+0000',
          from: { id: 'sender-1' },
          to: { data: [{ id: 'ig-1' }] },
          message: 'hello this is a direct message with private content',
          attachments: { data: [{ type: 'image' }] },
        },
      ],
    },
  };

  assert.deepEqual(summarizeConversationMessages(payload), {
    count: 1,
    messages: [
      {
        id: 'msg-1',
        createdTime: '2026-05-24T01:02:03+0000',
        fromId: 'sender-1',
        toIds: ['ig-1'],
        hasText: true,
        textLength: 51,
        textPreview: null,
        attachmentCount: 1,
      },
    ],
  });

  const withText = summarizeConversationMessages(payload, { includeMessageText: true, previewChars: 12 });
  assert.equal(withText.messages[0]?.textPreview, 'hello this i…');
});
