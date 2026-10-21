<?php
declare(strict_types=1);

header('Cache-Control: no-store');
header('Referrer-Policy: no-referrer');
header('X-Robots-Tag: noindex, nofollow');
header('X-Content-Type-Options: nosniff');

function finish_feedback(int $status, bool $ok, string $message): void
{
    http_response_code($status);
    $accept = $_SERVER['HTTP_ACCEPT'] ?? '';
    if (strpos($accept, 'application/json') !== false) {
        header('Content-Type: application/json; charset=UTF-8');
        echo json_encode(['ok' => $ok, 'message' => $message]);
        exit;
    }

    header('Content-Type: text/html; charset=UTF-8');
    $heading = $ok ? 'Message sent' : 'Message not sent';
    echo '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>';
    echo $heading;
    echo ' — NASSCAD</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f4f3ee;color:#0b1628;margin:0;padding:32px}main{max-width:600px;margin:10vh auto;background:#fff;padding:32px;border:1px solid #d8dfe9;border-radius:14px}a{color:#1d4ed8}</style></head><body><main><h1>';
    echo $heading;
    echo '</h1><p>' . htmlspecialchars($message, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8') . '</p><p><a href="feedback.html">Back to the feedback form</a></p></main></body></html>';
    exit;
}

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    finish_feedback(405, false, 'Use the feedback form to send a message.');
}

// Leave room for a 2 MB JPG and the form fields, but reject oversized requests early.
if ((int)($_SERVER['CONTENT_LENGTH'] ?? 0) > 2 * 1024 * 1024 + 16384) {
    finish_feedback(413, false, 'The message or JPG image is too large (2 MB maximum for the image).');
}

// A hidden field blocks basic automated submissions without a third-party CAPTCHA.
if (!empty($_POST['extra_field'])) {
    finish_feedback(200, true, 'Thank you — your message was sent.');
}

$category = $_POST['category'] ?? null;
$message = $_POST['message'] ?? null;
$categories = [
    'bug' => 'Bug',
    'idea' => 'Idea',
    'other' => 'Other',
];
if (!is_string($category) || !isset($categories[$category]) || !is_string($message)) {
    finish_feedback(400, false, 'Please complete the feedback form.');
}

$message = trim(str_replace(["\r\n", "\r"], "\n", $message));
$characters = preg_match('//u', $message) === 1 ? preg_match_all('/./us', $message) : false;
if (strlen($message) > 12000 || $characters === false || $characters < 5 || $characters > 4000) {
    finish_feedback(400, false, 'Write a message between 5 and 4000 characters.');
}
$message = preg_replace('/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/u', '', $message);

// Remove JPEG APP and comment segments (EXIF, XMP, IPTC, GPS, thumbnails,
// camera details, etc.) without relying on the optional GD extension.
function feedback_jpeg_without_metadata(string $data): ?string
{
    $length = strlen($data);
    if ($length < 4 || substr($data, 0, 2) !== "\xFF\xD8") return null;

    $clean = "\xFF\xD8";
    $position = 2;
    $inScan = false;
    $scanStart = 2;
    $hasScan = false;
    while ($position < $length) {
        if ($inScan) {
            $markerStart = strpos($data, "\xFF", $position);
            if ($markerStart === false) return null;
            $next = $markerStart + 1;
            while ($next < $length && $data[$next] === "\xFF") ++$next;
            if ($next >= $length) return null;
            $marker = ord($data[$next]);
            // Escaped FF bytes and restart markers belong to the compressed image.
            if ($marker === 0 || $marker === 1 || ($marker >= 0xD0 && $marker <= 0xD7)) {
                $position = $next + 1;
                continue;
            }
            $clean .= substr($data, $scanStart, $markerStart - $scanStart);
            $position = $markerStart;
            $inScan = false;
            continue;
        }

        if ($data[$position] !== "\xFF") return null;
        $start = $position;
        while ($position < $length && $data[$position] === "\xFF") ++$position;
        if ($position >= $length) return null;
        $marker = ord($data[$position++]);
        if ($marker === 0xD9) {
            $clean .= substr($data, $start, $position - $start);
            return $hasScan ? $clean : null;
        }
        if ($marker === 0xD8) return null;
        if ($marker === 1 || ($marker >= 0xD0 && $marker <= 0xD7)) {
            $clean .= substr($data, $start, $position - $start);
            continue;
        }
        if ($position + 2 > $length) return null;
        $segmentLength = unpack('nlength', substr($data, $position, 2))['length'];
        if ($segmentLength < 2 || $position + $segmentLength > $length) return null;
        $end = $position + $segmentLength;
        if (!(($marker >= 0xE0 && $marker <= 0xEF) || $marker === 0xFE)) {
            $clean .= substr($data, $start, $end - $start);
        }
        if ($marker === 0xDA) {
            $hasScan = true;
            $inScan = true;
            $scanStart = $end;
        }
        $position = $end;
    }
    return null;
}

