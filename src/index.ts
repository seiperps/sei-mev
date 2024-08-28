import { FlashbotsBundleProvider } from "@flashbots/ethers-provider-bundle";
import { Contract, providers, Wallet } from "ethers";
import { BUNDLE_EXECUTOR_ABI } from "./abi";
import { UNISWAP_PAIR_ABI } from "./abi";
import { UniswappyV2EthPair } from "./UniswappyV2EthPair";
import { FACTORY_ADDRESSES } from "./addresses";
import { Arbitrage } from "./Arbitrage";
import { get } from "https";
import { ethers } from "ethers";
import { promises as fs } from 'fs'; // Import the filesystem module for async file handling
import path from 'path';

import { getDefaultRelaySigningKey } from "./utils";
const UNISWAP_FACTORY_ABI = [
  "function allPairsLength() view returns (uint256)",
  "function allPairs(uint256) view returns (address)"
];
const ETHEREUM_RPC_URL = process.env.ETHEREUM_RPC_URL || "https://mainnet.infura.io/v3/05f102d186ac42a18384f98dfa20e224"; // Default or provided RPC URL
console.log("[Main Script] Ethereum RPC URL:", ETHEREUM_RPC_URL);

if (!ETHEREUM_RPC_URL) {
    console.error("[Main Script] ERROR: ETHEREUM_RPC_URL is not set.");
    process.exit(1); // Exit the process if the URL is not set
}

const PRIVATE_KEY = process.env.PRIVATE_KEY || "0xde81d6553d7ff9f3c94f030891f387ec9efc6283aa2fec6b809aefe511513050";
const BUNDLE_EXECUTOR_ADDRESS = process.env.BUNDLE_EXECUTOR_ADDRESS || "0xde81d6553d7ff9f3c94f030891f387ec9efc6283aa2fec6b809aefe511513050";
const FLASHBOTS_RELAY_SIGNING_KEY = process.env.FLASHBOTS_RELAY_SIGNING_KEY || "0xc05f1b05d7072d1975b3042351f2a410af4799abda43ec9df0226248599e7e57";
const UNISWAP_FACTORY_ADDRESS = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f"

console.log("[Main Script] Using Ethereum RPC URL:", ETHEREUM_RPC_URL);
console.log("[Main Script] Using Flashbots Relay Signing Key:", FLASHBOTS_RELAY_SIGNING_KEY);

if (ETHEREUM_RPC_URL === 'https://mainnet.infura.io/v3/05f102d186ac42a18384f98dfa20e224') {
    console.warn("[Main Script] WARNING: Using default Ethereum RPC URL. Consider setting ETHEREUM_RPC_URL in .env.");
}

if (FLASHBOTS_RELAY_SIGNING_KEY === 'default_signing_key') {
    console.warn("[Main Script] WARNING: Using default Flashbots Relay Signing Key. Consider setting FLASHBOTS_RELAY_SIGNING_KEY in .env.");
}

const MINER_REWARD_PERCENTAGE = parseInt(process.env.MINER_REWARD_PERCENTAGE || "80");

if (PRIVATE_KEY === "") {
    console.warn("[Main Script] Must provide PRIVATE_KEY environment variable");
    process.exit(1);
}
if (BUNDLE_EXECUTOR_ADDRESS === "") {
    console.warn("[Main Script] Must provide BUNDLE_EXECUTOR_ADDRESS environment variable. Please see README.md");
    process.exit(1);
}
if (FLASHBOTS_RELAY_SIGNING_KEY === "") {
    console.warn("[Main Script] Must provide FLASHBOTS_RELAY_SIGNING_KEY. Please see https://github.com/flashbots/pm/blob/main/guides/searcher-onboarding.md");
    process.exit(1);
}

const HEALTHCHECK_URL = process.env.HEALTHCHECK_URL || "";
console.log("[Main Script] Healthcheck URL:", HEALTHCHECK_URL);

const provider = new providers.StaticJsonRpcProvider(ETHEREUM_RPC_URL);
const arbitrageSigningWallet = new Wallet(PRIVATE_KEY);
const flashbotsRelaySigningWallet = new Wallet(FLASHBOTS_RELAY_SIGNING_KEY);

function healthcheck() {
  if (HEALTHCHECK_URL === "") {
      return;
  }
  console.log("[Main Script] Sending healthcheck request to:", HEALTHCHECK_URL);
  get(HEALTHCHECK_URL).on('error', console.error);
}

