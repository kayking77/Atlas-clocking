<?php
/**
 * Atlas Timeclock — staff login management (admin only).
 *
 * The admin portal calls this to create logins, reset passwords and
 * activate/deactivate staff. It needs the Supabase service_role key, which
 * must never reach a browser — so it lives in config.php on the server.
 *
 * POST JSON, with the admin's Supabase session token:
 *   Authorization: Bearer <access_token>
 *   {"action":"create", "full_name":"…", "email":"…", "phone":"…", "role":"staff|admin", "password":"…"}
 *   {"action":"reset_password", "user_id":"…", "password":"…"}
 *   {"action":"set_active", "user_id":"…", "active":true|false}
 */

declare(strict_types=1);
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function fail(int $status, string $message): void {
    http_response_code($status);
    echo json_encode(['error' => $message]);
    exit;
}

// ---- config: keep config.php OUTSIDE public_html when you can ------------
$candidates = [
    dirname(__DIR__, 3) . '/atlas-private/config.php', // e.g. /home/USER/atlas-private/config.php
    __DIR__ . '/config.php',                            // fallback, protected by .htaccess
];
$cfg = null;
foreach ($candidates as $path) {
    if (is_file($path)) { $cfg = require $path; break; }
}
if (!is_array($cfg) || empty($cfg['supabase_url']) || empty($cfg['service_role_key']) || empty($cfg['anon_key'])) {
    fail(500, 'The staff service is not configured yet. Create config.php from config.sample.php.');
}
$SUPABASE = rtrim($cfg['supabase_url'], '/');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') fail(405, 'Use POST.');

// ---- simple per-IP rate limit: 30 requests / 10 minutes ------------------
$ip = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? $_SERVER['REMOTE_ADDR'] ?? 'unknown';
$rlFile = sys_get_temp_dir() . '/atlas_staff_rl_' . hash('sha256', $ip);
$now = time();
$hits = is_file($rlFile) ? array_filter(json_decode((string)file_get_contents($rlFile), true) ?: [], fn($t) => $t > $now - 600) : [];
if (count($hits) >= 30) fail(429, 'Too many requests. Wait a few minutes and try again.');
$hits[] = $now;
@file_put_contents($rlFile, json_encode(array_values($hits)), LOCK_EX);

// ---- HTTP helper ---------------------------------------------------------
function supa(string $method, string $url, array $headers, ?array $body = null): array {
    $ch = curl_init($url);
    $h = array_merge(['Content-Type: application/json'], $headers);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST  => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER     => $h,
        CURLOPT_TIMEOUT        => 20,
    ]);
    if ($body !== null) curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    $raw = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err = curl_error($ch);
    curl_close($ch);
    if ($raw === false) fail(502, 'Could not reach Supabase: ' . $err);
    return [$status, json_decode($raw, true)];
}
$service = ['apikey: ' . $cfg['service_role_key'], 'Authorization: Bearer ' . $cfg['service_role_key']];

// ---- who is calling? must be an active admin -----------------------------
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
if (!preg_match('/^Bearer\s+(\S+)$/', $auth, $m)) fail(401, 'Sign in again.');
[$st, $caller] = supa('GET', "$SUPABASE/auth/v1/user", ['apikey: ' . $cfg['anon_key'], 'Authorization: Bearer ' . $m[1]]);
if ($st !== 200 || empty($caller['id'])) fail(401, 'Your session expired. Sign in again.');
$callerId = $caller['id'];

[$st, $rows] = supa('GET', "$SUPABASE/rest/v1/profiles?select=role,active&id=eq." . rawurlencode($callerId), $service);
if ($st !== 200 || empty($rows[0]) || $rows[0]['role'] !== 'admin' || !$rows[0]['active']) {
    fail(403, 'Only Atlas administrators can manage staff logins.');
}

// ---- input ---------------------------------------------------------------
$in = json_decode((string)file_get_contents('php://input'), true);
if (!is_array($in)) fail(400, 'Send JSON.');
$action = $in['action'] ?? '';

function uuid_ok($v): bool { return is_string($v) && preg_match('/^[0-9a-f-]{36}$/i', $v) === 1; }
function password_ok($p): ?string {
    if (!is_string($p) || strlen($p) < 10) return 'Passwords need at least 10 characters.';
    if (strlen($p) > 72) return 'Passwords can be at most 72 characters.';
    return null;
}

switch ($action) {
    case 'create': {
        $name  = trim((string)($in['full_name'] ?? ''));
        $email = strtolower(trim((string)($in['email'] ?? '')));
        $phone = trim((string)($in['phone'] ?? ''));
        $role  = ($in['role'] ?? 'staff') === 'admin' ? 'admin' : 'staff';
        $pw    = $in['password'] ?? '';
        if ($name === '' || mb_strlen($name) > 120) fail(400, 'Enter their full name.');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) fail(400, 'Enter a valid email address.');
        if ($e = password_ok($pw)) fail(400, $e);

        [$st, $res] = supa('POST', "$SUPABASE/auth/v1/admin/users", $service, [
            'email'         => $email,
            'password'      => $pw,
            'email_confirm' => true,
            'user_metadata' => ['full_name' => $name, 'phone' => $phone],
            'app_metadata'  => ['role' => $role],
        ]);
        if ($st >= 300) {
            $msg = $res['msg'] ?? $res['message'] ?? $res['error_description'] ?? 'Could not create the login.';
            if (stripos($msg, 'already') !== false) $msg = 'A login with that email already exists.';
            fail($st === 422 ? 400 : 502, $msg);
        }
        // the database trigger creates the profile; make sure name/phone/role are set
        supa('PATCH', "$SUPABASE/rest/v1/profiles?id=eq." . rawurlencode($res['id']), $service,
            ['full_name' => $name, 'phone' => $phone ?: null, 'role' => $role, 'email' => $email]);
        echo json_encode(['ok' => true, 'id' => $res['id']]);
        break;
    }

    case 'reset_password': {
        $id = $in['user_id'] ?? '';
        if (!uuid_ok($id)) fail(400, 'Unknown staff member.');
        if ($e = password_ok($in['password'] ?? '')) fail(400, $e);
        [$st, $res] = supa('PUT', "$SUPABASE/auth/v1/admin/users/" . rawurlencode($id), $service, ['password' => $in['password']]);
        if ($st >= 300) fail(502, $res['msg'] ?? $res['message'] ?? 'Could not reset the password.');
        echo json_encode(['ok' => true]);
        break;
    }

    case 'set_active': {
        $id = $in['user_id'] ?? '';
        $active = (bool)($in['active'] ?? false);
        if (!uuid_ok($id)) fail(400, 'Unknown staff member.');
        if ($id === $callerId && !$active) fail(400, 'You can’t deactivate your own account.');
        [$st, $res] = supa('PATCH', "$SUPABASE/rest/v1/profiles?id=eq." . rawurlencode($id), $service, ['active' => $active]);
        if ($st >= 300) fail(502, 'Could not update the profile.');
        // a ban blocks sign-in and token refresh; "none" lifts it
        [$st, $res] = supa('PUT', "$SUPABASE/auth/v1/admin/users/" . rawurlencode($id), $service,
            ['ban_duration' => $active ? 'none' : '876000h']);
        if ($st >= 300) fail(502, $res['msg'] ?? 'Profile updated, but the login could not be ' . ($active ? 'unblocked.' : 'blocked.'));
        echo json_encode(['ok' => true]);
        break;
    }

    default:
        fail(400, 'Unknown action.');
}