$cleanJpeg = null;
if (isset($_FILES['image'])) {
    $upload = $_FILES['image'];
    if (!is_array($upload) || !isset($upload['error']) || !is_int($upload['error'])) {
        finish_feedback(400, false, 'Please choose one JPG image.');
    }
    if ($upload['error'] !== UPLOAD_ERR_NO_FILE) {
        if ($upload['error'] !== UPLOAD_ERR_OK) {
            finish_feedback(400, false, 'The JPG could not be uploaded. Please use an image no larger than 2 MB.');
        }
        $temporary = $upload['tmp_name'] ?? null;
        if (!is_string($temporary) || !is_uploaded_file($temporary)) {
            finish_feedback(400, false, 'The JPG upload was invalid.');
        }
        $size = filesize($temporary);
        if ($size === false || $size < 1 || $size > 2 * 1024 * 1024) {
            finish_feedback(413, false, 'Please use a JPG image no larger than 2 MB.');
        }
        $imageInfo = @getimagesize($temporary);
        if ($imageInfo === false || ($imageInfo[2] ?? null) !== IMAGETYPE_JPEG
            || $imageInfo[0] < 1 || $imageInfo[1] < 1
            || $imageInfo[0] > 6000 || $imageInfo[1] > 6000
            || $imageInfo[0] * $imageInfo[1] > 20000000) {
            finish_feedback(400, false, 'Please choose a valid JPG image up to 20 megapixels.');
        }
        if (function_exists('finfo_open')) {
            $finfo = finfo_open(FILEINFO_MIME_TYPE);
            if ($finfo === false || finfo_file($finfo, $temporary) !== 'image/jpeg') {
                if ($finfo !== false) finfo_close($finfo);
                finish_feedback(400, false, 'Please choose a valid JPG image.');
            }
            finfo_close($finfo);
        }
        $original = file_get_contents($temporary);
        $cleanJpeg = $original === false ? null : feedback_jpeg_without_metadata($original);
        if ($cleanJpeg === null) {
            finish_feedback(400, false, 'The JPG could not be read. Please try another image.');
        }
        $cleanInfo = @getimagesizefromstring($cleanJpeg);
        if ($cleanInfo === false || ($cleanInfo[2] ?? null) !== IMAGETYPE_JPEG
            || $cleanInfo[0] !== $imageInfo[0] || $cleanInfo[1] !== $imageInfo[1]) {
            finish_feedback(400, false, 'The JPG could not be checked. Please try another image.');
        }
    }
}

// A global counter limits mail floods without recording an IP or visitor ID.
function feedback_rate_allowed(): bool
{
    $handle = @fopen(sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'nasscad_feedback_rate.json', 'c+');
    if ($handle === false) return true;
    if (!flock($handle, LOCK_EX)) {
        fclose($handle);
        return true;
    }
    $state = json_decode(stream_get_contents($handle), true);
    $now = time();
    if (!is_array($state) || !isset($state['start'], $state['count']) || $now - (int)$state['start'] >= 3600) {
        $state = ['start' => $now, 'count' => 0];
    }
    $allowed = (int)$state['count'] < 30;
    if ($allowed) ++$state['count'];
    rewind($handle);
    ftruncate($handle, 0);
    fwrite($handle, json_encode($state));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
    return $allowed;
}

if (!feedback_rate_allowed()) {
    finish_feedback(429, false, 'The form is temporarily busy. Please try again later.');
}

// The sender and recipient are fixed; no visitor identity or request metadata is mailed.
$to = 'contact@nasscad.com';
$subject = '[NASSCAD] Feedback without email';
$body = "Category: " . $categories[$category] . "\n\n" . $message . "\n";
$headers = "From: NASSCAD Feedback <contact@nasscad.com>\r\n"
         . "MIME-Version: 1.0\r\n"
         . "Content-Type: text/plain; charset=UTF-8\r\n";

if ($cleanJpeg !== null) {
    $boundary = 'nasscad-' . bin2hex(random_bytes(12));
    $headers = "From: NASSCAD Feedback <contact@nasscad.com>\r\n"
             . "MIME-Version: 1.0\r\n"
             . "Content-Type: multipart/mixed; boundary=\"$boundary\"\r\n";
    $text = "Category: " . $categories[$category] . "\r\n\r\n"
          . str_replace("\n", "\r\n", $message) . "\r\n";
    $body = "This is a multipart message in MIME format.\r\n"
          . "--$boundary\r\n"
          . "Content-Type: text/plain; charset=UTF-8\r\n"
          . "Content-Transfer-Encoding: base64\r\n\r\n"
          . chunk_split(base64_encode($text), 76, "\r\n")
          . "--$boundary\r\n"
          . "Content-Type: image/jpeg; name=\"feedback.jpg\"\r\n"
          . "Content-Disposition: attachment; filename=\"feedback.jpg\"\r\n"
          . "Content-Transfer-Encoding: base64\r\n\r\n"
          . chunk_split(base64_encode($cleanJpeg), 76, "\r\n")
          . "--$boundary--\r\n";
}

if (!function_exists('mail') || !@mail($to, $subject, $body, $headers)) {
    finish_feedback(503, false, 'The message could not be sent right now. Please try again later.');
}
finish_feedback(200, true, 'Thank you — your message was sent.');
