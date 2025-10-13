'use client';

interface ViewToggleProps {
  view: 'grid' | 'table';
  onViewChange: (view: 'grid' | 'table') => void;
}

export function ViewToggle({ view, onViewChange }: ViewToggleProps) {
  return (
    <div className="flex gap-2 bg-gray-800 rounded-lg p-1 border border-gray-700">
      <button
        onClick={() => onViewChange('grid')}
        className={`flex items-center gap-2 px-4 py-2 rounded-md transition ${
          view === 'grid'
            ? 'bg-purple-600 text-white'
            : 'text-gray-400 hover:text-white hover:bg-gray-700'
        }`}
        aria-label="Grid view"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"
          />
        </svg>
        <span className="hidden sm:inline">Grid</span>
      </button>
      <button
        onClick={() => onViewChange('table')}
        className={`flex items-center gap-2 px-4 py-2 rounded-md transition ${
          view === 'table'
            ? 'bg-purple-600 text-white'
            : 'text-gray-400 hover:text-white hover:bg-gray-700'
        }`}
        aria-label="Table view"
      >
        <svg
          className="h-5 w-5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 6h16M4 10h16M4 14h16M4 18h16"
          />
        </svg>
        <span className="hidden sm:inline">Table</span>
      </button>
    </div>
  );
}
