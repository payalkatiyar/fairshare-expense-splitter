'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useApp } from '@/lib/app-context';
import { supabase, Expense, ExpenseSplit, GroupMember, Settlement } from '@/lib/supabase';
import { realtimeManager, SubscriptionHandler } from '@/lib/realtime-utils';
import { parseError, logError } from '@/lib/error-handler';
import { deleteGroup } from '@/lib/member-utils';
import { toastManager } from '@/lib/toast';
import { calculateOptimizedSettlements } from '@/lib/expense-utils';
import { ChevronLeft, BarChart3, Plus, AlertCircle } from 'lucide-react';

function getFirstName(name?: string | null, email?: string | null) {
  const fullName = (name || '').trim();
  if (fullName) return fullName.split(/\s+/)[0];
  const safeEmail = (email || '').trim();
  if (!safeEmail) return 'Member';
  return safeEmail.split('@')[0];
}

export function GroupDetailScreen() {
  const { currentUser, selectedGroupId, setScreen } = useApp();
  const [groupName, setGroupName] = useState('');
  const [tab, setTab] = useState<'balances' | 'expenses' | 'settlements'>('balances');
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [balances, setBalances] = useState<Record<string, number>>({});
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState(false);
  const [isGroupCreator, setIsGroupCreator] = useState(false);
  const [deletingGroup, setDeletingGroup] = useState(false);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const unsubscribeRef = useRef<(() => void) | null>(null);

  const getSettlementHintForMember = (memberId: string) => {
    const toPay = settlements.filter((s) => s.from_user_id === memberId);
    if (toPay.length > 0) {
      const first = toPay[0];
      const payeeName = memberNames[first.to_user_id] || 'Member';
      if (toPay.length === 1) {
        return `Pay ${payeeName} Rs. ${Number(first.amount).toFixed(2)}`;
      }
      const totalToPay = toPay.reduce((sum, s) => sum + Number(s.amount || 0), 0);
      return `Pay ${toPay.length} members Rs. ${totalToPay.toFixed(2)}`;
    }

    const toReceive = settlements.filter((s) => s.to_user_id === memberId);
    if (toReceive.length > 0) {
      const first = toReceive[0];
      const payerName = memberNames[first.from_user_id] || 'Member';
      if (toReceive.length === 1) {
        return `Gets Rs. ${Number(first.amount).toFixed(2)} from ${payerName}`;
      }
      const totalToReceive = toReceive.reduce((sum, s) => sum + Number(s.amount || 0), 0);
      return `Gets from ${toReceive.length} members Rs. ${totalToReceive.toFixed(2)}`;
    }

    return 'All clear';
  };

  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;

    try {
      setError('');

      // Load group
      const { data: groupData } = await supabase
        .from('groups')
        .select('id, name, created_by')
        .eq('id', selectedGroupId)
        .single();

      setGroupName(groupData?.name || '');
      setIsGroupCreator(groupData?.created_by === currentUser?.id);

      // Load members
      const { data: membersData } = await supabase
        .from('group_members')
        .select('*')
        .eq('group_id', selectedGroupId);

      setMembers(membersData || []);

      const { data: profileRows, error: profileError } = await supabase.rpc(
        'get_group_member_profiles',
        { target_group_id: selectedGroupId }
      );
      if (profileError) throw profileError;

      const namesMap: Record<string, string> = {};
      (profileRows || []).forEach((row: any) => {
        namesMap[row.user_id] = getFirstName(row.full_name, row.email);
      });
      setMemberNames(namesMap);

      // Load expenses
      const { data: expensesData } = await supabase
        .from('expenses')
        .select('*')
        .eq('group_id', selectedGroupId)
        .order('created_at', { ascending: false });

      setExpenses(expensesData || []);

      // Calculate balances
      const { data: splits } = await supabase
        .from('expense_splits')
        .select('*')
        .in('expense_id', expensesData?.map((e) => e.id) || []);

      const { data: confirmedPayments } = await supabase
        .from('settlements')
        .select('from_user_id, to_user_id, amount')
        .eq('group_id', selectedGroupId)
        .eq('status', 'confirmed');

      const balancesMap: Record<string, number> = {};
      (membersData || []).forEach((member) => {
        balancesMap[member.user_id] = 0;
      });

      (expensesData || []).forEach((expense) => {
        balancesMap[expense.paid_by] = (balancesMap[expense.paid_by] || 0) + Number(expense.amount || 0);
      });

      (splits || []).forEach((split) => {
        balancesMap[split.user_id] = (balancesMap[split.user_id] || 0) - Number(split.amount || 0);
      });

      // Confirmed payments reduce outstanding balances only after creditor confirmation.
      (confirmedPayments || []).forEach((payment) => {
        balancesMap[payment.from_user_id] =
          (balancesMap[payment.from_user_id] || 0) + Number(payment.amount || 0);
        balancesMap[payment.to_user_id] =
          (balancesMap[payment.to_user_id] || 0) - Number(payment.amount || 0);
      });

      setBalances(balancesMap);

      // Load settlements
      const { data: settlementsData } = await supabase
        .from('settlements')
        .select('*')
        .eq('group_id', selectedGroupId)
        .eq('is_settled', false);

      const openSettlements = settlementsData || [];
      if (openSettlements.length > 0) {
        setSettlements(openSettlements);
      } else {
        // Fallback in case pending rows are not created yet: derive from balances.
        const computedSettlements = calculateOptimizedSettlements(
          expensesData || [],
          splits || [],
          [],
          (membersData || []).map((m) => m.user_id)
        ).map((s) => ({
          id: `${s.from}-${s.to}`,
          group_id: selectedGroupId,
          from_user_id: s.from,
          to_user_id: s.to,
          amount: s.amount,
          is_settled: false,
          status: 'pending' as const,
          settled_at: null,
          created_at: new Date().toISOString(),
        }));
        setSettlements(computedSettlements);
      }
      setConnectionError(false);
    } catch (error: any) {
      console.error('[v0] Error loading group data:', error);
      const appError = parseError(error);
      setError(appError.userMessage);
      logError(appError, 'loadData');
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId, currentUser?.id]);

  const setupRealtimeSubscriptions = useCallback(() => {
    if (!selectedGroupId) return;

    const handler: SubscriptionHandler = {
      onExpenseAdded: (expense) => {
        console.log('[v0] New expense received:', expense);
        loadData();
      },
      onSettlementUpdated: (settlement) => {
        console.log('[v0] Settlement updated:', settlement);
        loadData();
      },
      onMemberJoined: (member) => {
        console.log('[v0] Member joined:', member);
        loadData();
      },
      onError: (error) => {
        console.error('[v0] Realtime error:', error);
        setConnectionError(true);
        logError(parseError(error), 'realtimeSubscription');
      },
    };

    // Subscribe to group expenses
    const unsubscribe = realtimeManager.subscribeToGroupExpenses(
      selectedGroupId,
      handler
    );

    unsubscribeRef.current = unsubscribe;
  }, [selectedGroupId, loadData]);

  useEffect(() => {
    if (selectedGroupId) {
      loadData();
      setupRealtimeSubscriptions();
    }

    return () => {
      // Cleanup subscriptions on unmount
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
      }
    };
  }, [selectedGroupId, loadData, setupRealtimeSubscriptions]);

  async function handleDeleteGroup() {
    if (!selectedGroupId) return;
    if (!isGroupCreator) {
      toastManager.error('Only the group creator can delete this group.');
      return;
    }

    const confirmed = window.confirm(
      'Delete this group permanently? This is allowed only when all dues/settlements are cleared.'
    );
    if (!confirmed) return;

    setDeletingGroup(true);
    try {
      const result = await deleteGroup(selectedGroupId);
      if (!result.valid) {
        toastManager.warning(result.error || 'Group cannot be deleted yet.');
        return;
      }

      toastManager.success('Group deleted');
      setScreen('groups');
    } catch (deleteError: any) {
      const appError = parseError(deleteError);
      toastManager.error(appError.userMessage);
      logError(appError, 'deleteGroup');
    } finally {
      setDeletingGroup(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center pb-24">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full border-4 border-primary border-t-transparent animate-spin mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading group details...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Connection Error */}
      {connectionError && (
        <div className="mx-6 mt-4 p-4 rounded-lg bg-amber-500/10 border border-amber-500/20 flex gap-3">
          <AlertCircle className="text-amber-600 flex-shrink-0 mt-0.5" size={20} />
          <p className="text-amber-700 text-sm">Connection unstable. Updates may be delayed.</p>
        </div>
      )}

      {/* Error Alert */}
      {error && (
        <div className="mx-6 mt-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex gap-3">
          <AlertCircle className="text-destructive flex-shrink-0 mt-0.5" size={20} />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {/* Header */}
      <div className="p-6 flex items-center gap-3 mb-2">
        <button onClick={() => setScreen('groups')} className="text-muted-foreground">
          <ChevronLeft size={24} />
        </button>
        <h1 className="text-2xl font-bold text-foreground">{groupName}</h1>
      </div>
      <div className="px-6 pb-4 text-muted-foreground text-sm">
        {members.length} members
      </div>
      {isGroupCreator && (
        <div className="px-6 pb-4">
          <button
            onClick={handleDeleteGroup}
            disabled={deletingGroup}
            className="w-full bg-destructive/20 text-destructive font-bold py-2.5 px-4 rounded-lg hover:bg-destructive/30 transition disabled:opacity-50"
          >
            {deletingGroup ? 'Deleting...' : 'Delete Group'}
          </button>
          <p className="text-muted-foreground text-xs mt-2">
            You can delete this group only when all dues/debts and settlements are cleared.
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 px-6 mb-6">
        <button
          onClick={() => setTab('balances')}
          className={`flex-1 py-2 px-4 rounded-lg font-semibold transition ${
            tab === 'balances'
              ? 'bg-primary text-primary-foreground'
              : 'bg-secondary text-foreground'
          }`}
        >
          <BarChart3 size={18} className="inline mr-2" />
          Balances
        </button>
        <button
          onClick={() => setTab('expenses')}
          className={`flex-1 py-2 px-4 rounded-lg font-semibold transition ${
            tab === 'expenses'
              ? 'bg-primary text-primary-foreground text-xs sm:text-sm'
              : 'bg-secondary text-foreground text-xs sm:text-sm'
          }`}
        >
          Expenses
        </button>
        <button
          onClick={() => setTab('settlements')}
          className={`flex-1 py-2 px-4 rounded-lg font-semibold transition ${
            tab === 'settlements'
              ? 'bg-primary text-primary-foreground text-xs sm:text-sm'
              : 'bg-secondary text-foreground text-xs sm:text-sm'
          }`}
        >
          Settles
        </button>
      </div>

      {/* Content */}
      <div className="px-6">
        {tab === 'balances' ? (
          <div className="space-y-3">
            {members.map((member) => (
              <div key={member.id} className="bg-card rounded-lg p-4 border border-border">
                <p className="font-semibold text-foreground">
                  {memberNames[member.user_id] || 'Member'}
                </p>
                <div className="flex items-center justify-between">
                  <p className={`text-lg font-bold ${balances[member.user_id] > 0 ? 'text-green-500' : (balances[member.user_id] < 0 ? 'text-red-500' : 'text-muted-foreground')}`}>
                    {balances[member.user_id] > 0 ? '+' : ''}Rs. {Math.abs(balances[member.user_id] || 0).toFixed(2)}
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {balances[member.user_id] > 0 ? 'gets back' : (balances[member.user_id] < 0 ? 'owes' : 'settled')}
                  </p>
                </div>
                <p className="text-xs mt-2 text-muted-foreground">
                  {getSettlementHintForMember(member.user_id)}
                </p>
              </div>
            ))}
          </div>
        ) : tab === 'expenses' ? (
          <div className="space-y-3">
            {expenses.map((expense) => (
              <div key={expense.id} className="bg-card rounded-lg p-4 border border-border">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-bold text-foreground">{expense.title}</h3>
                  <span className="text-lg font-bold text-foreground">Rs {expense.amount}</span>
                </div>
                <p className="text-muted-foreground text-sm">
                  <span className="text-success font-semibold">Paid by {memberNames[expense.paid_by] || 'Member'}</span> • {new Date(expense.created_at).toLocaleDateString()}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-3">
            {settlements.length === 0 ? (
              <div className="text-center py-12">
                <p className="text-muted-foreground">Everyone is settled up! no pending payments. 🎉</p>
              </div>
            ) : (
              <>
                {settlements.map((settlement) => (
                  <div key={settlement.id} className="bg-card rounded-lg p-4 border border-border">
                    <p className="font-semibold text-foreground mb-1">
                      {memberNames[settlement.from_user_id]} <span className="text-muted-foreground font-normal mx-1 text-xs uppercase">has to pay</span> {memberNames[settlement.to_user_id]}
                    </p>
                    <div className="flex items-center justify-between">
                      <p className="text-xl font-bold text-destructive">
                        Rs {settlement.amount.toFixed(0)}
                      </p>
                      <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase border ${
                        settlement.status === 'paid' ? 'bg-amber-500/10 border-amber-500/30 text-amber-500' : 'bg-blue-500/10 border-blue-500/30 text-blue-500'
                      }`}>
                        {settlement.status === 'paid' ? 'Awaiting Confirmation' : 'Pending'}
                      </span>
                    </div>
                  </div>
                ))}
                <div className="pt-2">
                  <button 
                    onClick={() => setScreen('settlements')}
                    className="w-full py-3 px-4 rounded-lg bg-primary/10 text-primary font-bold hover:bg-primary/20 transition text-sm"
                  >
                    Go to Payments to record a settle
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Floating Action Button */}
      <button
        onClick={() => setScreen('add-expense')}
        className="fixed bottom-28 right-6 w-16 h-16 bg-primary rounded-full flex items-center justify-center text-primary-foreground shadow-lg hover:bg-primary/90 transition"
      >
        <Plus size={28} />
      </button>
    </div>
  );
}
