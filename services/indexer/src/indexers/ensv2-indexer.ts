import {
  createPublicClient,
  http,
  keccak256,
  namehash,
  parseAbi,
  toBytes,
  type Log,
  type PublicClient,
} from 'viem';
import { config, viemChain, getPostgresPool, hasEmoji, getRegistrationSource, safeNormalize } from '../../../shared/src';
import { logger } from '../utils/logger';
import { isBeyondHeadError } from '../utils/rpc-errors';

// ENSv2 ETHRegistry (PermissionedRegistry, ERC1155). Signatures from the deployed ABIs
// (contracts-v2 post-audit-2, deployments/sepolia).
const ETH_REGISTRY_EVENTS = parseAbi([
  'event LabelRegistered(uint256 indexed tokenId, bytes32 indexed labelHash, string label, address owner, uint64 expiry, address indexed sender)',
  'event LabelUnregistered(uint256 indexed tokenId, address indexed sender)',
  'event ExpiryUpdated(uint256 indexed tokenId, uint64 indexed newExpiry, address indexed sender)',
  'event ResolverUpdated(uint256 indexed tokenId, address indexed resolver, address indexed sender)',
  'event TokenRegenerated(uint256 indexed oldTokenId, uint256 indexed newTokenId)',
  'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
  'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
]);

// ETHRegistrar and ETHRenewerV1 (both AbstractETHRegistrar). Amounts are in paymentToken units.
const ETH_REGISTRAR_EVENTS = parseAbi([
  'event NameRegistered(uint256 indexed tokenId, string label, address owner, address subregistry, address resolver, uint64 duration, address paymentToken, bytes32 indexed referrer, uint256 base, uint256 premium)',
  'event NameRenewed(uint256 indexed tokenId, string label, uint64 duration, uint64 newExpiry, address paymentToken, bytes32 indexed referrer, uint256 amount)',
]);

const BASE_REGISTRAR_ABI = parseAbi([
  'function nameExpires(uint256 id) view returns (uint256)',
]);

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

type DecodedLog = Log & { eventName: string; args: any };

/**
 * Indexes ENSv2 .eth names: registrations, renewals, migrations from v1, transfers, expiry
 * changes and token ID regeneration on the ETHRegistry, plus registration/renewal costs from
 * the ETHRegistrar and ETHRenewerV1.
 *
 * Runs alongside ENSIndexer (v1) with its own cursor (keyed by the ETHRegistry address), so v2
 * can be backfilled from the registry deployment without replaying v1. Logs are processed one
 * at a time in (block, logIndex) order: handlers rely on in-tx order (LabelRegistered before
 * the registrar's NameRegistered; burn -> TokenRegenerated -> mint).
 *
 * ens_names stays one row per name. A v2 name's token_id is its current ETHRegistry token ID,
 * which changes on migration and on TokenRegenerated; every v2 ID is kept in ens_token_ids.
 * Unmigrated v1 names keep their v1 token and v1 expiry: renewals through ETHRenewerV1 are
 * recorded here (cost, currency) but expiry stays owned by the v1 BaseRegistrar handler.
 */
export class EnsV2Indexer {
  private client: PublicClient;
  private pool = getPostgresPool();
  private isRunning = false;
  private currentBlock = 0n;
  private readonly batchSize = 500;
  private readonly confirmations = BigInt(config.blockchain.confirmations);
  // Only constructed when config.blockchain.ensv2 is set (see index.ts)
  private readonly v2 = config.blockchain.ensv2!;
  private readonly registry = this.v2.ethRegistryAddress.toLowerCase();
  private readonly registrar = this.v2.ethRegistrarAddress.toLowerCase();
  private readonly renewerV1 = this.v2.ethRenewerV1Address.toLowerCase();
  private readonly migrationControllers = new Map([
    [this.v2.unlockedMigrationControllerAddress.toLowerCase(), 'unlocked'],
    [this.v2.lockedMigrationControllerAddress.toLowerCase(), 'locked'],
  ]);
  // Per-batch caches (cleared each block range)
  private blockTimes = new Map<bigint, Date>();
  private txSenders = new Map<string, string>();

