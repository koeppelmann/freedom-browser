/**
 * SwarmNodeFunder main-process service
 *
 * Builds calldata and quotes for the one-tx Bee-node funder contract on
 * Gnosis. Kept in the main process because this repo has no renderer-side
 * bundler — ethers only lives in Node.
 *
 * The renderer invokes these IPC channels, then calls the existing
 * `wallet:send-transaction` handler with the returned {to, data, value}.
 */

const { Interface, ZeroAddress } = require('ethers');
const { ipcMain } = require('electron');
const log = require('electron-log');

const { getProvider, withRetry } = require('../wallet/provider-manager');
const { funderConfig } = require('../../shared/swarm-funder');

const FUNDER_IFACE = new Interface(funderConfig.abi);
const POOL_IFACE = new Interface(funderConfig.poolSlot0Abi);

const TWO_96 = 2n ** 96n;
const BZZ_DECIMALS = 16;
const WXDAI_DECIMALS = 18;
const CHAIN_ID = funderConfig.chainId;
const POOL_FEE_BPS = funderConfig.poolFeeBps;

/**
 * Read the current BZZ/WXDAI spot price from the UniswapV3 pool.
 * @returns {Promise<number>} xDAI per BZZ (e.g. 0.094)
 */
async function getSpotXdaiPerBzz() {
  const provider = getProvider(CHAIN_ID);
  if (!provider) throw new Error(`No provider available for chain ${CHAIN_ID}`);

  const data = POOL_IFACE.encodeFunctionData('slot0', []);
  const raw = await withRetry(
    () => provider.call({ to: funderConfig.pool, data }),
    2,
    CHAIN_ID
  );
  const decoded = POOL_IFACE.decodeFunctionResult('slot0', raw);
  const sqrtPriceX96 = BigInt(decoded.sqrtPriceX96.toString());

  // Token ordering in the pool: token0 = BZZ (16 dec), token1 = WXDAI (18 dec).
  // raw price (token1 per token0) = (sqrtPriceX96 / 2^96)^2
  const sqrtFloat = Number(sqrtPriceX96) / Number(TWO_96);
  const rawPrice = sqrtFloat * sqrtFloat;
  return rawPrice * 10 ** (BZZ_DECIMALS - WXDAI_DECIMALS);
}

/**
 * Estimate BZZ output for an xDAI input at current spot, minus pool fee.
 * Real output will be slightly lower because of concentrated-liquidity slope
 * — caller applies a slippage margin on top.
 * @param {bigint} xdaiWei
 * @param {number} spotXdaiPerBzz
 * @returns {bigint} expected BZZ in PLUR (16 decimals)
 */
function expectedBzzOut(xdaiWei, spotXdaiPerBzz) {
  if (!spotXdaiPerBzz || spotXdaiPerBzz <= 0) return 0n;
  const xdaiFloat = Number(xdaiWei) / 1e18;
  const bzzFloat = (xdaiFloat * (1 - POOL_FEE_BPS / 10_000)) / spotXdaiPerBzz;
  return BigInt(Math.max(0, Math.floor(bzzFloat * 10 ** BZZ_DECIMALS)));
}

/**
 * Build the calldata for `fundNodeAndBuyStamp`. Skips the stamp purchase
 * (depth = 0) — we fund only; stamp purchase stays in the Bee API for v1.
 */
function buildFundCall({ beeWallet, xdaiToLeaveForBee, minBzzOut }) {
  if (!beeWallet || beeWallet === ZeroAddress) throw new Error('beeWallet required');
  return FUNDER_IFACE.encodeFunctionData('fundNodeAndBuyStamp', [
    beeWallet,
    xdaiToLeaveForBee,
    minBzzOut,
    [
      0n,                        // initialBalancePerChunk
      0,                         // depth = 0 → skip stamp
      0,                         // bucketDepth
      '0x' + '0'.repeat(64),     // nonce
      false,                     // immutableFlag
    ],
  ]);
}

/**
 * One-shot: compute spot + build calldata + return a ready-to-send tx.
 * Renderer hands the output straight to wallet:send-transaction.
 */
async function prepareFundTx({ beeWallet, xdaiForSwap, xdaiForBee, slippageBps = 500 }) {
  const swap = BigInt(xdaiForSwap);
  const bee = BigInt(xdaiForBee);
  if (swap <= 0n) throw new Error('xdaiForSwap must be > 0');

  const spot = await getSpotXdaiPerBzz();
  const expected = expectedBzzOut(swap, spot);
  const minBzzOut = (expected * BigInt(10_000 - Number(slippageBps))) / 10_000n;

  const data = buildFundCall({
    beeWallet,
    xdaiToLeaveForBee: bee,
    minBzzOut,
  });

  return {
    to: funderConfig.address,
    value: (swap + bee).toString(),
    data,
    chainId: CHAIN_ID,
    meta: {
      spotXdaiPerBzz: spot,
      expectedBzzPlur: expected.toString(),
      minBzzOutPlur: minBzzOut.toString(),
      totalValueWei: (swap + bee).toString(),
    },
  };
}

function registerSwarmFunderIpc() {
  ipcMain.handle('swarm-funder:get-config', async () => {
    return {
      success: true,
      address: funderConfig.address,
      chainId: funderConfig.chainId,
      bzzToken: funderConfig.bzzToken,
    };
  });

  ipcMain.handle('swarm-funder:get-quote', async (_event, { xdaiForSwap }) => {
    try {
      const swap = BigInt(xdaiForSwap);
      const spot = await getSpotXdaiPerBzz();
      const expected = expectedBzzOut(swap, spot);
      return {
        success: true,
        spotXdaiPerBzz: spot,
        expectedBzzPlur: expected.toString(),
      };
    } catch (err) {
      log.error('[SwarmFunder] Quote failed:', err?.message || err);
      return { success: false, error: err?.message || String(err) };
    }
  });

  ipcMain.handle('swarm-funder:prepare-tx', async (_event, params) => {
    try {
      const prepared = await prepareFundTx(params);
      return { success: true, ...prepared };
    } catch (err) {
      log.error('[SwarmFunder] Prepare failed:', err?.message || err);
      return { success: false, error: err?.message || String(err) };
    }
  });

  log.info('[SwarmFunder] IPC handlers registered');
}

module.exports = {
  registerSwarmFunderIpc,
  getSpotXdaiPerBzz,
  expectedBzzOut,
  prepareFundTx,
};
