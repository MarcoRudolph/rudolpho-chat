import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveInstagramWebhookVerifyToken,
  verifyInstagramWebhookChallenge,
} from './webhookVerify';

test('verifyInstagramWebhookChallenge accepts matching Meta subscribe challenge', () => {
  const result = verifyInstagramWebhookChallenge({
    mode: 'subscribe',
    verifyToken: 'meta-token',
    challenge: '123456',
    env: { INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'meta-token' },
  });

  assert.deepEqual(result, {
    ok: true,
    challenge: '123456',
    tokenSource: 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN',
  });
});

test('verifyInstagramWebhookChallenge trims accidental whitespace in configured and received token', () => {
  const result = verifyInstagramWebhookChallenge({
    mode: 'subscribe',
    verifyToken: ' meta-token ',
    challenge: 'abc',
    env: { META_WEBHOOK_VERIFY_TOKEN: ' meta-token\n' },
  });

  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.challenge, 'abc');
    assert.equal(result.tokenSource, 'META_WEBHOOK_VERIFY_TOKEN');
  }
});

test('resolveInstagramWebhookVerifyToken supports common fallback env names', () => {
  assert.deepEqual(resolveInstagramWebhookVerifyToken({ WEBHOOK_VERIFY_TOKEN: 'webhook-token' }), {
    token: 'webhook-token',
    source: 'WEBHOOK_VERIFY_TOKEN',
  });
  assert.deepEqual(resolveInstagramWebhookVerifyToken({ VERIFY_TOKEN: 'verify-token' }), {
    token: 'verify-token',
    source: 'VERIFY_TOKEN',
  });
  assert.deepEqual(resolveInstagramWebhookVerifyToken({ FACEBOOK_WEBHOOK_VERIFY_TOKEN: 'fb-token' }), {
    token: 'fb-token',
    source: 'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
  });
});

test('verifyInstagramWebhookChallenge rejects wrong token without leaking expected token', () => {
  const result = verifyInstagramWebhookChallenge({
    mode: 'subscribe',
    verifyToken: 'wrong',
    challenge: '123456',
    env: { INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'right' },
  });

  assert.deepEqual(result, {
    ok: false,
    status: 403,
    reason: 'invalid_mode_or_token_or_challenge',
    tokenSource: 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN',
    tokenMatch: false,
    hasChallenge: true,
  });
});

test('verifyInstagramWebhookChallenge reports missing server token as configuration error', () => {
  const result = verifyInstagramWebhookChallenge({
    mode: 'subscribe',
    verifyToken: 'anything',
    challenge: '123456',
    env: {},
  });

  assert.deepEqual(result, {
    ok: false,
    status: 500,
    reason: 'missing_server_verify_token',
    tokenSource: null,
    tokenMatch: false,
    hasChallenge: true,
  });
});
