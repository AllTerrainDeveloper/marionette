<?php
/**
 * Motion Puppet — minimal WebRTC signaling.
 *
 * Stores one SDP offer and one SDP answer per pairing session in temporary
 * files. Once both browsers have exchanged descriptions, all real-time
 * traffic flows peer to peer over WebRTC; this script is never touched again.
 *
 *   GET  signal.php?op=ping            -> {"ok":true,"engine":"php"}
 *   POST signal.php?s=CODE&k=offer     body: {"type":"offer","sdp":"..."}
 *   GET  signal.php?s=CODE&k=offer     -> {"ok":true,"data":{...}|null}
 *   POST signal.php?s=CODE&k=answer    body: {"type":"answer","sdp":"..."}  (first writer wins)
 *   GET  signal.php?s=CODE&k=answer    -> {"ok":true,"data":{...}|null}
 */

declare(strict_types=1);

const MP_TTL      = 900;    // Seconds a session file stays valid.
const MP_MAX_BODY = 65536;  // Largest accepted SDP payload, in bytes.

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');
header('X-Content-Type-Options: nosniff');

function mp_out(int $status, array $payload): void
{
    http_response_code($status);
    echo json_encode($payload);
    exit;
}

if (($_GET['op'] ?? '') === 'ping') {
    mp_out(200, ['ok' => true, 'engine' => 'php']);
}

$session = (string) ($_GET['s'] ?? '');
$kind    = (string) ($_GET['k'] ?? '');

if (!preg_match('/^[A-Z0-9]{6,12}$/', $session)) {
    mp_out(400, ['ok' => false, 'error' => 'bad_session']);
}
if ($kind !== 'offer' && $kind !== 'answer') {
    mp_out(400, ['ok' => false, 'error' => 'bad_kind']);
}

$dir = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'motion-puppet-signal';
if (!is_dir($dir) && !@mkdir($dir, 0700, true) && !is_dir($dir)) {
    mp_out(500, ['ok' => false, 'error' => 'storage_unavailable']);
}

// Occasionally sweep expired session files.
if (random_int(0, 19) === 0) {
    foreach ((array) glob($dir . DIRECTORY_SEPARATOR . '*.json') as $stale) {
        if (@filemtime($stale) < time() - MP_TTL) {
            @unlink($stale);
        }
    }
}

$file   = $dir . DIRECTORY_SEPARATOR . $session . '.' . $kind . '.json';
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if ($method === 'GET') {
    if (!is_file($file) || filemtime($file) < time() - MP_TTL) {
        mp_out(200, ['ok' => true, 'data' => null]);
    }
    $data = json_decode((string) file_get_contents($file), true);
    mp_out(200, ['ok' => true, 'data' => is_array($data) ? $data : null]);
}

if ($method !== 'POST') {
    header('Allow: GET, POST');
    mp_out(405, ['ok' => false, 'error' => 'method_not_allowed']);
}

$raw = (string) file_get_contents('php://input', false, null, 0, MP_MAX_BODY + 1);
if ($raw === '' || strlen($raw) > MP_MAX_BODY) {
    mp_out(413, ['ok' => false, 'error' => 'bad_size']);
}

$body = json_decode($raw, true);
if (
    !is_array($body)
    || ($body['type'] ?? '') !== $kind
    || !is_string($body['sdp'] ?? null)
    || strncmp($body['sdp'], 'v=0', 3) !== 0
) {
    mp_out(400, ['ok' => false, 'error' => 'bad_description']);
}

$clean = json_encode(['type' => $kind, 'sdp' => $body['sdp']]);

if ($kind === 'offer') {
    // A fresh offer restarts the session: drop any earlier answer.
    @unlink($dir . DIRECTORY_SEPARATOR . $session . '.answer.json');
    if (file_put_contents($file, $clean, LOCK_EX) === false) {
        mp_out(500, ['ok' => false, 'error' => 'write_failed']);
    }
    mp_out(200, ['ok' => true]);
}

// Answer: the offer must exist, and only the first phone may claim it.
$offer = $dir . DIRECTORY_SEPARATOR . $session . '.offer.json';
if (!is_file($offer) || filemtime($offer) < time() - MP_TTL) {
    mp_out(404, ['ok' => false, 'error' => 'no_such_session']);
}
$handle = @fopen($file, 'x');
if ($handle === false) {
    mp_out(409, ['ok' => false, 'error' => 'already_claimed']);
}
fwrite($handle, $clean);
fclose($handle);
mp_out(200, ['ok' => true]);
