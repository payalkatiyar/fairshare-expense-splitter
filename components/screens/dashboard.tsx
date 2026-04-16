'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/lib/app-context';
import { getUserTotalBalance, getUserGroupBalance } from '@/lib/expense-utils';
import { supabase, Group, User } from '@/lib/supabase';
import { getUserProfile } from '@/lib/auth-utils';
import { parseError, logError } from '@/lib/error-handler';
import { ChevronRight, Building2, Plus } from 'lucide-react';

export function DashboardScreen() {
  const { currentUser, setScreen, setSelectedGroupId, userRole } = useApp();
  const [userProfile, setUserProfile] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [organisations, setOrganisations] = useState<any[]>([]);
  const [balances, setBalances] = useState<{ owes: number; getsBack: number }>({
    owes: 0,
    getsBack: 0,
  });
  const [groupBalances, setGroupBalances] = useState<
    Record<string, { balance: number; color: string }>
  >({});
  const [monthlySpent, setMonthlySpent] = useState(0);
  const [monthlyBudget, setMonthlyBudget] = useState(15000);
  const [loading, setLoading] = useState(true);

  const loadData = useCallback(async () => {
    if (!currentUser?.id) return;

    try {
      // Load user profile
      const profile = await getUserProfile(currentUser.id);
      setUserProfile(profile);
      setMonthlyBudget(profile?.monthly_budget || 15000);

      if (userRole === 'individual') {
        // Load groups for individual users
        const { data: memberData } = await supabase
          .from('group_members')
          .select('group_id')
          .eq('user_id', currentUser.id);

        if (memberData && memberData.length > 0) {
          const { data: groupsData, error: groupsError } = await supabase
            .from('groups')
            .select('*')
            .in('id', memberData.map((m) => m.group_id));

          if (groupsError) throw groupsError;

          setGroups(groupsData || []);

          // Load balances for each group
          const balancesMap: Record<string, { balance: number; color: string }> = {};
          for (const group of groupsData || []) {
            try {
              const balance = await getUserGroupBalance(group.id, currentUser.id);
              balancesMap[group.id] = {
                balance: balance.balance,
                color: balance.balance < 0 ? 'text-destructive' : 'text-success',
              };
            } catch (err) {
              console.error(`Error loading balance for group ${group.id}:`, err);
              balancesMap[group.id] = { balance: 0, color: 'text-muted-foreground' };
            }
          }
          setGroupBalances(balancesMap);
        } else {
          setGroups([]);
          setGroupBalances({});
        }

        // Load total balances
        const totalBalance = await getUserTotalBalance(currentUser.id);
        setBalances(totalBalance);

        // Load monthly spending
        const now = new Date();
        const monthYear = new Date(now.getFullYear(), now.getMonth(), 1)
          .toISOString()
          .split('T')[0];

        const { data: monthlyData } = await supabase
          .from('monthly_spending')
          .select('total_spent')
          .eq('user_id', currentUser.id)
          .eq('month_year', monthYear)
          .single();

        setMonthlySpent(monthlyData?.total_spent || 0);
      } else if (userRole === 'organisation') {
        // Load organisations for org users
        const { data: orgs } = await supabase
          .from('organisations')
          .select('*')
          .eq('owner_id', currentUser.id);

        setOrganisations(orgs || []);
      }
    } catch (error: any) {
      console.error('[v0] Error loading dashboard data:', error);
      logError(parseError(error), 'DashboardScreen.loadData');
    } finally {
      setLoading(false);
    }
  }, [currentUser?.id, userRole]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  if (loading) {
    return <div className="p-6">Loading...</div>;
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <div className="p-6 pb-2">
        <p className="text-muted-foreground mb-1">Welcome back,</p>
        <h1 className="text-3xl font-bold text-foreground">
          {userProfile?.full_name?.split(' ')[0] || 'User'}
        </h1>
      </div>

      {/* Balance Overview */}
      <div className="mx-6 my-6">
        <div className="bg-card rounded-xl p-6 shadow-sm border border-border">
          <h2 className="text-muted-foreground text-sm font-semibold mb-4">Balance Overview</h2>
          <div className="flex justify-between items-end">
            <div>
              <p className="text-muted-foreground text-sm mb-1 flex items-center gap-2">
                <span className="text-red-500">✕</span> You owe
              </p>
              <p className="text-2xl font-bold text-foreground">Rs. {balances.owes.toFixed(0)}</p>
            </div>
            <div className="h-12 w-0.5 bg-border"></div>
            <div className="text-right">
              <p className="text-muted-foreground text-sm mb-1 flex items-center justify-end gap-2">
                <span className="text-green-500">↗</span> You get back
              </p>
              <p className="text-2xl font-bold text-foreground">Rs. {balances.getsBack.toFixed(0)}</p>
            </div>
          </div>
        </div>
      </div>

      {/* Content based on user role */}
      {userRole === 'individual' ? (
        <>
          {/* Monthly Budget - Individual Only */}
          {userProfile && (
            <div className="mx-6 mb-6">
              <div className="bg-card rounded-xl p-6 shadow-sm border border-border">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-muted-foreground text-xs font-bold uppercase tracking-wider">MONTHLY SPLURGE TRACK</h3>
                  <span className={`text-sm font-bold ${monthlySpent > monthlyBudget ? 'text-destructive' : 'text-primary'}`}>
                    {((monthlySpent / monthlyBudget) * 100).toFixed(0)}% splurged
                  </span>
                </div>
                <div className="w-full h-3 bg-secondary rounded-full overflow-hidden shadow-inner">
                  <div
                    className={`h-full transition-all duration-500 ease-out ${
                      monthlySpent > monthlyBudget
                        ? 'bg-gradient-to-r from-red-600 to-red-400'
                        : 'bg-gradient-to-r from-primary to-primary/60'
                    }`}
                    style={{
                      width: `${Math.min((monthlySpent / monthlyBudget) * 100, 100)}%`,
                    }}
                  ></div>
                </div>
                <div className="flex justify-between items-center mt-3">
                  <p className="text-muted-foreground text-sm font-medium">
                    Rs. <span className="text-foreground font-bold">{monthlySpent.toFixed(0)}</span> <span className="text-xs">spent</span>
                  </p>
                  <p className="text-muted-foreground text-sm font-medium">
                    Limit: Rs. <span className="text-foreground font-bold">{monthlyBudget.toFixed(0)}</span>
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Your Groups */}
          <div className="px-6 mb-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-foreground">Your Groups</h2>
              <button
                onClick={() => setScreen('groups')}
                className="text-primary text-sm hover:underline"
              >
                See all
              </button>
            </div>

            {groups.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground mb-4">No groups yet</p>
                <button
                  onClick={() => setScreen('groups')}
                  className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90"
                >
                  <Plus size={16} /> Create Group
                </button>
              </div>
            ) : (
              groups.slice(0, 3).map((group) => {
                const balance = groupBalances[group.id];
                const isNegative = balance?.balance < 0;

                return (
                  <button
                    key={group.id}
                    onClick={() => {
                      setSelectedGroupId(group.id);
                      setScreen('group-detail');
                    }}
                    className="w-full mb-3 bg-card rounded-lg p-4 border border-border hover:border-primary transition flex items-center justify-between"
                  >
                    <div className="flex items-center gap-4 flex-1 text-left">
                      <div className="w-12 h-12 rounded-lg bg-secondary flex items-center justify-center font-bold text-foreground">
                        {group.name.charAt(0)}
                      </div>
                      <div>
                        <h3 className="font-bold text-foreground">{group.name}</h3>
                        <p className="text-muted-foreground text-sm">Multiple members</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`font-bold text-sm ${balance?.color || 'text-foreground'}`}>
                        {isNegative ? '-' : '+'}Rs. {Math.abs(balance?.balance || 0).toFixed(0)}
                      </span>
                      <ChevronRight size={20} className="text-muted-foreground" />
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </>
      ) : (
        <>
          {/* Organisation Dashboard */}
          <div className="px-6 mb-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-foreground flex items-center gap-2">
                <Building2 size={20} /> Your Organisations
              </h2>
            </div>

            {organisations.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground mb-4">No organisations yet</p>
                <button
                  onClick={() => setScreen('organization')}
                  className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90"
                >
                  <Plus size={16} /> Create Organisation
                </button>
              </div>
            ) : (
              organisations.map((org) => (
                <button
                  key={org.id}
                  onClick={() => setScreen('organization')}
                  className="w-full mb-3 bg-card rounded-lg p-4 border border-border hover:border-primary transition flex items-center justify-between"
                >
                  <div className="flex items-center gap-4 flex-1 text-left">
                    <div className="w-12 h-12 rounded-lg bg-primary text-primary-foreground flex items-center justify-center font-bold">
                      {org.name.charAt(0)}
                    </div>
                    <div>
                      <h3 className="font-bold text-foreground">{org.name}</h3>
                      <p className="text-muted-foreground text-sm">Manage buildings & rooms</p>
                    </div>
                  </div>
                  <ChevronRight size={20} className="text-muted-foreground" />
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