  constructor() {
    this.client = createPublicClient({
      chain: viemChain,
      transport: http(config.blockchain.rpcUrl),
    });
  }

  async start() {
    logger.info('Starting ENSv2 indexer...');
    this.isRunning = true;

    const lastBlock = await this.getLastProcessedBlock();
    this.currentBlock = lastBlock > 0 ? BigInt(lastBlock) + 1n : BigInt(this.v2.startBlock);
    logger.info(`ENSv2 indexer starting from block ${this.currentBlock}`);

    this.indexLoop();
  }

  async stop() {
    logger.info('Stopping ENSv2 indexer...');
    this.isRunning = false;
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
        if (isBeyondHeadError(error)) {
          logger.debug(`getLogs head not caught up at block ${this.currentBlock}, retrying shortly`);
          await new Promise(resolve => setTimeout(resolve, 250));
          continue;
        }
        logger.error({
          err: error,
          code: error.code,
          details: error.shortMessage || error.details
        }, `Error in ENSv2 index loop at block ${this.currentBlock}`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
    }
  }

  /**
   * Index one block range. Throws on any handler error so the loop retries the whole range
   * (handlers are idempotent) instead of advancing past a half-processed range.
   */
  async indexBlockRange(fromBlock: bigint, toBlock: bigint) {
    logger.info(`Indexing ENSv2 events from block ${fromBlock} to ${toBlock}`);
    this.blockTimes.clear();
    this.txSenders.clear();

    const [registryLogs, registrarLogs] = await Promise.all([
      this.client.getLogs({
        address: this.registry as `0x${string}`,
        events: ETH_REGISTRY_EVENTS,
        fromBlock,
        toBlock,
        strict: true,
      }),
      this.client.getLogs({
        address: [this.registrar, this.renewerV1] as `0x${string}`[],
        events: ETH_REGISTRAR_EVENTS,
        fromBlock,
        toBlock,
        strict: true,
      }),
    ]);

    const logs = [...registryLogs, ...registrarLogs] as unknown as DecodedLog[];
    logs.sort((a, b) => {
      const blockA = a.blockNumber ?? 0n;
      const blockB = b.blockNumber ?? 0n;
      if (blockA !== blockB) return blockA < blockB ? -1 : 1;
      return (a.logIndex ?? 0) - (b.logIndex ?? 0);
    });

    for (const log of logs) {
      try {
        await this.processLog(log);
      } catch (error: any) {
        logger.error({
          err: error,
          event: log.eventName,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        }, `Failed to process ENSv2 ${log.eventName} at block ${log.blockNumber}`);
        throw error;
      }
    }
  }

  private async processLog(log: DecodedLog) {
    const emitter = log.address.toLowerCase();
    const args = log.args;

    if (emitter === this.registry) {
      switch (log.eventName) {
        case 'LabelRegistered':
          return this.handleLabelRegistered(args, log);
        case 'LabelUnregistered':
          return this.handleLabelUnregistered(args, log);
        case 'ExpiryUpdated':
          return this.handleExpiryUpdated(args);
        case 'ResolverUpdated':
          return this.handleResolverUpdated(args);
        case 'TokenRegenerated':
          return this.handleTokenRegenerated(args, log);
        case 'TransferSingle':
          return this.handleTransfer(args.from, args.to, [args.id], log);
        case 'TransferBatch':
          return this.handleTransfer(args.from, args.to, args.ids, log);
      }
      return;
    }

    switch (log.eventName) {
      case 'NameRegistered':
        return this.handleNameRegistered(args, log);
      case 'NameRenewed':
        return this.handleNameRenewed(args, log, emitter === this.renewerV1);
    }
  }

