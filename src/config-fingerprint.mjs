import crypto from 'node:crypto';

export function configFingerprint(config = {}) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({
      upstreamBaseUrl: config.upstreamBaseUrl || '',
      upstreamApiKey: config.upstreamApiKey || '',
      defaultModel: config.defaultModel || '',
      reasoningEffort: config.reasoningEffort || '',
      localAuthToken: config.localAuthToken || '',
    }))
    .digest('hex');
}
