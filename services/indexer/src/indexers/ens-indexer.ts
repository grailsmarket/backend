import {
  createPublicClient,
  http,
  decodeEventLog,
  type Log,
  type PublicClient,
  parseAbi,
} from 'viem';
import { mainnet } from 'viem/chains';
import PQueue from 'p-queue';
import { config, getPostgresPool, type BlockchainEvent, hasEmoji } from '../../../shared/src';
import { logger } from '../utils/logger';
import { ENSResolver } from '../services/ens-resolver';

// Define ENS ABI with proper event definitions (Base Registrar - ERC-721)
const ENS_ABI = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
  'event NameRegistered(uint256 indexed id, address indexed owner, uint256 expires)',
  'event NameRenewed(uint256 indexed id, uint256 expires)',
  'event NameMigrated(uint256 indexed id, address indexed owner, uint256 expires)',
]);

// ENS Controller ABIs - different controllers have different event signatures
const ENS_CONTROLLER_ABIS = {
  // Original controller (deployed May 2022)
  original: parseAbi([
    'event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)',
  ]),
  // ETH Registrar Controller 2 (has referrer param)
  v2: parseAbi([
    'event NameRegistered(string label, bytes32 indexed labelhash, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires, bytes32 referrer)',
  ]),
};

// Name Wrapper ABI (ERC-1155 for wrapped names)
const NAME_WRAPPER_ABI = parseAbi([
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
]);

const ENS_EVENTS = {
  Transfer: ENS_ABI[0],
  NameRegistered: ENS_ABI[1],
  NameRenewed: ENS_ABI[2],
} as const;

const ENS_CONTROLLER_EVENTS = {
  NameRegisteredOriginal: ENS_CONTROLLER_ABIS.original[0],
  NameRegisteredV2: ENS_CONTROLLER_ABIS.v2[0],
} as const;

const NAME_WRAPPER_EVENTS = {
  TransferSingle: NAME_WRAPPER_ABI[0],
  TransferBatch: NAME_WRAPPER_ABI[1],
} as const;

export class ENSIndexer {
  private client: PublicClient;
  private pool = getPostgresPool();
  private queue: PQueue;
  private resolver: ENSResolver;
  private isRunning = false;
  private currentBlock = 0n;
  private readonly batchSize = 100; // Reduced for better RPC compatibility
  private readonly confirmations = BigInt(config.blockchain.confirmations);

  constructor() {
    this.client = createPublicClient({
      chain: mainnet,
      transport: http(config.blockchain.rpcUrl),
    });
    this.queue = new PQueue({ concurrency: 5 });
    this.resolver = new ENSResolver();
  }

  async start() {
    logger.info('Starting ENS indexer...');
    this.isRunning = true;

    const lastBlock = await this.getLastProcessedBlock();
    const startBlock = lastBlock > 0
      ? BigInt(lastBlock) + 1n
      : BigInt(config.blockchain.startBlock || 0);

    this.currentBlock = startBlock;
    logger.info(`Starting from block ${this.currentBlock}`);

    this.indexLoop();
  }

  async stop() {
    logger.info('Stopping ENS indexer...');
    this.isRunning = false;
    await this.queue.onIdle();
  }

