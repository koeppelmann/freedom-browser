/**
 * SwarmNodeFunder client
 *
 * Thin renderer helper for interacting with the deployed one-tx funder
 * contract on Gnosis. Encodes calldata via ethers and submits through the
 * existing wallet IPC layer — no new main-process code needed.
 *
 * The helper contract swaps xDAI → xBZZ on a Gnosis UniswapV3 pool, forwards
 * a caller-specified amount of xDAI to the Bee node's wallet, and routes any
 * xBZZ (optionally via a postage-batch purchase owned by the Bee wallet) to
 * the Bee node.
 */

import {Interface, ZeroAddress} from 'ethers';
import funderConfig from '../../../shared/swarm-funder.json';

const CHAIN_ID = funderConfig.chainId;
const FUNDER_ADDR = funderConfig.address;
const POOL = funderConfig.pool;
const POOL_FEE_BPS = funderConfig.poolFeeBps;

const FUNDER_IFACE = new Interface(funderConfig.abi);
const POOL_IFACE = new Interface(funderConfig.poolSlot0Abi);

// UniswapV3 pool has token0 = xBZZ (16 dec), token1 = WXDAI (18 dec).
const BZZ_DECIMALS = 16;
const WXDAI_DECIMALS = 18;

const TWO_96 = 2n ** 96n;

/**
 * Read the UniV3 pool's spot price (raw token1/token0 ratio adjusted for decimals),
 * using the existing proxyRpc so we don't hit CSP.
 * @returns {Promise<number>} xDAI per BZZ (e.g. 0.094)
 */
export async function getSpotXdaiPerBzz() {
  const chain = await window.wallet.getChain(CHAIN_ID);
  const rpcUrl = chain?.rpcUrls?.[0] || 'https://rpc.gnosischain.com';

  const data = POOL_IFACE.encodeFunctionData('slot0', []);
  const result = await window.wallet.proxyRpc(rpcUrl, 'eth_call', [
    {to: POOL, data},
    'latest',
  ]);
  if (!result?.success) {
    throw new Error(result?.error || 'Failed to read pool slot0');
  }

  const decoded = POOL_IFACE.decodeFunctionResult('slot0', result.result);
  const sqrtPriceX96 = BigInt(decoded.sqrtPriceX96.toString());

  // price_token1_per_token0 (raw) = (sqrtPriceX96 / 2^96)^2
  // Adjust for decimals: xdai_per_bzz = raw * 10^(token0dec - token1dec) = raw * 10^-2
  // Use float math; precision beyond ~10 sig figs is not needed for UX.
  const sqrtFloat = Number(sqrtPriceX96) / Number(TWO_96);
  const rawPrice = sqrtFloat * sqrtFloat;
  return rawPrice * 10 ** (BZZ_DECIMALS - WXDAI_DECIMALS);
}

/**
 * Estimate the expected BZZ output for a given xDAI input, ignoring slippage.
 * Uses the spot price — real output will be slightly lower due to concentrated
 * liquidity and fees. Caller applies a slippage margin to derive `minBzzOut`.
 */
export function expectedBzzOut(xdaiWei, spotXdaiPerBzz) {
  if (!spotXdaiPerBzz || spotXdaiPerBzz <= 0) return 0n;
  // Fee is 0.3% → out ≈ in * (1 - 0.003) / spot
  const xdaiFloat = Number(xdaiWei) / 1e18;
  const bzzFloat = (xdaiFloat * (1 - POOL_FEE_BPS / 10_000)) / spotXdaiPerBzz;
  // return in PLUR (16 decimals)
  return BigInt(Math.floor(bzzFloat * 10 ** BZZ_DECIMALS));
}

/**
 * Build the calldata for a swap-and-fund tx. Pass depth=0 to skip stamp purchase.
 */
export function encodeFundCall({beeWallet, xdaiToLeaveForBee, minBzzOut, stamp}) {
  const stampTuple = stamp ?? {
    initialBalancePerChunk: 0n,
    depth: 0,
    bucketDepth: 0,
    nonce: '0x' + '0'.repeat(64),
    immutableFlag: false,
  };
  return FUNDER_IFACE.encodeFunctionData('fundNodeAndBuyStamp', [
    beeWallet,
    xdaiToLeaveForBee,
    minBzzOut,
    [
      stampTuple.initialBalancePerChunk,
      stampTuple.depth,
      stampTuple.bucketDepth,
      stampTuple.nonce,
      stampTuple.immutableFlag,
    ],
  ]);
}