const PAIRS_FILE = path.resolve(__dirname, 'fetched_pairs.json');
const LAST_INDEX_FILE = path.resolve(__dirname, 'last_processed_index.json');
let fetchedPairs: Set<string> = new Set(); // Use a global set to track fetched pairs
let lastProcessedIndex = 0; // Track the last processed pair index

async function loadFetchedPairs(): Promise<Set<string>> {
  try {
      const data = await fs.readFile(PAIRS_FILE, 'utf8');
      if (data.trim().length === 0) {
          console.log("[Main Script] Pairs file is empty, starting fresh.");
          return new Set();
      }

      try {
          const pairs = JSON.parse(data);
          console.log(`[Main Script] Loaded ${pairs.length} previously fetched pairs from JSON file.`);
          return new Set(pairs);
      } catch (parseError) {
          console.error("[Main Script] Error parsing pairs file, starting fresh:", parseError);
          return new Set();
      }
  } catch (error) {
      if (error.code === 'ENOENT') {
          // File not found, starting fresh
          console.log("[Main Script] No previously fetched pairs found, starting fresh.");
      } else {
          console.error("[Main Script] Error reading pairs file:", error);
      }
      return new Set();
  }
}

async function loadLastProcessedIndex(): Promise<number> {
  try {
      const data = await fs.readFile(LAST_INDEX_FILE, 'utf8');
      const index = parseInt(data, 10);

      if (isNaN(index)) {
          console.warn("[Main Script] Last processed index is not a valid number. Starting at 0.");
          await saveLastProcessedIndex(0); // Reset to 0 if invalid
          return 0;
      }

      console.log(`[Main Script] Loaded last processed index: ${index}`);
      return index;
  } catch (error) {
      if (error.code === 'ENOENT') {
          console.log("[Main Script] Last processed index file not found, initializing with 0.");
          await saveLastProcessedIndex(0); // Create the file with default index 0
      } else {
          console.error("[Main Script] Error reading last processed index file:", error);
      }
      return 0; // Start at the beginning if there's an error
  }
}

async function saveFetchedPairs() {
  try {
      const tempFilePath = `${PAIRS_FILE}.tmp`; // Write to a temporary file first
      await fs.writeFile(tempFilePath, JSON.stringify(Array.from(fetchedPairs), null, 2));
      await fs.rename(tempFilePath, PAIRS_FILE); // Atomically replace the original file
      console.log(`[Main Script] Saved ${fetchedPairs.size} pairs to JSON file.`);
  } catch (error) {
      console.error("[Main Script] Error saving pairs to file:", error);
  }
}

async function saveLastProcessedIndex(index: number) {
  try {
      const tempFilePath = `${LAST_INDEX_FILE}.tmp`; // Write to a temporary file first
      await fs.writeFile(tempFilePath, index.toString());
      await fs.rename(tempFilePath, LAST_INDEX_FILE); // Atomically replace the original file
      console.log(`[Main Script] Saved last processed index: ${index}`);
  } catch (error) {
      console.error("[Main Script] Error saving last processed index to file:", error);
  }
}

// Ensure that fetched pairs are saved when the process exits
function setupExitHandlers() {
  const saveAndExit = async () => {
      console.log("[Main Script] Saving pairs and last processed index before exit.");
      await saveFetchedPairs();
      await saveLastProcessedIndex(lastProcessedIndex);
      process.exit();
  };

  process.on('SIGINT', saveAndExit); // Handle Ctrl+C
  process.on('SIGTERM', saveAndExit); // Handle termination signals
  process.on('exit', saveAndExit); // Handle normal exits
}

// Periodically save fetched pairs and index every N pairs to reduce data loss in case of abrupt exit
const SAVE_INTERVAL = 100;

