<?php
// Copy to config.php and fill in from Supabase → Project Settings → API.
//
// Best: put config.php OUTSIDE public_html, at  /home/<you>/atlas-private/config.php
// (staff.php looks there first). If you must keep it in this folder, the
// .htaccess here blocks direct access to it.
//
// The service_role key bypasses row-level security. Never put it in any .js file.
return [
    'supabase_url'     => 'https://YOUR-PROJECT.supabase.co',
    'anon_key'         => 'YOUR-ANON-KEY',
    'service_role_key' => 'YOUR-SERVICE-ROLE-KEY',
];
