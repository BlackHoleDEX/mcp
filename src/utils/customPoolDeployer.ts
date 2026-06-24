import { SERVER_CONFIG } from '../config.js';
import { publicClient } from './viemClient.js';

// AlgebraPoolAPIStorage: maps pool address → deployer (set by the deployer contract itself at pool creation).
const ALGEBRA_POOL_API_STORAGE_ADDRESS = '0xa90BC0E1D28151206530dABa53A5b8d28332cb7f' as const;

const PAIR_TO_DEPLOYER_ABI = [
  {
    inputs: [{ internalType: 'address', name: '', type: 'address' }],
    name: 'pairToDeployer',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

async function resolveDeployerViaStorage(poolAddress: string): Promise<string | undefined> {
  const deployer = await publicClient.readContract({
    address: ALGEBRA_POOL_API_STORAGE_ADDRESS,
    abi: PAIR_TO_DEPLOYER_ABI,
    functionName: 'pairToDeployer',
    args: [poolAddress as `0x${string}`],
  });
  return deployer && deployer !== '0x0000000000000000000000000000000000000000'
    ? deployer
    : undefined;
}

/**
 * Resolve the deployer for a CL pool.
 * Tries the subgraph first, falls back to on-chain factory verification.
 */
export async function resolveDeployerFromPool(poolAddress: string): Promise<string> {
  const onChain = await resolveDeployerViaStorage(poolAddress);
  if (onChain) return onChain;

  try {
    const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ pool(id: "${poolAddress.toLowerCase()}") { deployer } }`,
      }),
    });
    const json = (await res.json()) as { data?: { pool?: { deployer?: string } } };
    const deployer = json?.data?.pool?.deployer;
    if (deployer) return deployer;
  } catch {
    // fall through
  }

  throw new Error(`No deployer found for pool ${poolAddress}`);
}

/**
 * Resolve deployer with no extra calls when it's already known.
 * - deployer provided → use it directly
 * - poolAddress provided → resolve via subgraph (+ on-chain fallback)
 * - neither → undefined (callers fall back to current/new addresses)
 */
export async function resolveDeployer(
  deployer?: string | null,
  poolAddress?: string | null,
): Promise<string | undefined> {
  if (deployer) return deployer;
  if (poolAddress) return resolveDeployerFromPool(poolAddress);
  return undefined;
}
