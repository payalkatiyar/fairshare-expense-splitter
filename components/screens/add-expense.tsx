'use client';

import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/lib/app-context';
import { supabase, GroupMember } from '@/lib/supabase';
import { calculateEqualSplit, calculateOptimizedSettlements, saveSettlements, validateExpenseAmount, validateCustomSplits } from '@/lib/expense-utils';
import { logActivity } from '@/lib/activity-utils';
import { ChevronLeft, Save, AlertCircle } from 'lucide-react';

function getFirstName(name?: string | null, email?: string | null) {
  const fullName = (name || '').trim();
  if (fullName) return fullName.split(/\s+/)[0];
  const safeEmail = (email || '').trim();
  if (!safeEmail) return 'Member';
  return safeEmail.split('@')[0];
}

export function AddExpenseScreen() {
  const { currentUser, selectedGroupId, setScreen } = useApp();
  const [groupName, setGroupName] = useState('');
  const [title, setTitle] = useState('');
  const [amount, setAmount] = useState('');
  const [paidBy, setPaidBy] = useState('');
  const [splitType, setSplitType] = useState<'equal' | 'custom'>('equal');
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [customSplits, setCustomSplits] = useState<Record<string, string>>({});
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});

  const loadData = useCallback(async () => {
    if (!selectedGroupId) return;

    try {
      // Load group name
      const { data: groupData } = await supabase
        .from('groups')
        .select('name')
        .eq('id', selectedGroupId)
        .single();

      setGroupName(groupData?.name || '');

      // Load members
      const { data: membersData } = await supabase
        .from('group_members')
        .select('*')
        .eq('group_id', selectedGroupId);

      setMembers(membersData || []);

      // Build member names map from secure RPC
      const names: Record<string, string> = {};
      const { data: profileRows, error: profileError } = await supabase.rpc(
        'get_group_member_profiles',
        { target_group_id: selectedGroupId }
      );
      if (profileError) throw profileError;

      (profileRows || []).forEach((row: any) => {
        names[row.user_id] = getFirstName(row.full_name, row.email);
      });

      (membersData || []).forEach((m: GroupMember) => {
        if (!names[m.user_id]) {
          names[m.user_id] = 'Member';
        }
      });

      setMemberNames(names);

      if (currentUser?.id) {
        setPaidBy(currentUser.id);
        setSelectedMembers(membersData?.map((m) => m.user_id) || []);

        // Initialize custom splits
        const splits: Record<string, string> = {};
        membersData?.forEach((m) => {
          splits[m.user_id] = '';
        });
        setCustomSplits(splits);
      }
    } catch (error) {
      console.error('Error loading data:', error);
    }
  }, [selectedGroupId, currentUser?.id]);

  useEffect(() => {
    if (selectedGroupId && currentUser?.id) {
      loadData();
    }
  }, [selectedGroupId, currentUser?.id, loadData]);

  async function handleAddExpense(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedGroupId || !currentUser?.id) return;

    setError('');
    setLoading(true);

    try {
      const expenseAmount = parseFloat(amount);

      // Validate expense amount
      const amountValidation = validateExpenseAmount(expenseAmount);
      if (!amountValidation.valid) {
        throw new Error(amountValidation.error);
      }

      // Validate title
      if (!title.trim()) {
        throw new Error('Title is required');
      }

      // Validate at least one member is selected
      if (selectedMembers.length === 0) {
        throw new Error('Select at least one member to split between');
      }

      // Validate custom splits if needed
      let parsedCustomSplits: Record<string, number> = {};
      if (splitType === 'custom') {
        parsedCustomSplits = Object.fromEntries(
          selectedMembers.map((memberId) => [memberId, parseFloat(customSplits[memberId] || '0')])
        );

        const splitsValidation = validateCustomSplits(
          expenseAmount,
          parsedCustomSplits
        );
        if (!splitsValidation.valid) {
          throw new Error(splitsValidation.error);
        }
      }

      // Insert expense
      const { data: expense, error: expenseError } = await supabase
        .from('expenses')
        .insert([
          {
            group_id: selectedGroupId,
            title,
            amount: expenseAmount,
            paid_by: paidBy,
            split_type: splitType,
          },
        ])
        .select()
        .single();

      if (expenseError) throw expenseError;

      // Calculate splits
      let splits: Record<string, number>;
      if (splitType === 'equal') {
        splits = calculateEqualSplit(expenseAmount, selectedMembers, paidBy);
      } else {
        splits = parsedCustomSplits;
      }

      // Insert splits
      const splitsToInsert = Object.entries(splits).map(([userId, splitAmount]) => ({
        expense_id: expense.id,
        user_id: userId,
        amount: splitAmount,
      }));

      const { error: splitsError } = await supabase
        .from('expense_splits')
        .insert(splitsToInsert);

      if (splitsError) throw splitsError;

      // Recalculate settlements
      const { data: allExpenses } = await supabase
        .from('expenses')
        .select('*')
        .eq('group_id', selectedGroupId);

      const { data: allSplits } = await supabase
        .from('expense_splits')
        .select('*')
        .in('expense_id', allExpenses?.map((e) => e.id) || []);

      const { data: existingSettlements } = await supabase
        .from('settlements')
        .select('*')
        .eq('group_id', selectedGroupId)
        .eq('status', 'confirmed');

      const allMemberIds = members.map((m) => m.user_id);
      const newSettlements = calculateOptimizedSettlements(
        allExpenses || [],
        allSplits || [],
        existingSettlements || [],
        allMemberIds
      );

      await saveSettlements(selectedGroupId, newSettlements);

      // Log activity
      await logActivity(
        'expense_added',
        currentUser.id,
        selectedGroupId,
        `Added ${title}`,
        {
          title,
          amount: expenseAmount,
          paidBy: memberNames[paidBy] || 'Unknown',
        }
      );

      setScreen('group-detail');
    } catch (error: any) {
      console.error('[v0] Error adding expense:', error);
      setError(error.message || 'Failed to add expense');
    } finally {
      setLoading(false);
    }
  }

  const toggleMember = (memberId: string) => {
    setSelectedMembers((prev) => {
      if (prev.includes(memberId)) {
        return prev.filter((m) => m !== memberId);
      }
      return [...prev, memberId];
    });
  };

  const setCustomSplitForMember = (memberId: string, value: string) => {
    setCustomSplits((prev) => ({ ...prev, [memberId]: value }));
  };

  return (
    <div className="min-h-screen bg-background pb-24">
      {/* Header */}
      <div className="p-6 flex items-center gap-3 mb-6">
        <button onClick={() => setScreen('group-detail')} className="text-muted-foreground">
          <ChevronLeft size={24} />
        </button>
        <div>
          <p className="text-muted-foreground text-sm">{groupName}</p>
          <h1 className="text-2xl font-bold text-foreground">Add Expense</h1>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mx-6 mb-4 p-4 rounded-lg bg-destructive/10 border border-destructive/20 flex gap-3">
          <AlertCircle className="text-destructive flex-shrink-0 mt-0.5" size={20} />
          <p className="text-destructive text-sm">{error}</p>
        </div>
      )}

      {/* Form */}
      <form onSubmit={handleAddExpense} className="px-6 space-y-6">
        {/* Title */}
        <div>
          <label className="block text-sm font-semibold text-foreground mb-2">Title</label>
          <input
            type="text"
            placeholder="eg. dinner, groceries"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            className="w-full px-4 py-3 rounded-lg bg-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary text-foreground placeholder-muted-foreground"
          />
        </div>

        {/* Amount */}
        <div>
          <label className="block text-sm font-semibold text-foreground mb-2">Amount (Rs.)</label>
          <input
            type="number"
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            step="0.01"
            className="w-full px-4 py-3 rounded-lg bg-secondary border border-border focus:outline-none focus:ring-2 focus:ring-primary text-foreground placeholder-muted-foreground"
          />
        </div>

        {/* Paid By */}
        <div>
          <label className="block text-sm font-semibold text-foreground mb-2">Paid by</label>
          <div className="flex gap-2 flex-wrap">
            {members.map((member: any) => (
              <button
                key={member.id}
                type="button"
                onClick={() => setPaidBy(member.user_id)}
                className={`px-4 py-2 rounded-lg font-semibold transition ${
                  paidBy === member.user_id
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-foreground hover:bg-secondary/80'
                }`}
              >
                {memberNames[member.user_id] || 'Member'}
              </button>
            ))}
          </div>
        </div>

        {/* Split Type */}
        <div>
          <label className="block text-sm font-semibold text-foreground mb-2">Split type</label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setSplitType('equal')}
              className={`flex-1 px-4 py-2 rounded-lg font-semibold transition ${
                splitType === 'equal'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-foreground'
              }`}
            >
              Equal
            </button>
            <button
              type="button"
              onClick={() => setSplitType('custom')}
              className={`flex-1 px-4 py-2 rounded-lg font-semibold transition ${
                splitType === 'custom'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-secondary text-foreground'
              }`}
            >
              Custom
            </button>
          </div>
        </div>

        {/* Split Between */}
        <div>
          <label className="block text-sm font-semibold text-foreground mb-3">Split between</label>
          <div className="space-y-2">
            {members.map((member: any) => (
              <label key={member.id} className="flex items-center gap-3 p-3 rounded-lg bg-secondary cursor-pointer hover:bg-secondary/80 transition">
                <input
                  type="checkbox"
                  checked={selectedMembers.includes(member.user_id)}
                  onChange={() => toggleMember(member.user_id)}
                  className="w-5 h-5 rounded accent-success"
                />
                <span className="font-semibold text-foreground flex-1">
                  {memberNames[member.user_id] || 'Member'}
                </span>
                {splitType === 'custom' && selectedMembers.includes(member.user_id) && (
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    placeholder="0"
                    value={customSplits[member.user_id] || ''}
                    onChange={(e) => setCustomSplitForMember(member.user_id, e.target.value)}
                    className="w-24 px-2 py-1 rounded-md border border-border bg-background text-foreground text-sm"
                  />
                )}
              </label>
            ))}
          </div>
          {splitType === 'custom' && (
            <p className="text-muted-foreground text-xs mt-2">
              Enter each member&apos;s share. Total custom split must equal amount.
            </p>
          )}
        </div>

        {/* Save Button */}
        <button
          type="submit"
          disabled={loading}
          className="w-full bg-success text-success-foreground font-bold py-3 px-4 rounded-lg hover:bg-success/90 transition disabled:opacity-50 flex items-center justify-center gap-2"
        >
          <Save size={20} /> Save Expense
        </button>
      </form>
    </div>
  );
}