  private async indexLoop() {
    while (this.isRunning) {
      try {
        const latestBlock = await this.client.getBlockNumber();
        const targetBlock = latestBlock - this.confirmations;

        if (this.currentBlock > targetBlock) {
          await new Promise(resolve => setTimeout(resolve, 12000));
          continue;
        }

        const toBlock = this.currentBlock + BigInt(this.batchSize) - 1n;
        const actualToBlock = toBlock > targetBlock ? targetBlock : toBlock;

        await this.indexBlockRange(this.currentBlock, actualToBlock);
        await this.updateLastProcessedBlock(actualToBlock);

        this.currentBlock = actualToBlock + 1n;
      } catch (error: any) {
        logger.error(`Error in index loop at block ${this.currentBlock}:`, {
          error: error.message,
          code: error.code,
          details: error.shortMessage || error.details
        });
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  private async indexBlockRange(fromBlock: bigint, toBlock: bigint) {
    logger.info(`Indexing ENS events from block ${fromBlock} to ${toBlock}`);

    // Fetch logs from Base Registrar (ERC-721)
    const registrarLogs = await this.client.getLogs({
      address: config.blockchain.ensRegistrarAddress as `0x${string}`,
      fromBlock,
      toBlock,
    });

    // Fetch logs from Name Wrapper (ERC-1155) for wrapped name transfers
    const nameWrapperLogs = await this.client.getLogs({
      address: config.blockchain.ensNameWrapperAddress as `0x${string}`,
      fromBlock,
      toBlock,
    });

    // Fetch logs from ENS Controllers for registration cost data (supports multiple controllers)
    const controllerLogs = await this.client.getLogs({
      address: config.blockchain.ensControllerAddresses as `0x${string}`[],
      fromBlock,
      toBlock,
    });

    // Process Base Registrar logs
    for (const log of registrarLogs) {
      await this.queue.add(async () => {
        await this.processLog(log);
      });
    }

    // Process Name Wrapper logs
    for (const log of nameWrapperLogs) {
      await this.queue.add(async () => {
        await this.processNameWrapperLog(log);
      });
    }

    // Process Controller logs (registration costs)
    for (const log of controllerLogs) {
      await this.queue.add(async () => {
        await this.processControllerLog(log);
      });
    }

    await this.queue.onIdle();
  }

  private async processLog(log: Log) {
    try {
      let eventName: string | undefined;
      let decodedLog: any;

      // Try to decode the log against our known events
      for (const [name, event] of Object.entries(ENS_EVENTS)) {
        try {
          decodedLog = decodeEventLog({
            abi: [event],
            data: log.data,
            topics: log.topics as any,
          });
          eventName = name;
          break;
        } catch {
          continue;
        }
      }

      if (!eventName || !decodedLog) {
        // This is not one of our tracked events, skip it
        return;
      }

      logger.debug(`Processing ${eventName} event at block ${log.blockNumber}`);

      const blockchainEvent: Partial<BlockchainEvent> = {
        blockNumber: log.blockNumber || 0n,
        transactionHash: log.transactionHash || '',
        logIndex: log.logIndex || 0,
        contractAddress: log.address,
        eventName,
        eventData: decodedLog.args as any,
        processed: false,
      };

      await this.processEvent(eventName, decodedLog.args, log);
    } catch (error: any) {
      // Only log actual errors, not decode failures
      console.error(`Error processing log at block ${log.blockNumber}:`, {
        error: error.message,
        code: error.code,
        transactionHash: log.transactionHash,
        topics: log.topics?.slice(0, 2), // Just first 2 topics for brevity
      });
    }
  }

  private async processNameWrapperLog(log: Log) {
    try {
      let eventName: string | undefined;
      let decodedLog: any;

      // Try to decode the log against Name Wrapper events
      for (const [name, event] of Object.entries(NAME_WRAPPER_EVENTS)) {
        try {
          decodedLog = decodeEventLog({
            abi: [event],
            data: log.data,
            topics: log.topics as any,
          });
          eventName = name;
          break;
        } catch {
          continue;
        }
      }

      if (!eventName || !decodedLog) {
        // This is not one of our tracked events, skip it
        return;
      }

      logger.debug(`Processing Name Wrapper ${eventName} event at block ${log.blockNumber}`);

      if (eventName === 'TransferSingle') {
        await this.handleNameWrapperTransferSingle(decodedLog.args, log);
      } else if (eventName === 'TransferBatch') {
        await this.handleNameWrapperTransferBatch(decodedLog.args, log);
      }
    } catch (error: any) {
      logger.error(`Error processing Name Wrapper log at block ${log.blockNumber}:`, {
        error: error.message,
        code: error.code,
        transactionHash: log.transactionHash,
      });
    }
  }

  private async handleNameWrapperTransferSingle(args: any, log: Log) {
    const { from, to, id: tokenId } = args;
    const tokenIdStr = typeof tokenId === 'bigint' ? tokenId.toString() : String(tokenId);
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
    const NAME_WRAPPER_ADDRESS = config.blockchain.ensNameWrapperAddress.toLowerCase();

    // Skip mint events (from zero address) - these are handled when wrapping via Base Registrar
    if (from.toLowerCase() === ZERO_ADDRESS) {
      logger.debug(`Name Wrapper mint event for token ${tokenIdStr}, skipping (handled by Base Registrar)`);
      return;
    }

    // Skip burn events (to zero address) - these are handled when unwrapping via Base Registrar
    if (to.toLowerCase() === ZERO_ADDRESS) {
      logger.debug(`Name Wrapper burn event for token ${tokenIdStr}, skipping (handled by Base Registrar)`);
      return;
    }

    logger.info(`Name Wrapper transfer: token ${tokenIdStr} from ${from} to ${to}`);

    let ensNameId: number | null = null;

    try {
      // Resolve the namehash token ID to get the name
      const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);

      if (!resolvedData || !resolvedData.name) {
        logger.warn(`Could not resolve Name Wrapper transfer token ${tokenIdStr}, skipping`);
        return;
      }

      const nameToStore = resolvedData.name;
      const newOwner = to.toLowerCase();

      // Verify the new owner from the contract (authoritative source)
      const contractOwner = await this.resolver.getWrappedNameOwner(nameToStore);
      const ownerToStore = contractOwner || newOwner;

      // Safety check: never store Name Wrapper as owner
      if (ownerToStore === NAME_WRAPPER_ADDRESS) {
        logger.warn(`Refusing to store Name Wrapper as owner for ${nameToStore}, skipping`);
        return;
      }

      logger.info(`Name Wrapper transfer for ${nameToStore}: updating owner to ${ownerToStore}`);

      // Update ownership - use name to find the record (handles both wrapped token_id and labelhash token_id)
      const result = await this.pool.query(
        `UPDATE ens_names SET
          owner_address = $1,
          last_transfer_date = NOW(),
          updated_at = NOW()
        WHERE name = $2
        RETURNING id`,
        [ownerToStore, nameToStore]
      );

      if (result.rows.length > 0) {
        ensNameId = result.rows[0].id;
        logger.info(`Updated ownership for wrapped name ${nameToStore} to ${ownerToStore}`);
      } else {
        // Name doesn't exist yet - create it with the namehash token_id
        const attributes = this.calculateNameAttributes(nameToStore);
        const insertResult = await this.pool.query(
          `INSERT INTO ens_names (token_id, name, owner_address, last_transfer_date, has_numbers, has_emoji)
          VALUES ($1, $2, $3, NOW(), $4, $5)
          ON CONFLICT (token_id) DO UPDATE SET
            owner_address = EXCLUDED.owner_address,
            last_transfer_date = NOW(),
            updated_at = NOW()
          RETURNING id`,
          [tokenIdStr, nameToStore, ownerToStore, attributes.has_numbers, attributes.has_emoji]
        );

        if (insertResult.rows.length > 0) {
          ensNameId = insertResult.rows[0].id;
          logger.info(`Created new record for wrapped name ${nameToStore} with owner ${ownerToStore}`);
        }
      }
    } catch (error: any) {
      logger.error('Failed to process Name Wrapper TransferSingle:', {
        error: error.message,
        tokenId: tokenIdStr,
        from,
        to
      });
      throw error;
    }

    // Publish ownership update job to queue
    if (ensNameId) {
      try {
        const { getQueueClient, QUEUE_NAMES } = await import('../queue');
        const boss = await getQueueClient();

        await boss.send(QUEUE_NAMES.UPDATE_OWNERSHIP, {
          ensNameId,
          newOwner: to.toLowerCase(),
          blockNumber: Number(log.blockNumber),
          transactionHash: log.transactionHash || '',
        });

        logger.debug({ ensNameId, tokenId: tokenIdStr, newOwner: to }, 'Published ownership update job for wrapped name transfer');
      } catch (queueError: any) {
        logger.error({
          errorMessage: queueError?.message || String(queueError),
          errorStack: queueError?.stack,
          ensNameId
        }, 'Failed to publish ownership update job for wrapped name transfer');
      }
    }

    // Record the transfer transaction
    try {
      const block = await this.client.getBlock({ blockNumber: log.blockNumber! });

      const txQuery = `
        INSERT INTO transactions (
          ens_name_id, transaction_hash, block_number,
          from_address, to_address, transaction_type, timestamp
        )
        SELECT id, $2, $3, $4, $5, 'transfer', $6
        FROM ens_names
        WHERE name = $1
        ON CONFLICT (transaction_hash) DO NOTHING
      `;

      // Use the resolved name to find the record
      const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);
      if (resolvedData?.name) {
        await this.pool.query(txQuery, [
          resolvedData.name,
          log.transactionHash,
          log.blockNumber?.toString(),
          from.toLowerCase(),
          to.toLowerCase(),
          new Date(Number(block.timestamp) * 1000),
        ]);
      }
    } catch (error: any) {
      logger.error('Failed to insert wrapped transfer transaction:', {
        error: error.message,
        tokenId: tokenIdStr,
        transactionHash: log.transactionHash
      });
    }
  }

  private async handleNameWrapperTransferBatch(args: any, log: Log) {
    const { from, to, ids } = args;

    // Process each token in the batch as a single transfer
    for (const tokenId of ids) {
      await this.handleNameWrapperTransferSingle(
        { from, to, id: tokenId },
        log
      );
    }
  }

  private async processControllerLog(log: Log) {
    try {
      let decodedLog: any;
      let isV2 = false;

      // Try to decode as Original Controller NameRegistered event
      try {
        decodedLog = decodeEventLog({
          abi: [ENS_CONTROLLER_EVENTS.NameRegisteredOriginal],
          data: log.data,
          topics: log.topics as any,
        });
      } catch {
        // Try V2 Controller NameRegistered event (has referrer param)
        try {
          decodedLog = decodeEventLog({
            abi: [ENS_CONTROLLER_EVENTS.NameRegisteredV2],
            data: log.data,
            topics: log.topics as any,
          });
          isV2 = true;
        } catch {
          // Not a NameRegistered event from any known Controller, skip
          return;
        }
      }

      if (!decodedLog) {
        return;
      }

      logger.debug(`Processing Controller NameRegistered event at block ${log.blockNumber} (${isV2 ? 'V2' : 'Original'})`);
      await this.handleControllerNameRegistered(decodedLog.args, log, isV2);
    } catch (error: any) {
      logger.error(`Error processing Controller log at block ${log.blockNumber}:`, {
        error: error.message,
        code: error.code,
        transactionHash: log.transactionHash,
      });
    }
  }

  private async handleControllerNameRegistered(args: any, log: Log, isV2: boolean = false) {
    // V2 controller uses 'label' for the name string and 'labelhash' for the hash
    // Original controller uses 'name' for the name string and 'label' for the hash
    const name = isV2 ? args.label : args.name;
    const labelHash = isV2 ? args.labelhash : args.label;
    const { owner, baseCost, premium, expires } = args;

    // Convert BigInt values to strings for storage
    const baseCostWei = typeof baseCost === 'bigint' ? baseCost.toString() : String(baseCost);
    const premiumWei = typeof premium === 'bigint' ? premium.toString() : String(premium);
    const totalCostWei = (BigInt(baseCostWei) + BigInt(premiumWei)).toString();

    // Calculate name length (excluding .eth suffix)
    const nameLength = name.length;

    // Get the actual registrant (transaction sender) - they may differ from owner
    let registrantAddress = owner.toLowerCase();
    if (log.transactionHash) {
      try {
        const tx = await this.client.getTransaction({ hash: log.transactionHash as `0x${string}` });
        if (tx && tx.from) {
          registrantAddress = tx.from.toLowerCase();
        }
      } catch (txError: any) {
        logger.warn(`Could not fetch transaction for Controller event, using owner as registrant: ${txError.message}`);
      }
    }

    const fullName = `${name}.eth`;
    const expiryDate = new Date(Number(expires) * 1000);

    // Get block timestamp for registration date
    let registrationDate: Date;
    try {
      const block = await this.client.getBlock({ blockNumber: log.blockNumber! });
      registrationDate = new Date(Number(block.timestamp) * 1000);
    } catch (blockError: any) {
      logger.warn(`Could not fetch block for registration date, using current time: ${blockError.message}`);
      registrationDate = new Date();
    }

    try {
      // Find the ens_name_id for this name
      const ensNameResult = await this.pool.query(
        'SELECT id FROM ens_names WHERE name = $1',
        [fullName]
      );

      if (ensNameResult.rows.length === 0) {
        // Name not yet in database - this can happen if Controller event is processed
        // before Base Registrar event. Log and skip - we'll catch it on next sync.
        logger.debug(`Controller NameRegistered: name ${fullName} not yet in ens_names, will retry later`);
        return;
      }

      const ensNameId = ensNameResult.rows[0].id;

      // Insert registration record with cost data
      await this.pool.query(
        `INSERT INTO registrations (
          ens_name_id, registrant_address, owner_address,
          base_cost_wei, premium_wei, total_cost_wei,
          name_length, transaction_hash, block_number,
          registration_date, expiry_date, metadata
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
        ON CONFLICT (transaction_hash, ens_name_id) DO UPDATE SET
          base_cost_wei = EXCLUDED.base_cost_wei,
          premium_wei = EXCLUDED.premium_wei,
          total_cost_wei = EXCLUDED.total_cost_wei`,
        [
          ensNameId,
          registrantAddress,
          owner.toLowerCase(),
          baseCostWei,
          premiumWei,
          totalCostWei,
          nameLength,
          log.transactionHash,
          log.blockNumber?.toString(),
          registrationDate,
          expiryDate,
          JSON.stringify({ label: labelHash })
        ]
      );

      logger.info(`Recorded registration cost for ${fullName}: base=${baseCostWei}, premium=${premiumWei}, total=${totalCostWei}`);

      // Update the mint activity record with cost metadata if it exists
      await this.pool.query(
        `UPDATE activity_history
         SET metadata = metadata || $1::jsonb,
             price_wei = $4
         WHERE ens_name_id = $2
           AND event_type = 'mint'
           AND transaction_hash = $3`,
        [
          JSON.stringify({
            base_cost_wei: baseCostWei,
            premium_wei: premiumWei,
            total_cost_wei: totalCostWei,
          }),
          ensNameId,
          log.transactionHash,
          totalCostWei
        ]
      );

    } catch (error: any) {
      logger.error('Failed to record registration cost:', {
        error: error.message,
        name: fullName,
        transactionHash: log.transactionHash
      });
      throw error;
    }
  }

  private async saveEvent(event: Partial<BlockchainEvent>) {
    const query = `
      INSERT INTO blockchain_events (
        block_number, transaction_hash, log_index,
        contract_address, event_name, event_data, processed
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (transaction_hash, log_index) DO NOTHING
    `;

    // Convert BigInts in eventData to strings for JSON serialization
    const eventData = event.eventData ? this.serializeBigInts(event.eventData) : {};

    await this.pool.query(query, [
      event.blockNumber?.toString(),
      event.transactionHash,
      event.logIndex,
      event.contractAddress,
      event.eventName,
      JSON.stringify(eventData),
      event.processed,
    ]);
  }

  private serializeBigInts(obj: any): any {
    if (typeof obj === 'bigint') {
      return obj.toString();
    } else if (Array.isArray(obj)) {
      return obj.map(item => this.serializeBigInts(item));
    } else if (obj !== null && typeof obj === 'object') {
      const result: any = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.serializeBigInts(value);
      }
      return result;
    }
    return obj;
  }

