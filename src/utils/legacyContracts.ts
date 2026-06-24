// Mirrors the legacy-detection logic from blackhole-website/src/common/utils/custom-pool-deployer.ts.
// Legacy addresses sourced from prodEnvConstants.legacyAddresses.
import { LEGACY_POOL_DEPLOYERS } from '../common/constants/contracts/custom-pool-deployers.js';
import {
  LEGACY_NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
  NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
} from '../constants/contracts.js';
import { legacyAlgebraPoolAPIAddress } from '../common/constants/contracts/algebra-pool-api.js';
import { legacyRouterV2Address, routerV2Address } from '../common/constants/contracts/router-v2.js';
import { ALGEBRA_POOL_API_ADDRESS } from '../constants/contracts.js';

// Farming addresses — from prodEnvConstants.legacyAddresses and app-constants.ts
const LEGACY_FARMING_CENTER          = "0xa47Ad2C95FaE476a73b85A355A5855aDb4b3A449";
const LEGACY_ALGEBRA_ETERNAL_FARMING = "0x01A8A00A6fC8106B94f84aAbAef689Fd0D77271A";
const CURRENT_FARMING_CENTER         = "0xCeCc64211f1Ed70a71BD47EB656f7067C1f45541";
const CURRENT_ALGEBRA_ETERNAL_FARMING = "0x9c70BedD11Cf874F07B1Bd9C29e3e41f9F248F5c";

export function isLegacyDeployer(deployer?: string | null): boolean {
  if (!deployer) return true; // unknown → assume legacy to be safe
  return LEGACY_POOL_DEPLOYERS.has(deployer.toLowerCase());
}

export function getRouterV2ForDeployer(deployer?: string | null): string {
  return isLegacyDeployer(deployer) ? legacyRouterV2Address : routerV2Address;
}

export function getNFPMForDeployer(deployer?: string | null): string {
  return isLegacyDeployer(deployer)
    ? LEGACY_NONFUNGIBLE_POSITION_MANAGER_ADDRESS
    : NONFUNGIBLE_POSITION_MANAGER_ADDRESS;
}

export function getFarmingCenterForDeployer(deployer?: string | null): string {
  return isLegacyDeployer(deployer) ? LEGACY_FARMING_CENTER : CURRENT_FARMING_CENTER;
}

export function getEternalFarmingForDeployer(deployer?: string | null): string {
  return isLegacyDeployer(deployer) ? LEGACY_ALGEBRA_ETERNAL_FARMING : CURRENT_ALGEBRA_ETERNAL_FARMING;
}

export function getPoolAPIForDeployer(deployer?: string | null): string {
  return isLegacyDeployer(deployer) ? legacyAlgebraPoolAPIAddress : ALGEBRA_POOL_API_ADDRESS;
}