  /**
   * A .eth name became REGISTERED on the ETHRegistry: a new registration, a re-registration
   * after expiry, or a v1 name migrating (sender = a migration controller). The label is
   * emitted in plaintext, so no subgraph lookup is needed.
   */
  private async handleLabelRegistered(args: any, log: DecodedLog) {
    const rawLabel: string = args.label;
    const label = safeNormalize(rawLabel);
    if (label !== rawLabel) {
      // Not in normalized form: the name can't be resolved and would collide with the
      // canonical name's row. ens_names only tracks normalized names.
      logger.warn(`ENSv2 LabelRegistered: label "${rawLabel}" is not normalized, skipping`);
      return;
    }

    const name = `${label}.eth`;
    const tokenId = (args.tokenId as bigint).toString();
    const labelhash = (args.labelHash as string).toLowerCase();
    const owner = (args.owner as string).toLowerCase();
    const expiryDate = new Date(Number(args.expiry) * 1000);
    const migration = this.migrationControllers.get((args.sender as string).toLowerCase());
    const blockDate = await this.getBlockTime(log.blockNumber!);
    const { has_numbers, has_emoji } = this.calculateNameAttributes(name);

    // The name may already have a row: its v1 record (by name, or a placeholder row keyed by
    // the v1 unwrapped labelhash / wrapped namehash token ID), or an earlier v2 registration.
    const v1UnwrappedId = BigInt(labelhash).toString();
    const v1WrappedId = BigInt(namehash(name)).toString();
    const existing = await this.pool.query(
      `SELECT id FROM ens_names
       WHERE name = $1 OR token_id IN ($2, $3, $4)
       ORDER BY (name = $1) DESC
       LIMIT 1`,
      [name, tokenId, v1UnwrappedId, v1WrappedId]
    );

    let ensNameId: number;
    if (existing.rows.length > 0) {
      ensNameId = existing.rows[0].id;
      // Migration keeps the original registration date; a (re-)registration starts a new one.
      await this.pool.query(
        `UPDATE ens_names SET
           name = $2,
           token_id = $3,
           token_contract = $4,
           ens_version = 2,
           labelhash = $5,
           owner_address = $6,
           registrant = $6,
           expiry_date = $7,
           registration_date = CASE WHEN $8 THEN COALESCE(registration_date, $9) ELSE $9 END,
           creation_date = COALESCE(creation_date, $9),
           has_numbers = $10,
           has_emoji = $11,
           updated_at = NOW()
         WHERE id = $1`,
        [ensNameId, name, tokenId, this.registry, labelhash, owner, expiryDate, !!migration, blockDate, has_numbers, has_emoji]
      );
    } else {
      const inserted = await this.pool.query(
        `INSERT INTO ens_names (
           name, token_id, token_contract, ens_version, labelhash, owner_address, registrant,
           expiry_date, registration_date, creation_date, has_numbers, has_emoji
         ) VALUES ($1, $2, $3, 2, $4, $5, $5, $6, $7, $7, $8, $9)
         RETURNING id`,
        [name, tokenId, this.registry, labelhash, owner, expiryDate, blockDate, has_numbers, has_emoji]
      );
      ensNameId = inserted.rows[0].id;
    }

    await this.recordTokenId(tokenId, ensNameId, migration ? 'migrated' : 'registered', log);
    if (existing.rows.length > 0) {
      // Orders on the name's previous token (v1, or an earlier v2 registration) can't fill
      await this.publishStaleOrders(ensNameId, migration ? 'migrated' : 'reregistered', log);
    }

    if (migration) {
      await this.insertActivityOnce(ensNameId, 'migrated', {
        actor: owner,
        log,
        createdAt: blockDate,
        metadata: { token_id: tokenId, migration_controller: migration },
      });
      logger.info(`ENSv2: ${name} migrated from v1 (${migration}), token ${tokenId}, owner ${owner}`);
      return;
    }

    // Registration. Cost and referrer are filled in by the registrar's NameRegistered,
    // which follows in the same tx.
    const minter = await this.getTxSender(log.transactionHash!, owner);
    await this.insertActivityOnce(ensNameId, 'mint', {
      actor: minter,
      log,
      createdAt: blockDate,
      metadata: {
        token_id: tokenId,
        duration_seconds: Math.floor((expiryDate.getTime() - blockDate.getTime()) / 1000),
      },
    });
    await this.insertTransaction(ensNameId, 'registration', ZERO_ADDRESS, owner, log, blockDate);
    logger.info(`ENSv2: registered ${name}, token ${tokenId}, owner ${owner}, expires ${expiryDate.toISOString()}`);
  }