  private calculateNameAttributes(name: string) {
    return {
      has_numbers: /\d/.test(name),
      has_emoji: hasEmoji(name),
    };
  }

  private async processEvent(eventName: string, args: any, log: Log) {
    try {
      switch (eventName) {
        case 'Transfer':
          await this.handleTransfer(args, log);
          break;
        case 'NameRegistered':
          await this.handleNameRegistered(args, log);
          break;
        case 'NameRenewed':
          await this.handleNameRenewed(args, log);
          break;
        default:
          logger.debug(`Unhandled event type: ${eventName}`);
      }
    } catch (error: any) {
      logger.error(`Error processing ${eventName} event:`, {
        error: error.message,
        args,
        blockNumber: log.blockNumber?.toString()
      });
      throw error;
    }
  }

  private async handleTransfer(args: any, log: Log) {
    const { from, to, tokenId } = args;
    const tokenIdStr = typeof tokenId === 'bigint' ? tokenId.toString() : String(tokenId);
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
    const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

    let ensNameId: number | null = null;

    try {
      // Check if this involves the Name Wrapper contract
      const isNameWrapperTransfer =
        to.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase() ||
        from.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();

      let correctTokenId = tokenIdStr;
      let nameToStore: string;
      let has_numbers: boolean;
      let has_emoji: boolean;
      let ownerToStore: string;

      if (isNameWrapperTransfer) {
        // Name Wrapper involved - resolve from The Graph to get correct token ID and name
        logger.debug(`Name Wrapper transfer detected for token ${tokenIdStr}, querying The Graph`);
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);

        // Require successful resolution for Name Wrapper transfers
        if (!resolvedData || !resolvedData.name) {
          logger.warn(`Could not resolve Name Wrapper transfer from The Graph for token ${tokenIdStr}, skipping Transfer event`);
          return;
        }

        correctTokenId = resolvedData.correctTokenId;
        nameToStore = resolvedData.name;
        const attributes = this.calculateNameAttributes(nameToStore);
        has_numbers = attributes.has_numbers;
        has_emoji = attributes.has_emoji;

        // Handle owner for Name Wrapper transfers
        // Query the Name Wrapper contract directly for authoritative owner data
        const isWrapping = to.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();
        const isUnwrapping = from.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();

        // First, try to get the owner directly from the Name Wrapper contract
        const contractOwner = await this.resolver.getWrappedNameOwner(nameToStore);

        if (contractOwner) {
          // Got authoritative owner from the blockchain
          ownerToStore = contractOwner;
          logger.debug(`Name Wrapper transfer for ${nameToStore}: got owner from contract: ${ownerToStore}`);
        } else if (isWrapping) {
          // Wrapping but contract query failed - try The Graph, otherwise skip
          if (resolvedData.ownerAddress && resolvedData.ownerAddress !== NAME_WRAPPER_ADDRESS.toLowerCase()) {
            ownerToStore = resolvedData.ownerAddress;
            logger.debug(`Wrapping transfer for ${nameToStore}: using resolved owner: ${ownerToStore}`);
          } else {
            logger.info(`Wrapping transfer for ${nameToStore}: cannot determine real owner, skipping`);
            return;
          }
        } else if (isUnwrapping) {
          // Unwrapping - 'to' is the new actual owner (unless it's zero address)
          if (to.toLowerCase() === ZERO_ADDRESS) {
            // Transfer from Name Wrapper to zero address = burning the wrapped token
            // This happens when a wrapped name expires and gets re-registered
            // We need to update the token_id from namehash to labelhash to prepare
            // for the upcoming NameRegistered event which will use labelhash
            const labelhashTokenId = this.resolver.getLabelhashTokenId(nameToStore);
            if (labelhashTokenId && labelhashTokenId !== correctTokenId) {
              logger.info(`Unwrap burn for ${nameToStore}: updating token_id from namehash ${correctTokenId} to labelhash ${labelhashTokenId}`);

              // Update token_id by name (since the name is unique)
              await this.pool.query(
                `UPDATE ens_names SET
                  token_id = $1,
                  updated_at = NOW()
                WHERE name = $2`,
                [labelhashTokenId, nameToStore]
              );

              logger.info(`Updated token_id for ${nameToStore} to labelhash format`);
            } else {
              logger.debug(`Unwrap burn for ${nameToStore}: token_id already in labelhash format or could not compute labelhash`);
            }
            // Don't update owner for burn transfers - the NameRegistered event will set the new owner
            return;
          }
          ownerToStore = to.toLowerCase();
          logger.debug(`Unwrapping transfer for ${nameToStore}: new owner is ${ownerToStore}`);
        } else {
          // Fallback to resolved data
          ownerToStore = resolvedData.ownerAddress || to.toLowerCase();
        }

        // Final safety check: never store Name Wrapper as owner
        if (ownerToStore === NAME_WRAPPER_ADDRESS.toLowerCase()) {
          logger.warn(`Refusing to store Name Wrapper as owner for ${nameToStore}, skipping`);
          return;
        }

        logger.debug(`Name Wrapper transfer: using correctTokenId ${correctTokenId}, owner ${ownerToStore} for ${nameToStore}`);
      } else {
        // Standard unwrapped transfer - use blockchain event data
        // First check if we already have this name in the database
        const existingRecord = await this.pool.query(
          'SELECT name, has_numbers, has_emoji FROM ens_names WHERE token_id = $1',
          [tokenIdStr]
        );

        if (existingRecord.rows.length > 0) {
          // Use existing name data
          nameToStore = existingRecord.rows[0].name;
          has_numbers = existingRecord.rows[0].has_numbers;
          has_emoji = existingRecord.rows[0].has_emoji;
        } else {
          // New name - try to resolve from The Graph
          const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);
          if (resolvedData && resolvedData.name) {
            nameToStore = resolvedData.name;
            const attributes = this.calculateNameAttributes(nameToStore);
            has_numbers = attributes.has_numbers;
            has_emoji = attributes.has_emoji;
          } else {
            // Can't resolve - skip this transfer
            logger.warn(`Could not resolve name for unwrapped transfer token ${tokenIdStr}, skipping Transfer event`);
            return;
          }
        }

        // For standard transfers, use the 'to' address as owner
        ownerToStore = to.toLowerCase();
        logger.debug(`Standard transfer: token ${tokenIdStr}, owner ${ownerToStore}`);
      }

