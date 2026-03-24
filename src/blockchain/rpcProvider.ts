import { ethers } from 'ethers';
import { logger } from '../utils/logger';

let cachedProvider: ethers.AbstractProvider | null = null;
let cachedEndpointsKey = '';

function parseEndpointList(value?: string): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function getConfiguredRpcEndpoints(): string[] {
  const explicitList = parseEndpointList(process.env.RPC_ENDPOINTS);
  const primary = process.env.RPC_ENDPOINT?.trim();
  const fallbackList = parseEndpointList(process.env.RPC_FALLBACK_ENDPOINTS);

  const ordered = explicitList.length > 0
    ? explicitList
    : [
        ...(primary ? [primary] : []),
        ...fallbackList,
      ];

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const endpoint of ordered) {
    if (seen.has(endpoint)) {
      continue;
    }

    seen.add(endpoint);
    deduped.push(endpoint);
  }

  return deduped;
}

export function createRpcProvider(): ethers.AbstractProvider {
  const endpoints = getConfiguredRpcEndpoints();

  if (endpoints.length === 0) {
    throw new Error('At least one RPC endpoint is required via RPC_ENDPOINT or RPC_ENDPOINTS.');
  }

  const endpointKey = endpoints.join('|');
  if (cachedProvider && cachedEndpointsKey === endpointKey) {
    return cachedProvider;
  }

  const providers = endpoints.map((endpoint) => new ethers.JsonRpcProvider(endpoint));
  const provider = providers.length === 1
    ? providers[0]
    : new ethers.FallbackProvider(providers);

  cachedProvider = provider;
  cachedEndpointsKey = endpointKey;

  logger.info(
    `RPC provider initialized with ${endpoints.length} endpoint(s).`,
    { context: 'startup.rpc' }
  );

  return provider;
}
