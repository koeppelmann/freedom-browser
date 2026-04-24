/**
 * Publish Setup Module
 *
 * Guided checklist for enabling Swarm publishing: fund xDAI, switch to
 * light mode, chequebook deployment, acquire xBZZ, purchase stamps.
 */

import { state } from '../state.js';
import { walletState, registerScreenHider } from './wallet-state.js';
import { isChequebookDeployed } from './wallet-utils.js';
import { normalizeSwarmMode } from './swarm-readiness.js';
import { fetchBeeJson } from './bee-api.js';
import { openStampManager } from './stamp-manager.js';
import { topUpXdai, topUpXbzz, GNOSIS_CHAIN_ID, XDAI_TOKEN_KEY, XBZZ_TOKEN_KEY } from './funding-actions.js';
import {
  fundNodeOneTx,
  waitForTx,
  getSpotXdaiPerBzz,
  expectedBzzOut,
  formatBzz,
  formatXdai,
} from './swarm-funder-client.js';

const POLL_MS = 5000;

// DOM references
let publishSetupScreen;
let publishSetupBackBtn;
let stepFundXdai;
let stepFundXdaiBtn;
let stepFundXdaiMeta;
let stepLightMode;
let stepLightModeBtn;
let stepChequebook;
let stepChequebookWaiting;
let stepFundXbzz;
let stepFundXbzzBtn;
let stepStamps;
let stepStampsBtn;

// One-click setup DOM references
let oneClickPanel;
let oneClickPresets;
let oneClickQuote;
let oneClickBtn;
let oneClickStatus;
let oneClickError;
let oneClickDetail;

// Amounts in xDAI wei
const ONECLICK_PRESETS = [
  {
    key: 'minimal',
    label: 'Try it out',
    desc: '0.25 xDAI',
    xdaiForSwap: 200000000000000000n, // 0.2
    xdaiForBee: 50000000000000000n,   //  0.05
  },
  {
    key: 'recommended',
    label: 'Recommended',
    desc: '0.65 xDAI',
    xdaiForSwap: 600000000000000000n, // 0.6
    xdaiForBee: 50000000000000000n,   // 0.05
  },
  {
    key: 'generous',
    label: 'Generous',
    desc: '1.55 xDAI',
    xdaiForSwap: 1500000000000000000n, // 1.5
    xdaiForBee: 50000000000000000n,    // 0.05
  },
];

let selectedPresetKey = 'recommended';
let cachedSpot = null;
let pollInterval = null;
let cachedBeeWalletAddress = null;
let lastEvaluation = null;

/**
 * Return the Bee wallet address, preferring the canonical identity-derived
 * address over the cached Bee API value. The cache is only a fallback for
 * when identity data hasn't loaded yet.
 */
function getBeeWalletAddress() {
  return walletState.fullAddresses.swarm || cachedBeeWalletAddress;
}

