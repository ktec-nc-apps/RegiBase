<?php

declare(strict_types=1);

namespace OCA\RegiBase\Service;

use OCA\RegiBase\AppInfo\Application;
use OCP\IConfig;

/**
 * How many PBKDF2-SHA256 rounds turn a master key into the AES key (review K17). A key set
 * before 2026-09 was made with 250,000 and keeps working as it is: the count is stored per
 * user (enc_kdf_iter), and a missing value means 250,000. A master key set or changed from
 * now on is made with 600,000 (OWASP 2023), which makes each guess against a stolen salt and
 * verifier cost more than twice as much. The page (js) and occ use the same numbers.
 */
final class Kdf {
	public const LEGACY = 250000;
	public const CURRENT = 600000;
	/** Shortest master key accepted when one is set or changed (existing keys keep working). */
	public const MIN_KEY_LENGTH = 8;

	public static function iterFor(IConfig $config, string $uid): int {
		$v = (int)$config->getUserValue($uid, Application::APP_ID, 'enc_kdf_iter', '0');
		return self::valid($v) ? $v : self::LEGACY;
	}

	/** A round count RegiBase could have written: guards what settings and a restore bring in. */
	public static function valid($v): bool {
		return (is_int($v) || (is_string($v) && ctype_digit($v))) && (int)$v >= 100000 && (int)$v <= 10000000;
	}

	public static function derive(string $password, string $saltB64, int $iter): string {
		return hash_pbkdf2('sha256', $password, (string)base64_decode($saltB64), $iter, 32, true);
	}
}
