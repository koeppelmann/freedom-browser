/**
 * SwarmNodeFunder renderer-side client
 *
 * Thin wrapper over the main-process swarmFunder IPC surface. All ethers /
 * JSON / ABI encoding lives in main — this file never imports node modules.
 *
 * The renderer calls main to get a quote + prepared tx, then hands the tx
 * body to the existing wallet IPC (`window.wallet.sendTransaction`) so
 * signing and broadcast reuse the same code path as every other wallet tx.
 */

const GNOSIS_CHAIN_ID = 100;

/**
 * Read the pool's spot price and the expected BZZ output for an xDAI input.
 * @param {bigint} xdaiForSwap - wei of xDAI to swap
 */
export async function getQuote(xdaiForSwap) {
  const res = await window.swarmFunder.getQuote({ xdaiForSwap: xdaiForSwap.toString() });
  if (!res?.success) throw new Error(res?.error || 'Quote failed');
  return {
    spotXdaiPerBzz: res.spotXdaiPerBzz,
    expectedBzzPlur: BigInt(res.expectedBzzPlur),
  };
}

/**
 * Prepare the fund-node transaction (calldata + value + slippage-guarded
 * minBzzOut). Does not sign or broadcast.
 */
export async function prepareTx({ beeWallet, xdaiForSwap, xdaiForBee, slippageBps = 500 }) {
  const res = await window.swarmFunder.prepareTx({
    beeWallet,
    xdaiForSwap: xdaiForSwap.toString(),
    xdaiForBee: xdaiForBee.toString(),
    slippageBps,
  });
  if (!res?.success) throw new Error(res?.error || 'Prepare failed');
  return res;
}

/**
 * End-to-end one-tx fund: quote → prepare → estimate → send → return hash.
 */
export async function fundNodeOneTx({ beeWallet, xdaiForSwap, xdaiForBee, slippageBps = 500 }) {
  const prepared = await prepareTx({ beeWallet, xdaiForSwap, xdaiForBee, slippageBps });

  const activeResp = await window.wallet.getActiveAddress();
  const activeAddress = typeof activeResp === 'string'
    ? activeResp
    : activeResp?.address;
  if (!activeAddress) {
    throw new Error(activeResp?.error || 'No active wallet address');
  }
  const gasEst = await window.wallet.estimateGas({
    from: activeAddress,
    to: prepared.to,
    value: prepared.value,
    data: prepared.data,
    chainId: GNOSIS_CHAIN_ID,
  });
  // Normalize gas-estimate response shape (some handlers return {success,...}).
  let gasLimit;
  if (typeof gasEst === 'string' || typeof gasEst === 'bigint' || typeof gasEst === 'number') {
    gasLimit = gasEst;
  } else if (gasEst && typeof gasEst === 'object') {
    if (gasEst.success === false) {
      throw new Error(gasEst.error || gasEst.message || 'Gas estimation failed');
    }
    if (gasEst.gasLimit != null) {
      gasLimit = gasEst.gasLimit;
    } else if (gasEst.error) {
      throw new Error(gasEst.error);
    } else {
      throw new Error(`Gas estimation returned no gasLimit: ${JSON.stringify(gasEst)}`);
    }
  } else {
    throw new Error('Gas estimation failed (empty response)');
  }

  const gasPrices = await window.wallet.getGasPrice(GNOSIS_CHAIN_ID);
  const gasParams = gasPrices && gasPrices.success !== false
    ? {
        maxFeePerGas: gasPrices?.market?.maxFeePerGas || gasPrices?.maxFeePerGas,
        maxPriorityFeePerGas: gasPrices?.market?.maxPriorityFeePerGas || gasPrices?.maxPriorityFeePerGas,
      }
    : {};

  const txResult = await window.wallet.sendTransaction({
    to: prepared.to,
    value: prepared.value,
    data: prepared.data,
    gasLimit: String(gasLimit),
    ...gasParams,
    chainId: GNOSIS_CHAIN_ID,
  });
  if (!txResult?.success) throw new Error(txResult?.error || 'Transaction failed');

  return {
    hash: txResult.hash,
    explorerUrl: txResult.explorerUrl,
    minBzzOutPlur: BigInt(prepared.meta.minBzzOutPlur),
    expectedBzzPlur: BigInt(prepared.meta.expectedBzzPlur),
    totalValueWei: BigInt(prepared.meta.totalValueWei),
  };
}

export async function waitForTx(hash, { confirmations = 1 } = {}) {
  return window.wallet.waitForTransaction(hash, GNOSIS_CHAIN_ID, confirmations);
}

/**
 * Format a BZZ PLUR bigint (16 dec) as "X.XXXX".
 */
export function formatBzz(plur) {
  const v = BigInt(plur);
  const whole = v / 10n ** 16n;
  const frac = v % 10n ** 16n;
  const fracStr = frac.toString().padStart(16, '0').slice(0, 4);
  return `${whole}.${fracStr}`;
}

/**
 * Format xDAI wei (18 dec) as "X.XXXX".
 */
export function formatXdai(wei) {
  const v = BigInt(wei);
  const whole = v / 10n ** 18n;
  const frac = v % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').slice(0, 4);
  return `${whole}.${fracStr}`;
}

export const CHAIN_ID = GNOSIS_CHAIN_ID;
