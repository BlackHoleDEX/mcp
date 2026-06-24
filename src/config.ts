const defaultClGraphUrl =
  'https://api.goldsky.com/api/public/project_cm8gyxv0x02qv01uphvy69ey6/subgraphs/poap-subgraph-core/avax-main/gn';

// Default Gamma vault addresses — override with GAMMA_VAULT_ADDRESSES env var
// (comma-separated). Add new vaults here or via the env var without code changes.
const DEFAULT_GAMMA_VAULT_ADDRESSES = [
  "0x5b8ba36c1483d8bd5cb2c99fb048765cd5b35329",
  "0xb8fb4031dc09b6d999722d2c51def7c0cebf41e2",
  "0x37937d9ca9363f66131c445307ff0ee20089fd54",
  "0xd173f801f7112e4fb42e7e92ddd653be9ade4358",
  "0x3375189bd929b75a595449c06390443ea3775340",
  "0x7abf35762cb88700d034b36a1e919d185919bc1f",
  "0x98c7ee1ff3350ebe192b27b8cb6db52bee3da625",
  "0xbd5b93ddc066f0aae40a18a9bd096f7972662e4f",
  "0x45ef94207e84d667d739270ee0e65ad311f74b34",
  "0xe058e1ffff9b13d3fcd4803fdb55d1cc2fe07ddc",
  "0x5dfdb2d983617bb2b21137d24f70cbfc35cf5b99",
];

export const resolveClGraphUrl = () => process.env.CL_GRAPH_URL ?? defaultClGraphUrl;

export const resolveGammaVaultAddresses = (): string[] => {
  const env = process.env.GAMMA_VAULT_ADDRESSES;
  if (env) return env.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  return DEFAULT_GAMMA_VAULT_ADDRESSES;
};

export const SERVER_CONFIG = {
  RPC_URL: process.env.RPC_URL ?? 'https://api.avax.network/ext/bc/C/rpc',
  MULTICALL3_ADDRESS: '0xca11bde05977b3631167028862be2a173976ca11',
  CL_GRAPH_URL: resolveClGraphUrl(),
  BASIC_GRAPH_URL: process.env.BASIC_GRAPH_URL ??
    'https://api.goldsky.com/api/public/project_cm8gyxv0x02qv01uphvy69ey6/subgraphs/blackhole-basic-pools-avalanche-c-chain-new-1/avax-basic/gn',
  GAMMA_VAULT_ADDRESSES: resolveGammaVaultAddresses(),
};
