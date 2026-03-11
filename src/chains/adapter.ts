import type { ChainSlug } from './index.js';

export interface ChainAdapter {
  chain: ChainSlug;
  /** Fetch the first inbound native token transaction for a wallet address.
   *  Returns null if no inbound native txs found or on error. */
  getFirstInboundNativeTx(address: string): Promise<FirstInboundTx | null>;
}

export interface FirstInboundTx {
  txHash: string;
  fromAddress: string; // the funder — always lowercase
  blockNumber: bigint;
  blockTimestamp: Date;
  valueWei: string; // string to avoid precision loss
  chain: ChainSlug;
}
