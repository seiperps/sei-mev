import * as _ from "lodash";
log("Lodash library imported");

import { BigNumber, Contract, Wallet } from "ethers";
log("Ethers library imported with BigNumber, Contract, Wallet");

import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
log("FlashbotsBundleProvider imported");

import { WETH_ADDRESS } from "./addresses";
log("WETH_ADDRESS imported:", WETH_ADDRESS);

import { EthMarket } from "./EthMarket";
log("EthMarket class imported");

import { ETHER, bigNumberToDecimal } from "./utils";
log("Utility functions ETHER and bigNumberToDecimal imported");

// Logging utility function
function log(message: string, ...optionalParams: any[]) {
    console.log(`[Arbitrage Bot] ${message}`, ...optionalParams);
}

export interface CrossedMarketDetails {
  profit: BigNumber,
  volume: BigNumber,
  tokenAddress: string,
  buyFromMarket: EthMarket,
  sellToMarket: EthMarket,
}
log("CrossedMarketDetails interface defined");

export type MarketsByToken = { [tokenAddress: string]: Array<EthMarket> }
log("MarketsByToken type defined");

// TODO: implement binary search (assuming linear/exponential global maximum profitability)
log("Initializing TEST_VOLUMES array for testing volume thresholds");
const TEST_VOLUMES = [
  ETHER.div(100),
  ETHER.div(10),
  ETHER.div(6),
  ETHER.div(4),
  ETHER.div(2),
  ETHER.div(1),
  ETHER.mul(2),
  ETHER.mul(5),
  ETHER.mul(10),
]
log("TEST_VOLUMES initialized:", TEST_VOLUMES);

export function getBestCrossedMarket(crossedMarkets: Array<EthMarket>[], tokenAddress: string): CrossedMarketDetails | undefined {
  log("Entering function getBestCrossedMarket with tokenAddress:", tokenAddress);
  
  let bestCrossedMarket: CrossedMarketDetails | undefined = undefined;
  for (const crossedMarket of crossedMarkets) {
    const sellToMarket = crossedMarket[0];
    const buyFromMarket = crossedMarket[1];
    
    log("Evaluating crossed market:", { sellToMarket, buyFromMarket });
    
    for (const size of TEST_VOLUMES) {
      const tokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, size);
      const proceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tokensOutFromBuyingSize);
      const profit = proceedsFromSellingTokens.sub(size);

      log("Calculated tokensOutFromBuyingSize:", tokensOutFromBuyingSize);
      log("Calculated proceedsFromSellingTokens:", proceedsFromSellingTokens);
      log("Calculated profit:", profit);

      if (bestCrossedMarket !== undefined && profit.lt(bestCrossedMarket.profit)) {
        log("Profit less than bestCrossedMarket.profit, checking midpoint");

        // If the next size up lost value, meet halfway. TODO: replace with real binary search
        const trySize = size.add(bestCrossedMarket.volume).div(2);
        const tryTokensOutFromBuyingSize = buyFromMarket.getTokensOut(WETH_ADDRESS, tokenAddress, trySize);
        const tryProceedsFromSellingTokens = sellToMarket.getTokensOut(tokenAddress, WETH_ADDRESS, tryTokensOutFromBuyingSize);
        const tryProfit = tryProceedsFromSellingTokens.sub(trySize);

        log("Calculated trySize:", trySize);
        log("Calculated tryTokensOutFromBuyingSize:", tryTokensOutFromBuyingSize);
        log("Calculated tryProceedsFromSellingTokens:", tryProceedsFromSellingTokens);
        log("Calculated tryProfit:", tryProfit);

        if (tryProfit.gt(bestCrossedMarket.profit)) {
          log("tryProfit is greater than bestCrossedMarket.profit, updating bestCrossedMarket");

          bestCrossedMarket = {
            volume: trySize,
            profit: tryProfit,
            tokenAddress,
            sellToMarket,
            buyFromMarket
          };
        }
        break;
      }

      log("Updating bestCrossedMarket with current size and profit");

      bestCrossedMarket = {
        volume: size,
        profit: profit,
        tokenAddress,
        sellToMarket,
        buyFromMarket
      };
    }
  }
  log("Returning bestCrossedMarket:", bestCrossedMarket);
  return bestCrossedMarket;
}

export class Arbitrage {
  private flashbotsProvider: FlashbotsBundleProvider;
  private bundleExecutorContract: Contract;
  private executorWallet: Wallet;

  constructor(executorWallet: Wallet, flashbotsProvider: FlashbotsBundleProvider, bundleExecutorContract: Contract) {
    this.executorWallet = executorWallet;
    this.flashbotsProvider = flashbotsProvider;
    this.bundleExecutorContract = bundleExecutorContract;
    log("Arbitrage class instantiated with executorWallet, flashbotsProvider, and bundleExecutorContract");
  }

  static printCrossedMarket(crossedMarket: CrossedMarketDetails): void {
    log("Printing details of crossed market:", crossedMarket);
    
    const buyTokens = crossedMarket.buyFromMarket.tokens;
    const sellTokens = crossedMarket.sellToMarket.tokens;
    console.log(
      `Profit: ${bigNumberToDecimal(crossedMarket.profit)} Volume: ${bigNumberToDecimal(crossedMarket.volume)}\n` +
      `${crossedMarket.buyFromMarket.protocol} (${crossedMarket.buyFromMarket.marketAddress})\n` +
      `  ${buyTokens[0]} => ${buyTokens[1]}\n` +
      `${crossedMarket.sellToMarket.protocol} (${crossedMarket.sellToMarket.marketAddress})\n` +
      `  ${sellTokens[0]} => ${sellTokens[1]}\n` +
      `\n`
    );
  }

