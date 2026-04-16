import { supabase } from './supabase';
import { getUserGroupBalance } from './expense-utils';

/**
 * Find user by email or username
 */
export async function findUserByEmailOrUsername(query: string) {
  if (!query || query.trim().length === 0) {
    return { valid: false, error: 'Email or username is required' };
  }

  const { data, error } = await supabase
    .from('users')
    .select('id, email, full_name')
    .or(`email.ilike.%${query}%,full_name.ilike.%${query}%`)
    .limit(10);

  if (error) {
    throw error;
  }

  if (!data || data.length === 0) {
    return { valid: false, error: 'User not found' };
  }

  return { valid: true, users: data };
}

/**
 * Check if user is already a member of group
 */
export async function isGroupMember(groupId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('group_members')
    .select('id')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return !!data;
}

/**
 * Check if user is already a member of room
 */
export async function isRoomMember(roomId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('room_members')
    .select('id')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return !!data;
}

/**
 * Add member to group
 */
export async function addGroupMember(groupId: string, userId: string) {
  const isMember = await isGroupMember(groupId, userId);
  if (isMember) {
    return { valid: false, error: 'User is already a member of this group' };
  }

  const { error } = await supabase.from('group_members').insert({
    group_id: groupId,
    user_id: userId,
  });

  if (error) {
    if (error.code === '23505') {
      return { valid: false, error: 'User is already a member of this group' };
    }
    throw error;
  }

  return { valid: true };
}

/**
 * Add member to room
 */
export async function addRoomMember(roomId: string, userId: string) {
  const isMember = await isRoomMember(roomId, userId);
  if (isMember) {
    return { valid: false, error: 'User is already a member of this room' };
  }

  const { error } = await supabase.from('room_members').insert({
    room_id: roomId,
    user_id: userId,
  });

  if (error) {
    if (error.code === '23505') {
      return { valid: false, error: 'User is already a member of this room' };
    }
    throw error;
  }

  return { valid: true };
}

/**
 * Check if user can leave group (no pending debts/balances)
 */
export async function canLeaveGroup(
  groupId: string,
  userId: string
): Promise<{ canLeave: boolean; message?: string; balances?: { owes: number; getsBack: number } }> {
  // 1. Check for unsettled formal settlements
  const { data: unsettledSettlements, error: settleError } = await supabase
    .from('settlements')
    .select('*')
    .eq('group_id', groupId)
    .eq('is_settled', false)
    .or(`from_user_id.eq.${userId},to_user_id.eq.${userId}`);

  if (settleError) throw settleError;

  if (unsettledSettlements && unsettledSettlements.length > 0) {
    return {
      canLeave: false,
      message: 'You have pending settlements that need to be cleared.',
    };
  }

  // 2. Check fundamental net balance using centralized function (factors in confirmed payments)
  const balanceData = await getUserGroupBalance(groupId, userId);
  const netBalance = balanceData.balance;

  if (Math.abs(netBalance) > 0.01) {
    return {
      canLeave: false,
      message: `You have an active balance of Rs. ${netBalance.toFixed(2)}. Settle all expenses before leaving.`,
      balances: { owes: netBalance < 0 ? Math.abs(netBalance) : 0, getsBack: netBalance > 0 ? netBalance : 0 }
    };
  }

  return { canLeave: true };
}

/**
 * Remove user from group
 */
export async function removeGroupMember(groupId: string, userId: string) {
  const canLeave = await canLeaveGroup(groupId, userId);
  if (!canLeave.canLeave) {
    return { valid: false, error: canLeave.message };
  }

  const { error } = await supabase
    .from('group_members')
    .delete()
    .eq('group_id', groupId)
    .eq('user_id', userId);

  if (error) throw error;

  return { valid: true };
}

/**
 * Check if a group can be deleted.
 * Group can be deleted only if:
 * - no unsettled settlements exist
 * - all computed member balances are zero
 */
export async function canDeleteGroup(
  groupId: string
): Promise<{ canDelete: boolean; message?: string }> {
  const { data: unsettled, error: unsettledError } = await supabase
    .from('settlements')
    .select('id')
    .eq('group_id', groupId)
    .eq('is_settled', false)
    .limit(1);

  if (unsettledError) throw unsettledError;
  if (unsettled && unsettled.length > 0) {
    return {
      canDelete: false,
      message: 'Cannot delete group while settlements are pending.',
    };
  }

  const { data: members, error: membersError } = await supabase
    .from('group_members')
    .select('user_id')
    .eq('group_id', groupId);
  if (membersError) throw membersError;

  const memberIds = (members || []).map((m) => m.user_id);
  if (memberIds.length === 0) {
    return { canDelete: true };
  }

  let hasOutstandingBalance = false;
  for (const id of memberIds) {
    const bal = await getUserGroupBalance(groupId, id);
    if (Math.abs(bal.balance) > 0.01) {
      hasOutstandingBalance = true;
      break;
    }
  }

  if (hasOutstandingBalance) {
    return {
      canDelete: false,
      message: 'Cannot delete group while dues/debts are still pending.',
    };
  }

  return { canDelete: true };
}

/**
 * Delete a group if no pending balances/settlements remain.
 */
export async function deleteGroup(groupId: string): Promise<{ valid: boolean; error?: string }> {
  const deletable = await canDeleteGroup(groupId);
  if (!deletable.canDelete) {
    return { valid: false, error: deletable.message };
  }

  const { error } = await supabase.from('groups').delete().eq('id', groupId);
  if (error) throw error;

  return { valid: true };
}
