'use client';

import { useState, useEffect, useRef } from 'react';
import { ActivityHistory } from '@/components/activity/ActivityHistory';
import { formatCurrencyAmount } from '@/lib/currency';

interface ActivityEvent {
  id: number;
  ens_name_id: number;
  name: string;
  token_id: string;
  event_type: 'listed' | 'offer_made' | 'bought' | 'sold' | 'offer_accepted' | 'cancelled' | 'mint' | 'burn' | 'sent' | 'received';
  actor_address: string;
  counterparty_address?: string;
  platform: string;
  chain_id: number;
  price_wei?: string;
  currency_address?: string;
  transaction_hash?: string;
  block_number?: number;
  metadata?: any;
  created_at: string;
}

export default function ActivityPage() {
  const [liveActivities, setLiveActivities] = useState<ActivityEvent[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    // Connect to WebSocket for live activity updates
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
    // Remove /api/v1 suffix if present
    const baseUrl = apiUrl.replace(/\/api\/v1$/, '');
    const wsUrl = baseUrl
      .replace('http://', 'ws://')
      .replace('https://', 'wss://');

    const ws = new WebSocket(`${wsUrl}/ws/activity`);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('Activity WebSocket connected');
      setIsConnected(true);

      // Subscribe to all activity
      ws.send(JSON.stringify({
        type: 'subscribe_all'
      }));
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);

        if (message.type === 'activity_event') {
          console.log('Received activity event:', message.data);

          // Add new activity to the top of the list
          setLiveActivities(prev => [message.data, ...prev].slice(0, 50)); // Keep max 50 live events
        } else if (message.type === 'subscribed') {
          console.log('Subscribed to:', message.subscription_type);
        }
      } catch (error) {
        console.error('Error parsing WebSocket message:', error);
      }
    };

    ws.onerror = (error) => {
      console.log('WebSocket error:', error);
      setIsConnected(false);
    };

    ws.onclose = () => {
      console.log('Activity WebSocket disconnected');
      setIsConnected(false);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'unsubscribe_all' }));
      }
      ws.close();
    };
  }, []);

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-white mb-2">Platform Activity</h1>
        <p className="text-gray-400">
          Real-time activity feed for all ENS marketplace events
        </p>
        <div className="mt-2 flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`}></div>
          <span className="text-sm text-gray-400">
            {isConnected ? 'Live updates connected' : 'Disconnected'}
          </span>
        </div>
      </div>

      {/* Live Activity Section */}
      {liveActivities.length > 0 && (
        <div className="mb-8">
          <div className="bg-gray-800 rounded-lg p-4 mb-4">
            <h2 className="text-lg font-semibold text-white mb-2 flex items-center gap-2">
              <span className="inline-block w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
              Live Activity
            </h2>
            <p className="text-sm text-gray-400">
              {liveActivities.length} recent event{liveActivities.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="bg-gray-800 rounded-lg divide-y divide-gray-700">
            {liveActivities.map((activity) => (
              <div key={`live-${activity.id}`} className="p-4 hover:bg-gray-750 transition animate-fade-in">
                <div className="flex items-start gap-3">
                  <div className="text-2xl">{getEventIcon(activity.event_type)}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className={`font-semibold ${getEventColor(activity.event_type)}`}>
                        {getEventLabel(activity.event_type)}
                      </span>
                      <a
                        href={`/names/${activity.name}`}
                        className="text-purple-400 hover:text-purple-300 font-medium truncate"
                      >
                        {activity.name}
                      </a>
                      {activity.price_wei && (
                        <span className="text-gray-300 font-medium">
                          for {formatCurrencyAmount(activity.price_wei, activity.currency_address)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-sm text-gray-400">
                      <span>by {formatAddress(activity.actor_address)}</span>
                      <span>•</span>
                      <span className="capitalize">{activity.platform}</span>
                      <span>•</span>
                      <span>{getRelativeTime(activity.created_at)}</span>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Historical Activity */}
      <div>
        <ActivityHistory showFilters={true} limit={50} />
      </div>
    </div>
  );
}

function formatAddress(addr: string) {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function getRelativeTime(timestamp: string) {
  const date = Date.parse(timestamp);
  const now = Date.now();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return new Date(date).toLocaleDateString();
}

function getEventIcon(eventType: string) {
  const icons: Record<string, string> = {
    listed: '📋',
    offer_made: '💰',
    bought: '🛒',
    sold: '✅',
    offer_accepted: '🤝',
    cancelled: '❌',
    mint: '🎨',
    burn: '🔥',
    sent: '📤',
    received: '📥',
  };
  return icons[eventType] || '📝';
}

function getEventLabel(eventType: string) {
  const labels: Record<string, string> = {
    listed: 'Listed',
    offer_made: 'Offer Made',
    bought: 'Bought',
    sold: 'Sold',
    offer_accepted: 'Offer Accepted',
    cancelled: 'Cancelled',
    mint: 'Minted',
    burn: 'Burned',
    sent: 'Sent',
    received: 'Received',
  };
  return labels[eventType] || eventType;
}

function getEventColor(eventType: string) {
  const colors: Record<string, string> = {
    listed: 'text-blue-400',
    offer_made: 'text-purple-400',
    bought: 'text-green-400',
    sold: 'text-green-400',
    offer_accepted: 'text-emerald-400',
    cancelled: 'text-red-400',
    mint: 'text-cyan-400',
    burn: 'text-orange-400',
    sent: 'text-indigo-400',
    received: 'text-teal-400',
  };
  return colors[eventType] || 'text-gray-400';
}
