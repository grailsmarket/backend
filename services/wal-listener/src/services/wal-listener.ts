import { Client } from 'pg';
import { config, getPostgresPool } from '../../../shared/src';
import { ElasticsearchSync } from './elasticsearch-sync';
import { ActivityHistoryService } from './activity-history';
import { logger } from '../utils/logger';
import { LogicalReplicationService, PgoutputPlugin } from 'pg-logical-replication';

interface Change {
  table: string;
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  data?: any;
  oldData?: any;
}

export class WALListener {
  private replicationService: LogicalReplicationService | null = null;
  private client: Client | null = null;
  private isRunning = false;
  private pool = getPostgresPool();
  private activityHistory: ActivityHistoryService;

  constructor(private esSync: ElasticsearchSync) {
    this.activityHistory = new ActivityHistoryService();
  }

  async start() {
    logger.info('Starting WAL listener...');
    this.isRunning = true;

    await this.setupReplication();
    await this.startListening();
  }

  async stop() {
    logger.info('Stopping WAL listener...');
    this.isRunning = false;

    if (this.replicationService) {
      await this.replicationService.stop();
      this.replicationService = null;
    }

    if (this.client) {
      await this.client.end();
      this.client = null;
    }
  }

  private async setupReplication() {
    this.client = new Client({
      connectionString: config.database.url,
    });

    await this.client.connect();

    // Check if replication slot exists, create if not
    const slotQuery = `
      SELECT slot_name
      FROM pg_replication_slots
      WHERE slot_name = 'elasticsearch_sync'
    `;

    const slotResult = await this.client.query(slotQuery);

    if (slotResult.rows.length === 0) {
      try {
        await this.client.query(`
          SELECT pg_create_logical_replication_slot('elasticsearch_sync', 'pgoutput')
        `);
        logger.info('Created replication slot: elasticsearch_sync');
      } catch (error: any) {
        logger.error('Failed to create replication slot:', error);
        throw error;
      }
    } else {
      logger.info('Replication slot already exists');
    }

    // Check if publication exists, create if not
    const pubQuery = `
      SELECT pubname
      FROM pg_publication
      WHERE pubname = 'elasticsearch_pub'
    `;

    const pubResult = await this.client.query(pubQuery);

    if (pubResult.rows.length === 0) {
      try {
        await this.client.query(`
          CREATE PUBLICATION elasticsearch_pub FOR TABLE ens_names, listings, offers
        `);
        logger.info('Created publication: elasticsearch_pub');
      } catch (error: any) {
        logger.error('Failed to create publication:', error);
        throw error;
      }
    } else {
      logger.info('Publication already exists');
    }

    // Also perform initial bulk sync
    await this.performInitialSync();
  }

  private async performInitialSync() {
    logger.info('Performing initial bulk sync to Elasticsearch...');
    await this.esSync.bulkSync();
    logger.info('Initial bulk sync completed');
  }

  private async startListening() {
    if (!this.isRunning) return;

    // Try trigger-based CDC first, fall back to polling if it fails
    try {
      await this.setupTriggerBasedCDC();
    } catch (error) {
      logger.error('Trigger-based CDC failed, using polling instead');
      await this.startPolling();
    }
  }

  private async startPolling() {
    logger.info('Starting change detection polling...');

    // Track last processed timestamps for each table
    const lastProcessed: Record<string, Date> = {
      ens_names: new Date(),
      listings: new Date(),
      offers: new Date(),
    };

    const pollInterval = 5000; // 5 seconds

    const poll = async () => {
      if (!this.isRunning) return;

      try {
        // Check for changes in ens_names
        const ensChanges = await this.pool.query(
          `SELECT * FROM ens_names WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT 100`,
          [lastProcessed.ens_names]
        );

        for (const row of ensChanges.rows) {
          await this.processChange({
            table: 'ens_names',
            operation: 'UPDATE',
            data: row,
          });
          lastProcessed.ens_names = row.updated_at;
        }

        // Check for changes in listings
        const listingChanges = await this.pool.query(
          `SELECT * FROM listings WHERE updated_at > $1 ORDER BY updated_at ASC LIMIT 100`,
          [lastProcessed.listings]
        );

        for (const row of listingChanges.rows) {
          // Determine if this is an INSERT or UPDATE based on created_at vs updated_at
          const isInsert = row.created_at && row.updated_at &&
            Math.abs(new Date(row.created_at).getTime() - new Date(row.updated_at).getTime()) < 1000; // Within 1 second

          await this.processChange({
            table: 'listings',
            operation: isInsert ? 'INSERT' : 'UPDATE',
            data: row,
            oldData: isInsert ? undefined : row, // For updates, we'll use current data as old data
          });
          lastProcessed.listings = row.updated_at;
        }

        // Check for changes in offers
        const offerChanges = await this.pool.query(
          `SELECT * FROM offers WHERE created_at > $1 ORDER BY created_at ASC LIMIT 100`,
          [lastProcessed.offers]
        );

        for (const row of offerChanges.rows) {
          await this.processChange({
            table: 'offers',
            operation: 'INSERT',
            data: row,
          });
          lastProcessed.offers = row.created_at;
        }

      } catch (error) {
        logger.error('Error during polling:', error);
      }

      if (this.isRunning) {
        setTimeout(poll, pollInterval);
      }
    };

    // Start polling
    poll();
  }