export function initPublishSetup() {
  publishSetupScreen = document.getElementById('sidebar-publish-setup');
  publishSetupBackBtn = document.getElementById('publish-setup-back');

  stepFundXdai = document.getElementById('publish-step-fund-xdai');
  stepFundXdaiBtn = document.getElementById('publish-step-fund-xdai-btn');
  stepFundXdaiMeta = document.getElementById('publish-step-fund-xdai-meta');
  stepLightMode = document.getElementById('publish-step-light-mode');
  stepLightModeBtn = document.getElementById('publish-step-light-mode-btn');
  stepChequebook = document.getElementById('publish-step-chequebook');
  stepChequebookWaiting = document.getElementById('publish-step-chequebook-waiting');
  stepFundXbzz = document.getElementById('publish-step-fund-xbzz');
  stepFundXbzzBtn = document.getElementById('publish-step-fund-xbzz-btn');
  stepStamps = document.getElementById('publish-step-stamps');
  stepStampsBtn = document.getElementById('publish-step-stamps-btn');

  registerScreenHider(() => closePublishSetup());

  publishSetupBackBtn?.addEventListener('click', () => closePublishSetup());

  window.addEventListener('wallet:tx-success', () => {
    if (!publishSetupScreen?.classList.contains('hidden')) {
      clearBeeWalletCache();
      setTimeout(() => refreshChecklist(), 3000);
    }
  });

  stepFundXdaiBtn?.addEventListener('click', () => handleFundXdai());
  stepLightModeBtn?.addEventListener('click', () => handleSwitchToLightMode());
  stepFundXbzzBtn?.addEventListener('click', () => handleFundXbzz());
  stepStampsBtn?.addEventListener('click', () => handleBuyStamps());

  // One-click setup
  oneClickPanel = document.getElementById('publish-oneclick');
  oneClickPresets = document.getElementById('publish-oneclick-presets');
  oneClickQuote = document.getElementById('publish-oneclick-quote');
  oneClickBtn = document.getElementById('publish-oneclick-btn');
  oneClickStatus = document.getElementById('publish-oneclick-status');
  oneClickError = document.getElementById('publish-oneclick-error');
  oneClickDetail = document.getElementById('publish-oneclick-detail');

  buildOneClickPresets();
  oneClickBtn?.addEventListener('click', () => handleOneClick());
}

function buildOneClickPresets() {
  if (!oneClickPresets) return;
  oneClickPresets.innerHTML = '';
  ONECLICK_PRESETS.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'publish-oneclick-preset';
    btn.dataset.key = p.key;
    if (p.key === selectedPresetKey) btn.classList.add('selected');
    const label = document.createElement('span');
    label.className = 'publish-oneclick-preset-label';
    label.textContent = p.label;
    const desc = document.createElement('span');
    desc.className = 'publish-oneclick-preset-desc';
    desc.textContent = p.desc;
    btn.appendChild(label);
    btn.appendChild(desc);
    btn.addEventListener('click', () => selectOneClickPreset(p.key));
    oneClickPresets.appendChild(btn);
  });
}

function selectOneClickPreset(key) {
  selectedPresetKey = key;
  oneClickPresets?.querySelectorAll('.publish-oneclick-preset').forEach((b) => {
    b.classList.toggle('selected', b.dataset.key === key);
  });
  refreshOneClickQuote();
}

function getSelectedPreset() {
  return ONECLICK_PRESETS.find((p) => p.key === selectedPresetKey) || ONECLICK_PRESETS[1];
}

async function refreshOneClickQuote() {
  if (!oneClickQuote) return;
  const p = getSelectedPreset();
  try {
    if (cachedSpot === null) {
      cachedSpot = await getSpotXdaiPerBzz();
    }
    const bzzOut = expectedBzzOut(p.xdaiForSwap, cachedSpot);
    const totalXdai = p.xdaiForSwap + p.xdaiForBee;
    oneClickQuote.textContent =
      `Swap ${formatXdai(p.xdaiForSwap)} xDAI  →  ~${formatBzz(bzzOut)} xBZZ\n` +
      `Forward ${formatXdai(p.xdaiForBee)} xDAI to Bee wallet\n` +
      `Total from main wallet: ${formatXdai(totalXdai)} xDAI + gas`;
    oneClickQuote.classList.remove('hidden');
  } catch (err) {
    oneClickQuote.textContent = `Quote unavailable: ${err.message || 'network error'}`;
    oneClickQuote.classList.remove('hidden');
  }
}