/**
 * One-shot: fund the Bee node from the user's MAIN wallet in a single tx.
 *
 * @param {Object} opts
 * @param {string} opts.beeWallet - Bee node Ethereum address (recipient)
 * @param {bigint} opts.xdaiForSwap - xDAI (wei) to swap into BZZ
 * @param {bigint} opts.xdaiForBee - xDAI (wei) to forward to beeWallet natively
 * @param {number} [opts.slippageBps=500] - Slippage tolerance in basis points (500 = 5%)
 * @returns {Promise<{hash:string, explorerUrl?:string, minBzzOut:bigint, expectedBzz:bigint}>}
 */
export async function fundNodeOneTx({beeWallet, xdaiForSwap, xdaiForBee, slippageBps = 500}) {
  if (!beeWallet || beeWallet === ZeroAddress) {
    throw new Error('Bee wallet address required');
  }
  if (xdaiForSwap <= 0n) throw new Error('xdaiForSwap must be > 0');

  const totalValue = xdaiForSwap + xdaiForBee;

  // 1. Read spot price, derive minBzzOut with slippage margin.
  const spot = await getSpotXdaiPerBzz();
  const expected = expectedBzzOut(xdaiForSwap, spot);
  const minBzzOut = (expected * BigInt(10_000 - slippageBps)) / 10_000n;

  // 2. Encode calldata (skip stamp purchase for the first integration).
  const data = encodeFundCall({
    beeWallet,
    xdaiToLeaveForBee: xdaiForBee,
    minBzzOut,
  });

  // 3. Estimate gas.
  const activeAddress = await window.wallet.getActiveAddress();
  const gasEst = await window.wallet.estimateGas({
    from: activeAddress,
    to: FUNDER_ADDR,
    value: totalValue.toString(),
    data,
    chainId: CHAIN_ID,
  });
  if (!gasEst?.success && gasEst?.success !== undefined) {
    // Some IPC handlers use {success, ...} shape; others throw on error. Normalize.
    throw new Error(gasEst.error || 'Gas estimation failed');
  }
  const gasLimit = gasEst.gasLimit || gasEst;

  // 4. Fetch fee data.
  const gasPrices = await window.wallet.getGasPrice(CHAIN_ID);
  const gasParams = gasPrices?.success === false
    ? {}
    : {
        maxFeePerGas: gasPrices?.market?.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices?.market?.maxPriorityFeePerGas,
      };

  // 5. Submit via existing wallet IPC (signs with active wallet).
  const result = await window.wallet.sendTransaction({
    to: FUNDER_ADDR,
    value: totalValue.toString(),
    data,
    gasLimit: typeof gasLimit === 'string' ? gasLimit : String(gasLimit),
    ...gasParams,
    chainId: CHAIN_ID,
  });

  if (!result?.success) {
    throw new Error(result?.error || 'Transaction failed');
  }

  return {
    hash: result.hash,
    explorerUrl: result.explorerUrl,
    minBzzOut,
    expectedBzz: expected,
    totalValue,
  };
}

/**
 * Wait for a tx to confirm. Uses existing wallet IPC.
 */
export async function waitForTx(hash, {confirmations = 1} = {}) {
  return window.wallet.waitForTransaction(hash, CHAIN_ID, confirmations);
}

/**
 * Format a BZZ PLUR bigint as a human-readable BZZ string.
 */
export function formatBzz(plur) {
  const v = BigInt(plur);
  const whole = v / 10n ** 16n;
  const frac = v % 10n ** 16n;
  const fracStr = frac.toString().padStart(16, '0').slice(0, 4);
  return `${whole}.${fracStr}`;
}

/**
 * Format xDAI wei as a human-readable decimal.
 */
export function formatXdai(wei) {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = v % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${fracStr}`;
}

export const CONSTANTS = {
  FUNDER_ADDR,
  CHAIN_ID,
  POOL_FEE_BPS,
  BZZ_DECIMALS,
  WXDAI_DECIMALS,
};
