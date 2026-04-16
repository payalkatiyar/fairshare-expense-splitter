'use client';

import { useApp } from '@/lib/app-context';
import { Home, Users, Activity, User } from 'lucide-react';

export function Navigation() {
  const { screen, setScreen, currentUser } = useApp();

  if (!currentUser || ['login'].includes(screen)) {
    return null;
  }

  const isActive = (screenName: string) => screen === screenName || screen.startsWith(screenName);

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-card border-t border-border max-w-lg mx-auto">
      <div className="flex items-center justify-around">
        <button
          onClick={() => setScreen('dashboard')}
          className={`flex-1 flex flex-col items-center justify-center py-4 gap-1 transition ${
            isActive('dashboard')
              ? 'text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Home size={24} />
          <span className="text-xs font-semibold">Home</span>
        </button>

        <button
          onClick={() => setScreen('groups')}
          className={`flex-1 flex flex-col items-center justify-center py-4 gap-1 transition ${
            isActive('groups') || isActive('group-detail') || isActive('add-expense') || isActive('settlements')
              ? 'text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Users size={24} />
          <span className="text-xs font-semibold">Groups</span>
        </button>

        <button
          onClick={() => setScreen('activity')}
          className={`flex-1 flex flex-col items-center justify-center py-4 gap-1 transition ${
            isActive('activity')
              ? 'text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <Activity size={24} />
          <span className="text-xs font-semibold">Activity</span>
        </button>

        <button
          onClick={() => setScreen('general-settings')}
          className={`flex-1 flex flex-col items-center justify-center py-4 gap-1 transition ${
            isActive('general-settings')
              ? 'text-primary'
              : 'text-muted-foreground hover:text-foreground'
          }`}
        >
          <User size={24} />
          <span className="text-xs font-semibold">Profile</span>
        </button>
      </div>
    </nav>
  );
}
