export const INSTAGRAM_WEBHOOK_VERIFY_TOKEN_ENV_KEYS = [
  'INSTAGRAM_WEBHOOK_VERIFY_TOKEN',
  'META_WEBHOOK_VERIFY_TOKEN',
  'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
  'WEBHOOK_VERIFY_TOKEN',
  'VERIFY_TOKEN',
] as const;

export type InstagramWebhookVerifyEnv = Record<string, string | undefined>;

export type InstagramWebhookVerificationInput = {
  mode: string | null;
  verifyToken: string | null;
  challenge: string | null;
  env?: InstagramWebhookVerifyEnv;
};

export type InstagramWebhookVerificationResult =
  | {
      ok: true;
      challenge: string;
      tokenSource: (typeof INSTAGRAM_WEBHOOK_VERIFY_TOKEN_ENV_KEYS)[number];
    }
  | {
      ok: false;
      status: 403 | 500;
      reason: 'missing_server_verify_token' | 'invalid_mode_or_token_or_challenge';
      tokenSource: (typeof INSTAGRAM_WEBHOOK_VERIFY_TOKEN_ENV_KEYS)[number] | null;
      tokenMatch: boolean;
      hasChallenge: boolean;
    };

function normalizeToken(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveInstagramWebhookVerifyToken(
  env: InstagramWebhookVerifyEnv = process.env
): { token: string | null; source: (typeof INSTAGRAM_WEBHOOK_VERIFY_TOKEN_ENV_KEYS)[number] | null } {
  for (const key of INSTAGRAM_WEBHOOK_VERIFY_TOKEN_ENV_KEYS) {
    const token = normalizeToken(env[key]);
    if (token) {
      return { token, source: key };
    }
  }

  return { token: null, source: null };
}

export function verifyInstagramWebhookChallenge(
  input: InstagramWebhookVerificationInput
): InstagramWebhookVerificationResult {
  const { token: expectedVerifyToken, source } = resolveInstagramWebhookVerifyToken(input.env);
  const receivedVerifyToken = normalizeToken(input.verifyToken);

  if (!expectedVerifyToken) {
    return {
      ok: false,
      status: 500,
      reason: 'missing_server_verify_token',
      tokenSource: null,
      tokenMatch: false,
      hasChallenge: Boolean(input.challenge),
    };
  }

  const tokenMatch = Boolean(receivedVerifyToken && receivedVerifyToken === expectedVerifyToken);
  if (input.mode === 'subscribe' && tokenMatch && input.challenge) {
    return {
      ok: true,
      challenge: input.challenge,
      tokenSource: source!,
    };
  }

  return {
    ok: false,
    status: 403,
    reason: 'invalid_mode_or_token_or_challenge',
    tokenSource: source,
    tokenMatch,
    hasChallenge: Boolean(input.challenge),
  };
}
