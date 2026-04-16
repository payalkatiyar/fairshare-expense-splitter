import { supabase, Settlement, Expense, ExpenseSplit } from './supabase';

/**
 * Validate expense amount
 */
export function validateExpenseAmount(amount: number): { valid: boolean; error?: string } {
  if (!amount || amount <= 0) {
    return { valid: false, error: 'Amount must be greater than 0' };
  }
  if (!Number.isFinite(amount)) {
    return { valid: false, error: 'Invalid amount' };
  }
  return { valid: true };
}

/**
 * Calculate equal split for an expense
 */
export function calculateEqualSplit(
  amount: number,
  participants: string[],
  remainderReceiverId?: string
): Record<string, number> {
  if (participants.length === 0) {
    throw new Error('At least one participant is required');
  }

  // Work in paise/cents to avoid floating-point drift and keep totals exact.
  const amountInCents = Math.round(amount * 100);
  const baseShareInCents = Math.floor(amountInCents / participants.length);
  const remainderInCents = amountInCents - baseShareInCents * participants.length;

  const splits: Record<string, number> = {};
  participants.forEach((userId) => {
    splits[userId] = baseShareInCents / 100;
  });

  if (remainderInCents > 0) {
    const receiverId =
      (remainderReceiverId && participants.includes(remainderReceiverId) && remainderReceiverId) ||
      participants[0];
    splits[receiverId] = (splits[receiverId] || 0) + remainderInCents / 100;
  }

  return splits;
}

/**
 * Validate custom splits
 */
export function validateCustomSplits(
  amount: number,
  splits: Record<string, number>
): { valid: boolean; error?: string } {
  const total = Object.values(splits).reduce((sum, val) => sum + val, 0);
  const difference = Math.abs(total - amount);

  if (difference > 0.01) {
    return {
      valid: false,
      error: `Split total (Rs. ${total.toFixed(2)}) must equal expense amount (Rs. ${amount.toFixed(2)})`,
    };
  }

  const hasNegative = Object.values(splits).some((v) => v < 0);
  if (hasNegative) {
    return { valid: false, error: 'All split amounts must be positive' };
  }

  return { valid: true };
}

/**
 * Calculate settlements using the Minimize Cash Flow algorithm
 * This algorithm minimizes the number of transactions needed to settle all debts
 */
export function calculateOptimizedSettlements(
  expenses: Expense[],
  splits: ExpenseSplit[],
  existingPayments: Settlement[],
  groupMembers: string[]
): Array<{ from: string; to: string; amount: number }> {
  const EPSILON = 0.01;

  // Calculate net balance for each user
  const balances: Record<string, number> = {};

  groupMembers.forEach((memberId) => {
    balances[memberId] = 0;
  });

  // Add expenses paid
  expenses.forEach((expense) => {
    balances[expense.paid_by] = (balances[expense.paid_by] || 0) + Number(expense.amount || 0);
  });

  // Subtract splits owed
  splits.forEach((split) => {
    balances[split.user_id] = (balances[split.user_id] || 0) - Number(split.amount || 0);
  });

  // Apply existing payments (money already moving or moved)
  existingPayments.forEach((payment) => {
    // Debtor sending money reduces what they owe, creditor receiving reduces what they should get back.
    balances[payment.from_user_id] = (balances[payment.from_user_id] || 0) + Number(payment.amount || 0);
    balances[payment.to_user_id] = (balances[payment.to_user_id] || 0) - Number(payment.amount || 0);
  });

  // Create settlement transactions
  const settlements: Array<{ from: string; to: string; amount: number }> = [];
  const debtors = Object.entries(balances)
    .filter(([_, balance]) => balance < -EPSILON)
    .map(([userId, balance]) => ({ userId, amount: Math.abs(balance) }));

  const creditors = Object.entries(balances)
    .filter(([_, balance]) => balance > EPSILON)
    .map(([userId, balance]) => ({ userId, amount: balance }));

  let debtorIdx = 0;
  let creditorIdx = 0;

  while (debtorIdx < debtors.length && creditorIdx < creditors.length) {
    const debtor = debtors[debtorIdx];
    const creditor = creditors[creditorIdx];

    const amount = Math.min(debtor.amount, creditor.amount);
    const roundedAmount = Math.round(amount * 100) / 100;
    if (roundedAmount >= EPSILON) {
      settlements.push({
        from: debtor.userId,
        to: creditor.userId,
        amount: roundedAmount,
      });
    }

    debtor.amount -= amount;
    creditor.amount -= amount;

    if (debtor.amount <= EPSILON) debtorIdx++;
    if (creditor.amount <= EPSILON) creditorIdx++;
  }

  return settlements;
}

