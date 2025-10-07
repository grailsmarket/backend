import { FastifyInstance } from 'fastify';
import { WebSocket } from 'ws';

interface WSClient {
  id: string;
  ws: WebSocket;
  subscriptions: Set<string>;
}

interface ActivityWSClient {
  id: string;
  ws: WebSocket;
  addressSubscriptions: Set<string>; // Set of addresses to watch
  nameSubscriptions: Set<string>;     // Set of ENS names to watch
}

const clients = new Map<string, WSClient>();
const activityClients = new Map<string, ActivityWSClient>();

export async function websocketRoutes(fastify: FastifyInstance) {
  fastify.get('/events', { websocket: true }, (connection, req) => {
    const clientId = req.id;
    const client: WSClient = {
      id: clientId,
      ws: connection.socket as WebSocket,
      subscriptions: new Set(),
    };

    clients.set(clientId, client);

    connection.socket.send(JSON.stringify({
      type: 'connected',
      clientId,
      timestamp: new Date().toISOString(),
    }));

    connection.socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        handleMessage(client, data);
      } catch (error) {
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    });

    connection.socket.on('close', () => {
      clients.delete(clientId);
    });

    connection.socket.on('error', (error) => {
      req.log.error({ error }, 'WebSocket error');
      clients.delete(clientId);
    });
  });

  fastify.get('/orders', { websocket: true }, (connection, req) => {
    const clientId = req.id;

    connection.socket.send(JSON.stringify({
      type: 'connected',
      channel: 'orders',
      clientId,
      timestamp: new Date().toISOString(),
    }));

    connection.socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'subscribe') {
          connection.socket.send(JSON.stringify({
            type: 'subscribed',
            orderId: data.orderId,
            timestamp: new Date().toISOString(),
          }));
        }
      } catch (error) {
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    });

    connection.socket.on('close', () => {
      req.log.info(`WebSocket closed: ${clientId}`);
    });
  });

  fastify.get('/activity', { websocket: true }, (connection, req) => {
    const clientId = req.id;
    const client: ActivityWSClient = {
      id: clientId,
      ws: connection.socket as WebSocket,
      addressSubscriptions: new Set(),
      nameSubscriptions: new Set(),
    };

    activityClients.set(clientId, client);

    connection.socket.send(JSON.stringify({
      type: 'connected',
      channel: 'activity',
      clientId,
      timestamp: new Date().toISOString(),
    }));

    connection.socket.on('message', (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        handleActivityMessage(client, data);
      } catch (error) {
        connection.socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format',
        }));
      }
    });

    connection.socket.on('close', () => {
      activityClients.delete(clientId);
      req.log.info(`Activity WebSocket closed: ${clientId}`);
    });

    connection.socket.on('error', (error) => {
      req.log.error({ error }, 'Activity WebSocket error');
      activityClients.delete(clientId);
    });
  });
}

function handleMessage(client: WSClient, data: any) {
  switch (data.type) {
    case 'subscribe':
      if (data.event) {
        client.subscriptions.add(data.event);
        client.ws.send(JSON.stringify({
          type: 'subscribed',
          event: data.event,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'unsubscribe':
      if (data.event) {
        client.subscriptions.delete(data.event);
        client.ws.send(JSON.stringify({
          type: 'unsubscribed',
          event: data.event,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'ping':
      client.ws.send(JSON.stringify({
        type: 'pong',
        timestamp: new Date().toISOString(),
      }));
      break;

    default:
      client.ws.send(JSON.stringify({
        type: 'error',
        message: `Unknown message type: ${data.type}`,
      }));
  }
}

export function broadcastEvent(event: string, data: any) {
  clients.forEach(client => {
    if (client.subscriptions.has(event)) {
      client.ws.send(JSON.stringify({
        type: 'event',
        event,
        data,
        timestamp: new Date().toISOString(),
      }));
    }
  });
}

export function broadcastToAll(data: any) {
  clients.forEach(client => {
    client.ws.send(JSON.stringify({
      type: 'broadcast',
      data,
      timestamp: new Date().toISOString(),
    }));
  });
}

function handleActivityMessage(client: ActivityWSClient, data: any) {
  switch (data.type) {
    case 'subscribe_address':
      if (data.address) {
        const normalizedAddress = data.address.toLowerCase();
        client.addressSubscriptions.add(normalizedAddress);
        client.ws.send(JSON.stringify({
          type: 'subscribed',
          subscription_type: 'address',
          address: normalizedAddress,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'unsubscribe_address':
      if (data.address) {
        const normalizedAddress = data.address.toLowerCase();
        client.addressSubscriptions.delete(normalizedAddress);
        client.ws.send(JSON.stringify({
          type: 'unsubscribed',
          subscription_type: 'address',
          address: normalizedAddress,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'subscribe_name':
      if (data.name) {
        client.nameSubscriptions.add(data.name);
        client.ws.send(JSON.stringify({
          type: 'subscribed',
          subscription_type: 'name',
          name: data.name,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'unsubscribe_name':
      if (data.name) {
        client.nameSubscriptions.delete(data.name);
        client.ws.send(JSON.stringify({
          type: 'unsubscribed',
          subscription_type: 'name',
          name: data.name,
          timestamp: new Date().toISOString(),
        }));
      }
      break;

    case 'ping':
      client.ws.send(JSON.stringify({
        type: 'pong',
        timestamp: new Date().toISOString(),
      }));
      break;

    default:
      client.ws.send(JSON.stringify({
        type: 'error',
        message: `Unknown message type: ${data.type}`,
      }));
  }
}

/**
 * Broadcast activity event to all subscribed clients
 * @param activityData Activity history record data
 */
export function broadcastActivityEvent(activityData: any) {
  const {
    actor_address,
    counterparty_address,
    name,
    event_type,
  } = activityData;

  activityClients.forEach(client => {
    let shouldSend = false;

    // Check if client is subscribed to the actor address
    if (actor_address && client.addressSubscriptions.has(actor_address.toLowerCase())) {
      shouldSend = true;
    }

    // Check if client is subscribed to the counterparty address
    if (counterparty_address && client.addressSubscriptions.has(counterparty_address.toLowerCase())) {
      shouldSend = true;
    }

    // Check if client is subscribed to the ENS name
    if (name && client.nameSubscriptions.has(name)) {
      shouldSend = true;
    }

    if (shouldSend) {
      try {
        client.ws.send(JSON.stringify({
          type: 'activity_event',
          event_type,
          data: activityData,
          timestamp: new Date().toISOString(),
        }));
      } catch (error) {
        console.error('Error sending activity event to client:', error);
      }
    }
  });
}