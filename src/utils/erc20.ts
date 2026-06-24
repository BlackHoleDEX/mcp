import { ERC20_ABI } from '../constants/contracts.js';
import { publicClient } from './viemClient.js';

export async function getAllowance(
  token: string,
  owner: string,
  spender: string,
): Promise<bigint> {
  return (await publicClient.readContract({
    address: token as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner as `0x${string}`, spender as `0x${string}`],
  })) as bigint;
}

export async function hasSufficientAllowance(
  token: string,
  owner: string,
  spender: string,
  amountRaw: bigint,
): Promise<boolean> {
  try {
    const current = await getAllowance(token, owner, spender);
    return current >= amountRaw;
  } catch {
    return false;
  }
}