/**
 * Save settlements to database
 */
export async function saveSettlements(
  groupId: string,
  settlements: Array<{ from: string; to: string; amount: number }>
) {
  // First, clear previous pending settlements. 
  // IMPORTANT: Do NOT delete 'paid' or 'confirmed' settlements!
  const { error: deleteError } = await supabase
    .from('settlements')
    .delete()
    .eq('group_id', groupId)
    .eq('status', 'pending');

  if (deleteError) throw deleteError;

  // Insert new settlements
  if (settlements.length === 0) return;

  const { error: insertError } = await supabase
    .from('settlements')
    .insert(
      settlements.map((s) => ({
        group_id: groupId,
        from_user_id: s.from,
        to_user_id: s.to,
        amount: s.amount,
        is_settled: false,
        status: 'pending',
      }))
    );

  if (insertError) throw insertError;
}

/**
 * Mark settlement as paid by debtor
 */
export async function markAsPaid(settlementId: string) {
  const { error } = await supabase
    .from('settlements')
    .update({
      status: 'paid',
    })
    .eq('id', settlementId);

  if (error) throw error;
}

/**
 * Confirm settlement payment by creditor
 */
export async function confirmPayment(settlementId: string) {
  const { error } = await supabase
    .from('settlements')
    .update({
      status: 'confirmed',
      is_settled: true,
      settled_at: new Date().toISOString(),
    })
    .eq('id', settlementId);

  if (error) throw error;
}

/**
 * Get balance for a user in a group
 */
export async function getUserGroupBalance(groupId: string, userId: string) {
  const { data: expenses, error: expenseError } = await supabase
    .from('expenses')
    .select('id, amount, paid_by')
    .eq('group_id', groupId);

  if (expenseError) throw expenseError;

  let splits: any[] = [];
  if (expenses && expenses.length > 0) {
    const { data: splitsData, error: splitError } = await supabase
      .from('expense_splits')
      .select('expense_id, user_id, amount')
      .in('expense_id', expenses.map((e) => e.id));

    if (splitError) throw splitError;
    splits = splitsData || [];
  }

  const { data: settledPayments, error: settledError } = await supabase
    .from('settlements')
    .select('from_user_id, to_user_id, amount')
    .eq('group_id', groupId)
    .eq('status', 'confirmed');

  if (settledError) throw settledError;

  let paid = 0;
  let owes = 0;

  expenses?.forEach((expense) => {
    if (expense.paid_by === userId) {
      paid += Number(expense.amount || 0);
    }
  });

  splits?.forEach((split) => {
    if (split.user_id === userId) {
      owes += Number(split.amount || 0);
    }
  });

  // Factor in confirmed payments
  let paymentsSent = 0;
  let paymentsReceived = 0;

  settledPayments?.forEach((p) => {
    if (p.from_user_id === userId) paymentsSent += Number(p.amount || 0);
    if (p.to_user_id === userId) paymentsReceived += Number(p.amount || 0);
  });

  // Positive balance means the user should receive money, negative means they owe money.
  // Sending payment improves your balance; receiving payment reduces your claim.
  const balance = (paid - owes) + paymentsSent - paymentsReceived;

  return { paid, owes, paymentsSent, paymentsReceived, balance };
}

/**
 * Get total balance across all groups for a user
 */
export async function getUserTotalBalance(userId: string) {
  const { data: userGroups, error: groupError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId);

  if (groupError) throw groupError;

  const groupIds = userGroups?.map((g) => g.group_id) || [];

  let totalOwes = 0;
  let totalGetsBack = 0;

  for (const groupId of groupIds) {
    const balance = await getUserGroupBalance(groupId, userId);
    if (balance.balance < 0) {
      totalOwes += Math.abs(balance.balance);
    } else {
      totalGetsBack += balance.balance;
    }
  }

  return { owes: totalOwes, getsBack: totalGetsBack };
}
