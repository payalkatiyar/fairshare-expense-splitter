import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const hasSupabaseEnv = Boolean(supabaseUrl && supabaseKey);
if (!hasSupabaseEnv) {
  console.warn(
    '[expense-splitter] Missing Supabase environment variables. Using placeholder client until NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.'
  );
}

export const supabase = createClient(
  supabaseUrl ?? 'https://placeholder.supabase.co',
  supabaseKey ?? 'placeholder-anon-key'
);

export type User = {
  id: string;
  email: string;
  full_name: string | null;
  monthly_budget: number;
  created_at: string;
  updated_at: string;
};

export type Group = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

export type GroupMember = {
  id: string;
  group_id: string;
  user_id: string;
  joined_at: string;
};

export type Expense = {
  id: string;
  group_id: string;
  title: string;
  amount: number;
  paid_by: string;
  split_type: 'equal' | 'custom';
  created_at: string;
  updated_at: string;
};

export type ExpenseSplit = {
  id: string;
  expense_id: string;
  user_id: string;
  amount: number;
  created_at: string;
};

export type Settlement = {
  id: string;
  group_id: string;
  from_user_id: string;
  to_user_id: string;
  amount: number;
  is_settled: boolean;
  status: 'pending' | 'paid' | 'confirmed';
  settled_at: string | null;
  created_at: string;
};

export type ActivityLog = {
  id: string;
  group_id: string | null;
  user_id: string;
  activity_type: string;
  description: string | null;
  metadata: Record<string, any> | null;
  created_at: string;
};