  private async processChange(change: Change) {
    logger.info(`Processing ${change.operation} on ${change.table}`, {
      table: change.table,
      operation: change.operation,
      dataId: change.data?.id
    });

    try {
      switch (change.table) {
        case 'ens_names':
          await this.processENSNameChange(change);
          break;
        case 'listings':
          await this.processListingChange(change);
          break;
        case 'offers':
          await this.processOfferChange(change);
          break;
      }
    } catch (error) {
      logger.error(`Failed to process change for ${change.table}:`, error);
    }
  }

  private async processENSNameChange(change: Change) {
    const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

    switch (change.operation) {
      case 'INSERT':
        await this.esSync.indexENSName(change.data);

        // Check if this is a mint (first registration)
        if (change.data?.owner_address && change.data.owner_address.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
          try {
            await this.activityHistory.handleMint({
              ens_name_id: change.data.id,
              recipient_address: change.data.owner_address,
              token_id: change.data.token_id,
              transaction_hash: change.data.transaction_hash,
              block_number: change.data.block_number,
            });
          } catch (error) {
            logger.error('Failed to create mint activity record:', error);
          }
        }
        break;

      case 'UPDATE':
        await this.esSync.indexENSName(change.data);

        // Check for ownership transfer
        if (change.oldData && change.data) {
          const oldOwner = change.oldData.owner_address?.toLowerCase();
          const newOwner = change.data.owner_address?.toLowerCase();

          // Only process if owner actually changed
          if (oldOwner !== newOwner) {
            try {
              // Check for mint (from zero address)
              if (oldOwner === ZERO_ADDRESS.toLowerCase() && newOwner !== ZERO_ADDRESS.toLowerCase()) {
                await this.activityHistory.handleMint({
                  ens_name_id: change.data.id,
                  recipient_address: change.data.owner_address,
                  token_id: change.data.token_id,
                  transaction_hash: change.data.transaction_hash,
                  block_number: change.data.block_number,
                });
              }
              // Check for burn (to zero address)
              else if (newOwner === ZERO_ADDRESS.toLowerCase() && oldOwner !== ZERO_ADDRESS.toLowerCase()) {
                await this.activityHistory.handleBurn({
                  ens_name_id: change.data.id,
                  sender_address: change.oldData.owner_address,
                  token_id: change.data.token_id,
                  transaction_hash: change.data.transaction_hash,
                  block_number: change.data.block_number,
                });
              }
              // Regular transfer between two addresses
              else if (oldOwner !== ZERO_ADDRESS.toLowerCase() && newOwner !== ZERO_ADDRESS.toLowerCase()) {
                await this.activityHistory.handleTransfer({
                  ens_name_id: change.data.id,
                  from_address: change.oldData.owner_address,
                  to_address: change.data.owner_address,
                  token_id: change.data.token_id,
                  transaction_hash: change.data.transaction_hash,
                  block_number: change.data.block_number,
                });
              }
            } catch (error) {
              logger.error('Failed to create transfer activity record:', error);
            }
          }
        }
        break;

      case 'DELETE':
        await this.esSync.deleteENSName(change.oldData?.id || change.data?.id);
        break;
    }
  }

