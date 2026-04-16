import { supabase } from './supabase';

export type ActivityType =
  | 'expense_added'
  | 'payment_recorded'
  | 'payment_marked_paid'
  | 'payment_confirmed'
  | 'member_added'
  | 'member_left'
  | 'member_joined'
  | 'group_created'
  | 'group_deleted';

/**
 * Log activity
 */
export async function logActivity(
  activityType: ActivityType,
  userId: string,
  groupId: string | null,
  description: string,
  metadata?: Record<string, any>
) {
  const { error } = await supabase.from('activity_log').insert({
    activity_type: activityType,
    user_id: userId,
    group_id: groupId,
    description,
    metadata,
  });

  if (error) throw error;
}

/**
 * Get group activity
 */
export async function getGroupActivity(groupId: string, limit = 50) {
  const { data, error } = await supabase
    .from('activity_log')
    .select(
      `
      id,
      activity_type,
      description,
      metadata,
      created_at,
      users(email, full_name)
    `
    )
    .eq('group_id', groupId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

/**
 * Get user activity across all groups
 */
export async function getUserActivity(userId: string, limit = 50) {
  const { data: userGroups, error: groupError } = await supabase
    .from('group_members')
    .select('group_id')
    .eq('user_id', userId);

  if (groupError) throw groupError;

  const groupIds = userGroups?.map((g) => g.group_id) || [];

  if (groupIds.length === 0) {
    return [];
  }

  const { data, error } = await supabase
    .from('activity_log')
    .select(
      `
      id,
      activity_type,
      description,
      metadata,
      created_at,
      group_id,
      groups(name),
      users(email, full_name)
    `
    )
    .in('group_id', groupIds)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;
  return data;
}

/**
 * Format activity message
 */
export function formatActivityMessage(activity: any): string {
  const user = activity.users?.full_name || activity.users?.email || 'Unknown';
  const group = activity.groups?.name || '';

  switch (activity.activity_type) {
    case 'expense_added':
      return `${user} added ${activity.metadata?.title} - Rs. ${activity.metadata?.amount}${group ? ` in ${group}` : ''}`;
    case 'member_added':
      return `${activity.metadata?.memberName} joined${group ? ` ${group}` : ''}`;
    case 'payment_recorded':
      return `${user} paid Rs. ${activity.metadata?.amount}${group ? ` in ${group}` : ''}`;
    case 'payment_marked_paid':
      return `${user} marked payment of Rs. ${activity.metadata?.amount} as paid`;
    case 'payment_confirmed':
      return `${user} confirmed receiving Rs. ${activity.metadata?.amount}`;
    case 'member_left':
      return `${user} left${group ? ` ${group}` : ''}`;
    case 'group_created':
      return `${user} created ${activity.metadata?.groupName}`;
    default:
      return activity.description || 'Activity occurred';
  }
}
