import { TokenManager } from '../auth/tokenManager';
import { AIProvider } from './aiProvider';
import { CodexProvider, HttpStreamClient } from './codexProvider';
import { RateLimiter } from './rateLimiter';

export interface ProviderFactoryConfig {
  endpoint: string;
  model: string;
  instructions?: string;
  rateLimitWindowSec: number;
  rateLimitMaxRequests: number;
  maxOutputTokens?: number;
  serviceTier?: string;
  promptCacheKey?: string;
  promptCacheRetention?: string;
}

export interface ProviderFactoryOverrides {
  httpClient?: HttpStreamClient;
}

export function createAIProvider(
  tokenManager: Pick<TokenManager, 'getAccessToken'>,
  config: ProviderFactoryConfig,
  overrides: ProviderFactoryOverrides = {},
): AIProvider {
  const rateLimiter = new RateLimiter({
    maxRequests: config.rateLimitMaxRequests,
    windowMs: config.rateLimitWindowSec * 1000,
  });

  return new CodexProvider({
    endpoint: config.endpoint,
    model: config.model,
    instructions: config.instructions,
    tokenManager,
    rateLimiter,
    httpClient: overrides.httpClient,
    maxOutputTokens: config.maxOutputTokens,
    serviceTier: config.serviceTier,
    promptCacheKey: config.promptCacheKey,
    promptCacheRetention: config.promptCacheRetention,
  });
}