  async evaluateMarkets(marketsByToken: MarketsByToken): Promise<Array<CrossedMarketDetails>> {
    log("Entering function evaluateMarkets");
    
    const bestCrossedMarkets = new Array<CrossedMarketDetails>();

    for (const tokenAddress in marketsByToken) {
      log(`Evaluating markets for token: ${tokenAddress}`);
      
      const markets = marketsByToken[tokenAddress];
      const pricedMarkets = _.map(markets, (ethMarket: EthMarket) => {
        return {
          ethMarket: ethMarket,
          buyTokenPrice: ethMarket.getTokensIn(tokenAddress, WETH_ADDRESS, ETHER.div(100)),
          sellTokenPrice: ethMarket.getTokensOut(WETH_ADDRESS, tokenAddress, ETHER.div(100)),
        };
      });

      const crossedMarkets = new Array<Array<EthMarket>>();
      for (const pricedMarket of pricedMarkets) {
        _.forEach(pricedMarkets, pm => {
          if (pm.sellTokenPrice.gt(pricedMarket.buyTokenPrice)) {
            crossedMarkets.push([pricedMarket.ethMarket, pm.ethMarket]);
          }
        });
      }

      const bestCrossedMarket = getBestCrossedMarket(crossedMarkets, tokenAddress);
      if (bestCrossedMarket !== undefined && bestCrossedMarket.profit.gt(ETHER.div(1000))) {
        log("Adding profitable bestCrossedMarket to bestCrossedMarkets", bestCrossedMarket);
        bestCrossedMarkets.push(bestCrossedMarket);
      }
    }
    bestCrossedMarkets.sort((a, b) => a.profit.lt(b.profit) ? 1 : a.profit.gt(b.profit) ? -1 : 0);
    log("Returning sorted bestCrossedMarkets:", bestCrossedMarkets);
    return bestCrossedMarkets;
  }

  // TODO: take more than 1
  async takeCrossedMarkets(bestCrossedMarkets: CrossedMarketDetails[], blockNumber: number, minerRewardPercentage: number): Promise<void> {
    log("Entering function takeCrossedMarkets");
    
    for (const bestCrossedMarket of bestCrossedMarkets) {
      log("Processing bestCrossedMarket:", bestCrossedMarket);

      console.log("Send this much WETH", bestCrossedMarket.volume.toString(), "get this much profit", bestCrossedMarket.profit.toString());
      const buyCalls = await bestCrossedMarket.buyFromMarket.sellTokensToNextMarket(WETH_ADDRESS, bestCrossedMarket.volume, bestCrossedMarket.sellToMarket);
      const inter = bestCrossedMarket.buyFromMarket.getTokensOut(WETH_ADDRESS, bestCrossedMarket.tokenAddress, bestCrossedMarket.volume);
      const sellCallData = await bestCrossedMarket.sellToMarket.sellTokens(bestCrossedMarket.tokenAddress, inter, this.bundleExecutorContract.address);

      const targets: Array<string> = [...buyCalls.targets, bestCrossedMarket.sellToMarket.marketAddress];
      const payloads: Array<string> = [...buyCalls.data, sellCallData];
      log("Transaction targets and payloads prepared", {targets, payloads});

      const minerReward = bestCrossedMarket.profit.mul(minerRewardPercentage).div(100);
      const transaction = await this.bundleExecutorContract.populateTransaction.uniswapWeth(bestCrossedMarket.volume, minerReward, targets, payloads, {
        gasPrice: BigNumber.from(0),
        gasLimit: BigNumber.from(1000000),
      });

      try {
        const estimateGas = await this.bundleExecutorContract.provider.estimateGas(
          {
            ...transaction,
            from: this.executorWallet.address
          });
        if (estimateGas.gt(1400000)) {
          console.log("EstimateGas succeeded, but suspiciously large: " + estimateGas.toString());
          continue;
        }
        transaction.gasLimit = estimateGas.mul(2);
      } catch (e) {
        console.warn(`Estimate gas failure for ${JSON.stringify(bestCrossedMarket)}`);
        continue;
      }

      const bundledTransactions = [
        {
          signer: this.executorWallet,
          transaction: transaction
        }
      ];
      log("Bundled transactions prepared", bundledTransactions);

      const signedBundle = await this.flashbotsProvider.signBundle(bundledTransactions);
      const simulation = await this.flashbotsProvider.simulate(signedBundle, blockNumber + 1);
      if ("error" in simulation || simulation.firstRevert !== undefined) {
        console.log(`Simulation Error on token ${bestCrossedMarket.tokenAddress}, skipping`);
        continue;
      }
      log("Simulation successful, submitting bundle");

      console.log(`Submitting bundle, profit sent to miner: ${bigNumberToDecimal(simulation.coinbaseDiff)}, effective gas price: ${bigNumberToDecimal(simulation.coinbaseDiff.div(simulation.totalGasUsed), 9)} GWEI`);
      const bundlePromises =  _.map([blockNumber + 1, blockNumber + 2], targetBlockNumber =>
        this.flashbotsProvider.sendRawBundle(
          signedBundle,
          targetBlockNumber
        ));
      await Promise.all(bundlePromises);
      return;
    }
    log("No arbitrage submitted to relay");
    throw new Error("No arbitrage submitted to relay");
  }
}