  private async processListingChange(change: Change) {
    // When a listing changes, we need to update the associated ENS name in ES
    if (change.data?.ens_name_id || change.oldData?.ens_name_id) {
      const ensNameId = change.data?.ens_name_id || change.oldData?.ens_name_id;
      await this.esSync.updateENSNameListing(ensNameId);
    }

    // Track activity history based on operation
    try {
      switch (change.operation) {
        case 'INSERT':
          // New listing created
          if (change.data && change.data.status === 'active') {
            await this.activityHistory.handleListingCreated(change.data);

            // Publish notification jobs for watchers
            await this.publishNotificationsForListing(change.data, 'new-listing');
          }
          break;

        case 'UPDATE':
          // Check for various update scenarios
          if (change.oldData && change.data) {
            // Listing price updated
            if (change.oldData.price_wei !== change.data.price_wei && change.data.status === 'active') {
              await this.activityHistory.handleListingUpdated(change.oldData, change.data);
            }

            // Listing cancelled
            if (change.oldData.status === 'active' && change.data.status === 'cancelled') {
              await this.activityHistory.handleListingCancelled(change.data);
            }

            // Listing fulfilled (sold)
            if (change.oldData.status === 'active' && change.data.status === 'sold') {
              // We need to get the buyer address from somewhere
              // This might be in metadata or we might need to join with a transaction table
              const buyerAddress = change.data.buyer_address || change.data.metadata?.buyer_address;
              if (buyerAddress) {
                await this.activityHistory.handleListingFulfilled(
                  change.data,
                  buyerAddress,
                  change.data.transaction_hash
                );
              }
            }
          }
          break;

        case 'DELETE':
          // Listing deleted (treat as cancelled if it was active)
          if (change.oldData?.status === 'active') {
            await this.activityHistory.handleListingCancelled(change.oldData);
          }
          break;
      }
    } catch (error) {
      logger.error('Failed to create activity history for listing change:', error);
    }
  }

  private async processOfferChange(change: Change) {
    // When an offer changes, we might want to update analytics in ES
    if (change.data?.ens_name_id || change.oldData?.ens_name_id) {
      const ensNameId = change.data?.ens_name_id || change.oldData?.ens_name_id;
      await this.esSync.updateENSNameOffers(ensNameId);
    }

    // Track activity history based on operation
    try {
      switch (change.operation) {
        case 'INSERT':
          // New offer created
          if (change.data && change.data.status === 'pending') {
            await this.activityHistory.handleOfferCreated(change.data);

            // Publish notification jobs for watchers
            await this.publishNotificationsForOffer(change.data);
          }
          break;

        case 'UPDATE':
          // Check for various update scenarios
          if (change.oldData && change.data) {
            // Offer accepted
            if (change.oldData.status === 'pending' && change.data.status === 'accepted') {
              // We need to get the seller address (current owner)
              // This might require a lookup to the ens_names table
              const sellerAddress = change.data.seller_address || change.data.metadata?.seller_address;
              if (sellerAddress) {
                await this.activityHistory.handleOfferAccepted(change.data, sellerAddress);
              } else {
                // If we don't have seller address in the offer data, fetch it from ens_names
                try {
                  const result = await this.pool.query(
                    'SELECT owner_address FROM ens_names WHERE id = $1',
                    [change.data.ens_name_id]
                  );
                  if (result.rows.length > 0) {
                    await this.activityHistory.handleOfferAccepted(change.data, result.rows[0].owner_address);
                  }
                } catch (err) {
                  logger.error('Failed to fetch owner address for offer acceptance:', err);
                }
              }
            }

            // Offer cancelled or rejected
            if (
              change.oldData.status === 'pending' &&
              (change.data.status === 'cancelled' || change.data.status === 'rejected')
            ) {
              await this.activityHistory.handleOfferCancelled(change.data);
            }
          }
          break;

        case 'DELETE':
          // Offer deleted (treat as cancelled if it was pending)
          if (change.oldData?.status === 'pending') {
            await this.activityHistory.handleOfferCancelled(change.oldData);
          }
          break;
      }
    } catch (error) {
      logger.error('Failed to create activity history for offer change:', error);
    }
  }