async function handleOneClick() {
  if (!oneClickBtn) return;

  const beeWallet = getBeeWalletAddress();
  if (!beeWallet) {
    showOneClickError('Bee wallet address not available. Start the Swarm node first.');
    return;
  }

  const p = getSelectedPreset();
  const totalXdai = p.xdaiForSwap + p.xdaiForBee;

  // Pre-check main wallet xDAI balance.
  const mainXdaiStr = walletState.currentBalances[XDAI_TOKEN_KEY]?.raw || '0';
  const mainXdai = BigInt(mainXdaiStr);
  if (mainXdai < totalXdai) {
    showOneClickError(
      `Main wallet needs ${formatXdai(totalXdai)} xDAI; found ${formatXdai(mainXdai.toString())}.`
    );
    return;
  }

  hideOneClickError();
  oneClickBtn.disabled = true;
  setOneClickStatus('Signing transaction…');

  try {
    const res = await fundNodeOneTx({
      beeWallet,
      xdaiForSwap: p.xdaiForSwap,
      xdaiForBee: p.xdaiForBee,
      slippageBps: 500,
    });

    setOneClickStatus(`Sent. Waiting for confirmation… (${res.hash.slice(0, 10)}…)`);
    // Fire-and-forget await — UI remains on the setup screen; banner updates on receipt.
    await waitForTx(res.hash);
    setOneClickStatus('Funded. Bee will deploy the chequebook and sync postage automatically.');

    // Switch to light mode without a separate user action.
    await handleSwitchToLightMode();

    // Kick a refresh.
    clearBeeWalletCache();
    setTimeout(() => refreshChecklist(), 2000);
  } catch (err) {
    console.error('[PublishSetup] One-click failed:', err);
    showOneClickError(err?.message || 'Transaction failed');
    setOneClickStatus('');
  } finally {
    oneClickBtn.disabled = false;
  }
}

function setOneClickStatus(msg) {
  if (!oneClickStatus) return;
  if (msg) {
    oneClickStatus.textContent = msg;
    oneClickStatus.classList.remove('hidden');
  } else {
    oneClickStatus.classList.add('hidden');
  }
}

function showOneClickError(msg) {
  if (!oneClickError) return;
  oneClickError.textContent = msg;
  oneClickError.classList.remove('hidden');
}

function hideOneClickError() {
  oneClickError?.classList.add('hidden');
}

function updateOneClickVisibility(evaluation) {
  if (!oneClickPanel) return;

  // Show the one-click banner while the node still needs funding
  // (i.e., chequebook not yet deployed, or xBZZ not yet present).
  // Hide once both are satisfied — from that point the checklist covers
  // only stamp purchase which happens inside the Bee API.
  const needsFunding = !evaluation?.chequebookDeployed || !evaluation?.hasXbzz;
  const nodeRunning = evaluation?.nodeState === 'running';

  oneClickPanel.classList.toggle('hidden', !(needsFunding && nodeRunning));

  // Keep detail label accurate.
  if (oneClickDetail && needsFunding && nodeRunning) {
    if (!evaluation?.hasXdai) {
      oneClickDetail.textContent =
        'Fund your Bee node in a single transaction from your main wallet: swap to xBZZ, forward xDAI for chequebook deploy, done.';
    } else if (!evaluation?.hasXbzz) {
      oneClickDetail.textContent =
        'Fund your Bee node with xBZZ in one transaction from your main wallet.';
    } else {
      oneClickDetail.textContent =
        'One-transaction swap + fund path.';
    }
  }

  if (oneClickBtn) oneClickBtn.disabled = false;

  // Refresh quote on first display.
  if (needsFunding && nodeRunning && oneClickQuote && oneClickQuote.classList.contains('hidden')) {
    refreshOneClickQuote();
  }
}

export function openPublishSetup() {
  walletState.identityView?.classList.add('hidden');
  publishSetupScreen?.classList.remove('hidden');

  clearBeeWalletCache();
  refreshChecklist();
  startPolling();
}

export function closePublishSetup() {
  stopPolling();
  cachedBeeWalletAddress = null;
  lastEvaluation = null;
  publishSetupScreen?.classList.add('hidden');
  walletState.identityView?.classList.remove('hidden');
}

function startPolling() {
  stopPolling();
  pollInterval = setInterval(() => refreshChecklist(), POLL_MS);
}