  /** ETHRegistrar NameRegistered: registration cost, payment token and referrer. */
  private async handleNameRegistered(args: any, log: DecodedLog) {
    const tokenId = (args.tokenId as bigint).toString();
    const ensName = await this.findV2Name(tokenId);
    if (!ensName) {
      // LabelRegistered (earlier in the same tx) was skipped, e.g. a non-normalized label
      logger.warn(`ENSv2 NameRegistered: no name for token ${tokenId} ("${args.label}"), skipping cost`);
      return;
    }

    const baseCost = (args.base as bigint).toString();
    const premium = (args.premium as bigint).toString();
    const totalCost = ((args.base as bigint) + (args.premium as bigint)).toString();
    const currency = (args.paymentToken as string).toLowerCase();
    const referrer = (args.referrer as string).toLowerCase();
    const owner = (args.owner as string).toLowerCase();
    const durationSeconds = Number(args.duration);
    const blockDate = await this.getBlockTime(log.blockNumber!);
    const registrant = await this.getTxSender(log.transactionHash!, owner);
    const label = ensName.name.slice(0, -'.eth'.length);

    await this.pool.query(
      `INSERT INTO registrations (
         ens_name_id, registrant_address, owner_address,
         base_cost_wei, premium_wei, total_cost_wei, currency_address,
         name_length, transaction_hash, block_number,
         registration_date, expiry_date, metadata, referrer
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (transaction_hash, ens_name_id) DO UPDATE SET
         base_cost_wei = EXCLUDED.base_cost_wei,
         premium_wei = EXCLUDED.premium_wei,
         total_cost_wei = EXCLUDED.total_cost_wei,
         currency_address = EXCLUDED.currency_address,
         referrer = COALESCE(EXCLUDED.referrer, registrations.referrer)`,
      [
        ensName.id,
        registrant,
        owner,
        baseCost,
        premium,
        totalCost,
        currency,
        this.countGraphemes(label),
        log.transactionHash,
        log.blockNumber!.toString(),
        blockDate,
        new Date(blockDate.getTime() + durationSeconds * 1000),
        JSON.stringify({
          label: ensName.labelhash,
          ens_version: 2,
          duration_seconds: durationSeconds,
          subregistry: (args.subregistry as string).toLowerCase(),
          resolver: (args.resolver as string).toLowerCase(),
        }),
        referrer,
      ]
    );

    const registrationSource = getRegistrationSource(referrer);
    await this.pool.query(
      `UPDATE activity_history
       SET metadata = metadata || $1::jsonb,
           price_wei = $4,
           currency_address = $5
           ${registrationSource ? ', platform = $6' : ''}
       WHERE ens_name_id = $2
         AND event_type = 'mint'
         AND transaction_hash = $3`,
      [
        JSON.stringify({
          base_cost_wei: baseCost,
          premium_wei: premium,
          total_cost_wei: totalCost,
          duration_seconds: durationSeconds,
          referrer,
          ...(registrationSource ? { registration_source: registrationSource } : {}),
        }),
        ensName.id,
        log.transactionHash,
        totalCost,
        currency,
        ...(registrationSource ? [registrationSource] : []),
      ]
    );

    logger.info(`ENSv2: recorded registration cost for ${ensName.name}: ${totalCost} of ${currency}`);
  }