  // Alternative: Use LISTEN/NOTIFY for real-time updates
  async setupTriggerBasedCDC() {
    logger.info('Setting up trigger-based CDC with LISTEN/NOTIFY...');

    // Create a notification function
    const createFunctionQuery = `
      CREATE OR REPLACE FUNCTION notify_changes() RETURNS trigger AS $$
      DECLARE
        payload json;
      BEGIN
        payload = json_build_object(
          'table', TG_TABLE_NAME,
          'operation', TG_OP,
          'data', row_to_json(NEW),
          'old_data', row_to_json(OLD)
        );
        PERFORM pg_notify('table_changes', payload::text);
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `;

    // Create triggers for each table
    const tables = ['ens_names', 'listings', 'offers'];

    // Ensure we have a database connection
    if (!this.client) {
      throw new Error('Database client not initialized');
    }

    try {
      await this.client.query(createFunctionQuery);
      logger.info('Created notification function');

      for (const table of tables) {
        const dropTriggerQuery = `DROP TRIGGER IF EXISTS notify_${table}_changes ON ${table}`;
        const createTriggerQuery = `
          CREATE TRIGGER notify_${table}_changes
          AFTER INSERT OR UPDATE OR DELETE ON ${table}
          FOR EACH ROW EXECUTE FUNCTION notify_changes();
        `;

        try {
          await this.client.query(dropTriggerQuery);
          await this.client.query(createTriggerQuery);
          logger.info(`Created trigger for table: ${table}`);
        } catch (tableError: any) {
          logger.error(`Failed to create trigger for ${table}:`, tableError?.message);
          throw tableError;
        }
      }

      // Listen for changes
      await this.client!.query('LISTEN table_changes');

      this.client!.on('notification', async (msg) => {
        try {
          const payload = JSON.parse(msg.payload || '{}');
          await this.processChange({
            table: payload.table,
            operation: payload.operation,
            data: payload.data,
            oldData: payload.old_data,
          });
        } catch (error) {
          logger.error('Error processing notification:', error);
        }
      });

      logger.info('Trigger-based CDC setup complete');
    } catch (error: any) {
      logger.error('Failed to setup trigger-based CDC:', error?.message || error);
      if (error?.stack) {
        logger.error('Stack trace:', error.stack);
      }
      // Fall back to polling
      logger.info('Falling back to polling-based sync...');
      await this.startPolling();
    }
  }

  /**
   * Publish notification jobs for users watching this listing's ENS name
   */
  private async publishNotificationsForListing(listingData: any, notificationType: 'new-listing' | 'price-change' | 'sale') {
    try {
      const { getQueueClient, QUEUE_NAMES } = await import('../queue');
      const boss = await getQueueClient();

      // Find all users watching this ENS name with the appropriate notification setting
      const watchlistQuery = `
        SELECT w.user_id, u.email, w.notify_on_listing, w.notify_on_price_change, w.notify_on_sale
        FROM watchlist w
        JOIN users u ON u.id = w.user_id
        WHERE w.ens_name_id = $1
      `;

      const watchers = await this.pool.query(watchlistQuery, [listingData.ens_name_id]);

      for (const watcher of watchers.rows) {
        // Check if user wants this type of notification
        const shouldNotify =
          (notificationType === 'new-listing' && watcher.notify_on_listing) ||
          (notificationType === 'price-change' && watcher.notify_on_price_change) ||
          (notificationType === 'sale' && watcher.notify_on_sale);

        if (!shouldNotify) {
          continue;
        }

        await boss.send(QUEUE_NAMES.SEND_NOTIFICATION, {
          type: notificationType,
          userId: watcher.user_id,
          email: watcher.email,
          ensNameId: listingData.ens_name_id,
          metadata: {
            priceWei: listingData.price_wei,
            sellerAddress: listingData.seller_address,
            listingId: listingData.id,
          },
        });
      }

      if (watchers.rows.length > 0) {
        logger.info(
          { ensNameId: listingData.ens_name_id, watchersCount: watchers.rows.length, notificationType },
          'Published notification jobs for listing change'
        );
      } else {
        logger.info(
          { ensNameId: listingData.ens_name_id, notificationType },
          'No watchers found for listing change'
        );
      }
    } catch (error: any) {
      logger.error({
        error: error?.message || String(error),
        errorStack: error?.stack,
        errorCode: error?.code,
        listingData
      }, 'Failed to publish listing notifications');
    }
  }

  /**
   * Publish notification jobs for users watching this offer's ENS name
   */
  private async publishNotificationsForOffer(offerData: any) {
    try {
      const { getQueueClient, QUEUE_NAMES } = await import('../queue');
      const boss = await getQueueClient();

      // Find all users watching this ENS name who want offer notifications
      const watchlistQuery = `
        SELECT w.user_id, u.email
        FROM watchlist w
        JOIN users u ON u.id = w.user_id
        WHERE w.ens_name_id = $1
          AND w.notify_on_offer = true
      `;

      const watchers = await this.pool.query(watchlistQuery, [offerData.ens_name_id]);

      for (const watcher of watchers.rows) {
        await boss.send(QUEUE_NAMES.SEND_NOTIFICATION, {
          type: 'new-offer',
          userId: watcher.user_id,
          email: watcher.email,
          ensNameId: offerData.ens_name_id,
          metadata: {
            offerAmountWei: offerData.offer_amount_wei,
            buyerAddress: offerData.buyer_address,
            offerId: offerData.id,
          },
        });
      }

      if (watchers.rows.length > 0) {
        logger.debug(
          { ensNameId: offerData.ens_name_id, watchersCount: watchers.rows.length },
          'Published notification jobs for new offer'
        );
      }
    } catch (error) {
      logger.error({ error, offerData }, 'Failed to publish offer notifications');
    }
  }
}