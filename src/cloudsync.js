import { createClient } from '@supabase/supabase-js';

const supabaseUrl = "https://ietqxkurqiigmniimbab.supabase.co";
const supabaseKey = "sb_publishable_c5CVuaR4k4xNohC_Pc2fyA_8GoQy1jC";

// Single client instantiation with explicit persistence properties
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,       // Stores JWT securely inside localStorage
    autoRefreshToken: true,     // Automatically refreshes expired links silently
    detectSessionInUrl: true    // Catches incoming magic links instantly
  }
});

/**
 * Validates active cloud sessions and pulls down remote state 
 * BEFORE the React rendering tree begins.
 */
const buildLocalPayload = () => ({
  ss_settings: JSON.parse(localStorage.getItem('ss_settings') || '{}'),
  ss_papers_pool: JSON.parse(localStorage.getItem('ss_papers_pool') || '[]'),
  ss_affinity_profile: JSON.parse(localStorage.getItem('ss_affinity_profile') || '{}'),
  ss_saved_stack: JSON.parse(localStorage.getItem('ss_saved_stack') || '[]')
});

export async function startSync() {
  try {
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    
    if (sessionError) throw sessionError;

    if (session && session.user) {
      console.log("SpinStack secure handshake active:", session.user.email);
      
      const { data, error: fetchError } = await supabase
        .from('user_state')
        .select('data')
        .eq('user_id', session.user.id)
        .maybeSingle();

      if (fetchError) throw fetchError;

      if (data && data.data) {
        console.log("Synching cloud down to local sandbox...");
        Object.entries(data.data).forEach(([key, val]) => {
          localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
        });
      } else {
        console.log("No cloud record found, seeding user_state with local defaults.");
        const payload = buildLocalPayload();
        const { error: seedError } = await supabase.from('user_state').upsert({
          user_id: session.user.id,
          data: payload,
          updated_at: new Date().toISOString()
        });
        if (seedError) throw seedError;
      }
    } else {
      console.log("Running in localized decoupled state mode. No active session.");
    }
  } catch (err) {
    printCloudSyncError(err);
  }
}

/**
 * Push current localStorage state upwards to Supabase.
 * Debounced or executed selectively upon significant mutations (like swiping or configuring feeds).
 */
export async function pushToCloud() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session || !session.user) return;

    // Bundle core keys into a clean single JSON object
    const payload = {
      ss_settings: JSON.parse(localStorage.getItem('ss_settings') || '{}'),
      ss_papers_pool: JSON.parse(localStorage.getItem('ss_papers_pool') || '[]'),
      ss_affinity_profile: JSON.parse(localStorage.getItem('ss_affinity_profile') || '{}'),
      ss_saved_stack: JSON.parse(localStorage.getItem('ss_saved_stack') || '[]')
    };

    const { error } = await supabase
      .from('user_state')
      .upsert({
        user_id: session.user.id,
        data: payload,
        updated_at: new Date().toISOString()
      });

    if (error) throw error;
    console.log("Cloud mirror update secure.");
  } catch (err) {
    console.error("Upstream upload caught an exception:", err);
  }
}

function printCloudSyncError(err) {
  console.warn("Cross-device framework message:", err.message || err);
}