  /**
   * NameRenewed from the ETHRegistrar (a v2 name) or ETHRenewerV1 (an unmigrated v1 name
   * renewed through v2; the v1 BaseRegistrar emits its own NameRenewed in the same tx).
   */
  private async handleNameRenewed(args: any, log: DecodedLog, viaRenewerV1: boolean) {
    const rawLabel: string = args.label;
    const label = safeNormalize(rawLabel);
    if (label !== rawLabel) {
      logger.warn(`ENSv2 NameRenewed: label "${rawLabel}" is not normalized, skipping`);
      return;
    }
    const name = `${label}.eth`;
    const tokenId = (args.tokenId as bigint).toString();
    const amount = (args.amount as bigint).toString();
    const currency = (args.paymentToken as string).toLowerCase();
    const referrer = (args.referrer as string).toLowerCase();
    const durationSeconds = Number(args.duration);
    const blockDate = await this.getBlockTime(log.blockNumber!);
    const renewer = await this.getTxSender(log.transactionHash!, ZERO_ADDRESS);

    let ensNameId: number;
    let newExpiry: Date;
    if (viaRenewerV1) {
      // Unmigrated names show their v1 expiry. The v2 newExpiry here is the reserved entry's
      // expiry (v1 expiry + the migration bonus period), so read the v1 one.
      const labelhash = keccak256(toBytes(rawLabel));
      newExpiry = await this.getV1Expiry(labelhash, log.blockNumber!) ?? new Date(Number(args.newExpiry) * 1000);
      const existing = await this.pool.query('SELECT id FROM ens_names WHERE name = $1', [name]);
      if (existing.rows.length > 0) {
        ensNameId = existing.rows[0].id;
      } else {
        // Never-seen v1 name: create the v1 row (unwrapped labelhash token ID) so the renewal
        // isn't lost; the v1 indexer and workers fill in owner/metadata.
        const { has_numbers, has_emoji } = this.calculateNameAttributes(name);
        const inserted = await this.pool.query(
          `INSERT INTO ens_names (token_id, name, owner_address, expiry_date, has_numbers, has_emoji)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (token_id) DO UPDATE SET updated_at = NOW()
           RETURNING id`,
          [BigInt(labelhash).toString(), name, renewer, newExpiry, has_numbers, has_emoji]
        );
        ensNameId = inserted.rows[0].id;
        logger.info(`ENSv2 NameRenewed (renewer v1): ${name} not in ens_names, created v1 record`);
      }
    } else {
      const ensName = await this.findV2Name(tokenId);
      if (!ensName) {
        logger.warn(`ENSv2 NameRenewed: no v2 name for token ${tokenId} (${name}), skipping`);
        return;
      }
      ensNameId = ensName.id;
      newExpiry = new Date(Number(args.newExpiry) * 1000);
    }

    const source = viaRenewerV1 ? 'ensv2_renewer_v1' : 'ensv2_registrar';
    await this.pool.query(
      `INSERT INTO renewals (
         ens_name_id, renewer_address, cost_wei, currency_address, duration_seconds,
         new_expiry_date, referrer, name_length,
         transaction_hash, block_number, renewal_date, metadata
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (transaction_hash, ens_name_id) DO UPDATE SET
         cost_wei = EXCLUDED.cost_wei,
         currency_address = EXCLUDED.currency_address,
         duration_seconds = EXCLUDED.duration_seconds,
         new_expiry_date = EXCLUDED.new_expiry_date,
         referrer = COALESCE(EXCLUDED.referrer, renewals.referrer)`,
      [
        ensNameId,
        renewer,
        amount,
        currency,
        durationSeconds,
        newExpiry,
        referrer,
        this.countGraphemes(label),
        log.transactionHash,
        log.blockNumber!.toString(),
        blockDate,
        JSON.stringify({ source, ens_version: 2 }),
      ]
    );

    const renewalSource = getRegistrationSource(referrer);
    await this.insertActivityOnce(ensNameId, 'renewal', {
      actor: renewer,
      log,
      createdAt: blockDate,
      platform: renewalSource || 'blockchain',
      priceWei: amount,
      currency,
      metadata: {
        source,
        duration_seconds: durationSeconds,
        referrer,
        ...(renewalSource ? { registration_source: renewalSource } : {}),
      },
    });
    await this.insertTransaction(ensNameId, 'renewal', renewer, renewer, log, blockDate);

    logger.info(`ENSv2: recorded renewal of ${name} (${source}): ${amount} of ${currency}, expires ${newExpiry.toISOString()}`);
  }

