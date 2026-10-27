<?php
// Authenticates with strict TLS but never issues MAIL FROM, RCPT TO, or DATA.
try {
    $config = json_decode(file_get_contents('/run/secrets/smtp_settings'), true, 512, JSON_THROW_ON_ERROR);
    $host = $config['mail_smtphost'];
    $port = (int)$config['mail_smtpport'];
    if (!in_array($port, [465, 587], true)) throw new RuntimeException('port');
    $context = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true, 'peer_name' => $host]]);
    $connection = stream_socket_client(($port === 465 ? 'tls://' : 'tcp://').$host.':'.$port, $errno, $error, 20, STREAM_CLIENT_CONNECT, $context);
    if (!$connection) throw new RuntimeException('connection');
    stream_set_timeout($connection, 20);
    function reply($connection, $expected) {
        do {
            $line = fgets($connection, 4096);
            if ($line === false || !preg_match('/^([0-9]{3})([- ])/D', $line, $matches)) throw new RuntimeException('response');
            $code = (int)$matches[1];
        } while ($matches[2] === '-');
        if ($code !== $expected) throw new RuntimeException('authentication');
    }
    function command($connection, $value, $expected) {
        fwrite($connection, $value."\r\n");
        reply($connection, $expected);
    }
    reply($connection, 220);
    command($connection, 'EHLO erp.trusoft.ai', 250);
    if ($port === 587) {
        command($connection, 'STARTTLS', 220);
        if (stream_socket_enable_crypto($connection, true, STREAM_CRYPTO_METHOD_TLS_CLIENT) !== true) throw new RuntimeException('tls');
        command($connection, 'EHLO erp.trusoft.ai', 250);
    }
    command($connection, 'AUTH LOGIN', 334);
    command($connection, base64_encode($config['mail_smtpname']), 334);
    command($connection, base64_encode($config['mail_smtppassword']), 235);
    command($connection, 'QUIT', 221);
    fclose($connection);
    echo "PASS strict TLS and company SMTP authentication; no message sent\n";
} catch (Throwable $error) {
    // Do not include server responses, addresses or credential material in logs.
    fwrite(STDERR, "SMTP verification failed; inspect connectivity and protected settings\n");
    exit(1);
}
