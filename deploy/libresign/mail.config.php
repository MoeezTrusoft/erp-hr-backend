<?php
// Loaded only with the production mail overlay; credentials remain Docker secrets.
$CONFIG = json_decode(file_get_contents('/run/secrets/smtp_settings'), true, 512, JSON_THROW_ON_ERROR);