  private async handleExpiryUpdated(args: any) {
    const sender = (args.sender as string).toLowerCase();
    if (sender === this.renewerV1) {
      // Reserved (unmigrated) name: the displayed expiry is v1's, set by the v1 indexer
      return;
    }
    const ensName = await this.findV2Name((args.tokenId as bigint).toString());
    if (!ensName) {
      // Reserved entries (premigration, BatchRegistrar re-syncs) aren't v2 names
      return;
    }
    await this.pool.query(
      'UPDATE ens_names SET expiry_date = $2, updated_at = NOW() WHERE id = $1',
      [ensName.id, new Date(Number(args.newExpiry) * 1000)]
    );
  }

  /** Unregistered: expiry set to now and the token burned. The row stays, now expired. */
  private async handleLabelUnregistered(args: any, log: DecodedLog) {
    const ensName = await this.findV2Name((args.tokenId as bigint).toString());
    if (!ensName) return;
    const blockDate = await this.getBlockTime(log.blockNumber!);
    await this.pool.query(
      'UPDATE ens_names SET expiry_date = $2, updated_at = NOW() WHERE id = $1',
      [ensName.id, blockDate]
    );
    await this.publishStaleOrders(ensName.id, 'unregistered', log);
    logger.info(`ENSv2: ${ensName.name} unregistered`);
  }

  private async handleResolverUpdated(args: any) {
    const ensName = await this.findV2Name((args.tokenId as bigint).toString());
    if (!ensName) return;
    const resolver = (args.resolver as string).toLowerCase();
    await this.pool.query(
      'UPDATE ens_names SET resolver_address = $2, updated_at = NOW() WHERE id = $1',
      [ensName.id, resolver === ZERO_ADDRESS ? null : resolver]
    );
  }

  /**
   * Roles on the name changed, so the token was burned and re-minted under a new ID (same
   * owner). Orders signed against the old ID can no longer be filled.
   */
  private async handleTokenRegenerated(args: any, log: DecodedLog) {
    const oldTokenId = (args.oldTokenId as bigint).toString();
    const newTokenId = (args.newTokenId as bigint).toString();
    const ensName = await this.findV2Name(oldTokenId);
    if (!ensName) {
      logger.warn(`ENSv2 TokenRegenerated: no name for old token ${oldTokenId}, skipping`);
      return;
    }
    await this.pool.query(
      'UPDATE ens_names SET token_id = $2, updated_at = NOW() WHERE id = $1',
      [ensName.id, newTokenId]
    );
    await this.recordTokenId(newTokenId, ensName.id, 'regenerated', log);
    await this.publishStaleOrders(ensName.id, 'token_regenerated', log);
    logger.info(`ENSv2: ${ensName.name} token regenerated ${oldTokenId} -> ${newTokenId}`);
  }

