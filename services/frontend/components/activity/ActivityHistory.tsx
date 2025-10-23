'use client';

import { useState, useEffect } from 'react';
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

interface ActivityHistoryProps {
  name?: string;
  address?: string;
  limit?: number;
  showFilters?: boolean;
}

const EVENT_LABELS: Record<string, string> = {
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

const EVENT_COLORS: Record<string, string> = {
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

const EVENT_ICONS: Record<string, string> = {
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

export function ActivityHistory({ name, address, limit = 20, showFilters = false }: ActivityHistoryProps) {
  const [activities, setActivities] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [eventTypeFilter, setEventTypeFilter] = useState<string[]>([]);

  useEffect(() => {
    const fetchActivity = async () => {
      setLoading(true);
      setError(null);

      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002/api/v1';

        // Build query params
        const params = new URLSearchParams();
        params.append('limit', limit.toString());

        // Add event type filters if any
        eventTypeFilter.forEach(type => {
          params.append('event_type', type);
        });

        let url = `${apiUrl}/activity`;
        if (name) {
          url = `${apiUrl}/activity/${name}?${params.toString()}`;
        } else if (address) {
          url = `${apiUrl}/activity/address/${address}?${params.toString()}`;
        } else {
          url = `${apiUrl}/activity?${params.toString()}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
          throw new Error('Failed to fetch activity');
        }

        const data = await response.json();
        setActivities(data.data || []);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchActivity();
  }, [name, address, limit, eventTypeFilter]);

  const formatAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const getRelativeTime = (timestamp: string) => {
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
  };

  const toggleEventType = (eventType: string) => {
    setEventTypeFilter(prev =>
      prev.includes(eventType)
        ? prev.filter(t => t !== eventType)
        : [...prev, eventType]
    );
  };

  if (loading) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <div className="animate-pulse space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-gray-700 rounded"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-gray-800 rounded-lg p-6">
        <p className="text-red-400">Error loading activity: {error}</p>
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="bg-gray-800 rounded-lg p-6 text-center">
        <p className="text-gray-400">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="bg-gray-800 rounded-lg">
      <div className="p-4 border-b border-gray-700">
        <h3 className="text-lg font-semibold text-white">Activity</h3>
      </div>

      {showFilters && (
        <div className="p-4 border-b border-gray-700">
          <div className="flex flex-wrap gap-2">
            <span className="text-sm text-gray-400 mr-2">Filter:</span>
            {Object.entries(EVENT_LABELS).map(([type, label]) => (
              <button
                key={type}
                onClick={() => toggleEventType(type)}
                className={`px-3 py-1 text-xs rounded-full transition ${
                  eventTypeFilter.includes(type)
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                }`}
              >
                {EVENT_ICONS[type as keyof typeof EVENT_ICONS]} {label}
              </button>
            ))}
            {eventTypeFilter.length > 0 && (
              <button
                onClick={() => setEventTypeFilter([])}
                className="px-3 py-1 text-xs rounded-full bg-red-900/50 text-red-300 hover:bg-red-900 transition"
              >
                Clear Filters
              </button>
            )}
          </div>
        </div>
      )}

      <div className="divide-y divide-gray-700">
        {activities.map((activity) => (
          <div key={activity.id} className="p-4 hover:bg-gray-750 transition">
            <div className="flex items-start gap-3">
              <div className="text-2xl">{EVENT_ICONS[activity.event_type]}</div>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className={`font-semibold ${EVENT_COLORS[activity.event_type]}`}>
                    {EVENT_LABELS[activity.event_type] || activity.event_type || 'Unknown'}
                  </span>
                  {name ? null : (
                    <a
                      href={`/names/${activity.name}`}
                      className="text-purple-400 hover:text-purple-300 font-medium truncate"
                    >
                      {activity.name}
                    </a>
                  )}
                  {activity.price_wei && (
                    <span className="text-gray-300 font-medium">
                      for {formatCurrencyAmount(activity.price_wei, activity.currency_address)}
                    </span>
                  )}
                </div>

                <div className="mt-1 flex items-center gap-3 text-sm text-gray-400">
                  <span>by {formatAddress(activity.actor_address)}</span>
                  {activity.counterparty_address && (
                    <>
                      <span>•</span>
                      <span>to {formatAddress(activity.counterparty_address)}</span>
                    </>
                  )}
                  <span>•</span>
                  <span className="capitalize">{activity.platform}</span>
                  <span>•</span>
                  <span>{getRelativeTime(activity.created_at)}</span>
                </div>

                {activity.transaction_hash && (
                  <div className="mt-1">
                    <a
                      href={`https://etherscan.io/tx/${activity.transaction_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-gray-500 hover:text-gray-400"
                    >
                      View on Etherscan →
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