async function fetchAllPairs() {
  console.log("[Main Script] Fetching all pairs from Uniswap factory");

  const uniswapFactoryContract = new ethers.Contract(UNISWAP_FACTORY_ADDRESS, UNISWAP_FACTORY_ABI, provider);

  fetchedPairs = await loadFetchedPairs(); // Initialize with previously fetched pairs
  lastProcessedIndex = await loadLastProcessedIndex(); // Load the last processed index

  try {
      const totalPairs = await uniswapFactoryContract.allPairsLength();
      console.log(`[Main Script] Total number of pairs: ${totalPairs.toString()}`);

      for (let i = lastProcessedIndex; i < totalPairs; i++) {
          const pairAddress = await uniswapFactoryContract.allPairs(i);

          if (fetchedPairs.has(pairAddress)) {
              console.log(`[Main Script] Skipping already fetched pair #${i} address: ${pairAddress}`);
              continue;
          }

          console.log(`[Main Script] Pair #${i} address: ${pairAddress}`);
          fetchedPairs.add(pairAddress); // Update the global set with the new pair
          lastProcessedIndex = i; // Update the last processed index

          // Save pairs and index periodically to avoid data loss
          if (i % SAVE_INTERVAL === 0) {
              await saveFetchedPairs();
              await saveLastProcessedIndex(lastProcessedIndex);
          }

          // Here, add logic to further interact with each pair if needed.
          // For instance, fetching reserves, token addresses, etc.

          // Example: Fetching additional data from each pair
          const pairContract = new ethers.Contract(pairAddress, [
              "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
              "function token0() view returns (address)",
              "function token1() view returns (address)"
          ], provider);

          const [reserve0, reserve1] = await pairContract.getReserves();
          const token0 = await pairContract.token0();
          const token1 = await pairContract.token1();

          console.log(`[Main Script] Pair #${i} - Reserves: ${reserve0.toString()} / ${reserve1.toString()}, Tokens: ${token0} / ${token1}`);
      }

      // Final save at the end of fetching
      await saveFetchedPairs();
      await saveLastProcessedIndex(lastProcessedIndex);
  } catch (error) {
      console.error("[Main Script] Error fetching total pairs:", error);
  }
}

async function main() {
  console.log("[Main Script] Searcher Wallet Address: " + await arbitrageSigningWallet.getAddress());
  console.log("[Main Script] Flashbots Relay Signing Wallet Address: " + await flashbotsRelaySigningWallet.getAddress());

  console.log("[Main Script] Creating Flashbots provider");
  const flashbotsProvider = await FlashbotsBundleProvider.create(provider, flashbotsRelaySigningWallet);

  console.log("[Main Script] Initializing Arbitrage class");
  const arbitrage = new Arbitrage(
      arbitrageSigningWallet,
      flashbotsProvider,
      new Contract(BUNDLE_EXECUTOR_ADDRESS, BUNDLE_EXECUTOR_ABI, provider)
  );

  setupExitHandlers(); // Setup handlers to save data on exit

  // Fetch all Uniswap pairs
  await fetchAllPairs();

  console.log("[Main Script] Fetching Uniswap markets by token");

  try {
      // Actual fetching of Uniswap markets by token
      const markets = await UniswappyV2EthPair.getUniswapMarketsByToken(provider, FACTORY_ADDRESSES);
      console.log("[Main Script] Markets fetched successfully:", markets);

      provider.on('block', async (blockNumber) => {
          console.log("[Main Script] New block detected:", blockNumber);
          try {
              await UniswappyV2EthPair.updateReserves(provider, markets.allMarketPairs);
              console.log("[Main Script] Updated reserves for market pairs");

              const bestCrossedMarkets = await arbitrage.evaluateMarkets(markets.marketsByToken);
              console.log("[Main Script] Best crossed markets found:", bestCrossedMarkets);

              if (bestCrossedMarkets.length === 0) {
                  console.log("[Main Script] No crossed markets");
                  return;
              }

              console.log("[Main Script] Printing crossed market details");
              bestCrossedMarkets.forEach(Arbitrage.printCrossedMarket);

              console.log("[Main Script] Attempting to take crossed markets");
              arbitrage.takeCrossedMarkets(bestCrossedMarkets, blockNumber, MINER_REWARD_PERCENTAGE)
                  .then(() => {
                      console.log("[Main Script] Successfully submitted arbitrage transactions");
                      healthcheck();
                  })
                  .catch((error) => {
                      console.error("[Main Script] Error in taking crossed markets:", error);
                  });
          } catch (error) {
              console.error("[Main Script] Error during block processing:", error);
          }
      });
  } catch (error) {
      console.error("[Main Script] Error fetching Uniswap markets by token:", error);
  }
}

main().catch(error => {
  console.error("[Main Script] Fatal error in main script:", error);
  process.exit(1);
});