  /**
   * Owner-to-owner transfers. Mints and burns are skipped: registration, regeneration and
   * unregistration are handled by their own events.
   */
  private async handleTransfer(from: string, to: string, ids: bigint[], log: DecodedLog) {
    const fromAddress = from.toLowerCase();
    const toAddress = to.toLowerCase();
    if (fromAddress === ZERO_ADDRESS || toAddress === ZERO_ADDRESS) return;

    const blockDate = await this.getBlockTime(log.blockNumber!);
    for (const id of ids) {
      const tokenId = id.toString();
      const ensName = await this.findV2Name(tokenId);
      if (!ensName) {
        logger.warn(`ENSv2 transfer: no name for token ${tokenId}, skipping`);
        continue;
      }

      await this.pool.query(
        `UPDATE ens_names SET owner_address = $2, registrant = $2, last_transfer_date = $3, updated_at = NOW()
         WHERE id = $1`,
        [ensName.id, toAddress, blockDate]
      );
      await this.insertTransaction(ensName.id, 'transfer', fromAddress, toAddress, log, blockDate);
      await this.publishOwnershipUpdate(ensName.id, toAddress, log);
      logger.info(`ENSv2: ${ensName.name} transferred ${fromAddress} -> ${toAddress}`);
    }
  }

  /** Name row for a v2 token ID, current or superseded. */
  private async findV2Name(tokenId: string): Promise<{ id: number; name: string; labelhash: string | null } | null> {
    const result = await this.pool.query(
      `SELECT id, name, labelhash FROM ens_names
       WHERE token_id = $1 AND ens_version = 2
       UNION ALL
       SELECT en.id, en.name, en.labelhash FROM ens_token_ids t
       JOIN ens_names en ON en.id = t.ens_name_id
       WHERE t.token_contract = $2 AND t.token_id = $1
       LIMIT 1`,
      [tokenId, this.registry]
    );
    return result.rows[0] ?? null;
  }

  private async recordTokenId(tokenId: string, ensNameId: number, reason: string, log: DecodedLog) {
    await this.pool.query(
      `INSERT INTO ens_token_ids (token_contract, token_id, ens_name_id, ens_version, reason, transaction_hash, block_number)
       VALUES ($1, $2, $3, 2, $4, $5, $6)
       ON CONFLICT (token_contract, token_id) DO UPDATE SET ens_name_id = EXCLUDED.ens_name_id`,
      [this.registry, tokenId, ensNameId, reason, log.transactionHash, log.blockNumber!.toString()]
    );
  }

  private async insertActivityOnce(
    ensNameId: number,
    eventType: 'mint' | 'renewal' | 'migrated',
    opts: {
      actor: string;
      log: DecodedLog;
      createdAt: Date;
      platform?: string;
      priceWei?: string;
      currency?: string;
      metadata: Record<string, unknown>;
    }
  ) {
    await this.pool.query(
      `INSERT INTO activity_history (
         ens_name_id, event_type, actor_address, platform, chain_id,
         price_wei, currency_address, transaction_hash, block_number, metadata, created_at
       ) SELECT $1, $2::activity_event_type, $3, $4, $5, $6, $7, $8::varchar, $9, $10, $11
       WHERE NOT EXISTS (
         SELECT 1 FROM activity_history
         WHERE ens_name_id = $1 AND event_type = $2::activity_event_type AND transaction_hash = $8::varchar
       )`,
      [
        ensNameId,
        eventType,
        opts.actor,
        opts.platform || 'blockchain',
        config.blockchain.chainId,
        opts.priceWei ?? null,
        opts.currency ?? null,
        opts.log.transactionHash,
        opts.log.blockNumber!.toString(),
        JSON.stringify(opts.metadata),
        opts.createdAt,
      ]
    );
  }

  private async insertTransaction(
    ensNameId: number,
    type: 'registration' | 'renewal' | 'transfer',
    from: string,
    to: string,
    log: DecodedLog,
    timestamp: Date
  ) {
    await this.pool.query(
      `INSERT INTO transactions (
         ens_name_id, transaction_hash, block_number,
         from_address, to_address, transaction_type, timestamp
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING`,
      [ensNameId, log.transactionHash, log.blockNumber!.toString(), from, to, type, timestamp]
    );
  }