      // Check if this name exists with a different token_id (edge case for wrapped/unwrapped transitions)
      const duplicateName = await this.pool.query(
        'SELECT id, token_id FROM ens_names WHERE name = $1 AND token_id != $2',
        [nameToStore, correctTokenId]
      );

      let result;

      if (duplicateName.rows.length > 0) {
        // Name exists with different token_id - update the existing record by name
        // Also update token_id to match the new wrapped/unwrapped state
        logger.info(`Updating token_id for ${nameToStore} from ${duplicateName.rows[0].token_id} to ${correctTokenId} (wrap/unwrap transition)`);
        result = await this.pool.query(
          `UPDATE ens_names SET
            token_id = $1,
            owner_address = $2,
            last_transfer_date = NOW(),
            updated_at = NOW()
          WHERE name = $3
          RETURNING id`,
          [correctTokenId, ownerToStore, nameToStore]
        );
      } else {
        // Upsert by token_id
        const upsertQuery = `
          INSERT INTO ens_names (token_id, name, owner_address, last_transfer_date, has_numbers, has_emoji)
          VALUES ($1, $2, $3, NOW(), $4, $5)
          ON CONFLICT (token_id) DO UPDATE SET
            owner_address = EXCLUDED.owner_address,
            name = CASE
              WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.name
              ELSE ens_names.name
            END,
            has_numbers = CASE
              WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.has_numbers
              ELSE ens_names.has_numbers
            END,
            has_emoji = CASE
              WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.has_emoji
              ELSE ens_names.has_emoji
            END,
            last_transfer_date = NOW(),
            updated_at = NOW()
          RETURNING id
        `;

        result = await this.pool.query(upsertQuery, [
          correctTokenId,
          nameToStore,
          ownerToStore,
          has_numbers,
          has_emoji
        ]);
      }