function stopPolling() {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

async function refreshChecklist() {
  try {
    lastEvaluation = await evaluateSteps();
    renderSteps(lastEvaluation);
    updateOneClickVisibility(lastEvaluation);
  } catch (err) {
    console.error('[PublishSetup] Failed to refresh checklist:', err);
  }
}

async function evaluateSteps() {
  const beeStatus = state.currentBeeStatus;

  // If Bee isn't running, return a node-level blocked state
  if (beeStatus !== 'running') {
    return {
      nodeState: beeStatus === 'starting' ? 'starting' : beeStatus === 'stopping' ? 'stopping' : beeStatus === 'error' ? 'error' : 'stopped',
      hasXdai: false,
      beeWalletAddress: getBeeWalletAddress(),
      isLightOrFull: false,
      chequebookDeployed: false,
      stampsSynced: false,
      hasXbzz: false,
      hasUsableStamps: false,
      syncProgress: null,
    };
  }

  // Tier 1 queries (always available when Bee is running)
  let nodeResult, addressesResult, chequebookAddrResult;
  try {
    [nodeResult, addressesResult, chequebookAddrResult] = await Promise.all([
      fetchBeeJson('/node'),
      fetchBeeJson('/addresses'),
      fetchBeeJson('/chequebook/address'),
    ]);
  } catch {
    return {
      nodeState: 'unreachable',
      hasXdai: false,
      beeWalletAddress: getBeeWalletAddress(),
      isLightOrFull: false,
      chequebookDeployed: false,
      stampsSynced: false,
      hasXbzz: false,
      hasUsableStamps: false,
      syncProgress: null,
    };
  }

  const beeMode = normalizeSwarmMode(nodeResult.data?.beeMode);
  const isLightOrFull = beeMode === 'light' || beeMode === 'full';
  const beeWalletAddress = addressesResult.data?.ethereum || null;

  if (beeWalletAddress) {
    cachedBeeWalletAddress = beeWalletAddress;
  }

  const chequebookAddr = chequebookAddrResult.data?.chequebookAddress;
  const chequebookDeployed = isChequebookDeployed(chequebookAddr);

  // Balance checks via existing wallet infrastructure (main process IPC)
  let hasXdai = false;
  let beeHasXbzz = false;
  let mainWalletHasXbzz = false;
  const beeAddr = getBeeWalletAddress();
  const mainAddr = walletState.fullAddresses.wallet;

  // Bee wallet balances
  if (beeAddr && window.wallet?.getBalances) {
    try {
      const result = await window.wallet.getBalances(beeAddr);
      if (result?.success && result.balances) {
        const xdaiRaw = parseFloat(result.balances[XDAI_TOKEN_KEY]?.formatted || '0');
        hasXdai = xdaiRaw > 0;
        const xbzzRaw = parseFloat(result.balances[XBZZ_TOKEN_KEY]?.formatted || '0');
        beeHasXbzz = xbzzRaw > 0;
      }
    } catch {
      // Balance fetch failed — leave as false
    }
  }

  // Main wallet xBZZ balance (to know if user already swapped).
  // Read from walletState.currentBalances — already kept fresh by balance-display polling.
  if (!beeHasXbzz && mainAddr && mainAddr.toLowerCase() !== beeAddr?.toLowerCase()) {
    const xbzzRaw = parseFloat(walletState.currentBalances[XBZZ_TOKEN_KEY]?.formatted || '0');
    mainWalletHasXbzz = xbzzRaw > 0;
  }

  // Tier 2 + sync progress queries (run in parallel when available)
  let hasXbzz = beeHasXbzz;
  let hasUsableStamps = false;
  let stampsSynced = false;
  let syncProgress = null;

  if (isLightOrFull) {
    const tier2Promises = [fetchBeeJson('/status')];
    if (chequebookDeployed) {
      tier2Promises.push(fetchBeeJson('/wallet'), fetchBeeJson('/stamps'));
    }

    let statusResult, walletResult, stampsResult;
    try {
      const results = await Promise.all(tier2Promises);
      statusResult = results[0];
      walletResult = chequebookDeployed ? results[1] : { ok: false, data: null };
      stampsResult = chequebookDeployed ? results[2] : { ok: false, data: null };
    } catch {
      statusResult = { ok: false, data: null };
      walletResult = { ok: false, data: null };
      stampsResult = { ok: false, data: null };
    }

    if (walletResult.ok && walletResult.data) {
      const bzz = walletResult.data.bzzBalance;
      if (typeof bzz === 'string' && bzz !== '0' && bzz.length > 0) {
        hasXbzz = true;
      }
    }

    if (stampsResult.ok && Array.isArray(stampsResult.data?.stamps)) {
      stampsSynced = true;
      hasUsableStamps = stampsResult.data.stamps.some((s) => s?.usable === true);
    }

    if (statusResult.ok && statusResult.data?.lastSyncedBlock) {
      const lastSynced = statusResult.data.lastSyncedBlock;
      let chainHead = null;
      try {
        if (window.wallet?.testProvider) {
          const providerResult = await window.wallet.testProvider(GNOSIS_CHAIN_ID);
          if (providerResult?.success) {
            chainHead = providerResult.blockNumber;
          }
        }
      } catch {
        // Non-critical
      }
      syncProgress = { lastSynced, chainHead };
    }
  }

  return {
    nodeState: 'running',
    hasXdai,
    beeWalletAddress: getBeeWalletAddress(),
    isLightOrFull,
    chequebookDeployed,
    stampsSynced,
    hasXbzz,
    mainWalletHasXbzz,
    hasUsableStamps,
    syncProgress,
  };
}

function renderSteps(steps) {
  // If Bee isn't running, show all steps as blocked
  if (steps.nodeState !== 'running') {
    const blockedDetail = {
      stopped: 'Start the Swarm node to continue.',
      starting: 'Swarm node is starting\u2026',
      stopping: 'Swarm node is stopping\u2026',
      error: 'Swarm node encountered an error.',
      unreachable: 'Cannot reach the Swarm node.',
    }[steps.nodeState] || 'Swarm node is not available.';

    setStepStatus(stepFundXdai, 'pending');
    setStepStatus(stepLightMode, 'pending');
    setStepStatus(stepChequebook, 'pending');
    setStepStatus(stepFundXbzz, 'pending');
    setStepStatus(stepStamps, 'pending');
    toggleEl(stepFundXdaiBtn, false);
    toggleEl(stepLightModeBtn, false);
    toggleEl(stepChequebookWaiting, false);
    toggleEl(stepFundXbzzBtn, false);
    toggleEl(stepStampsBtn, false);

    if (stepFundXdaiMeta) {
      stepFundXdaiMeta.textContent = blockedDetail;
      stepFundXdaiMeta.classList.remove('hidden');
    }
    return;
  }

  // Step 1: Fund xDAI
  const step1Complete = steps.hasXdai || steps.chequebookDeployed;
  const step1Status = step1Complete ? 'complete' : 'active';

  setStepStatus(stepFundXdai, step1Status);
  toggleEl(stepFundXdaiBtn, step1Status === 'active');

  if (stepFundXdaiBtn && step1Status === 'active') {
    const mainHasXdai = parseFloat(walletState.currentBalances[XDAI_TOKEN_KEY]?.formatted || '0') > 0;
    stepFundXdaiBtn.textContent = mainHasXdai ? 'Send xDAI' : 'Get xDAI';
  }

  if (stepFundXdaiMeta) {
    if (steps.beeWalletAddress) {
      stepFundXdaiMeta.textContent = steps.beeWalletAddress;
      stepFundXdaiMeta.classList.remove('hidden');
    } else {
      stepFundXdaiMeta.classList.add('hidden');
    }
  }

  // Step 2: Switch to light mode
  const step2Complete = steps.isLightOrFull;
  const step2Active = step1Complete && !step2Complete;
  const step2Status = step2Complete ? 'complete' : step2Active ? 'active' : 'pending';

  setStepStatus(stepLightMode, step2Status);
  toggleEl(stepLightModeBtn, step2Status === 'active');

  // Step 3: Chequebook deployment + postage sync
  const step3Complete = steps.chequebookDeployed && steps.stampsSynced;
  const step3Waiting = step2Complete && !step3Complete;
  const step3Status = step3Complete ? 'complete' : step3Waiting ? 'waiting' : 'pending';

  setStepStatus(stepChequebook, step3Status);

  if (stepChequebookWaiting) {
    if (step3Status === 'waiting') {
      stepChequebookWaiting.classList.remove('hidden');
      if (steps.chequebookDeployed && !steps.stampsSynced && steps.syncProgress) {
        const { lastSynced, chainHead } = steps.syncProgress;
        if (chainHead && lastSynced) {
          const pct = Math.min(99, Math.round((lastSynced / chainHead) * 100));
          stepChequebookWaiting.textContent = `Syncing postage data\u2026 ${pct}% (block ${lastSynced.toLocaleString()} / ${chainHead.toLocaleString()})`;
        } else {
          stepChequebookWaiting.textContent = `Syncing postage data\u2026 block ${(lastSynced || 0).toLocaleString()}`;
        }
      } else if (!steps.chequebookDeployed) {
        stepChequebookWaiting.textContent = 'Deploying chequebook contract\u2026';
      } else {
        stepChequebookWaiting.textContent = 'Syncing postage data\u2026';
      }
    } else {
      stepChequebookWaiting.classList.add('hidden');
    }
  }

  // Step 4: Acquire xBZZ
  const step4Complete = steps.hasXbzz;
  const step4Active = step3Complete && !step4Complete;
  const step4Status = step4Complete ? 'complete' : step4Active ? 'active' : 'pending';

  setStepStatus(stepFundXbzz, step4Status);
  toggleEl(stepFundXbzzBtn, step4Status === 'active');

  if (stepFundXbzzBtn && step4Status === 'active') {
    stepFundXbzzBtn.textContent = steps.mainWalletHasXbzz
      ? 'Send xBZZ to Node'
      : 'Swap xDAI \u2192 xBZZ';
  }

  // Step 5: Purchase stamps
  const step5Complete = steps.hasUsableStamps;
  const step5Active = step4Complete && !step5Complete;
  const step5Status = step5Complete ? 'complete' : step5Active ? 'active' : 'pending';

  setStepStatus(stepStamps, step5Status);
  toggleEl(stepStampsBtn, step5Status === 'active');
}

function setStepStatus(el, status) {
  if (el) {
    el.dataset.status = status;
  }
}

function toggleEl(el, visible) {
  if (el) {
    el.classList.toggle('hidden', !visible);
  }
}

// ============================================
// Step actions
// ============================================

function handleFundXdai() {
  closePublishSetup();
  topUpXdai(getBeeWalletAddress());
}

async function handleSwitchToLightMode() {
  try {
    const settings = await window.electronAPI?.getSettings?.();
    const nextSettings = { ...settings, beeNodeMode: 'light' };
    const success = await window.electronAPI?.saveSettings?.(nextSettings);

    if (!success) {
      throw new Error('Failed to save settings');
    }
  } catch (err) {
    console.error('[PublishSetup] Failed to switch to light mode:', err);
    alert(err.message || 'Failed to switch to light mode');
  }
}

function handleFundXbzz() {
  closePublishSetup();
  topUpXbzz(getBeeWalletAddress());
}

function handleBuyStamps() {
  closePublishSetup();
  openStampManager();
}

// ============================================
// Helpers
// ============================================

async function clearBeeWalletCache() {
  const addr = getBeeWalletAddress();
  if (addr && window.wallet?.clearBalanceCache) {
    try {
      await window.wallet.clearBalanceCache(addr);
    } catch {
      // Non-critical
    }
  }
}