  private async publishOwnershipUpdate(ensNameId: number, newOwner: string, log: DecodedLog) {
    try {
      const { getQueueClient, QUEUE_NAMES } = await import('../queue');
      const boss = await getQueueClient();
      await boss.send(QUEUE_NAMES.UPDATE_OWNERSHIP, {
        ensNameId,
        newOwner,
        blockNumber: Number(log.blockNumber),
        transactionHash: log.transactionHash || '',
      });
    } catch (queueError: any) {
      // Don't fail indexing if queue publishing fails
      logger.error({
        errorMessage: queueError?.message || String(queueError),
        ensNameId
      }, 'Failed to publish ownership update job');
    }
  }

  private async publishStaleOrders(ensNameId: number, reason: string, log: DecodedLog) {
    try {
      const { getQueueClient, QUEUE_NAMES } = await import('../queue');
      const boss = await getQueueClient();
      await boss.send(QUEUE_NAMES.INVALIDATE_STALE_ORDERS, {
        ensNameId,
        reason,
        transactionHash: log.transactionHash || '',
      });
    } catch (queueError: any) {
      // Don't fail indexing; listing validation also catches stale orders
      logger.error({
        errorMessage: queueError?.message || String(queueError),
        ensNameId
      }, 'Failed to publish stale order job');
    }
  }

  private async getV1Expiry(labelhash: `0x${string}`, blockNumber: bigint): Promise<Date | null> {
    try {
      const expires = await this.client.readContract({
        address: config.blockchain.ensRegistrarAddress as `0x${string}`,
        abi: BASE_REGISTRAR_ABI,
        functionName: 'nameExpires',
        args: [BigInt(labelhash)],
        blockNumber,
      });
      return expires > 0n ? new Date(Number(expires) * 1000) : null;
    } catch (error: any) {
      logger.warn(`Could not read v1 expiry for ${labelhash} at block ${blockNumber}: ${error.shortMessage || error.message}`);
      return null;
    }
  }

  private async getBlockTime(blockNumber: bigint): Promise<Date> {
    let date = this.blockTimes.get(blockNumber);
    if (!date) {
      const block = await this.client.getBlock({ blockNumber });
      date = new Date(Number(block.timestamp) * 1000);
      this.blockTimes.set(blockNumber, date);
    }
    return date;
  }

  // The account that sent the tx (the registrant/renewer), which may differ from the owner
  private async getTxSender(hash: string, fallback: string): Promise<string> {
    let sender = this.txSenders.get(hash);
    if (!sender) {
      try {
        const tx = await this.client.getTransaction({ hash: hash as `0x${string}` });
        sender = tx.from.toLowerCase();
        this.txSenders.set(hash, sender);
      } catch (error: any) {
        logger.warn(`Could not fetch transaction ${hash}, using fallback sender: ${error.message}`);
        return fallback;
      }
    }
    return sender;
  }

  private calculateNameAttributes(name: string) {
    return {
      has_numbers: /\d/.test(name),
      has_emoji: hasEmoji(name),
    };
  }

  private static graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  private countGraphemes(label: string): number {
    return [...EnsV2Indexer.graphemeSegmenter.segment(label)].length;
  }

  private async getLastProcessedBlock(): Promise<number> {
    const result = await this.pool.query(
      'SELECT last_processed_block FROM indexer_state WHERE contract_address = $1',
      [this.registry]
    );
    return result.rows.length > 0 ? parseInt(result.rows[0].last_processed_block) : 0;
  }

  private async updateLastProcessedBlock(blockNumber: bigint) {
    await this.pool.query(
      `INSERT INTO indexer_state (contract_address, last_processed_block)
       VALUES ($1, $2)
       ON CONFLICT (contract_address) DO UPDATE
       SET last_processed_block = EXCLUDED.last_processed_block,
           last_processed_timestamp = NOW(),
           updated_at = NOW()`,
      [this.registry, blockNumber.toString()]
    );
  }
}