      if (result.rows.length > 0) {
        ensNameId = result.rows[0].id;
      }
    } catch (error: any) {
      logger.error('Failed to process Transfer event:', {
        error: error.message,
        tokenId: tokenIdStr,
        to
      });
      throw error;
    }

    // Publish ownership update job to queue
    if (ensNameId) {
      try {
        const { getQueueClient, QUEUE_NAMES } = await import('../queue');
        const boss = await getQueueClient();

        await boss.send(QUEUE_NAMES.UPDATE_OWNERSHIP, {
          ensNameId,
          newOwner: to.toLowerCase(),
          blockNumber: Number(log.blockNumber),
          transactionHash: log.transactionHash || '',
        });

        logger.debug({ ensNameId, tokenId: tokenIdStr, newOwner: to }, 'Published ownership update job');
      } catch (queueError: any) {
        // Don't fail indexing if queue publishing fails
        logger.error({
          errorMessage: queueError?.message || String(queueError),
          errorStack: queueError?.stack,
          ensNameId
        }, 'Failed to publish ownership update job');
      }
    }

    try {
      const block = await this.client.getBlock({ blockNumber: log.blockNumber! });

      const txQuery = `
        INSERT INTO transactions (
          ens_name_id, transaction_hash, block_number,
          from_address, to_address, transaction_type, timestamp
        )
        SELECT id, $2, $3, $4, $5, 'transfer', $6
        FROM ens_names
        WHERE token_id = $1
        ON CONFLICT (transaction_hash) DO NOTHING
      `;

      await this.pool.query(txQuery, [
        tokenIdStr,
        log.transactionHash,
        log.blockNumber?.toString(),
        from.toLowerCase(),
        to.toLowerCase(),
        new Date(Number(block.timestamp) * 1000),
      ]);
    } catch (error: any) {
      logger.error('Failed to insert transaction:', {
        error: error.message,
        tokenId: tokenIdStr,
        transactionHash: log.transactionHash
      });
      // Don't rethrow - we can continue even if transaction insert fails
    }
  }

  private async handleNameRegistered(args: any, log: Log) {
    const { id: tokenId, owner, expires } = args;
    const tokenIdStr = typeof tokenId === 'bigint' ? tokenId.toString() : String(tokenId);
    const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

    // Set defaults outside try block so they're available for transaction logging
    let correctTokenId = tokenIdStr;
    let registrationDate: Date | null = null;
    let creationDate: Date | null = null;
    let registrantAddress = owner.toLowerCase();

    try {
      // Check if owner is Name Wrapper (edge case)
      const isWrappedRegistration = owner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase();

      let nameToStore: string;
      let has_numbers: boolean;
      let has_emoji: boolean;
      let ownerAddress: string;
      let expiryDate: Date;

      if (isWrappedRegistration) {
        // Name Wrapper registration - resolve from The Graph to get correct data
        logger.debug(`Name Wrapper registration detected for token ${tokenIdStr}, querying The Graph`);
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);

        // Require successful resolution for wrapped registrations
        if (!resolvedData || !resolvedData.name) {
          logger.warn(`Could not resolve Name Wrapper registration from The Graph for token ${tokenIdStr}, skipping NameRegistered event`);
          return;
        }

        correctTokenId = resolvedData.correctTokenId;
        nameToStore = resolvedData.name;
        const attributes = this.calculateNameAttributes(nameToStore);
        has_numbers = attributes.has_numbers;
        has_emoji = attributes.has_emoji;

        // For wrapped registrations, query the Name Wrapper contract directly for authoritative owner
        const contractOwner = await this.resolver.getWrappedNameOwner(nameToStore);

        if (contractOwner) {
          ownerAddress = contractOwner;
          logger.debug(`Name Wrapper registration for ${nameToStore}: got owner from contract: ${ownerAddress}`);
        } else if (resolvedData.ownerAddress && resolvedData.ownerAddress !== NAME_WRAPPER_ADDRESS.toLowerCase()) {
          ownerAddress = resolvedData.ownerAddress;
          logger.debug(`Name Wrapper registration for ${nameToStore}: using resolved owner: ${ownerAddress}`);
        } else {
          logger.info(`Name Wrapper registration for ${nameToStore}: cannot determine real owner, skipping`);
          return;
        }

        // Final safety check
        if (ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase()) {
          logger.warn(`Refusing to store Name Wrapper as owner for ${nameToStore} registration, skipping`);
          return;
        }

        registrantAddress = resolvedData.registrantAddress || owner.toLowerCase();

        // Use dates from The Graph, fallback to event data
        expiryDate = resolvedData.expiryDate || new Date(Number(expires) * 1000);
        registrationDate = resolvedData.registrationDate;
        creationDate = resolvedData.creationDate;

        logger.debug(`Name Wrapper registration: correctTokenId ${correctTokenId}, owner ${ownerAddress}, registrant ${registrantAddress}`);
      } else {
        // Standard unwrapped registration - resolve name from The Graph but use event data for ownership
        const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);

        if (resolvedData && resolvedData.name) {
          nameToStore = resolvedData.name;
          registrationDate = resolvedData.registrationDate;
          creationDate = resolvedData.creationDate;
        } else {
          // The Graph lookup failed - this can happen due to race conditions where
          // The Graph hasn't indexed this block yet. Check if we already have this
          // token in our database and update the expiry from the event data.
          const existingName = await this.pool.query(
            'SELECT id, name FROM ens_names WHERE token_id = $1',
            [tokenIdStr]
          );

          if (existingName.rows.length > 0) {
            // We have this token already - update expiry from blockchain event data
            const expiryFromEvent = new Date(Number(expires) * 1000);
            await this.pool.query(
              `UPDATE ens_names SET
                expiry_date = $1,
                owner_address = $2,
                registrant = $2,
                updated_at = NOW()
              WHERE token_id = $3`,
              [expiryFromEvent, owner.toLowerCase(), tokenIdStr]
            );
            logger.info(`Graph lookup failed but updated existing token ${tokenIdStr} (${existingName.rows[0].name}) with expiry ${expiryFromEvent.toISOString()} from NameRegistered event`);
            return;
          }

          // Can't resolve name and don't have it in DB - skip this registration
          logger.warn(`Could not resolve name for registration token ${tokenIdStr}, skipping NameRegistered event`);
          return;
        }

        const attributes = this.calculateNameAttributes(nameToStore);
        has_numbers = attributes.has_numbers;
        has_emoji = attributes.has_emoji;

        // For standard registrations, use event data for owner/registrant
        ownerAddress = owner.toLowerCase();
        registrantAddress = owner.toLowerCase();
        expiryDate = new Date(Number(expires) * 1000);

        logger.debug(`Standard registration: token ${tokenIdStr}, name ${nameToStore}, owner ${ownerAddress}`);
      }

      // Check if this name exists with a different token_id (wrapping/unwrapping transition)
      const duplicateName = await this.pool.query(
        'SELECT id, token_id FROM ens_names WHERE name = $1 AND token_id != $2',
        [nameToStore, correctTokenId]
      );

      let result;

      if (duplicateName.rows.length > 0) {
        // Name exists with different token_id - update the existing record by name
        result = await this.pool.query(
          `UPDATE ens_names SET
            token_id = $1,
            owner_address = $2,
            registrant = $3,
            expiry_date = $4,
            registration_date = COALESCE(registration_date, $5),
            creation_date = COALESCE(creation_date, $9),
            has_numbers = $6,
            has_emoji = $7,
            updated_at = NOW()
          WHERE name = $8
          RETURNING id`,
          [correctTokenId, ownerAddress, registrantAddress, expiryDate, registrationDate, has_numbers, has_emoji, nameToStore, creationDate]
        );
      } else {
        // Upsert by token_id
        const upsertQuery = `
          INSERT INTO ens_names (
            token_id, owner_address, registrant,
            expiry_date, registration_date, creation_date, name, has_numbers, has_emoji
          ) VALUES ($1, $2, $3, $4, $5, $9, $6, $7, $8)
          ON CONFLICT (token_id) DO UPDATE SET
          owner_address = EXCLUDED.owner_address,
          registrant = EXCLUDED.registrant,
          expiry_date = EXCLUDED.expiry_date,
          registration_date = COALESCE(ens_names.registration_date, EXCLUDED.registration_date),
          creation_date = COALESCE(ens_names.creation_date, EXCLUDED.creation_date),
          name = CASE
            WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.name
            ELSE ens_names.name
          END,
          has_numbers = CASE
            WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.has_numbers
            ELSE ens_names.has_numbers
          END,
          has_emoji = CASE
            WHEN ens_names.name LIKE 'token-%' THEN EXCLUDED.has_emoji
            ELSE ens_names.has_emoji
          END,
          updated_at = NOW()
        `;

        result = await this.pool.query(upsertQuery + ' RETURNING id', [
          correctTokenId,
          ownerAddress,
          registrantAddress,
          expiryDate,
          registrationDate,
          nameToStore,
          has_numbers,
          has_emoji,
          creationDate
        ]);
      }

      // Create mint activity record with the registration date as the event timestamp
      if (result.rows.length > 0 && registrationDate) {
        const ensNameId = result.rows[0].id;

        try {
          // Get the actual minter from the transaction's 'from' address
          // The NameRegistered event's 'owner' may be the controller contract, not the actual user
          let actualMinter = registrantAddress;
          if (log.transactionHash) {
            try {
              const tx = await this.client.getTransaction({ hash: log.transactionHash as `0x${string}` });
              if (tx && tx.from) {
                actualMinter = tx.from.toLowerCase();
                logger.debug(`Mint activity: using tx.from ${actualMinter} instead of event owner ${registrantAddress}`);
              }
            } catch (txError: any) {
              logger.warn(`Could not fetch transaction for mint activity, using event owner: ${txError.message}`);
            }
          }

          await this.pool.query(
            `INSERT INTO activity_history (
              ens_name_id,
              event_type,
              actor_address,
              platform,
              chain_id,
              transaction_hash,
              block_number,
              metadata,
              created_at
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT DO NOTHING`,
            [
              ensNameId,
              'mint',
              actualMinter,
              'blockchain',
              1,
              log.transactionHash || null,
              log.blockNumber?.toString() || null,
              JSON.stringify({ token_id: correctTokenId }),
              registrationDate
            ]
          );
          logger.debug(`Created mint activity for ${nameToStore} (token ${correctTokenId}) with registration date ${registrationDate.toISOString()}, minter: ${actualMinter}`);
        } catch (activityError: any) {
          logger.error('Failed to create mint activity:', {
            error: activityError.message,
            tokenId: correctTokenId,
            ensNameId
          });
          // Don't fail the entire registration if activity creation fails
        }
      }
    } catch (error: any) {
      logger.error('Failed to handle NameRegistered:', {
        error: error.message,
        tokenId: tokenIdStr,
        owner
      });
      throw error;
    }

    // Log transaction data
    const txQuery = `
      INSERT INTO transactions (
        ens_name_id, transaction_hash, block_number,
        from_address, to_address, transaction_type, timestamp
      )
      SELECT id, $2, $3, $4, $4, 'registration', $5
      FROM ens_names WHERE token_id = $1
      ON CONFLICT (transaction_hash) DO NOTHING
    `;

    try {
      // Get timestamp - use registrationDate from Graph, or fetch block timestamp
      let timestamp: Date;
      if (registrationDate) {
        timestamp = registrationDate;
      } else {
        const block = await this.client.getBlock({ blockNumber: log.blockNumber! });
        timestamp = new Date(Number(block.timestamp) * 1000);
      }

      await this.pool.query(txQuery, [
        correctTokenId,
        log.transactionHash,
        log.blockNumber?.toString(),
        registrantAddress,
        timestamp,
      ]);
    } catch (error: any) {
      logger.error('Failed to insert registration transaction:', {
        error: error.message,
        tokenId: correctTokenId
      });
    }
  }

  private async handleNameRenewed(args: any, log: Log) {
    const { id: tokenId, expires } = args;
    const tokenIdStr = typeof tokenId === 'bigint' ? tokenId.toString() : String(tokenId);
    const expiryDate = new Date(Number(expires) * 1000);

    // The NameRenewed event emits the labelhash as the id, but wrapped names
    // are stored with the namehash as token_id. We need to resolve the name
    // first and then update by name to handle both wrapped and unwrapped names.

    // First, try to resolve the name from The Graph using the labelhash
    const resolvedData = await this.resolver.resolveTokenIdToNameData(tokenIdStr);

    let updateResult;
    let nameForTx: string | null = null;

    if (resolvedData && resolvedData.name) {
      // Successfully resolved - update by name (works for both wrapped and unwrapped)
      nameForTx = resolvedData.name;
      logger.info(`NameRenewed: resolved labelhash ${tokenIdStr} to name ${nameForTx}, updating expiry to ${expiryDate.toISOString()}`);

      const updateQuery = `
        UPDATE ens_names
        SET expiry_date = $1, updated_at = NOW()
        WHERE name = $2
      `;
      updateResult = await this.pool.query(updateQuery, [expiryDate, nameForTx]);
    } else {
      // Could not resolve from The Graph - fall back to token_id lookup
      // This handles unwrapped names that might not be in The Graph yet
      logger.debug(`NameRenewed: could not resolve labelhash ${tokenIdStr}, falling back to token_id lookup`);

      const updateQuery = `
        UPDATE ens_names
        SET expiry_date = $1, updated_at = NOW()
        WHERE token_id = $2
      `;
      updateResult = await this.pool.query(updateQuery, [expiryDate, tokenIdStr]);
    }

    if (updateResult.rowCount === 0) {
      logger.warn(`NameRenewed: no rows updated for token ${tokenIdStr}${nameForTx ? ` (${nameForTx})` : ''}`);
    } else {
      logger.info(`NameRenewed: updated expiry for ${nameForTx || `token ${tokenIdStr}`} to ${expiryDate.toISOString()}`);
    }

    // Record the renewal transaction
    const block = await this.client.getBlock({ blockNumber: log.blockNumber! });

    const txQuery = nameForTx
      ? `
        INSERT INTO transactions (
          ens_name_id, transaction_hash, block_number,
          from_address, to_address, transaction_type, timestamp
        )
        SELECT id, $2, $3, owner_address, owner_address, 'renewal', $4
        FROM ens_names WHERE name = $1
        ON CONFLICT (transaction_hash) DO NOTHING
      `
      : `
        INSERT INTO transactions (
          ens_name_id, transaction_hash, block_number,
          from_address, to_address, transaction_type, timestamp
        )
        SELECT id, $2, $3, owner_address, owner_address, 'renewal', $4
        FROM ens_names WHERE token_id = $1
        ON CONFLICT (transaction_hash) DO NOTHING
      `;

    await this.pool.query(txQuery, [
      nameForTx || tokenIdStr,
      log.transactionHash,
      log.blockNumber?.toString(),
      new Date(Number(block.timestamp) * 1000),
    ]);
  }

  private async getLastProcessedBlock(): Promise<number> {
    const query = `
      SELECT last_processed_block FROM indexer_state
      WHERE contract_address = $1
    `;

    const result = await this.pool.query(query, [config.blockchain.ensRegistrarAddress]);
    return result.rows.length > 0 ? parseInt(result.rows[0].last_processed_block) : 0;
  }

  private async updateLastProcessedBlock(blockNumber: bigint) {
    const query = `
      INSERT INTO indexer_state (contract_address, last_processed_block)
      VALUES ($1, $2)
      ON CONFLICT (contract_address) DO UPDATE
      SET last_processed_block = EXCLUDED.last_processed_block,
          last_processed_timestamp = NOW(),
          updated_at = NOW()
    `;

    await this.pool.query(query, [
      config.blockchain.ensRegistrarAddress,
      blockNumber.toString(),
    ]);
  }
}