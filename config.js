// Atlas Timeclock admin portal configuration.
// Supabase → Project Settings → API. The anon key is public by design;
// row-level security in schema.sql protects the data.
// NEVER put the service_role key in this file — it belongs only in api/config.php.
window.ATLAS_CONFIG = {
  supabaseUrl: 'https://YOUR-PROJECT.supabase.co',
  supabaseAnonKey: 'YOUR-ANON-KEY',
  // Where api/staff.php lives, relative to this page.
  staffApi: 'api/staff.php',
};
