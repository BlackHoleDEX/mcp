import { getAddress, isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY_ENV_KEY = "PRIVATE_KEY";
const USER_ADDRESS_ENV_KEY = "USER_ADDRESS";

export function resolveEnvPrivateKey(): Hex | undefined {
  const raw = process.env[PRIVATE_KEY_ENV_KEY]?.trim();
  if (!raw) return undefined;

  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`Invalid private key in ${PRIVATE_KEY_ENV_KEY}. Expected a 32-byte hex string.`);
  }

  return normalized as Hex;
}

export function getEnvWalletAccount() {
  const privateKey = resolveEnvPrivateKey();
  return privateKey ? privateKeyToAccount(privateKey) : undefined;
}

export function getEnvUserAddress(): Address | undefined {
  const account = getEnvWalletAccount();
  if (account) return account.address;

  const envAddress = process.env[USER_ADDRESS_ENV_KEY]?.trim();
  if (!envAddress) return undefined;
  if (!isAddress(envAddress)) {
    throw new Error(`Invalid address in ${USER_ADDRESS_ENV_KEY}.`);
  }

  return getAddress(envAddress);
}

export function withEnvUserAddress(args: Record<string, unknown>): Record<string, unknown> {
  if ("userAddress" in args && args.userAddress) return args;

  const userAddress = getEnvUserAddress();
  if (!userAddress) return args;

  return {
    ...args,
    userAddress,
  };
}
