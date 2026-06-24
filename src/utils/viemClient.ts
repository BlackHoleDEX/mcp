import { createPublicClient, http } from 'viem';
import { avalanche } from 'viem/chains';
import { SERVER_CONFIG } from '../config.js';

export const publicClient = createPublicClient({
  chain: avalanche,
  transport: http(SERVER_CONFIG.RPC_URL),
});
