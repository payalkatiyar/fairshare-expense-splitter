'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/lib/app-context';
import { supabase, Settlement } from '@/lib/supabase';
import { markAsPaid, confirmPayment, calculateOptimizedSettlements, saveSettlements } from '@/lib/expense-utils';
import { removeGroupMember, canLeaveGroup } from '@/lib/member-utils';
import { logActivity } from '@/lib/activity-utils';
import { ChevronLeft, LogOut, Check, AlertCircle } from 'lucide-react';

export function SettlementsScreen() {
  const { selectedGroupId, setScreen, currentUser } = useApp();
  const [groupName, setGroupName] = useState('');
  const [settlements, setSettlements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [recordingPayment, setRecordingPayment] = useState<string | null>(null);
  const [leavingGroup, setLeavingGroup] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;

    try {
      setError('');

      // Load group name
      const { data: groupData } = await supabase
        .from('groups')
        .select('name')
        .eq('id', selectedGroupId)
        .single();

      setGroupName(groupData?.name || '');

      // Load settlements with user details
      const { data: settlementsData, error: settlementsError } = await supabase
        .from('settlements')
        .select(
          `
          id,
          from_user_id,
          to_user_id,
          amount,
          status,
          is_settled,
          created_at,
          from_user:users!settlements_from_user_id_fkey(id, full_name, email),
          to_user:users!settlements_to_user_id_fkey(id, full_name, email)
        `
        )
        .eq('group_id', selectedGroupId)
        .eq('is_settled', false);

      if (settlementsError) throw settlementsError;

      let pendingSettlements = settlementsData || [];

      // Auto-heal missing pending settlements so debtors/creditors always get actions.
      if (pendingSettlements.length === 0) {
        const { data: allExpenses } = await supabase
          .from('expenses')
          .select('*')
          .eq('group_id', selectedGroupId);

        const { data: allSplits } = await supabase
          .from('expense_splits')
          .select('*')
          .in('expense_id', allExpenses?.map((e) => e.id) || []);

        const { data: confirmedPayments } = await supabase
          .from('settlements')
          .select('*')
          .eq('group_id', selectedGroupId)
          .eq('status', 'confirmed');

        const { data: membersData } = await supabase
          .from('group_members')
          .select('user_id')
          .eq('group_id', selectedGroupId);

        const computed = calculateOptimizedSettlements(
          allExpenses || [],
          allSplits || [],
          confirmedPayments || [],
          (membersData || []).map((m) => m.user_id)
        );

        if (computed.length > 0) {
          await saveSettlements(selectedGroupId, computed);

          const { data: regeneratedSettlements, error: regeneratedError } = await supabase
            .from('settlements')
            .select(
              `
              id,
              from_user_id,
              to_user_id,
              amount,
              status,
              is_settled,
              created_at,
              from_user:users!settlements_from_user_id_fkey(id, full_name, email),
              to_user:users!settlements_to_user_id_fkey(id, full_name, email)
            `
            )
            .eq('group_id', selectedGroupId)
            .eq('is_settled', false);

          if (regeneratedError) throw regeneratedError;
          pendingSettlements = regeneratedSettlements || [];
        }
      }

      setSettlements(pendingSettlements);
    } catch (error: any) {
      console.error('[v0] Error loading settlements:', error);
      setError(error.message || 'Failed to load settlements');
    } finally {
      setLoading(false);
    }
  }, [selectedGroupId]);

  useEffect(() => {
    if (selectedGroupId) {
      loadData();
    }
  }, [selectedGroupId, loadData]);

  async function handleMarkAsPaid(settlementId: string) {
    if (!currentUser?.id) return;

    setRecordingPayment(settlementId);
    setError('');
    setSuccess('');

    try {
      await markAsPaid(settlementId);

      // Log activity
      const settlement = settlements.find((s) => s.id === settlementId);
      await logActivity(
        'payment_marked_paid',
        currentUser.id,
        selectedGroupId,
        `Payment marked as paid`,
        {
          amount: settlement?.amount,
          from: settlement?.from_user?.full_name || settlement?.from_user?.email,
          to: settlement?.to_user?.full_name || settlement?.to_user?.email,
        }
      );

      setSuccess('Payment marked as paid! Waiting for creditor confirmation.');
      setTimeout(() => loadData(), 1500);
    } catch (error: any) {
      console.error('[v0] Error marking payment:', error);
      setError(error.message || 'Failed to mark payment');
    } finally {
      setRecordingPayment(null);
    }
  }

  async function handleConfirmPayment(settlementId: string) {
    if (!currentUser?.id) return;

    setRecordingPayment(settlementId);
    setError('');
    setSuccess('');

    try {
      await confirmPayment(settlementId);

      // Log activity
      const settlement = settlements.find((s) => s.id === settlementId);
      await logActivity(
        'payment_confirmed',
        currentUser.id,
        selectedGroupId,
        `Payment confirmed`,
        {
          amount: settlement?.amount,
          from: settlement?.from_user?.full_name || settlement?.from_user?.email,
          to: settlement?.to_user?.full_name || settlement?.to_user?.email,
        }
      );

      setSuccess('Payment confirmed and balance cleared!');
      setTimeout(() => loadData(), 1500);
    } catch (error: any) {
      console.error('[v0] Error confirming payment:', error);
      setError(error.message || 'Failed to confirm payment');
    } finally {
      setRecordingPayment(null);
    }
  }

  async function handleLeaveGroup() {
    if (!selectedGroupId || !currentUser?.id) return;

    setLeavingGroup(true);
    setError('');

    try {
      const removeResult = await removeGroupMember(selectedGroupId, currentUser.id);
      if (!removeResult.valid) {
        throw new Error(removeResult.error || 'Failed to leave group');
      }

      await logActivity(
        'member_left',
        currentUser.id,
        selectedGroupId,
        'Member left group',
        { groupName }
      );

      setScreen('groups');
    } catch (error: any) {
      console.error('[v0] Error leaving group:', error);
      setError(error.message || 'Failed to leave group');
    } finally {
      setLeavingGroup(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 rounded-full border-4 border-primary border-t-transparent animate-spin mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading settlements...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <div className="p-6 flex items-center gap-3 mb-2">
        <button onClick={() => setScreen('group-detail')} className="text-muted-foreground">
          <ChevronLeft size={24} />
        </button>
        <div>
          <p className="text-muted-foreground text-sm">{groupName}</p>
          <h1 className="text-2xl font-bold text-foreground">Settlements</h1>
        </div>
      </div>

      <div className="px-6 pb-6">
        <p className="text-muted-foreground text-sm">Payments move to confirmed only after the receiver verifies them.</p>
      </div>

      {error && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex gap-3">
          <AlertCircle className="text-destructive flex-shrink-0 mt-0.5" size={20} />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {success && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-success/10 border border-success/20 flex gap-3">
          <Check className="text-success flex-shrink-0 mt-0.5" size={20} />
          <p className="text-success text-sm">{success}</p>
        </div>
      )}

      <div className="px-6 space-y-4 mb-8">
        {settlements.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-muted-foreground mb-2">All settled up!</p>
            <p className="text-sm text-muted-foreground">No pending settlements</p>
          </div>
        ) : (
          settlements.map((settlement) => {
            const fromUser = settlement.from_user?.full_name || settlement.from_user?.email || 'Unknown';
            const toUser = settlement.to_user?.full_name || settlement.to_user?.email || 'Unknown';
            const isCurrentUserDebtor = settlement.from_user_id === currentUser?.id;
            const isCurrentUserCreditor = settlement.to_user_id === currentUser?.id;
            const status = settlement.status || 'pending';

            return (
              <div key={settlement.id} className="bg-card rounded-lg p-4 border border-border">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex-1">
                    <p className="font-semibold text-foreground mb-1">
                      {fromUser} <span className="text-muted-foreground font-normal mx-2 text-xs">has to pay</span> {toUser}
                    </p>
                    <div className="flex items-center gap-2">
                       <p className="text-muted-foreground text-xs uppercase tracking-tighter">
                        Status: <span className={`font-bold ${status === 'paid' ? 'text-amber-500' : 'text-blue-500'}`}>{status.replace('_', ' ')}</span>
                      </p>
                    </div>
                  </div>
                  <span className="text-lg font-bold text-destructive">
                    Rs {settlement.amount.toFixed(0)}
                  </span>
                </div>

                {isCurrentUserDebtor && status === 'pending' && (
                  <button
                    onClick={() => handleMarkAsPaid(settlement.id)}
                    disabled={recordingPayment === settlement.id}
                    className="w-full bg-success text-success-foreground rounded-lg py-2 font-semibold hover:bg-success/90 transition flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <Check size={18} /> {recordingPayment === settlement.id ? 'Updating...' : 'I have paid'}
                  </button>
                )}

                {isCurrentUserDebtor && status === 'paid' && (
                  <div className="w-full bg-secondary text-muted-foreground rounded-lg py-2 text-center text-sm font-medium border border-border">
                    Waiting for {toUser} to confirm
                  </div>
                )}

                {isCurrentUserCreditor && status === 'paid' && (
                  <button
                    onClick={() => handleConfirmPayment(settlement.id)}
                    disabled={recordingPayment === settlement.id}
                    className="w-full bg-primary text-primary-foreground rounded-lg py-2 font-semibold hover:bg-primary/90 transition flex items-center justify-center gap-2 disabled:opacity-50"
                  >
                    <Check size={18} /> {recordingPayment === settlement.id ? 'Confirming...' : 'Confirm Receipt'}
                  </button>
                )}

                {isCurrentUserCreditor && status === 'pending' && (
                  <div className="w-full bg-secondary/50 text-muted-foreground rounded-lg py-2 text-center text-sm italic">
                    Waiting for {fromUser} to pay
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Leave Group Button */}
      <div className="px-6 mt-8">
        {currentUser && (
          <>
            {settlements.some((s) => s.from_user_id === currentUser.id) && (
              <div className="mb-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex gap-3">
                <AlertCircle className="text-destructive flex-shrink-0 mt-0.5" size={20} />
                <p className="text-destructive text-sm">
                  You owe money to members. Settle your debts before leaving.
                </p>
              </div>
            )}
            <button
              onClick={handleLeaveGroup}
              disabled={leavingGroup || settlements.some((s) => s.from_user_id === currentUser.id)}
              className="w-full bg-destructive/20 text-destructive font-bold py-3 px-4 rounded-lg hover:bg-destructive/30 transition flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <LogOut size={20} /> {leavingGroup ? 'Leaving...' : 'Leave Group'}
            </button>
            <p className="text-center text-muted-foreground text-sm mt-3">
              {settlements.some((s) => s.from_user_id === currentUser.id)
                ? 'You must settle your debts before leaving'
                : 'You can leave the group'}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
