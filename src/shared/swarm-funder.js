/**
 * SwarmNodeFunder contract config.
 *
 * Consumed only by the main process. The renderer never imports this file —
 * it talks to the `swarm-funder` IPC surface instead (see
 * `src/main/swarm/swarm-funder-service.js`).
 */

const funderConfig = {
  chainId: 100,
  // Deployed 2026-04-24, verified on Blockscout. Stateless, admin-less.
  address: '0x508994B55C53E84d2d600A55da05f751aEf658d2',
  pool: '0x7583b9C573FA4FB5Ea21C83454939c4Cf6aacBc3',
  poolFeeBps: 30,
  bzzToken: '0xdBF3Ea6F5beE45c02255B2c26a16F300502F68da',
  wxdaiToken: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
  postageStamp: '0x45a1502382541Cd610CC9068e88727426b696293',
  abi: [
    'function fundNodeAndBuyStamp(address beeWallet,uint256 xdaiToLeaveForBee,uint256 minBzzOut,tuple(uint256 initialBalancePerChunk,uint8 depth,uint8 bucketDepth,bytes32 nonce,bool immutableFlag) stamp) payable returns (bytes32)',
  ],
  poolSlot0Abi: [
    'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  ],
};

module.exports = { funderConfig };
